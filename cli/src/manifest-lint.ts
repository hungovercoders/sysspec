/** Cross-check every service manifest against its contracts and the specs graph.
 *
 * Per service:
 *   0. `name` must equal the service directory name (docs and mocks join
 *      paths from either), and `summary` must be a non-empty string.
 *   1. `produces` must exactly match the channel addresses its AsyncAPI files
 *      publish with a `send` operation; documented `receive` channels must be
 *      listed in `consumes`.
 *   2. Every `consumes` entry must be produced by some service in the specs,
 *      and no channel may be produced by more than one service.
 *   3. Every declared artifact path must exist on disk, and every file of a
 *      gated kind on disk must be declared in the manifest.
 *   4. For asyncapi/openapi artifacts, the spec's `info.version` must equal the
 *      manifest version (mock URLs and rendered docs surface `info.version`).
 *   5. Feature files may only reference messages the service owns or consumes
 *      (quoted PascalCase tokens) and channels it produces or consumes (quoted
 *      dotted addresses) - scenarios about phantom events are rot.
 *   6. For data contracts, the ODCS `version` must equal the manifest version,
 *      and every declared relationship (ODCS 3.2 foreign keys) must resolve -
 *      inside the document, or in the contract file it names.
 *
 * Suite-wide: the optional `<specs>/system.yaml` - the annotation every
 * generated catalog page carries - must be complete when it exists.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { pyRepr, pySorted } from "./util.js";

const KIND_DIRS: [string, string][] = [
  ["asyncapi", "asyncapi"],
  ["openapi", "openapi"],
  ["data-contract", "data-contracts"],
  ["feature", "features"],
];
const SPEC_SUFFIXES = new Set([".yaml", ".yml", ".feature"]);

// Quoted PascalCase with at least two humps: "OrderPlaced" but not "Placed",
// "SKU-RED" or "c-1001". Quoted dotted address ending .v<major>.
const MESSAGE_RE = /"([A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)"/g;
const CHANNEL_RE = /"([a-z0-9]+(?:\.[a-z0-9-]+)*\.v\d+)"/g;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function serviceDirs(specsDir: string): string[] {
  if (!isDir(specsDir)) return [];
  return readdirSync(specsDir)
    .sort()
    .map((d) => path.join(specsDir, d))
    .filter((d) => isFile(path.join(d, "service.yaml")));
}

function globYaml(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function readYaml(file: string): Record<string, any> {
  return (parse(readFileSync(file, "utf-8")) ?? {}) as Record<string, any>;
}

function findAll(re: RegExp, text: string): Set<string> {
  return new Set([...text.matchAll(re)].map((m) => m[1]));
}

/** [channel address -> message names on it, service name -> own message names] */
function messageIndex(
  dirs: string[],
): [Map<string, Set<string>>, Map<string, Set<string>>] {
  const byAddress = new Map<string, Set<string>>();
  const own = new Map<string, Set<string>>();
  for (const d of dirs) {
    const names = new Set<string>();
    for (const spec of globYaml(path.join(d, "asyncapi"))) {
      const doc = readYaml(spec);
      for (const name of Object.keys(doc.components?.messages ?? {})) names.add(name);
      for (const channel of Object.values(doc.channels ?? {}) as any[]) {
        const address = channel?.address;
        if (address) {
          const set = byAddress.get(address) ?? new Set<string>();
          for (const msg of Object.keys(channel?.messages ?? {})) set.add(msg);
          byAddress.set(address, set);
        }
      }
    }
    own.set(path.basename(d), names);
  }
  return [byAddress, own];
}

/** [sent, received] channel addresses of an AsyncAPI 3 document. */
export function channelOps(doc: Record<string, any>): [Set<string>, Set<string>] {
  const channels = doc.channels ?? {};
  const sent = new Set<string>();
  const received = new Set<string>();
  for (const op of Object.values(doc.operations ?? {}) as any[]) {
    const ref: string = op?.channel?.$ref ?? "";
    const key = ref.split("/").pop() ?? "";
    const address = channels[key]?.address;
    if (!address) continue;
    if (op?.action === "send") sent.add(address);
    else if (op?.action === "receive") received.add(address);
  }
  return [sent, received];
}

const ORG_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MCP_URL_RE = /^https?:\/\/[^\s]+$/;

