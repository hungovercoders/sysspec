/** Shared specs readers and chart builders for the docs pipeline.
 *
 * Everything the docs data emitter needs to see the specs whole: the
 * manifests, the channel and surface indexes, the mermaid charts (specs
 * graph, per-channel delivery sequences, ODCS ER diagrams), the gherkin
 * parser, the Microcks example loaders and the release-tag reader. The
 * mermaid gate lives here too: `check_diagrams` parses every chart -
 * fences in ungated doc sources and generated markdown, plus each chart
 * string `sysspec docs data` emits - headlessly with mermaid-cli, so a
 * syntax error lands in CI instead of a viewer's browser.
 */

import {
  accessSync,
  constants,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { MERMAID_CLI } from "./pins.js";
import { clean, gitLines, isDir, isFile, run, splitLines } from "./util.js";

export { clean, gitLines };

export type Dict = Record<string, any>;

export function readYaml(file: string): Dict {
  return (parse(readFileSync(file, "utf-8")) ?? {}) as Dict;
}

/** First executable named cmd on PATH, or null. Searched in-process:
 * shelling out to `which` fails on systems that do not ship it. */
export function which(cmd: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here - keep looking
      }
    }
  }
  return null;
}

export function loadManifests(specs: string): Dict[] {
  if (!isDir(specs)) return [];
  return readdirSync(specs)
    .sort()
    .map((d) => path.join(specs, d, "service.yaml"))
    .filter(isFile)
    .map(readYaml);
}

/** The suite's system manifest, if the repo declares one.
 *
 * `<specs>/system.yaml` names the system the services belong to - its
 * title, business domain and event namespace. It is what makes one
 * generated catalog recognisably *this* instance rather than a generic
 * "System specs". Optional: repos scaffolded before it existed, and
 * anyone who deletes it, render the generic wording instead.
 */
export function loadSystem(specs: string): Dict | null {
  const file = path.join(specs, "system.yaml");
  return isFile(file) ? readYaml(file) : null;
}

/** A mermaid-safe node id. */
export function nodeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Producer-side index of every published channel, plus its consumers.
 *
 * Returns [index, consumers]: index maps a channel address to the
 * producing service and the message schemas its AsyncAPI publishes on
 * it; consumers maps an address to the manifests that list it under
 * `consumes`. lint:manifest guarantees produces/consumes resolve, so
 * pages degrade gracefully rather than fail on a gap.
 */
export function channelIndex(
  manifests: Dict[],
  specs: string,
): [Map<string, Dict>, Map<string, Dict[]>] {
  const index = new Map<string, Dict>();
  for (const m of manifests) {
    for (const a of m.artifacts ?? []) {
      if (a.kind !== "asyncapi") continue;
      const doc = readYaml(path.join(specs, m.name, a.path));
      const channels: Dict = doc.channels ?? {};
      const messages: Dict = doc.components?.messages ?? {};
      for (const [opKey, op] of Object.entries<Dict>(doc.operations ?? {})) {
        // Producer-keyed by design: `receive` operations are not indexed
        // (a consumed channel renders via its producer; modeling
        // external producers is a deliberate non-goal for now).
        if (op?.action !== "send") continue;
        const chanKey = String(op?.channel?.$ref ?? "").split("/").pop() ?? "";
        const channel: Dict = channels[chanKey] ?? {};
        const address = channel.address;
        if (!address) continue;
        // `doc` rides along (never serialized) so consumers can deref
        // $ref message payloads against the full document.
        index.set(address, {
          service: m.name,
          title: m.title,
          artifact_path: a.path,
          artifact_version: a.version ?? null,
          op_name: opKey,
          description: clean(op.description ?? ""),
          doc,
          messages: Object.keys(channel.messages ?? {}).map((name) => [
            name,
            messages[name] ?? {},
          ]),
        });
      }
    }
  }
  const consumers = new Map<string, Dict[]>();
  for (const m of manifests) {
    for (const address of m.consumes ?? []) {
      const list = consumers.get(address) ?? [];
      list.push(m);
      consumers.set(address, list);
    }
  }
  return [index, consumers];
}

