/** Emit the normalized specs data the docs site renders from.
 *
 * Reads every <specs>/*\/service.yaml and writes one specs.json - the
 * manifests, the produces/consumes graph, the whole message surface
 * (commands and queries from OpenAPI, events with their schemas and
 * Microcks examples, data products with ER diagrams), structured
 * acceptance criteria, tag-driven changelogs, and the mermaid charts the
 * site renders (delivery sequences and ER diagrams, gated by
 * `sysspec docs diagrams`; the system graphs are react islands). Raw
 * artifacts are copied under the site's public/ dir so spec renderers
 * and contract-of-record links reach them by URL. The manifests are the
 * only input; a new service appears on the site with no config edits.
 *
 * specs.json is written with a stable format (two-space indent,
 * non-ASCII escaped) pinned by a golden test, so the generated site
 * data never churns.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  channelIndex,
  channelSequence,
  clean,
  deref,
  Dict,
  docLabel,
  gitLines,
  jsonBodySchema,
  loadExamples,
  loadManifests,
  loadRestExamples,
  odcsEr,
  parseFeature,
  PHASES,
  readYaml,
  STEP_RE,
  surfaceIndex,
} from "./docs-gen.js";
import { Exit, pyJson, pyRepr, splitLines } from "./util.js";

/** A fenced ```mermaid block from docs-gen as a bare chart string. */
function unfence(lines: string[]): string {
  return lines.slice(1, -1).join("\n");
}

const stem = (p: string) => path.basename(p).replace(/\.[^.]*$/, "");

/** JSON-schema properties as row dicts, one level deep - the data
 * twin of the site's schema tables. */
export function flattenSchema(properties: Dict, required: string[], prefix = ""): Dict[] {
  const rows: Dict[] = [];
  for (const [prop, rawSchema] of Object.entries<Dict>(properties ?? {})) {
    const schema: Dict = rawSchema ?? {};
    let type = schema.type ?? "—";
    if (schema.format) type = `${type} (${schema.format})`;
    const constraints: string[] = [];
    if ("const" in schema) constraints.push(`always ${pyRepr(schema.const)}`);
    if ("enum" in schema) constraints.push("one of " + schema.enum.map(String).join(", "));
    if ("minimum" in schema) constraints.push(`≥ ${schema.minimum}`);
    if ("maximum" in schema) constraints.push(`≤ ${schema.maximum}`);
    if ("pattern" in schema) constraints.push(`pattern ${schema.pattern}`);
    if ("minItems" in schema) constraints.push(`min ${schema.minItems} item(s)`);
    rows.push({
      field: `${prefix}${prop}`,
      type,
      required: (required ?? []).includes(prop),
      constraints: constraints.join("; "),
    });
    if (schema.type === "object" && !prefix) {
      rows.push(
        ...flattenSchema(schema.properties ?? {}, schema.required ?? [], `${prop}.`),
      );
    } else if (schema.type === "array" && !prefix) {
      const items: Dict = schema.items ?? {};
      if (items.type === "object") {
        rows.push(
          ...flattenSchema(items.properties ?? {}, items.required ?? [], `${prop}[].`),
        );
      }
    }
  }
  return rows;
}

/** Every OpenAPI operation as a structured entry; GET documents as a
 * query, everything else as a command. */
