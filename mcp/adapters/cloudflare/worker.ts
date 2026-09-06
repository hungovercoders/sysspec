/** Optional Cloudflare Worker entry — one thin adapter over the same
 * createServer() every other deployment uses. Nothing else depends on this
 * directory; the portable deploy route is the Docker image (see
 * mcp/README.md). Specs come from the bundle `wrangler`'s custom build
 * step generates (scripts/bundle-specs.mjs), so a deploy is a snapshot of
 * the repo's specs at deploy time.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../../src/server.js";
import { BundledSpecSource, SpecsBundle } from "../../src/source/bundle.js";
import bundleJson from "../../src/generated/specs-bundle.json" with { type: "json" };

const source = new BundledSpecSource(bundleJson as unknown as SpecsBundle);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ name: "sysspec-mcp", endpoint: "/mcp", transport: "streamable-http" });
    }
    if (url.pathname !== "/mcp") {
      return Response.json({ error: "Not found. The MCP endpoint is /mcp." }, { status: 404 });
    }
    const server = createServer(source);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