/** Resolve one ODCS relationship reference inside a contract document.
 *
 * Shorthand (`object.column`) resolves by `name`; the fully qualified
 * form (`schema/<id>/properties/<id>`) resolves by `id`, which is what
 * makes it survive a rename. Returns null when it resolves, or the
 * reason it does not.
 */
export function resolveOdcsTarget(doc: Record<string, any>, ref: string): string | null {
  const parts = ref.split("/").filter(Boolean);
  const qualified = parts.length > 1;
  const objects: any[] = doc.schema ?? [];
  const objectKey = qualified ? parts[1] : ref.split(".")[0];
  const obj = objects.find((o) => String(qualified ? o?.id ?? "" : o?.name ?? "") === objectKey);
  if (!obj) {
    return qualified && objects.some((o) => String(o?.name ?? "") === objectKey)
      ? `object '${objectKey}' is referenced by id but declares only a name - add 'id: ${objectKey}'`
      : `object '${objectKey}' does not exist`;
  }
  const at = qualified ? parts.indexOf("properties") : -1;
  const propertyKey = qualified
    ? at === -1
      ? null
      : parts[at + 1]
    : (ref.split(".")[1] ?? null);
  if (!propertyKey) return null;
  const properties: any[] = obj.properties ?? [];
  const found = properties.some(
    (p) => String(qualified ? p?.id ?? "" : p?.name ?? "") === propertyKey,
  );
  if (found) return null;
  return qualified && properties.some((p) => String(p?.name ?? "") === propertyKey)
    ? `property '${objectKey}.${propertyKey}' is referenced by id but declares only a name - add 'id: ${propertyKey}'`
    : `property '${objectKey}.${propertyKey}' does not exist`;
}

/** Every unresolvable relationship in one data contract.
 *
 * A declared foreign key is a promise about two columns; if either end
 * does not exist, the promise is decoration. Remote (http) targets are
 * skipped - a gate that needs the network to agree with itself is not a
 * gate - everything else must resolve on disk.
 */
export function relationshipProblems(doc: Record<string, any>, file: string): string[] {
  const problems: string[] = [];
  const cache = new Map<string, Record<string, any> | null>();
  const load = (target: string): Record<string, any> | null => {
    if (!cache.has(target)) {
      cache.set(target, isFile(target) ? readYaml(target) : null);
    }
    return cache.get(target) ?? null;
  };

  const check = (rel: Record<string, any>, ends: [string, unknown][]) => {
    for (const [side, value] of ends) {
      for (const ref of ([] as unknown[]).concat(value ?? [])) {
        const text = String(ref ?? "").trim();
        if (!text) continue;
        if (/^https?:\/\//.test(text)) continue;
        const [maybeFile, pointer] = text.includes("#") ? text.split("#") : [null, text];
        let doc2 = doc;
        if (maybeFile) {
          const resolved = path.resolve(path.dirname(file), maybeFile);
          const loaded = load(resolved);
          if (!loaded) {
            problems.push(`relationship ${side} '${text}': no contract at ${maybeFile}`);
            continue;
          }
          doc2 = loaded;
        }
        const problem = resolveOdcsTarget(doc2, pointer);
        if (problem) problems.push(`relationship ${side} '${text}': ${problem}`);
      }
    }
    const from = rel.from;
    const to = rel.to;
    if (Array.isArray(from) !== Array.isArray(to) && from !== undefined) {
      problems.push(`relationship '${rel.id ?? to}': from and to must both be single or both be lists`);
    } else if (Array.isArray(from) && Array.isArray(to) && from.length !== to.length) {
      problems.push(`relationship '${rel.id ?? "composite"}': from and to list different numbers of columns`);
    }
  };

  for (const obj of doc.schema ?? []) {
    for (const rel of obj.relationships ?? []) {
      if (rel?.from === undefined) {
        problems.push(`relationship '${rel?.id ?? rel?.to}': a schema-level relationship needs 'from'`);
      }
      check(rel ?? {}, [
        ["from", rel?.from],
        ["to", rel?.to],
      ]);
    }
    for (const p of obj.properties ?? []) {
      for (const rel of p.relationships ?? []) {
        if (rel?.from !== undefined) {
          problems.push(
            `relationship '${rel?.id ?? rel?.to}': 'from' is implicit on a property-level relationship`,
          );
        }
        check(rel ?? {}, [["to", rel?.to]]);
      }
    }
  }
  return problems;
}

/** The optional suite-level system manifest.
 *
 * Absent is fine (the catalog falls back to generic wording), but a
 * half-filled one is not: an instance that claims a system must say
 * which one, in which domain, so its catalog is unmistakably its own.
 * `mcp` is the one genuinely optional field: the hosted endpoint these
 * specs answer questions on, checked for shape when it is there.
 */
export function lintSystem(specsDir: string): string[] {
  const file = path.join(specsDir, "system.yaml");
  if (!isFile(file)) return [];
  const manifest = readYaml(file);
  const problems: string[] = [];
  const where = path.join(specsDir, "system.yaml");
  if (manifest.kind !== "System") {
    problems.push(`${where}: kind must be 'System', got ${pyRepr(manifest.kind ?? null)}`);
  }
  if (manifest.apiVersion !== "sysspec/v1") {
    problems.push(
      `${where}: apiVersion must be 'sysspec/v1', got ${pyRepr(manifest.apiVersion ?? null)}`,
    );
  }
  for (const field of ["name", "title", "domain"]) {
    const value = manifest[field];
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`${where}: ${field} is required and must be a non-empty string`);
    }
  }
  if (typeof manifest.name === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    problems.push(`${where}: name must be lower-kebab-case, got ${pyRepr(manifest.name)}`);
  }
  const org = manifest.org;
  if (org !== undefined && org !== null && !ORG_RE.test(String(org))) {
    problems.push(`${where}: org must be reverse-DNS (e.g. com.acme), got ${pyRepr(String(org))}`);
  }
  // Optional: where these specs answer questions over MCP. Absent means
  // the catalog shows the local stdio route only; present, it hands
  // readers a URL they can paste into a client.
  const mcp = manifest.mcp;
  if (mcp !== undefined && mcp !== null && !MCP_URL_RE.test(String(mcp).trim())) {
    problems.push(
      `${where}: mcp must be the http(s) URL of the MCP endpoint, got ${pyRepr(String(mcp))}`,
    );
  }
  return problems;
}

