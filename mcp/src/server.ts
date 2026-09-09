import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import {
  DEFAULT_MAX_BYTES,
  getAcceptanceCriteria,
  getArtifact,
  getMessageSchema,
  getService,
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

/** Build the sysspec MCP server over a spec source. Tool names, shapes,
 * descriptions and error messages are the served contract — see core.ts.
 */
export function createServer(source: SpecSource): McpServer {
  const server = new McpServer({ name: "sysspec", version: pkg.version });

  server.registerTool(
    "list_services",
    {
      description:
        "List every service in the specs with its domain, owner and summary.\n\n" +
        "Start here. Returns no artifact contents — use get_service next.",
      inputSchema: {},
    },
    async () => run(() => listServices(source)),
  );

  server.registerTool(
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

  server.registerTool(
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
        max_bytes: z.number().int().default(DEFAULT_MAX_BYTES),
      },
    },
    async (args) => run(() => getArtifact(source, args)),
  );

  server.registerTool(
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

  server.registerTool(
    "get_acceptance_criteria",
    {
      description:
        "Return Gherkin acceptance criteria for a service — narrowly.\n\n" +
        'Start with names_only=True to see the scenario index, then fetch one\n' +
        'scenario (scenario="substring of its title") or one file (path=...).\n' +
        "Only omit all filters when you are about to implement the whole service.\n\n" +
        "These are binding acceptance criteria. Implement toward them. If a\n" +
        "scenario looks wrong, say so and stop rather than adjusting it.",
      inputSchema: {
        service: z.string(),
        path: z.string().nullable().optional(),
        scenario: z.string().nullable().optional(),
        names_only: z.boolean().default(false),
        max_bytes: z.number().int().default(DEFAULT_MAX_BYTES),
      },
    },
    async (args) => run(() => getAcceptanceCriteria(source, args)),
  );

  server.registerTool(
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

  server.registerTool(
    "search_specs",
    {
      description:
        "Search artifact contents across services.\n\n" +
        "Returns matching lines only (each capped at 200 chars), never whole\n" +
        "files or surrounding context — follow up with get_artifact(section=...)\n" +
        "on a hit's path. Narrow with kind= (asyncapi, openapi, data-contract,\n" +
        "feature, doc) and service=; raise limit (max 100) only if truncated is\n" +
        "true and you need more.",
      inputSchema: {
        query: z.string(),
        kind: z.string().nullable().optional(),
        service: z.string().nullable().optional(),
        limit: z.number().int().default(20),
      },
    },
    async (args) => run(() => searchSpecs(source, args)),
  );

  return server;
}
