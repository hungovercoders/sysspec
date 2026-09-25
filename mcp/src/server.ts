import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { getDataContract, getOperation, impact, validatePayload } from "./contracts.js";
import {
  DEFAULT_MAX_BYTES,
  getAcceptanceCriteria,
  getArtifact,
  getMessageSchema,
  getService,
  getSystem,
  listServices,
  searchSpecs,
  traceChannel,
} from "./core.js";
import { SpecSource } from "./source/types.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(result: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

// Every tool only reads a closed set of spec files: safe to call, safe to
// repeat, and never reaching outside the suite.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const MAX_BYTES = z.number().int().min(1).max(1_000_000).default(DEFAULT_MAX_BYTES);

/** Build the sysspec MCP server over a spec source. Tool names, shapes,
 * descriptions and error messages are the served contract — see core.ts
 * and contracts.ts.
 */
export function createServer(source: SpecSource): McpServer {
  const server = new McpServer({ name: "sysspec", version: pkg.version });
  const registerTool: typeof server.registerTool = (name, config, cb) =>
    server.registerTool(name, { ...config, annotations: { ...READ_ONLY, ...config.annotations } }, cb);

  registerTool(
    "get_system",
    {
      description:
        "Describe the system these specs specify: its name, title, business\n" +
        "domain, event namespace (org), summary and hosted MCP endpoint.\n\n" +
        "A good first call for a plain-language question about the system as a\n" +
        "whole; list_services then names its parts.",
      inputSchema: {},
    },
    async () => run(() => getSystem(source)),
  );

  registerTool(
    "list_services",
    {
      description:
        "List every service in the specs with its domain, owner, version and\n" +
        "summary. The version is the one consumers pin (<service>/v<version>).\n\n" +
        "Start here. Returns no artifact contents — use get_service next.",
      inputSchema: {},
    },
    async () => run(() => listServices(source)),
  );

  registerTool(
    "get_service",
    {
      description:
        "Describe one service: its artifact index and event dependencies.\n\n" +
        "Returns an index only, not file contents. Then fetch narrowly:\n" +
        "get_message_schema for one payload, get_acceptance_criteria with\n" +
        "names_only/scenario/path filters, or get_artifact with section=,\n" +
        "before pulling any whole file.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => run(() => getService(source, name)),
  );

  registerTool(
    "get_artifact",
    {
      description:
        "Fetch one declared artifact, or one section of it.\n\n" +
        "Prefer the narrowest call that answers the question: get_message_schema\n" +
        "for a single payload, or section= (an RFC 6901 JSON pointer such as\n" +
        "'/components/schemas/Order' or '/paths/~1orders/post' — '~1' escapes\n" +
        "'/') for one part of a YAML spec. Omit section only when you genuinely\n" +
        "need the whole document. Responses are capped at max_bytes and say so\n" +
        "via the truncated flag — never silently cut.\n\n" +
        "Gated artifacts (asyncapi, openapi, data-contract, feature) are the\n" +
        "record. If the implementation disagrees with a gated artifact, the\n" +
        "implementation is wrong — do not edit the artifact to make it pass.",
      inputSchema: {
        service: z.string(),
        path: z.string(),
        section: z.string().nullable().optional(),
        max_bytes: MAX_BYTES,
      },
    },
    async (args) => run(() => getArtifact(source, args)),
  );

  registerTool(
    "get_message_schema",
    {
      description:
        "Return one named payload schema — an AsyncAPI message or, failing\n" +
        "that, an OpenAPI component schema.\n\n" +
        "Call with no message first to list the names available on a service —\n" +
        "the response carries names only, no schema bodies. This is the\n" +
        "cheapest schema accessor for the caller; prefer it over get_artifact\n" +
        "whenever you only need a shape.",
      inputSchema: { service: z.string(), message: z.string().nullable().optional() },
    },
    async ({ service, message }) => run(() => getMessageSchema(source, service, message)),
  );

  registerTool(
    "get_acceptance_criteria",
    {
      description:
        "Return Gherkin acceptance criteria for a service — narrowly.\n\n" +
        'Start with names_only=true to see the scenario index, then fetch one\n' +
        'scenario (scenario="substring of its title") or one file (path=...).\n' +
        "Only omit all filters when you are about to implement the whole service.\n\n" +
        "A scenario= match comes back in matched[] as {name, gherkin}. A\n" +
        "scenario inside a Rule also has rule_index: rules[rule_index] is that\n" +
        "Rule's block (Rule line, description, Background). A scenario stands\n" +
        "alone only as header + rules[rule_index] + gherkin; the header holds\n" +
        "the Feature and its Background, never a Rule.\n\n" +
        "Nothing is sent past max_bytes. With truncated=true, what did not\n" +
        "fit is flagged instead: header_omitted, gherkin_omitted (name only),\n" +
        "names_omitted (scenario_count only), unlisted_matches (a count of\n" +
        "matches not even named). Narrow the call or raise max_bytes.\n\n" +
        "These are binding acceptance criteria. Implement toward them. If a\n" +
        "scenario looks wrong, say so and stop rather than adjusting it.",
      inputSchema: {
        service: z.string(),
        path: z.string().nullable().optional(),
        scenario: z.string().nullable().optional(),
        names_only: z.boolean().default(false),
        max_bytes: MAX_BYTES,
      },
    },
    async (args) => run(() => getAcceptanceCriteria(source, args)),
  );

  registerTool(
    "trace_channel",
    {
      description:
        "Find which services produce and consume a channel address.\n\n" +
        "Use before changing a message shape: the consumers listed are what\n" +
        "you will break.",
      inputSchema: { address: z.string() },
    },
    async ({ address }) => run(() => traceChannel(source, address)),
  );

  registerTool(
    "search_specs",
    {
      description:
        "Search artifact contents (and service manifests) across services.\n\n" +
        "Ranked: every word of the query counts, camelCase and snake_case are\n" +
        "split, so 'order placed' finds OrderPlaced and orders.placed.v2, and\n" +
        "exact matches lead. Returns matching lines only (each capped at 200\n" +
        "chars) with a score and, in YAML files, the JSON pointer of the line —\n" +
        "pass it to get_artifact(section=...). Narrow with kind= (asyncapi,\n" +
        "openapi, data-contract, feature, doc, manifest) and service=; raise\n" +
        "limit (max 100) only if truncated is true and you need more.",
      inputSchema: {
        query: z.string(),
        kind: z.string().nullable().optional(),
        service: z.string().nullable().optional(),
        limit: z.number().int().default(20),
      },
    },
    async (args) => run(() => searchSpecs(source, args)),
  );

  registerTool(
    "get_operation",
    {
      description:
        "Return one OpenAPI operation with its $refs resolved: parameters\n" +
        "(path-level included), request body and every response, inline.\n\n" +
        "Address it by operation_id, or by method + path ('POST', '/orders').\n" +
        "Call with neither to list the service's operations. Cheaper and more\n" +
        "complete than get_artifact on the paths section.",
      inputSchema: {
        service: z.string(),
        operation_id: z.string().nullable().optional(),
        method: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
        max_bytes: MAX_BYTES,
      },
    },
    async (args) => run(() => getOperation(source, args)),
  );

  registerTool(
    "get_data_contract",
    {
      description:
        "Read an ODCS data contract as tables and columns rather than YAML.\n\n" +
        "No path: an index of the service's contracts and their tables. With\n" +
        "path: that contract's purpose, reader context (instructions, verified\n" +
        "question/answer pairs, constraints) and tables. With table: one table's\n" +
        "columns (types, required, enum values, synonyms, quality rules) and\n" +
        "relationships. The context is gated contract text — follow it when\n" +
        "answering questions about the data.",
      inputSchema: {
        service: z.string(),
        path: z.string().nullable().optional(),
        table: z.string().nullable().optional(),
      },
    },
    async (args) => run(() => getDataContract(source, args)),
  );

  registerTool(
    "impact",
    {
      description:
        "Who and what a change would reach. Pass exactly one of:\n" +
        "- message= an AsyncAPI message: its channels, their producers and\n" +
        "  consumers, every scenario (in any service) naming it or its channel,\n" +
        "  and the data contracts that record the stream;\n" +
        "- column= '<table>.<column>' in one of the service's data contracts:\n" +
        "  every ODCS relationship pointing at it, and the scenarios naming it.\n\n" +
        "Use before changing a contract: what is listed is what you break.",
      inputSchema: {
        service: z.string(),
        message: z.string().nullable().optional(),
        column: z.string().nullable().optional(),
      },
    },
    async (args) => run(() => impact(source, args)),
  );

  registerTool(
    "validate_payload",
    {
      description:
        "Validate a JSON payload against a message schema — an AsyncAPI\n" +
        "message's payload or, failing that, an OpenAPI component schema —\n" +
        "with $refs resolved.\n\n" +
        "Returns valid plus leaf errors (instance path and message). Use it to\n" +
        "check an example, a fixture or a captured event against the contract\n" +
        "of record; a failure is a finding about the payload, not the schema.",
      inputSchema: {
        service: z.string(),
        message: z.string(),
        payload: z.unknown(),
      },
    },
    async (args) => run(() => validatePayload(source, args)),
  );

  return server;
}
