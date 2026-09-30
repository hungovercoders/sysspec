/** Contract-shaped queries over a SpecSource: one OpenAPI operation with
 * its references resolved, an ODCS data contract read as tables and
 * columns, the impact of changing a message or column, and validation of
 * a payload against a message schema.
 *
 * Same rules as core.ts: read-only, confined to declared artifacts,
 * bounded, and every miss names what does exist.
 */

import { Validator } from "@cfworker/json-schema";
import { parse } from "yaml";
import {
  artifactMeta,
  artifacts,
  DEFAULT_MAX_BYTES,
  read,
  service,
  summaryOf,
  utf8Len,
} from "./core.js";
import { splitGherkin } from "./gherkin.js";
import { resolvePointer } from "./pointer.js";
import { pyList, pyRepr, pySorted } from "./pyformat.js";
import { ArtifactMeta, ArtifactMissingError, ServiceEntry, SpecSource } from "./source/types.js";

type Dict = Record<string, any>;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function isRecord(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function yamlDoc(source: SpecSource, svc: ServiceEntry, a: ArtifactMeta): Promise<Dict> {
  return (parse(await read(source, svc, a.path)) ?? {}) as Dict;
}

/** Inline every local `#/...` $ref under node, against doc. A reference
 * back into one already being expanded is left as `{$ref, circular: true}`;
 * external references are left as they are. */
export function resolveRefs(node: unknown, doc: unknown, stack: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, doc, stack));
  if (!isRecord(node)) return node;
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    if (stack.includes(ref)) return { $ref: ref, circular: true };
    return resolveRefs(resolvePointer(doc, ref.slice(1)), doc, [...stack, ref]);
  }
  const out: Dict = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveRefs(v, doc, stack);
  return out;
}

// --------------------------------------------------------------------------
// get_operation
// --------------------------------------------------------------------------

export interface GetOperationArgs {
  service: string;
  operation_id?: string | null;
  method?: string | null;
  path?: string | null;
  max_bytes?: number;
}

export async function getOperation(source: SpecSource, args: GetOperationArgs): Promise<object> {
  const { operation_id = null, method = null, path: route = null, max_bytes = DEFAULT_MAX_BYTES } =
    args;
  const svc = await service(source, args.service);
  const specs = artifacts(svc).filter((a) => a.kind === "openapi");
  if (specs.length === 0) {
    throw new Error(`Service ${pyRepr(svc.name)} declares no OpenAPI contract`);
  }
  if ((method === null) !== (route === null)) {
    throw new Error("method and path go together: pass both, or operation_id instead");
  }

  const index: Dict[] = [];
  for (const a of specs) {
    const doc = await yamlDoc(source, svc, a);
    for (const [p, item] of Object.entries((doc.paths ?? {}) as Dict)) {
      if (!isRecord(item)) continue;
      for (const m of HTTP_METHODS) {
        const op = item[m];
        if (!isRecord(op)) continue;
        const hit =
          (operation_id !== null && op.operationId === operation_id) ||
          (method !== null && m === method.toLowerCase() && p === route);
        if (!hit) {
          index.push({
            operation_id: op.operationId ?? null,
            method: m.toUpperCase(),
            path: p,
            summary: summaryOf(op.summary),
          });
          continue;
        }
        const raw = {
          ...op,
          // Path-level parameters apply to every operation under the path.
          parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
        };
        const resolved = resolveRefs(raw, doc) as Dict;
        const out: Dict = {
          service: svc.name,
          artifact: a.path,
          contract_version: a.version ?? null,
          authority: "contract of record",
          method: m.toUpperCase(),
          path: p,
          operation_id: op.operationId ?? null,
          summary: summaryOf(op.summary),
          operation: resolved,
          refs_resolved: true,
          truncated: false,
        };
        if (utf8Len(JSON.stringify(out)) > max_bytes) {
          out.operation = raw;
          out.refs_resolved = false;
          out.truncated = true;
          out.note =
            `The resolved operation exceeds ${max_bytes} bytes, so its $refs are ` +
            "left as pointers - fetch each with get_artifact(section=...) or raise max_bytes.";
        }
        return out;
      }
    }
  }
  if (operation_id === null && method === null) {
    return { service: svc.name, operations: index };
  }
  const wanted = operation_id !== null ? `operation_id ${pyRepr(operation_id)}` : `${method} ${route}`;
  const known = index.map((o) => `${o.method} ${o.path} (${o.operation_id ?? "no operationId"})`);
  throw new Error(`No operation ${wanted} on ${pyRepr(svc.name)}. Operations: ${pyList(known)}`);
}

// --------------------------------------------------------------------------
// get_data_contract
// --------------------------------------------------------------------------