/** Per-service HTTP operations and data products, for the graph views
 * and overview lists. */
export function surfaceIndex(manifests: Dict[], specs: string): Map<string, Dict> {
  const out = new Map<string, Dict>();
  for (const m of manifests) {
    const ops: [string, string, string][] = [];
    const data: [string, string][] = [];
    for (const a of m.artifacts ?? []) {
      const file = path.join(specs, m.name, a.path);
      if (a.kind === "openapi") {
        const doc = readYaml(file);
        for (const [path_, methods] of Object.entries<Dict>(doc.paths ?? {})) {
          for (const [method, op] of Object.entries<Dict>(methods ?? {})) {
            if (["get", "post", "put", "patch", "delete"].includes(method)) {
              const opId = op.operationId || `${method} ${path_}`;
              ops.push([opId, method, path_]);
            }
          }
        }
      } else if (a.kind === "data-contract") {
        const odcs = readYaml(file);
        const stem = path.basename(a.path).replace(/\.[^.]*$/, "");
        data.push([stem, odcs.name ?? stem]);
      }
    }
    out.set(m.name, { ops, data });
  }
  return out;
}

/** Example payloads per send operation from <mocks>/<service>.events.examples.yaml.
 *
 * Anything missing - the directory, the file, the keys - yields {}:
 * a specs without Microcks examples still documents its messages,
 * just without the example blocks.
 */
export function loadExamples(mocksDir: string, service: string): Map<string, [string, any][]> {
  const file = path.join(mocksDir, `${service}.events.examples.yaml`);
  const examples = new Map<string, [string, any][]>();
  if (!isFile(file)) return examples;
  const doc = readYaml(file);
  for (const [opKey, cases] of Object.entries<Dict>(doc.operations ?? {})) {
    const op = opKey.split(/\s+/).pop()!;
    for (const [caseName, body] of Object.entries<Dict>(cases ?? {})) {
      const payload = body?.eventMessage?.payload;
      if (payload) {
        const list = examples.get(op) ?? [];
        list.push([caseName, payload]);
        examples.set(op, list);
      }
    }
  }
  return examples;
}

/** Example exchanges per 'METHOD /path' from <mocks>/<service>.rest.examples.yaml.
 *
 * Same silent fallback as loadExamples: no file, no examples.
 */
export function loadRestExamples(
  mocksDir: string,
  service: string,
): Map<string, [string, any, any, any][]> {
  const file = path.join(mocksDir, `${service}.rest.examples.yaml`);
  const examples = new Map<string, [string, any, any, any][]>();
  if (!isFile(file)) return examples;
  const doc = readYaml(file);
  for (const [opKey, cases] of Object.entries<Dict>(doc.operations ?? {})) {
    for (const [caseName, body] of Object.entries<Dict>(cases ?? {})) {
      const request: Dict = body?.request ?? {};
      const response: Dict = body?.response ?? {};
      const list = examples.get(opKey) ?? [];
      list.push([caseName, request.body ?? null, response.status ?? null, response.body ?? null]);
      examples.set(opKey, list);
    }
  }
  return examples;
}

/** Resolve a local '#/...' $ref chain against the spec document. */
export function deref(doc: Dict, schema: Dict): Dict {
  for (let i = 0; i < 10; i++) {
    const ref: string = (schema ?? {}).$ref ?? "";
    if (!ref.startsWith("#/")) break;
    let target: Dict = doc;
    for (const part of ref.slice(2).split("/")) {
      target = (target ?? {})[part] ?? {};
    }
    schema = target;
  }
  return schema ?? {};
}