function httpOperations(m: Dict, specs: string, restExamples: Map<string, any[]>): Dict[] {
  const ops: Dict[] = [];
  for (const a of m.artifacts ?? []) {
    if (a.kind !== "openapi") continue;
    const doc = readYaml(path.join(specs, m.name, a.path));
    for (const [path_, methods] of Object.entries<Dict>(doc.paths ?? {})) {
      for (const [method, op] of Object.entries<Dict>(methods ?? {})) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const opId = op.operationId || `${method} ${path_}`;
        const parameters: Dict[] = [];
        for (const p of op.parameters ?? []) {
          const schema = deref(doc, p.schema ?? {});
          let type = schema.type ?? "—";
          if (schema.format) type = `${type} (${schema.format})`;
          parameters.push({
            name: p.name ?? null,
            in: p.in ?? null,
            type,
            required: Boolean(p.required),
          });
        }
        const request = jsonBodySchema(doc, op.requestBody ?? {});
        const responses = Object.entries<Dict>(op.responses ?? {}).map(([status, r]) => ({
          status: String(status),
          description: clean((r ?? {}).description ?? ""),
        }));
        let responseBody: Dict | null = null;
        for (const [status, r] of Object.entries<Dict>(op.responses ?? {})) {
          if (String(status).startsWith("2")) {
            const body = jsonBodySchema(doc, r ?? {});
            if (Object.keys(body).length) {
              responseBody = {
                status: String(status),
                rows: flattenSchema(body.properties ?? {}, body.required ?? []),
              };
              break;
            }
          }
        }
        const examples = (restExamples.get(`${method.toUpperCase()} ${path_}`) ?? []).map(
          ([caseName, req, status, resp]: any[]) => ({
            case: caseName,
            request: req,
            status,
            response: resp,
          }),
        );
        ops.push({
          op_id: opId,
          kind: method === "get" ? "query" : "command",
          method: method.toUpperCase(),
          path: path_,
          summary: clean(op.summary ?? ""),
          description: clean(op.description ?? ""),
          artifact_path: a.path,
          artifact_version: a.version ?? null,
          parameters,
          request_rows: Object.keys(request).length
            ? flattenSchema(request.properties ?? {}, request.required ?? [])
            : [],
          responses,
          response_body: responseBody,
          examples,
        });
      }
    }
  }
  return ops;
}

/** One published channel: producer, consumers, delivery sequence
 * diagram, and each message's schema split into data and envelope. */
function channelEntry(
  address: string,
  info: Dict,
  consumers: Map<string, Dict[]>,
  examples: Map<string, [string, any][]>,
): Dict {
  const consuming = consumers.get(address) ?? [];
  const messages: Dict[] = [];
  for (const [msgName, message] of info.messages as [string, Dict][]) {
    const payload: Dict = message.payload ?? {};
    const props: Dict = payload.properties ?? {};
    const data: Dict = props.data ?? {};
    const envelope = Object.fromEntries(
      Object.entries(props).filter(([k]) => k !== "data"),
    );
    messages.push({
      name: msgName,
      title: message.title ?? "",
      event_type: (props.type ?? {}).const ?? null,
      data_rows: flattenSchema(data.properties ?? {}, data.required ?? []),
      envelope_rows: flattenSchema(envelope, payload.required ?? []),
    });
  }
  return {
    address,
    producer: info.service,
    producer_title: info.title,
    artifact_path: info.artifact_path,
    artifact_version: info.artifact_version,
    description: info.description,
    consumers: consuming.map((c) => c.name),
    sequence_mermaid: unfence(channelSequence(address, info, consuming)),
    messages,
    examples: (examples.get(info.op_name) ?? []).map(([caseName, payload]) => ({
      case: caseName,
      payload,
    })),
  };
}

/** Gherkin step lines as data: keyword/phase/text steps, tables, and
 * prose - the data twin of the site's step renderer. */
