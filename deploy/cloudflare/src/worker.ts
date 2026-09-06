// The MCP half of the demo Worker. Static assets handle everything else
// (run_worker_first routes only /mcp here). The Node http server from the
// mcp package runs unchanged on workerd: with nodejs_compat and a
// 2025-09-01+ compatibility date, httpServerHandler bridges fetch events
// into node:http, and the port is a routing key, not a socket.
//
// Imports the mcp *source*, not the committed dist: wrangler's esbuild
// resolves node builtins for workerd itself, which the node-targeted dist
// bundle (createRequire banner, inlined CJS require calls) cannot.
// Requires mcp/node_modules to be installed.
import { httpServerHandler } from "cloudflare:node";
import { makeHttpServer } from "../../../mcp/src/http.js";
import { BundledSpecSource, type SpecsBundle } from "../../../mcp/src/source/bundle.js";
import bundle from "../../../mcp/src/generated/specs-bundle.json";

const server = makeHttpServer({ source: new BundledSpecSource(bundle as SpecsBundle) });
server.listen(8080);
export default httpServerHandler({ port: 8080 });