export interface GetDataContractArgs {
  service: string;
  path?: string | null;
  table?: string | null;
}

function column(p: Dict): Dict {
  const out: Dict = {
    name: p.name ?? null,
    logical_type: p.logicalType ?? null,
    physical_type: p.physicalType ?? null,
    required: p.required === true,
    unique: p.unique === true,
    primary_key: p.primaryKey === true,
    description: summaryOf(p.description),
  };
  if (Array.isArray(p.enum)) out.enum = p.enum;
  if (Array.isArray(p.synonyms)) out.synonyms = p.synonyms;
  if (Array.isArray(p.quality)) out.quality = p.quality;
  // Property-level relationships: 'from' is this column, implicitly.
  if (Array.isArray(p.relationships)) out.relationships = p.relationships;
  if (p.partitioned === true) out.partitioned = true;
  return out;
}

function tableRelationships(t: Dict): Dict[] {
  const out: Dict[] = [...(t.relationships ?? [])];
  for (const p of t.properties ?? []) {
    for (const r of p?.relationships ?? []) out.push({ ...r, from: `${t.name}.${p.name}` });
  }
  return out;
}

export async function getDataContract(
  source: SpecSource,
  args: GetDataContractArgs,
): Promise<object> {
  const { path = null, table = null } = args;
  const svc = await service(source, args.service);
  let contracts = artifacts(svc).filter((a) => a.kind === "data-contract");
  if (contracts.length === 0) {
    throw new Error(`Service ${pyRepr(svc.name)} declares no data contracts`);
  }
  if (path !== null) {
    artifactMeta(svc, path); // throws listing declared artifacts if unknown
    contracts = contracts.filter((a) => a.path === path);
    if (contracts.length === 0) {
      throw new Error(`${pyRepr(path)} is not a data contract`);
    }
  }

  const docs: [ArtifactMeta, Dict][] = [];
  for (const a of contracts) docs.push([a, await yamlDoc(source, svc, a)]);

  if (table !== null) {
    const names: string[] = [];
    for (const [a, doc] of docs) {
      for (const t of (doc.schema ?? []) as Dict[]) {
        names.push(String(t?.name));
        if (t?.name !== table && t?.physicalName !== table) continue;
        return {
          service: svc.name,
          path: a.path,
          contract: doc.id ?? null,
          contract_version: a.version ?? null,
          authority: "contract of record",
          table: t.name,
          physical_name: t.physicalName ?? null,
          description: summaryOf(t.description),
          columns: (t.properties ?? []).map(column),
          relationships: tableRelationships(t),
          quality: t.quality ?? [],
        };
      }
    }
    throw new Error(`No table ${pyRepr(table)} on ${pyRepr(svc.name)}. Tables: ${pyList(names)}`);
  }

  const overview = ([a, doc]: [ArtifactMeta, Dict]) => ({
    path: a.path,
    id: doc.id ?? null,
    name: doc.name ?? null,
    version: doc.version ?? null,
    status: doc.status ?? null,
    purpose: summaryOf(doc.description?.purpose),
    tables: ((doc.schema ?? []) as Dict[]).map((t) => ({
      name: t?.name ?? null,
      description: summaryOf(t?.description),
      column_count: (t?.properties ?? []).length,
      relationships: tableRelationships(t ?? {}).length,
    })),
  });

  if (path === null) {
    return { service: svc.name, contracts: docs.map(overview) };
  }
  const [a, doc] = docs[0];
  return {
    service: svc.name,
    ...overview([a, doc]),
    authority: "contract of record",
    description: doc.description ?? null,
    // Reader guidance is part of the gated contract, not a comment.
    context: doc.context ?? null,
    quality: doc.quality ?? [],
  };
}

// --------------------------------------------------------------------------
// impact
// --------------------------------------------------------------------------

export interface ImpactArgs {
  service: string;
  message?: string | null;
  column?: string | null;
}

/** Features in any service whose scenarios name any of the needles. */
async function featureMentions(source: SpecSource, needles: string[]): Promise<Dict[]> {
  const out: Dict[] = [];
  for (const svc of (await source.loadServices()).values()) {
    for (const a of artifacts(svc).filter((x) => x.kind === "feature")) {
      let text: string;
      try {
        text = await read(source, svc, a.path);
      } catch (err) {
        if (err instanceof ArtifactMissingError) continue;
        throw err;
      }
      const scenarios = splitGherkin(text)
        .scenarios.filter((s) => needles.some((n) => s.gherkin.includes(n)))
        .map((s) => s.name);
      if (scenarios.length) out.push({ service: svc.name, path: a.path, scenarios });
    }
  }
  return out;
}