export function jsonBodySchema(doc: Dict, holder: Dict): Dict {
  const content: Dict = (holder ?? {}).content ?? {};
  return deref(doc, (content["application/json"] ?? {}).schema ?? {});
}

/** Mermaid label text: the separators that would end a label early. */
function mermaidLabel(text: string): string {
  return String(text).replace(/[\r\n]+/g, " ").replace(/[;#]/g, " ").trim();
}

/** One channel's delivery as a fenced sequence diagram.
 *
 * The producer publishes each message to the channel (solid arrow); the
 * channel fans it out to every consumer (dotted). Steps are numbered so
 * prose can cite them, the CloudEvents type rides under each publish -
 * the thing a consumer actually filters on - and two or more consumers
 * are boxed as the fan-out. A note stands in when there is none yet.
 *
 * `messages` carries the normalized [name, event type] pairs; without it
 * the names fall back to the raw channel index.
 */
export function channelSequence(
  address: string,
  info: Dict,
  consuming: Dict[],
  messages: Dict[] | null = null,
): string[] {
  const producer = nodeId(info.service);
  const msgs: Dict[] =
    messages ?? (info.messages as [string, Dict][]).map(([name]) => ({ name, event_type: null }));
  const lines = [
    "```mermaid",
    "sequenceDiagram",
    "    autonumber",
    `    participant ${producer} as ${mermaidLabel(info.title)}`,
    `    participant chan as ${mermaidLabel(address)}`,
  ];
  // A box earns its keep only as a fan-out: one consumer reads as itself.
  const boxed = consuming.length > 1;
  if (boxed) lines.push("    box transparent Consumers");
  for (const c of consuming) {
    lines.push(`    participant ${nodeId(c.name)} as ${mermaidLabel(c.title)}`);
  }
  if (boxed) lines.push("    end");
  for (const m of msgs) {
    lines.push(`    ${producer}-)chan: ${mermaidLabel(m.name)}`);
    if (m.event_type) lines.push(`    Note right of chan: ${mermaidLabel(m.event_type)}`);
    for (const c of consuming) {
      lines.push(`    chan--)${nodeId(c.name)}: ${mermaidLabel(m.name)}`);
    }
  }
  if (consuming.length === 0) {
    lines.push("    Note over chan: no consumer in the specs yet");
  }
  lines.push("```");
  return lines;
}

/** An ER attribute comment: markers first, then the prose, clipped.
 *
 * Mermaid comments are double-quoted and single-line, so quotes become
 * typographic ones and the description is trimmed to a width that keeps
 * the entity box readable next to its neighbours.
 */
function erComment(p: Dict): string {
  const markers: string[] = [];
  let text = clean(String(p.description ?? "")).replace(/[\r\n]+/g, " ").replace(/"/g, "'");
  // A marker the prose already makes is noise, not signal.
  if (p.partitioned && !/partition/i.test(text)) markers.push("partition key");
  if (p.required !== true && !/optional/i.test(text)) markers.push("optional");
  if (text.length > 64) text = text.slice(0, 63).trimEnd() + "…";
  const parts = [...markers, text].filter(Boolean);
  return parts.join(" · ");
}

/** One declared relationship, resolved far enough to draw.
 *
 * ODCS 3.2 writes a reference either as shorthand (`table.column`) or
 * fully qualified (`section/id/properties/id`), optionally prefixed by
 * another contract file. Only the tail matters for the diagram: which
 * object, which column, and - when the target is in another file - which
 * contract it belongs to.
 */
export interface OdcsRef {
  file: string | null;
  object: string;
  property: string | null;
}

export function parseOdcsRef(ref: string): OdcsRef | null {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  const hash = text.indexOf("#");
  const file = hash === -1 ? null : text.slice(0, hash) || null;
  const target = hash === -1 ? text : text.slice(hash + 1);
  const parts = target.split("/").filter(Boolean);
  if (parts.length > 1) {
    // Fully qualified: schema/<object>[/properties/<property>].
    const object = parts[1] ?? null;
    const at = parts.indexOf("properties");
    const property = at === -1 ? null : (parts[at + 1] ?? null);
    return object ? { file, object, property } : null;
  }
  // Shorthand: <object>.<column>, dotted, no slashes.
  const dotted = parts[0]?.split(".") ?? [];
  if (dotted.length < 2) return null;
  return { file, object: dotted[0], property: dotted[dotted.length - 1] };
}

/** Every relationship in the document, as [fromObject, fromProperty, ref].
 *
 * A reference may name an object by either its logical `name` or its
 * `physicalName`; entity boxes are drawn under the physical one, so both
 * spellings resolve to that to keep one table from becoming two.
 */
function odcsRelationships(odcs: Dict): [string, string | null, OdcsRef][] {
  const boxes = new Map<string, string>();
  for (const obj of odcs.schema ?? []) {
    const box = String(obj.physicalName ?? obj.name);
    boxes.set(String(obj.name), box);
    boxes.set(box, box);
  }
  const box = (name: string) => boxes.get(name) ?? name;
  const found: [string, string | null, OdcsRef][] = [];
  for (const obj of odcs.schema ?? []) {
    const objectName = String(obj.physicalName ?? obj.name);
    for (const rel of obj.relationships ?? []) {
      // Schema level names both ends; a composite key lists several, and
      // the diagram draws one edge per pair.
      const froms = Array.isArray(rel.from) ? rel.from : [rel.from];
      const tos = Array.isArray(rel.to) ? rel.to : [rel.to];
      for (let i = 0; i < tos.length; i++) {
        const to = parseOdcsRef(tos[i]);
        if (!to) continue;
        const from = parseOdcsRef(froms[i] ?? froms[0] ?? "");
        const target = to.file ? to : { ...to, object: box(to.object) };
        found.push([box(from?.object ?? objectName), from?.property ?? null, target]);
      }
    }
    for (const p of obj.properties ?? []) {
      for (const rel of p.relationships ?? []) {
        for (const to of Array.isArray(rel.to) ? rel.to : [rel.to]) {
          const target = parseOdcsRef(to);
          if (!target) continue;
          found.push([
            objectName,
            String(p.name),
            target.file ? target : { ...target, object: box(target.object) },
          ]);
        }
      }
    }
  }
  return found;
}

/** A foreign contract's file path, reduced to something readable in a box. */
function foreignLabel(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.(odcs\.)?ya?ml$/i, "");
}

/** The contract's schema objects as a fenced mermaid ER diagram.
 *
 * One entity per object, top-level properties only: logical type,
 * PK/UK markers, and the property's own description as the attribute
 * comment, so the shape carries its meaning rather than just its names.
 * Nesting and constraints stay in the field tables below. Empty when
 * nothing would show.
 *
 * Declared `relationships` (ODCS 3.2) become the edges. One that points
 * into another contract draws an empty stub entity named for that file,
 * so the lineage shows without the diagram pretending to own a table it
 * does not describe.
 */
export function odcsEr(odcs: Dict): string[] {
  const entities: [string, string[]][] = [];
  for (const obj of odcs.schema ?? []) {
    const rows: string[] = [];
    for (const p of obj.properties ?? []) {
      const type = nodeId(String(p.logicalType ?? "unknown"));
      const key = p.primaryKey ? "PK" : p.unique ? "UK" : "";
      const comment = erComment(p);
      const cells = [type, p.name, key, comment && `"${comment}"`].filter(Boolean);
      rows.push(`        ${cells.join(" ")}`);
    }
    if (rows.length) entities.push([obj.physicalName ?? obj.name, rows]);
  }
  if (entities.length === 0) return [];
  const lines = ["```mermaid", "erDiagram"];
  for (const [entity, rows] of entities) {
    lines.push(`    ${nodeId(String(entity))} {`, ...rows, "    }");
  }

  const stubs = new Map<string, string[]>();
  const edges: string[] = [];
  for (const [from, property, to] of odcsRelationships(odcs)) {
    const target = to.file ? `${foreignLabel(to.file)}_${to.object}` : to.object;
    if (to.file) {
      const rows = stubs.get(target) ?? [];
      const row = `        key ${to.property ?? "id"} "in ${foreignLabel(to.file)}"`;
      if (!rows.includes(row)) rows.push(row);
      stubs.set(target, rows);
    }
    const label = [to.property, to.file && "external"].filter(Boolean).join(" · ");
    // Many-to-one: a foreign key is the many side by construction.
    edges.push(`    ${nodeId(target)} ||--o{ ${nodeId(String(from))} : "${label || property || "references"}"`);
  }
  for (const stub of [...stubs.keys()].sort()) {
    lines.push(`    ${nodeId(stub)} {`, ...stubs.get(stub)!, "    }");
  }
  lines.push(...edges);
  lines.push("```");
  return lines;
}

export const STEP_RE = /^(Given|When|Then|And|But|\*)\s+(.+)$/;
const SCENARIO_RE = /^[ \t]*(?:Scenario Outline|Scenario):[ \t]*(.+)$/;
export const PHASES: Record<string, string> = { Given: "given", When: "when", Then: "then" };

/** [title, description lines, background lines, [scenario title, lines][]] */
export function parseFeature(
  text: string,
): [string, string[], string[], [string, string[]][]] {
  let title = "";
  const description: string[] = [];
  const background: string[] = [];
  const scenarios: [string, string[]][] = [];
  let section: string[] | null = null;
  for (const raw of splitLines(text)) {
    const line = raw.trim();
    let match: RegExpMatchArray | null;
    if (line.startsWith("Feature:")) {
      title = line.slice("Feature:".length).trim();
      section = description;
    } else if (line.startsWith("Background:")) {
      section = background;
    } else if ((match = raw.match(SCENARIO_RE))) {
      scenarios.push([match[1].trim(), []]);
      section = scenarios[scenarios.length - 1][1];
    } else if (section !== null) {
      section.push(raw);
    }
  }
  return [title, description, background, scenarios];
}

/** Nav label for an ungated doc: its own H1, else the summary, else the stem. */
export function docLabel(src: string, summary: string): string {
  for (const line of splitLines(readFileSync(src, "utf-8"))) {
    const match = line.match(/^#\s+(.+)/);
    if (match) return match[1].trim();
  }
  return summary ? clean(summary).replace(/\.+$/, "") : path.basename(src).replace(/\.[^.]*$/, "");
}

const MERMAID_FENCE = /^```mermaid\n([\s\S]*?)^```/gm;

function rglobMd(dir: string): string[] {
  const out: string[] = [];
  if (!isDir(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rglobMd(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out.sort();
}

/** [file, line, source] for every mermaid fence the site will render:
 * any generated pages, plus the ungated doc sources the site renders
 * (an ADR's diagram breaks the page just as surely as a generated one). */
export function mermaidBlocks(specs: string, docs: string): [string, number, string][] {
  // docs/specs symlinks into the source tree; its .md files are
  // covered by the explicit source glob below.
  const specsSub = path.join(docs, "specs") + path.sep;
  const pages = rglobMd(docs).filter((p) => !p.startsWith(specsSub));
  const sources: string[] = [];
  if (isDir(specs)) {
    for (const d of readdirSync(specs).sort()) {
      const docsDir = path.join(specs, d, "docs");
      if (!isDir(docsDir)) continue;
      for (const f of readdirSync(docsDir).sort()) {
        if (f.endsWith(".md")) sources.push(path.join(docsDir, f));
      }
    }
  }
  const blocks: [string, number, string][] = [];
  for (const f of [...pages, ...sources]) {
    const text = readFileSync(f, "utf-8");
    for (const match of text.matchAll(MERMAID_FENCE)) {
      const line = text.slice(0, match.index).split("\n").length;
      blocks.push([f, line, match[1]]);
    }
  }
  return blocks;
}

/** [puppeteer launch config, environment] for a mermaid-cli run. A
 * system Chrome is reused when one is found (and puppeteer's own browser
 * download is skipped); otherwise puppeteer fetches its own. */
export function browserEnv(): [Dict, NodeJS.ProcessEnv] {
  const env = { ...process.env };
  const config: Dict = { args: ["--no-sandbox", "--disable-gpu"] };
  let chrome = env.PUPPETEER_EXECUTABLE_PATH || null;
  if (!chrome) {
    for (const c of ["google-chrome", "chromium-browser", "chromium", "chrome"]) {
      chrome = which(c);
      if (chrome) break;
    }
  }
  if (chrome) {
    config.executablePath = chrome;
    env.PUPPETEER_SKIP_DOWNLOAD = "1";
  }
  return [config, env];
}

/** Parse every mermaid diagram with mermaid-cli.
 *
 * Static builds never parse mermaid - a syntax error only surfaces in
 * the viewer's browser, as raw diagram source. This gate renders each
 * chart headlessly so that failure lands in CI instead: the fences in
 * ungated doc sources (and any generated markdown), plus every chart
 * string `sysspec docs data` emitted when the site's specs.json is
 * present.
 */
export async function checkDiagrams(
  specsDir: string,
  docsDir: string,
  siteDir = "docs-site",
): Promise<number> {
  const blocks = mermaidBlocks(specsDir, docsDir);
  const dataFile = path.join(siteDir, "src", "data", "specs.json");
  if (isFile(dataFile)) {
    const { collectMermaid } = await import("./docs-data.js");
    const data = JSON.parse(readFileSync(dataFile, "utf-8"));
    for (const [label, chart] of collectMermaid(data)) {
      blocks.push([`${dataFile} (${label})`, 0, chart]);
    }
  }
  if (blocks.length === 0) {
    console.log("no mermaid diagrams found");
    return 0;
  }

  const [config, env] = browserEnv();
  let failures = 0;
  const tmp = mkdtempSync(path.join(tmpdir(), "sysspec-mmd-"));
  try {
    const configFile = path.join(tmp, "puppeteer.json");
    writeFileSync(configFile, JSON.stringify(config));
    const mmdc = (input: string, output: string) =>
      run(
        [
          "npx", "-y", MERMAID_CLI, "--quiet",
          "--puppeteerConfigFile", configFile,
          "--input", input, "--output", output,
        ],
        { env },
      );

    // One headless browser for every diagram: mermaid-cli renders each
    // fence of a markdown input in turn. Only when that batch fails is it
    // worth one launch per diagram, to say which one broke and why.
    const batch = path.join(tmp, "all.md");
    writeFileSync(batch, blocks.map(([, , source]) => "```mermaid\n" + source + "\n```\n").join("\n"));
    if (mmdc(batch, path.join(tmp, "all-out.md")).status === 0) {
      for (const [f, line] of blocks) console.log(`mermaid ok: ${f}:${line}`);
    } else {
      for (const [f, line, source] of blocks) {
        const mmd = path.join(tmp, "diagram.mmd");
        writeFileSync(mmd, source);
        const res = mmdc(mmd, path.join(tmp, "diagram.svg"));
        if (res.status !== 0) {
          failures += 1;
          const detail = (res.stderr || res.stdout).trim();
          console.error(`mermaid FAILED: ${f}:${line}\n${detail}\n`);
        } else {
          console.log(`mermaid ok: ${f}:${line}`);
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`\n${failures} of ${blocks.length} diagram(s) failed to parse.`);
    return 1;
  }
  console.log(`\n${blocks.length} diagram(s) parsed.`);
  return 0;
}
