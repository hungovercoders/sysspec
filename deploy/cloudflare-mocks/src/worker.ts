// The mocks half of the demo: the same spec-derived mock bundle the CLI
// serves locally (`sysspec mocks serve`), on a Worker.
//
// Imports the engine *source* from the cli package rather than a published
// build, exactly as the demo Worker imports the mcp source: mock-engine.ts
// is deliberately free of node builtins and dependencies, so wrangler's
// esbuild takes it to workerd unchanged. One dispatch implementation serves
// both runtimes, which is what makes `sysspec mocks test` against this URL
// a real gate rather than a second opinion.
//
// Build input (see ../../.github/workflows/mocks-deploy.yml):
//   src/generated/mocks-bundle.json  <- sysspec mocks bundle --out ...
import { DurableObject } from "cloudflare:workers";
import {
  CORS_HEADERS,
  dispatch,
  matchChannel,
  PUBLISH_INTERVAL_MS,
  replay,
  type MockBundle,
} from "../../../cli/src/mock-engine.js";
import generated from "./generated/mocks-bundle.json";

const BUNDLE = generated as MockBundle;

interface Env {
  EVENTS: DurableObjectNamespace<MockEvents>;
}

/** One subscriber's event stream. Workers cannot hold a timer outside a
 * Durable Object, and each channel's publishing is independent, so the
 * object is addressed by the channel path: subscribers to one channel share
 * an object, subscribers to different channels never queue behind it. */
export class MockEvents extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const matched = matchChannel(BUNDLE, new URL(request.url).pathname);
    if (!matched) return new Response("no such channel", { status: 404 });
    const [, channel] = matched;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // First example on connect, then the minion's cadence - the same
    // sequence the local mocks publish.
    const next = replay(channel);
    const publish = () => {
      const message = next();
      if (message !== null) server.send(message);
    };
    publish();
    const timer = setInterval(publish, PUBLISH_INTERVAL_MS);
    const stop = () => clearInterval(timer);
    server.addEventListener("close", stop);
    server.addEventListener("error", stop);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!matchChannel(BUNDLE, url.pathname)) {
        return new Response("no such channel", { status: 404, headers: CORS_HEADERS });
      }
      const id = env.EVENTS.idFromName(url.pathname);
      return env.EVENTS.get(id).fetch(request);
    }

    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    const out = dispatch(BUNDLE, request.method.toUpperCase(), url.pathname, query);
    return new Response(out.status === 204 || request.method === "HEAD" ? null : out.body, {
      status: out.status,
      headers: out.headers,
    });
  },
};