async function messageImpact(source: SpecSource, svc: ServiceEntry, message: string): Promise<object> {
  const addresses = new Set<string>();
  const known: string[] = [];
  for (const a of artifacts(svc).filter((x) => x.kind === "asyncapi")) {
    const doc = await yamlDoc(source, svc, a);
    known.push(...Object.keys(doc.components?.messages ?? {}));
    for (const channel of Object.values((doc.channels ?? {}) as Dict)) {
      if (!isRecord(channel) || !channel.address) continue;
      for (const [key, m] of Object.entries((channel.messages ?? {}) as Dict)) {
        const ref = isRecord(m) && typeof m.$ref === "string" ? m.$ref.split("/").pop() : null;
        if (key === message || ref === message) addresses.add(String(channel.address));
      }
    }
  }
  if (!known.includes(message)) {
    throw new Error(
      `No message ${pyRepr(message)} on ${pyRepr(svc.name)}. Messages: ${pyList(pySorted(known))}`,
    );
  }
  const services = await source.loadServices();
  const channels = pySorted(addresses).map((address) => ({
    address,
    produced_by: pySorted(
      [...services.values()].filter((s) => (s.manifest.produces ?? []).includes(address)).map((s) => s.name),
    ),
    consumed_by: pySorted(
      [...services.values()].filter((s) => (s.manifest.consumes ?? []).includes(address)).map((s) => s.name),
    ),
  }));

  // Data contracts that record the stream: their text names the address.
  const records: Dict[] = [];
  for (const s of services.values()) {
    for (const a of artifacts(s).filter((x) => x.kind === "data-contract")) {
      let text: string;
      try {
        text = await read(source, s, a.path);
      } catch (err) {
        if (err instanceof ArtifactMissingError) continue;
        throw err;
      }
      const hits = [...addresses].filter((addr) => text.includes(addr));
      if (hits.length) records.push({ service: s.name, path: a.path, mentions: pySorted(hits) });
    }
  }

  const consumers = pySorted(new Set(channels.flatMap((c) => c.consumed_by)));
  return {
    service: svc.name,
    message,
    channels,
    consumers,
    features: await featureMentions(source, [`"${message}"`, ...[...addresses].map((a) => `"${a}"`)]),
    data_contracts: records,
    note:
      consumers.length === 0
        ? "No service consumes this message's channels; a change still takes the version gates."
        : `A breaking change to ${message} breaks ${consumers.join(", ")}: it needs a new major ` +
          "channel (.vN) or their agreement, and a major service bump.",
  };
}

/** Does an ODCS relationship end name the column: shorthand
 * `table.column` by name, or the qualified `schema/<id>/properties/<id>`
 * form by id? A cross-file end must also name a file with the target's
 * basename. */
function refersTo(
  ref: unknown,
  target: { table: string; tableId: string; col: string; colId: string; file: string },
): boolean {
  const raw = String(ref ?? "");
  const [file, pointer] = raw.includes("#") ? raw.split("#") : [null, raw];
  if (file && file.split("/").pop() !== target.file.split("/").pop()) return false;
  if (pointer === `${target.table}.${target.col}`) return true;
  const parts = pointer.split("/").filter(Boolean);
  const at = parts.indexOf("properties");
  return (
    parts[0] === "schema" &&
    parts[1] === target.tableId &&
    at !== -1 &&
    parts[at + 1] === target.colId
  );
}

async function columnImpact(source: SpecSource, svc: ServiceEntry, target: string): Promise<object> {
  const [table, col] = target.split(".");
  if (!table || !col) {
    throw new Error(`column must be <table>.<column>, got ${pyRepr(target)}`);
  }
  // It must exist: an impact report on a typo would read as "safe to change".
  let found: { table: string; tableId: string; col: string; colId: string; file: string } | null =
    null;
  const tables: string[] = [];
  for (const a of artifacts(svc).filter((x) => x.kind === "data-contract")) {
    for (const t of ((await yamlDoc(source, svc, a)).schema ?? []) as Dict[]) {
      tables.push(String(t?.name));
      const p = t?.name === table ? (t.properties ?? []).find((x: Dict) => x?.name === col) : null;
      if (p && !found) {
        found = {
          table,
          tableId: String(t.id ?? t.name),
          col,
          colId: String(p.id ?? p.name),
          file: a.path,
        };
      }
    }
  }
  if (!found) {
    throw new Error(
      `No column ${pyRepr(target)} in ${pyRepr(svc.name)}'s data contracts. Tables: ${pyList(tables)}`,
    );
  }
  const relationships: Dict[] = [];
  for (const s of (await source.loadServices()).values()) {
    for (const a of artifacts(s).filter((x) => x.kind === "data-contract")) {
      let doc: Dict;
      try {
        doc = await yamlDoc(source, s, a);
      } catch (err) {
        if (err instanceof ArtifactMissingError) continue;
        throw err;
      }
      for (const t of (doc.schema ?? []) as Dict[]) {
        for (const r of tableRelationships(t ?? {})) {
          const ends = [...[r.to].flat(), ...[r.from].flat()];
          // A shorthand end is local to its own document.
          const local = (e: unknown) => String(e ?? "").includes("#") || (s.name === svc.name && a.path === found!.file);
          if (ends.some((e) => local(e) && refersTo(e, found!))) {
            relationships.push({ service: s.name, path: a.path, table: t.name, ...r });
          }
        }
      }
    }
  }
  return {
    service: svc.name,
    column: target,
    relationships,
    features: await featureMentions(source, [col]),
    note:
      "Removing or retyping a column is breaking (check:compat asks for a major); every " +
      "relationship listed above stops resolving if it goes.",
  };
}