function lintService(
  serviceDir: string,
  producedBy: Map<string, Set<string>>,
  messagesByAddress: Map<string, Set<string>>,
  ownMessages: Map<string, Set<string>>,
): string[] {
  const problems: string[] = [];
  const manifest = readYaml(path.join(serviceDir, "service.yaml"));
  const name = manifest.name;
  const artifacts: any[] = manifest.artifacts ?? [];

  const dirName = path.basename(serviceDir);
  if (name !== dirName) {
    problems.push(
      `${dirName}: manifest name ${pyRepr(name ?? null)} must equal its directory name ` +
        `${pyRepr(dirName)}`,
    );
  }
  if (typeof manifest.summary !== "string" || !manifest.summary.trim()) {
    problems.push(`${name}: summary is required and must be a non-empty string`);
  }

  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ? String(version) : "")) {
    problems.push(`${name}: manifest needs a top-level semver version, got ${pyRepr(version ?? null)}`);
  }

  const declared = new Set(artifacts.map((a) => a.path));
  let sent = new Set<string>();
  let received = new Set<string>();

  for (const a of artifacts) {
    const file = path.join(serviceDir, a.path);
    if (!isFile(file)) {
      problems.push(`${name}: declared artifact missing on disk: ${a.path}`);
      continue;
    }
    if (a.kind === "asyncapi" || a.kind === "openapi") {
      const doc = readYaml(file);
      const specVersion = doc.info?.version;
      if (String(specVersion) !== String(a.version)) {
        problems.push(
          `${name}: ${a.path} info.version ${specVersion} != manifest version ${a.version}`,
        );
      }
      if (a.kind === "asyncapi") {
        const [s, r] = channelOps(doc);
        sent = new Set([...sent, ...s]);
        received = new Set([...received, ...r]);
      }
    }
    if (a.kind === "data-contract") {
      const doc = readYaml(file);
      if (String(doc.version) !== String(a.version)) {
        problems.push(
          `${name}: ${a.path} version ${doc.version} != manifest version ${a.version}`,
        );
      }
      for (const problem of relationshipProblems(doc, file)) {
        problems.push(`${name}: ${a.path} ${problem}`);
      }
    }
  }

  for (const [kind, subdir] of KIND_DIRS) {
    const dir = path.join(serviceDir, subdir);
    if (!isDir(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const rel = path.join(subdir, f);
      if (SPEC_SUFFIXES.has(path.extname(f)) && !declared.has(rel)) {
        problems.push(`${name}: ${kind} file on disk but not in manifest: ${rel}`);
      }
    }
  }

  const repo = manifest.implementationRepo;
  if (repo !== undefined && repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) {
    problems.push(`${name}: implementationRepo must be <owner>/<repo>, got ${pyRepr(String(repo))}`);
  }

  const producesList: string[] = manifest.produces ?? [];
  for (const address of pySorted(new Set(producesList.filter((a, i) => producesList.indexOf(a) !== i)))) {
    problems.push(`${name}: lists '${address}' in produces more than once`);
  }
  const produces = new Set<string>(producesList);
  const consumes = new Set<string>(manifest.consumes ?? []);

  for (const address of pySorted([...produces].filter((a) => !sent.has(a)))) {
    problems.push(`${name}: produces '${address}' but no AsyncAPI send operation publishes it`);
  }
  for (const address of pySorted([...sent].filter((a) => !produces.has(a)))) {
    problems.push(
      `${name}: AsyncAPI sends '${address}' but the manifest does not list it in produces`,
    );
  }
  for (const address of pySorted([...received].filter((a) => !consumes.has(a)))) {
    problems.push(
      `${name}: AsyncAPI receives '${address}' but the manifest does not list it in consumes`,
    );
  }
  for (const address of pySorted(consumes)) {
    if (!producedBy.has(address)) {
      problems.push(`${name}: consumes '${address}' but no service produces it`);
    }
  }
  // One channel, one owner: two producers make the channel's schema a
  // negotiation and trace_channel's answer a coin toss.
  for (const address of pySorted(produces)) {
    const others = [...(producedBy.get(address) ?? [])].filter((o) => o !== name);
    if (others.length) {
      problems.push(
        `${name}: produces '${address}', which is also produced by ` +
          pySorted(others).join(", ") +
          " - a channel has exactly one producer",
      );
    }
  }

  const allowedMessages = new Set(ownMessages.get(path.basename(serviceDir)) ?? []);
  for (const address of consumes) {
    for (const msg of messagesByAddress.get(address) ?? []) allowedMessages.add(msg);
  }
  const allowedChannels = new Set([...produces, ...consumes]);

  const featuresDir = path.join(serviceDir, "features");
  const featureFiles = isDir(featuresDir)
    ? readdirSync(featuresDir)
        .filter((f) => f.endsWith(".feature"))
        .sort()
    : [];
  for (const f of featureFiles) {
    const rel = path.join("features", f);
    const text = readFileSync(path.join(featuresDir, f), "utf-8");
    for (const token of pySorted([...findAll(MESSAGE_RE, text)].filter((t) => !allowedMessages.has(t)))) {
      problems.push(
        `${name}: ${rel} references message "${token}" which no owned ` +
          "or consumed AsyncAPI channel defines",
      );
    }
    for (const token of pySorted([...findAll(CHANNEL_RE, text)].filter((t) => !allowedChannels.has(t)))) {
      problems.push(
        `${name}: ${rel} references channel "${token}" which the service ` +
          "neither produces nor consumes",
      );
    }
  }

  return problems;
}

