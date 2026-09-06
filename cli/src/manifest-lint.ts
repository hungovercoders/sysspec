/** Cross-check every service manifest against its contracts and the specs graph.
 *
 * Per service:
 *   1. `produces` must exactly match the channel addresses its AsyncAPI files
 *      publish with a `send` operation; documented `receive` channels must be
 *      listed in `consumes`.
 *   2. Every `consumes` entry must be produced by some service in the specs.
 *   3. Every declared artifact path must exist on disk, and every file of a
 *      gated kind on disk must be declared in the manifest.
 *   4. For asyncapi/openapi artifacts, the spec's `info.version` must equal the
 *      manifest version (mock URLs and rendered docs surface `info.version`).
 *   5. Feature files may only reference messages the service owns or consumes
 *      (quoted PascalCase tokens) and channels it produces or consumes (quoted
 *      dotted addresses) - scenarios about phantom events are rot.
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

function lintService(
  serviceDir: string,
  producedBy: Map<string, string>,
  messagesByAddress: Map<string, Set<string>>,
  ownMessages: Map<string, Set<string>>,
): string[] {
  const problems: string[] = [];
  const manifest = readYaml(path.join(serviceDir, "service.yaml"));
  const name = manifest.name;
  const artifacts: any[] = manifest.artifacts ?? [];

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

  const produces = new Set<string>(manifest.produces ?? []);
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

  const producedBy = new Map<string, string>();
  for (const d of dirs) {
    const manifest = readYaml(path.join(d, "service.yaml"));
    for (const address of manifest.produces ?? []) producedBy.set(address, manifest.name);
  }
  const [messagesByAddress, ownMessages] = messageIndex(dirs);

  const problems: string[] = [];
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