export async function impact(source: SpecSource, args: ImpactArgs): Promise<object> {
  const { message = null, column: col = null } = args;
  if ((message === null) === (col === null)) {
    throw new Error("Pass exactly one of message= (an AsyncAPI message) or column= (<table>.<column>)");
  }
  const svc = await service(source, args.service);
  return message !== null ? messageImpact(source, svc, message) : columnImpact(source, svc, col!);
}

// --------------------------------------------------------------------------
// validate_payload
// --------------------------------------------------------------------------

export interface ValidatePayloadArgs {
  service: string;
  message: string;
  payload: unknown;
}

/** OpenAPI 3.0 spells "may be null" as nullable: true beside the type;
 * JSON Schema spells it as a type union. */
function nullableToUnion(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(nullableToUnion);
  if (!isRecord(node)) return node;
  const out: Dict = {};
  for (const [k, v] of Object.entries(node)) out[k] = nullableToUnion(v);
  if (out.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  delete out.nullable;
  return out;
}

export async function validatePayload(source: SpecSource, args: ValidatePayloadArgs): Promise<object> {
  const svc = await service(source, args.service);
  let payload = args.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      throw new Error(`payload is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
  }

  let schema: unknown = null;
  let origin = "";
  let version: string | null = null;
  const known: string[] = [];
  for (const kind of ["asyncapi", "openapi"]) {
    for (const a of artifacts(svc).filter((x) => x.kind === kind)) {
      const doc = await yamlDoc(source, svc, a);
      const pool = (kind === "asyncapi" ? doc.components?.messages : doc.components?.schemas) ?? {};
      known.push(...Object.keys(pool));
      if (schema === null && isRecord(pool[args.message])) {
        const body = pool[args.message];
        schema = resolveRefs(kind === "asyncapi" ? body.payload ?? {} : body, doc);
        if (kind === "openapi") schema = nullableToUnion(schema);
        origin = kind;
        version = a.version ?? null;
      }
    }
  }
  if (schema === null) {
    throw new Error(
      `No message or schema ${pyRepr(args.message)} on ${pyRepr(svc.name)}. ` +
        `Known: ${pyList(pySorted(new Set(known)))}`,
    );
  }

  const result = new Validator(schema as Dict, "7", false).validate(payload);
  return {
    service: svc.name,
    message: args.message,
    source: origin,
    contract_version: version,
    valid: result.valid,
    errors: result.valid ? [] : leafErrors(result.errors, schema as Dict),
  };
}

// Keywords whose errors only say "a child failed" - the child's own
// error carries the detail.
const WRAPPERS = new Set(["properties", "items", "prefixItems", "allOf", "$ref", "false"]);

/** The validator's error list, reduced to what a reader acts on: leaf
 * errors with their instance path. Its additionalProperties errors are
 * rewritten as "unexpected property", and dropped for properties the
 * schema does declare (the validator also reports a declared property
 * that failed its own subschema as un-evaluated). */
function leafErrors(
  errors: { keyword: string; keywordLocation: string; instanceLocation: string; error: string }[],
  schema: Dict,
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    if (WRAPPERS.has(e.keyword)) continue;
    let path = e.instanceLocation.replace(/^#/, "") || "/";
    let message = e.error;
    if (e.keyword === "additionalProperties") {
      const name = /Property "([^"]+)"/.exec(e.error)?.[1];
      if (name === undefined) continue;
      const parentPointer = e.keywordLocation.replace(/^#/, "").replace(/\/additionalProperties$/, "");
      let parent: unknown;
      try {
        parent = parentPointer ? resolvePointer(schema, parentPointer) : schema;
      } catch {
        parent = null;
      }
      if (isRecord(parent) && isRecord(parent.properties) && name in parent.properties) continue;
      path = `${path === "/" ? "" : path}/${name}`;
      message = `unexpected property "${name}" - the schema does not allow additional properties`;
    }
    const key = `${path}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, message });
  }
  return out;
}
