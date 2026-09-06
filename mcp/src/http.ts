import { createServer as createNodeServer, Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { SpecSource } from "./source/types.js";

export interface HttpOptions {
  source: SpecSource;
  /** URL path the MCP endpoint is served at. Default /mcp. */
  path?: string;
  /** Host header values to accept (DNS-rebinding protection). Empty = any. */
  allowedHosts?: string[];
}

/** A stateless streamable-HTTP MCP server as a plain Node http.Server —
 * no session store, so it runs unchanged behind any load balancer or
 * scale-to-zero container host. Each POST gets a fresh transport + server
 * pair (construction just registers seven closures).
 */
export function makeHttpServer(opts: HttpOptions): Server {
  const mcpPath = opts.path ?? "/mcp";
  const allowedHosts = opts.allowedHosts ?? [];
  return createNodeServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== mcpPath) {
      const body =
        url.pathname === "/" || url.pathname === ""
          ? { name: "sysspec-mcp", endpoint: mcpPath, transport: "streamable-http" }
          : { error: `Not found. The MCP endpoint is ${mcpPath}.` };
      res.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    const server = createServer(opts.source);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(allowedHosts.length
        ? { allowedHosts, enableDnsRebindingProtection: true }
        : {}),
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void transport.close();
      void server.close();
    };
    // JSON-response mode completes the response inside handleRequest, so
    // the finally is the deterministic close; the 'close' listener covers
    // premature client disconnects mid-request.
    res.on("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      cleanup();
    }
  });
}
