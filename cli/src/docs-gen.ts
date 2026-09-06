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

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { MERMAID_CLI } from "./pins.js";
import { clean, gitLines, run, splitLines } from "./util.js";

export { clean, gitLines };

export type Dict = Record<string, any>;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function readYaml(file: string): Dict {
  return (parse(readFileSync(file, "utf-8")) ?? {}) as Dict;
}

export function which(cmd: string): string | null {
  const res = run(["which", cmd]);
  return res.status === 0 ? res.stdout.trim() : null;
}

export function loadManifests(specs: string): Dict[] {
  if (!isDir(specs)) return [];
  return readdirSync(specs)
    .sort()
    .map((d) => path.join(specs, d, "service.yaml"))
    .filter(isFile)
    .map(readYaml);
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
        if (op?.action !== "send") continue;
        const chanKey = String(op?.channel?.$ref ?? "").split("/").pop() ?? "";
        const channel: Dict = channels[chanKey] ?? {};
        const address = channel.address;
        if (!address) continue;
        index.set(address, {
          service: m.name,
          title: m.title,
          artifact_path: a.path,
          artifact_version: a.version ?? null,
          op_name: opKey,
          description: clean(op.description ?? ""),
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

/** One channel's delivery as a fenced sequence diagram: the producer
 * publishing each message to the channel, and the channel delivering it
 * to every consumer - a note stands in when there is none yet. */
export function channelSequence(address: string, info: Dict, consuming: Dict[]): string[] {
  const producer = nodeId(info.service);
  const lines = [
    "```mermaid",
    "sequenceDiagram",
    `    participant ${producer} as ${info.title}`,
    `    participant chan as ${address}`,
  ];
  for (const c of consuming) {
    lines.push(`    participant ${nodeId(c.name)} as ${c.title}`);
  }
  for (const [msgName] of info.messages) {
    lines.push(`    ${producer}-)chan: ${msgName}`);
    for (const c of consuming) {
      lines.push(`    chan-)${nodeId(c.name)}: ${msgName}`);
    }
  }
  if (consuming.length === 0) {
    lines.push("    Note over chan: no consumer in the specs yet");
  }
  lines.push("```");
  return lines;
}

/** The contract's schema objects as a fenced mermaid ER diagram.
 *
 * One entity per object, top-level properties only with their logical
 * type and PK/UK markers - the shape at a glance; the field tables
 * below carry nesting and constraints. Empty when nothing would show.
 */
export function odcsEr(odcs: Dict): string[] {
  const entities: [string, string[]][] = [];
  for (const obj of odcs.schema ?? []) {
    const rows: string[] = [];
    for (const p of obj.properties ?? []) {
      const type = String(p.logicalType ?? "unknown");
      const key = p.primaryKey ? "PK" : p.unique ? "UK" : "";
      rows.push(`        ${type} ${p.name} ${key}`.replace(/\s+$/, ""));
    }
    if (rows.length) entities.push([obj.physicalName ?? obj.name, rows]);
  }
  if (entities.length === 0) return [];
  const lines = ["```mermaid", "erDiagram"];
  for (const [entity, rows] of entities) {
    lines.push(`    ${entity} {`, ...rows, "    }");
  }
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
    for (const [f, line, source] of blocks) {
      const mmd = path.join(tmp, "diagram.mmd");
      writeFileSync(mmd, source);
      const res = run(
        [
          "npx", "-y", MERMAID_CLI, "--quiet",
          "--puppeteerConfigFile", configFile,
          "--input", mmd, "--output", path.join(tmp, "diagram.svg"),
        ],
        { env },
      );
      if (res.status !== 0) {
        failures += 1;
        const detail = (res.stderr || res.stdout).trim();
        console.error(`mermaid FAILED: ${f}:${line}\n${detail}\n`);
      } else {
        console.log(`mermaid ok: ${f}:${line}`);
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