export function structuredSteps(blockLines: string[]): Dict[] {
  const out: Dict[] = [];
  let table: string[][] = [];
  let phase = "given";

  const flushTable = () => {
    if (table.length) {
      out.push({ table: table.map((r) => [...r]) });
      table = [];
    }
  };

  for (const raw of blockLines) {
    const line = raw.trim();
    if (line.startsWith("|")) {
      table.push(
        line
          .replace(/^\|+|\|+$/g, "")
          .split("|")
          .map((c) => c.trim()),
      );
      continue;
    }
    flushTable();
    if (!line) continue;
    const step = line.match(STEP_RE);
    if (step) {
      const [, keyword, rest] = step;
      phase = PHASES[keyword] ?? phase;
      out.push({ keyword, phase, text: rest });
    } else if (line.startsWith("Examples:")) {
      out.push({ heading: "Examples" });
    } else if (line.startsWith("#")) {
      out.push({ comment: line.replace(/^[# ]+/, "") });
    } else {
      out.push({ prose: line });
    }
  }
  flushTable();
  return out;
}

export function featureData(a: Dict, source: string): Dict {
  const [title, description, background, scenarios] = parseFeature(source);
  const prose = description.map((line) => line.trim());
  while (prose.length && !prose[0]) prose.shift();
  while (prose.length && !prose[prose.length - 1]) prose.pop();
  return {
    title: title || stem(a.path),
    description: prose,
    background: structuredSteps(background),
    scenarios: scenarios.map(([t, lines]) => ({ title: t, steps: structuredSteps(lines) })),
  };
}

/** [version, tag] for the service's release tags, oldest first. */
export function releaseTags(name: string): [string, string][] {
  const releases: [number[], string, string][] = [];
  for (const tag of gitLines("tag", "-l", `${name}/v*`)) {
    const version = tag.startsWith(`${name}/v`) ? tag.slice(`${name}/v`.length) : tag;
    const parts = version.split(".");
    if (parts.every((p) => /^\d+$/.test(p))) {
      releases.push([parts.map((p) => parseInt(p, 10)), version, tag]);
    }
  }
  releases.sort((a, b) => {
    for (let i = 0; i < Math.min(a[0].length, b[0].length); i++) {
      if (a[0][i] !== b[0][i]) return a[0][i] - b[0][i];
    }
    return a[0].length - b[0].length;
  });
  return releases.map(([, version, tag]) => [version, tag]);
}

/** Release history from <name>/v<version> tags, newest first; [] in a
 * checkout without tags (fresh scaffold, shallow clone). */
function changelogData(m: Dict): Dict[] {
  const name = m.name;
  const releases = [...releaseTags(name)].reverse();
  if (releases.length === 0) return [];

  const commits = (revRange: string): string[] => {
    const subjects = gitLines(
      "log", "--no-merges", "--format=%s", revRange, "--", `specs/${name}`,
    );
    return subjects.length ? subjects : [`no commits under specs/${name}/ in this release`];
  };

  const out: Dict[] = [];
  if (m.version && m.version !== releases[0][0]) {
    out.push({
      version: m.version,
      date: null,
      unreleased: true,
      commits: commits(`${releases[0][1]}..HEAD`),
    });
  }
  for (let i = 0; i < releases.length; i++) {
    const [version, tag] = releases[i];
    const date = gitLines("log", "-1", "--format=%cs", tag)[0] ?? null;
    const sha = gitLines("rev-parse", `${tag}^{commit}`)[0] ?? null;
    const older = i + 1 < releases.length ? releases[i + 1][1] : null;
    out.push({
      version,
      date,
      unreleased: false,
      tag,
      sha,
      commits: commits(older ? `${older}..${tag}` : tag),
    });
  }
  return out;
}

/** Per-artifact version history from the service's release tags: the
 * manifest as it stood at each tag, recording when each artifact version
 * first shipped. Pre-rename tags carry the old catalog/ tree, hence the
 * path fallback. Empty in a checkout without tags. */
function artifactHistories(m: Dict): Map<string, Dict[]> {
  const name = m.name;
  const histories = new Map<string, Dict[]>();
  for (const [serviceVersion, tag] of releaseTags(name)) {
    let manifest: Dict | null = null;
    for (const root of ["specs", "catalog"]) {
      const out = gitLines("show", `${tag}:${root}/${name}/service.yaml`);
      if (out.length) {
        manifest = (parseYamlLines(out) ?? {}) as Dict;
        break;
      }
    }
    if (!manifest || Object.keys(manifest).length === 0) continue;
    const date = gitLines("log", "-1", "--format=%cs", tag)[0] ?? null;
    for (const a of manifest.artifacts ?? []) {
      if (!a.version) continue;
      const entries = histories.get(a.path) ?? [];
      if (!entries.length || entries[entries.length - 1].version !== a.version) {
        entries.push({ version: a.version, date, service_version: serviceVersion });
      }
      histories.set(a.path, entries);
    }
  }
  return new Map([...histories].map(([p, entries]) => [p, [...entries].reverse()]));
}

import { parse as yamlParse } from "yaml";
function parseYamlLines(lines: string[]): unknown {
  return yamlParse(lines.join("\n"));
}

export function buildData(manifests: Dict[], specs: string, mocks: string): Dict {
  const [index, consumers] = channelIndex(manifests, specs);
  const surfaces = surfaceIndex(manifests, specs);

  const services: Dict[] = [];
  for (const m of manifests) {
    const name = m.name;
    const examples = loadExamples(mocks, name);
    const restExamples = loadRestExamples(mocks, name);
    const histories = artifactHistories(m);
    const artifacts: Dict[] = [];
    for (const a of m.artifacts ?? []) {
      const entry: Dict = {
        kind: a.kind,
        path: a.path,
        stem: stem(a.path),
        version: a.version ?? null,
        gated: "gated" in a && a.gated !== undefined ? a.gated : a.kind !== "doc",
        summary: a.summary ?? "",
        history: histories.get(a.path) ?? [],
      };
      const source = path.join(specs, name, a.path);
      if (a.kind === "data-contract") {
        const odcs = readYaml(source);
        entry.odcs = odcs;
        const er = odcsEr(odcs);
        if (er.length) entry.er_mermaid = unfence(er);
      } else if (a.kind === "feature") {
        entry.text = readFileSync(source, "utf-8");
        entry.feature = featureData(a, entry.text);
      } else if (a.kind === "doc") {
        entry.text = readFileSync(source, "utf-8");
        entry.label = docLabel(source, a.summary ?? "");
      }
      artifacts.push(entry);
    }

    const ops = httpOperations(m, specs, restExamples);
    const surface = surfaces.get(name) ?? { ops: [], data: [] };
    const changelog = changelogData(m);
    const released = changelog.filter((r) => !r.unreleased);
    services.push({
      name,
      title: m.title,
      version: m.version ?? null,
      domain: m.domain,
      owner: m.owner,
      summary: clean(m.summary),
      implementation_repo: m.implementationRepo ?? null,
      artifacts,
      produces: m.produces ?? [],
      consumes: m.consumes ?? [],
      operations: ops,
      data_products: (surface.data as [string, string][]).map(([s, title]) => ({
        stem: s,
        title,
      })),
      channels: (m.produces ?? [])
        .filter((address: string) => index.has(address))
        .map((address: string) => channelEntry(address, index.get(address)!, consumers, examples)),
      changelog,
      latest_release: released.length ? released[0] : null,
      ahead: changelog.length > 0 && changelog[0].unreleased,
    });
  }

  const produced: Record<string, string> = {};
  for (const m of manifests) {
    for (const address of m.produces ?? []) produced[address] = m.name;
  }
  const edges: Dict[] = [];
  const unconsumed = { ...produced };
  for (const m of manifests) {
    for (const address of m.consumes ?? []) {
      if (address in produced) {
        edges.push({ from: produced[address], channel: address, to: m.name });
        delete unconsumed[address];
      }
    }
  }
  return {
    services,
    edges,
    unconsumed: Object.entries(unconsumed)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([a, s]) => ({ channel: a, producer: s })),
  };
}

/** [label, chart] for every mermaid string in the emitted data - the
 * input `sysspec docs diagrams` validates on an Astro-site repo. The
 * system graphs are react islands, not mermaid, so they are not here. */
export function collectMermaid(data: Dict): [string, string][] {
  const charts: [string, string][] = [];
  for (const s of data.services) {
    for (const c of s.channels) {
      charts.push([`${s.name} ${c.address} sequence`, c.sequence_mermaid]);
    }
    for (const a of s.artifacts) {
      if (a.er_mermaid) charts.push([`${s.name} ${a.stem} ER`, a.er_mermaid]);
    }
  }
  return charts;
}

export function runData(specsDir: string, siteDir: string, mocksDir = "mocks"): number {
  const manifests = loadManifests(specsDir);
  if (manifests.length === 0) {
    throw new Exit(`no service manifests found under ${specsDir}/*/service.yaml`);
  }

  const data = buildData(manifests, specsDir, mocksDir);
  const dataFile = path.join(siteDir, "src", "data", "specs.json");
  mkdirSync(path.dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, pyJson(data) + "\n");

  const publicDir = path.join(siteDir, "public", "specs");
  rmSync(publicDir, { recursive: true, force: true });
  for (const m of manifests) {
    for (const a of m.artifacts ?? []) {
      const source = path.join(specsDir, m.name, a.path);
      const target = path.join(publicDir, m.name, a.path);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { preserveTimestamps: true });
    }
  }

  console.log(`emitted specs data for ${manifests.length} service(s) to ${dataFile}`);
  return 0;
}