export function runLint(only: string | null, specsDir: string): number {
  const dirs = serviceDirs(specsDir);
  if (dirs.length === 0) {
    console.error(`no service manifests found under ${specsDir}/*/service.yaml`);
    return 1;
  }

  // Owners per channel, as a set: one service listing a channel twice is
  // its own problem (reported per service), not a second producer.
  const producedBy = new Map<string, Set<string>>();
  for (const d of dirs) {
    const manifest = readYaml(path.join(d, "service.yaml"));
    for (const address of manifest.produces ?? []) {
      producedBy.set(address, (producedBy.get(address) ?? new Set<string>()).add(manifest.name));
    }
  }
  const [messagesByAddress, ownMessages] = messageIndex(dirs);

  // Suite-wide, so only on a full run: `--service` scopes to one service.
  const problems: string[] = only ? [] : lintSystem(specsDir);
  let checked = 0;
  for (const d of dirs) {
    if (only && path.basename(d) !== only) continue;
    checked += 1;
    problems.push(...lintService(d, producedBy, messagesByAddress, ownMessages));
  }

  if (!checked) {
    console.error(`no such service: ${only}`);
    return 1;
  }
  if (problems.length) {
    console.error("Manifest drift:\n  " + problems.join("\n  "));
    return 1;
  }
  console.log(`${checked} manifest(s) consistent with contracts and specs graph.`);
  return 0;
}
