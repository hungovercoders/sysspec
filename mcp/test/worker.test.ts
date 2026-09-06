/** The optional Cloudflare adapter, exercised with web-standard
 * Request/Response in-process — the same interface workerd calls.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

let worker: { fetch(req: Request): Promise<Response> };

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(here, "..", "scripts", "bundle-specs.mjs")], {
    env: { ...process.env, SPECS_DIR: path.join(repoRoot, "specs") },
  });
  worker = (await import("../adapters/cloudflare/worker.js")).default;
});

function rpc(body: object): Request {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

describe("cloudflare adapter", () => {
  test("info page and 404", async () => {
    const info = await worker.fetch(new Request("https://worker.example/"));
    expect(info.status).toBe(200);
    expect(((await info.json()) as any).endpoint).toBe("/mcp");
    const missing = await worker.fetch(new Request("https://worker.example/nope"));
    expect(missing.status).toBe(404);
  });

  test("answers a stateless tools/call", async () => {
    const init = await worker.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    );
    expect(init.status).toBe(200);

    const called = await worker.fetch(
      rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_services", arguments: {} },
      }),
    );
    expect(called.status).toBe(200);
    const payload = (await called.json()) as any;
    const services = JSON.parse(payload.result.content[0].text);
    expect(services.map((s: any) => s.name)).toContain("orders");
  });
});
