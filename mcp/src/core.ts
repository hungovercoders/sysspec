/** The seven read-only spec tools, as plain functions over a SpecSource.
 *
 * Design notes (carried from the original Python server):
 *
 * - The specs is a graph of services, not a flat list of files. Services own
 *   artifacts and declare the channels they produce and consume, so questions
 *   like "who breaks if I change this?" are answerable without grepping.
 * - Every read is confined to SPECS_DIR and to paths a service manifest
 *   actually declares. An undeclared file is not reachable, so dropping
 *   something into the tree does not silently expose it.
 * - There is no write tool. Gated artifacts (contracts, features) are the
 *   record; ungated ones (docs) are context.
 * - Responses are bounded and self-describing: anything that can be cut
 *   carries a truncated flag and a count, never a silent cap. Every
 *   content-bearing tool has a mode that returns exactly one thing.
 *
 * Error messages reproduce the Python originals character-for-character
 * (including repr() quoting) — they are part of the served contract.
 */

import { parse, stringify } from "yaml";
import { bounded } from "./bounded.js";
import { splitGherkin } from "./gherkin.js";
import { resolvePointer } from "./pointer.js";
import { pyList, pyRepr, pySorted } from "./pyformat.js";
import { ArtifactMeta, ArtifactMissingError, ServiceEntry, SpecSource } from "./source/types.js";

export const GATED_KINDS = new Set(["asyncapi", "openapi", "data-contract", "feature"]);
export const SEARCH_KINDS = new Set(["asyncapi", "openapi", "data-contract", "feature", "doc"]);
export const DEFAULT_MAX_BYTES = 50_000;

function artifacts(svc: ServiceEntry): ArtifactMeta[] {
  return svc.manifest.artifacts ?? [];
}

function artifactMeta(svc: ServiceEntry, path: string): ArtifactMeta {
  for (const a of artifacts(svc)) {
    if (a.path === path) return a;
  }
  const declared = artifacts(svc).map((a) => a.path);
  throw new Error(
    `${pyRepr(path)} is not declared by service ${pyRepr(svc.name)}. ` +
      `Declared artifacts: ${pyList(declared)}`,
  );
}

async function service(source: SpecSource, name: string): Promise<ServiceEntry> {
  const services = await source.loadServices();
  const svc = services.get(name);
  if (!svc) {
    throw new Error(`No service ${pyRepr(name)}. Available: ${pyList(pySorted(services.keys()))}`);
  }
  return svc;
}

/** Read a declared artifact, confined to the service directory. */
async function read(source: SpecSource, svc: ServiceEntry, path: string): Promise<string> {
  artifactMeta(svc, path); // throws unless declared in the manifest
  return source.readFile(svc, path);
}

function isGated(a: ArtifactMeta): boolean {
  return "gated" in a && a.gated !== undefined ? a.gated : GATED_KINDS.has(a.kind);
}

function summaryOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function utf8Len(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Python str.splitlines() for \n-separated text (no trailing empty line). */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

export async function listServices(source: SpecSource): Promise<object[]> {
  const out = [];
  for (const svc of (await source.loadServices()).values()) {
    const m = svc.manifest;
    out.push({
      name: svc.name,
      title: m.title ?? svc.name,
      domain: m.domain ?? "",
      owner: m.owner ?? "",
      summary: summaryOf(m.summary),
      artifact_count: artifacts(svc).length,
    });
  }
  return out;
}

export async function getService(source: SpecSource, name: string): Promise<object> {
  const svc = await service(source, name);
  const m = svc.manifest;
  return {
    name: svc.name,
    title: m.title ?? svc.name,
    domain: m.domain ?? "",
    owner: m.owner ?? "",
    summary: summaryOf(m.summary),
    produces: m.produces ?? [],
    consumes: m.consumes ?? [],
    artifacts: artifacts(svc).map((a) => ({
      kind: a.kind,
      path: a.path,
      version: a.version ?? null,
      gated: isGated(a),
      summary: summaryOf(a.summary),
    })),
  };
}

// --------------------------------------------------------------------------
// Artifact access
// --------------------------------------------------------------------------

export interface GetArtifactArgs {
  service: string;
  path: string;
  section?: string | null;
  max_bytes?: number;
}

export async function getArtifact(source: SpecSource, args: GetArtifactArgs): Promise<object> {
  const { service: serviceName, path, section = null, max_bytes = DEFAULT_MAX_BYTES } = args;
  const svc = await service(source, serviceName);
  const meta = artifactMeta(svc, path);
  const gated = isGated(meta);
  let text = await read(source, svc, path);
  if (section !== null && section !== undefined) {
    if (meta.kind === "feature") {
      throw new Error(
        "section selectors only apply to YAML artifacts; use " +
          "get_acceptance_criteria(scenario=...) for feature files",
      );
    }
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (exc) {
      throw new Error(
        `${path} is not YAML; fetch it without section=: ${exc instanceof Error ? exc.message : exc}`,
      );
    }
    const node = resolvePointer(doc, section);
    text = stringify(node).replace(/\n+$/, "");
  }
  const { text: content, truncated, totalBytes } = bounded(text, max_bytes);
  const out: Record<string, unknown> = {
    service: svc.name,
    kind: meta.kind,
    path,
    version: meta.version ?? null,
    gated,
    authority: gated ? "contract of record" : "context, not binding",
    section: section ?? null,
    content,
    truncated,
    total_bytes: totalBytes,
  };
  if (truncated) {
    out.note =
      `Truncated at ${max_bytes} of ${totalBytes} bytes. Narrow with ` +
      "section= (e.g. '/components/messages/OrderPlaced', " +
      "'/paths/~1orders/post') or raise max_bytes.";
  }
  return out;
}

export async function getMessageSchema(
  source: SpecSource,
  serviceName: string,
  message?: string | null,
): Promise<object> {
  const svc = await service(source, serviceName);
  const asyncapiMessages: [ArtifactMeta, string, Record<string, unknown>][] = [];
  const openapiSchemas: [ArtifactMeta, string, unknown][] = [];
  for (const a of artifacts(svc)) {
    if (a.kind === "asyncapi") {
      const doc = (parse(await read(source, svc, a.path)) ?? {}) as Record<string, any>;
      for (const [name, body] of Object.entries(doc.components?.messages ?? {})) {
        asyncapiMessages.push([a, name, (body ?? {}) as Record<string, unknown>]);
      }
    } else if (a.kind === "openapi") {
      const doc = (parse(await read(source, svc, a.path)) ?? {}) as Record<string, any>;
      for (const [name, body] of Object.entries(doc.components?.schemas ?? {})) {
        openapiSchemas.push([a, name, body]);
      }
    }
  }
  if (message === null || message === undefined) {
    return {
      service: svc.name,
      messages: asyncapiMessages.map(([a, name]) => ({
        name,
        path: a.path,
        contract_version: a.version ?? null,
      })),
      schemas: openapiSchemas.map(([a, name]) => ({
        name,
        path: a.path,
        contract_version: a.version ?? null,
      })),
    };
  }
  for (const [a, name, body] of asyncapiMessages) {
    if (name === message) {
      return {
        service: svc.name,
        message,
        source: "asyncapi",
        contract_version: a.version ?? null,
        payload: body.payload ?? {},
      };
    }
  }
  for (const [a, name, body] of openapiSchemas) {
    if (name === message) {
      return {
        service: svc.name,
        message,
        source: "openapi",
        contract_version: a.version ?? null,
        payload: body,
      };
    }
  }
  throw new Error(
    `No message or schema ${pyRepr(message)} on service ${pyRepr(serviceName)}. ` +
      `Messages: ${pyList(pySorted(asyncapiMessages.map(([, n]) => n)))}. ` +
      `Schemas: ${pyList(pySorted(openapiSchemas.map(([, n]) => n)))}.`,
  );
}

export interface AcceptanceCriteriaArgs {
  service: string;
  path?: string | null;
  scenario?: string | null;
  names_only?: boolean;
  max_bytes?: number;
}

export async function getAcceptanceCriteria(
  source: SpecSource,
  args: AcceptanceCriteriaArgs,
): Promise<object> {
  const {
    service: serviceName,
    path = null,
    scenario = null,
    names_only = false,
    max_bytes = DEFAULT_MAX_BYTES,
  } = args;
  const svc = await service(source, serviceName);
  let features = artifacts(svc).filter((a) => a.kind === "feature");
  if (features.length === 0) {
    throw new Error(`Service ${pyRepr(serviceName)} declares no feature files`);
  }
  if (path !== null && path !== undefined) {
    artifactMeta(svc, path); // throws listing declared artifacts if unknown
    features = features.filter((a) => a.path === path);
    if (features.length === 0) {
      const declared = artifacts(svc)
        .filter((a) => a.kind === "feature")
        .map((a) => a.path);
      throw new Error(`${pyRepr(path)} is not a feature file. Features: ${pyList(declared)}`);
    }
  }
  const out: {
    service: string;
    authority: string;
    truncated: boolean;
    features: Record<string, unknown>[];
    note?: string;
  } = {
    service: svc.name,
    authority: "binding — implement toward these, do not amend them",
    truncated: false,
    features: [],
  };
  let budget = max_bytes;
  for (const a of features) {
    const text = await read(source, svc, a.path);
    const summary = summaryOf(a.summary);
    const { header, scenarios } = splitGherkin(text);
    if (names_only) {
      out.features.push({ path: a.path, summary, scenarios: scenarios.map((s) => s.name) });
      continue;
    }
    if (scenario !== null && scenario !== undefined) {
      const needle = scenario.toLowerCase();
      const matched = scenarios.filter((s) => s.name.toLowerCase().includes(needle));
      if (matched.length) {
        out.features.push({
          path: a.path,
          summary,
          header,
          matched,
          total_scenarios: scenarios.length,
        });
      }
      continue;
    }
    if (utf8Len(text) > budget) {
      out.truncated = true;
      out.features.push({
        path: a.path,
        summary,
        scenarios: scenarios.map((s) => s.name),
        gherkin_omitted: true,
      });
      continue;
    }
    budget -= utf8Len(text);
    out.features.push({ path: a.path, summary, gherkin: text });
  }
  if (scenario !== null && scenario !== undefined && out.features.length === 0) {
    const names: string[] = [];
    for (const a of features) {
      const { scenarios } = splitGherkin(await read(source, svc, a.path));
      names.push(...scenarios.map((s) => s.name));
    }
    throw new Error(`No scenario matching ${pyRepr(scenario)}. Scenarios: ${pyList(names)}`);
  }
  if (out.truncated) {
    out.note =
      `Some Gherkin bodies omitted to stay under ${max_bytes} bytes. ` +
      "Fetch narrowly with path= or scenario=, or raise max_bytes.";
  }
  return out;
}

// --------------------------------------------------------------------------
// Graph queries
// --------------------------------------------------------------------------

export async function traceChannel(source: SpecSource, address: string): Promise<object> {
  const producers: string[] = [];
  const consumers: string[] = [];
  for (const svc of (await source.loadServices()).values()) {
    if ((svc.manifest.produces ?? []).includes(address)) producers.push(svc.name);
    if ((svc.manifest.consumes ?? []).includes(address)) consumers.push(svc.name);
  }
  let note = "Changing this payload breaks the consumers listed above.";
  if (producers.length === 0 && consumers.length === 0) {
    note =
      "No service produces or consumes this address. Check the spelling " +
      "against get_service(...)['produces'/'consumes'] — addresses are " +
      "dotted lowercase like 'orders.placed.v2'.";
  }
  return {
    address,
    produced_by: pySorted(producers),
    consumed_by: pySorted(consumers),
    note,
  };
}

export interface SearchSpecsArgs {
  query: string;
  kind?: string | null;
  service?: string | null;
  limit?: number;
}

export async function searchSpecs(source: SpecSource, args: SearchSpecsArgs): Promise<object> {
  const { query, kind = null, service: serviceName = null } = args;
  let limit = args.limit ?? 20;
  if (kind !== null && kind !== undefined && !SEARCH_KINDS.has(kind)) {
    throw new Error(`Unknown kind ${pyRepr(kind)}. Valid kinds: ${pyList(pySorted(SEARCH_KINDS))}`);
  }
  if (serviceName !== null && serviceName !== undefined) {
    await service(source, serviceName); // throws listing available services if unknown
  }
  limit = Math.max(1, Math.min(limit, 100));
  const needle = query.toLowerCase();
  const hits: object[] = [];
  let totalMatches = 0;
  for (const svc of (await source.loadServices()).values()) {
    if (serviceName && svc.name !== serviceName) continue;
    for (const a of artifacts(svc)) {
      if (kind && a.kind !== kind) continue;
      let text: string;
      try {
        text = await read(source, svc, a.path);
      } catch (err) {
        if (err instanceof ArtifactMissingError) continue;
        throw err;
      }
      const lines = splitLines(text);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          totalMatches += 1;
          if (hits.length < limit) {
            hits.push({
              service: svc.name,
              kind: a.kind,
              path: a.path,
              line: i + 1,
              text: lines[i].trim().slice(0, 200),
            });
          }
        }
      }
    }
  }
  return {
    query,
    kind: kind ?? null,
    service: serviceName ?? null,
    hits,
    total_matches: totalMatches,
    returned: hits.length,
    truncated: totalMatches > hits.length,
  };
}
