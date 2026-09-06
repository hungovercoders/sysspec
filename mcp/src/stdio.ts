#!/usr/bin/env node
/** Entry point for the sysspec MCP server.
 *
 * Two ways to serve the same read-only spec tools:
 *
 * - stdio (default) — how the Claude plugin and local `.mcp.json` wire it up.
 * - http — stateless streamable HTTP for a hosted deployment (any container
 *   host), so remote clients connect with just a URL.
 *
 * Flags win over environment variables; the environment variables exist so
 * container platforms (which prefer env over argv) can configure the server
 * without a wrapper script.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { makeHttpServer } from "./http.js";
import { FsSpecSource } from "./source/fs.js";

const USAGE = `usage: sysspec-mcp [--transport stdio|http] [--host HOST] [--port PORT]
                   [--path PATH] [--allowed-hosts HOSTS]

Serve the sysspec read-only MCP tools over stdio or HTTP.

  --transport      stdio for local clients (default); http for a
                   URL-addressable server (env: SYSSPEC_MCP_TRANSPORT)
  --host           http only: interface to bind, e.g. 0.0.0.0 in a
                   container (default 127.0.0.1; env: HOST)
  --port           http only: port to bind (default 8080; env: PORT)
  --path           http only: URL path of the MCP endpoint
                   (default /mcp; env: SYSSPEC_MCP_PATH)
  --allowed-hosts  http only: comma-separated Host header values to accept,
                   e.g. mcp.example.com — requests carrying any other Host
                   are rejected (env: SYSSPEC_MCP_ALLOWED_HOSTS)

SPECS_DIR must point at the spec tree to serve.`;

function parseArgs(argv: string[]) {
  const opts = {
    transport: process.env.SYSSPEC_MCP_TRANSPORT ?? "stdio",
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? "8080"),
    path: process.env.SYSSPEC_MCP_PATH ?? "/mcp",
    allowedHosts: process.env.SYSSPEC_MCP_ALLOWED_HOSTS ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--transport") opts.transport = next();
    else if (arg === "--host") opts.host = next();
    else if (arg === "--port") opts.port = Number(next());
    else if (arg === "--path") opts.path = next();
    else if (arg === "--allowed-hosts") opts.allowedHosts = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.transport !== "stdio" && opts.transport !== "http") {
    throw new Error(`--transport must be stdio or http, not ${opts.transport}`);
  }
  return opts;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const source = new FsSpecSource(process.env.SPECS_DIR);
  if (opts.transport === "stdio") {
    await createServer(source).connect(new StdioServerTransport());
    return;
  }
  const allowedHosts = opts.allowedHosts
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const server = makeHttpServer({ source, path: opts.path, allowedHosts });
  server.listen(opts.port, opts.host, () => {
    console.error(`sysspec-mcp serving http://${opts.host}:${opts.port}${opts.path}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
