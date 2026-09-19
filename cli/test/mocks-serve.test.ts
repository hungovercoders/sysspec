/** The served mocks: what the bundle builder refuses, how dispatch picks a
 * case, and that a real server answers on the Microcks URL shapes (the
 * shapes are the contract between this engine and `mocks test`, so they are
 * asserted here as well as by the smoke suite in CI).
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe as suite, expect, test } from "vitest";
import { dispatch, matchChannel, restBase } from "../src/mock-engine.js";
import { buildBundle, runBundle, serve } from "../src/mocks-serve.js";
import { Exit } from "../src/util.js";

const FIXTURES = path.join(__dirname, "fixtures");
const temps: string[] = [];

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A writable copy of the fixture tree, so a test can break one example. */
function tree(): { specs: string; mocks: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "sysspec-mocks-"));
  temps.push(dir);
  cpSync(path.join(FIXTURES, "tree-specs"), path.join(dir, "specs"), { recursive: true });
  cpSync(path.join(FIXTURES, "tree-mocks"), path.join(dir, "mocks"), { recursive: true });
  return { specs: path.join(dir, "specs"), mocks: path.join(dir, "mocks") };
}

function patch(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf-8");
  expect(text).toContain(from);
  writeFileSync(file, text.replace(from, to));
}

const build = (t: { specs: string; mocks: string }) => buildBundle(null, t.specs, t.mocks);

suite("buildBundle", () => {
  test("REST and event mocks are separate services, as Microcks sees them", () => {
    const { bundle, gaps } = build(tree());
    expect(bundle.services.map((s) => `${s.kind} ${s.title} ${s.version}`)).toEqual([
      "rest Orders API 3.1.0",
      "events Orders 3.0.0",
      "events Payments 2.0.0",
    ]);
    expect(gaps).toEqual([]);
  });

  test("routes carry every example case, with its status and dispatch parameters", () => {
    const { bundle } = build(tree());
    const rest = bundle.services.find((s) => s.kind === "rest")!;
    const get = rest.routes.find((r) => r.path === "/orders/{order_id}")!;
    expect(get.method).toBe("GET");
    expect(get.cases).toEqual([
      expect.objectContaining({
        name: "placed",
        status: 200,
        pathParams: { order_id: "11111111-1111-1111-1111-111111111111" },
        query: {},
      }),
    ]);
  });

  test("an example for an operation no contract declares is refused", () => {
    const t = tree();
    patch(path.join(t.mocks, "orders.rest.examples.yaml"), "'POST /orders':", "'POST /invoices':");
    expect(() => build(t)).toThrow(Exit);
    expect(() => build(t)).toThrow(/not in the contract/);
  });

  test("an event example for an operation no contract declares is refused", () => {
    const t = tree();
    patch(
      path.join(t.mocks, "orders.events.examples.yaml"),
      "'SEND publishOrderPlaced':",
      "'SEND publishOrderInvented':",
    );
    expect(() => build(t)).toThrow(/declares\s+no send operation/);
  });

  test("templated payloads are refused rather than served differently", () => {
    const t = tree();
    patch(
      path.join(t.mocks, "orders.rest.examples.yaml"),
      '"order_id": "11111111-1111-1111-1111-111111111111",\n            "customer_id"',
      '"order_id": "{{uuid()}}",\n            "customer_id"',
    );
    expect(() => build(t)).toThrow(/templating is not supported/);
  });

  test("cases a URI cannot tell apart are refused", () => {
    const t = tree();
    const file = path.join(t.mocks, "orders.rest.examples.yaml");
    const text = readFileSync(file, "utf-8");
    // A second case on POST /orders, which declares no dispatching parameter.
    writeFileSync(file, text.replace("  'GET /orders/{order_id}':", `    rejected:
      response:
        status: "400"
        mediaType: application/json
        body: |-
          {"error_code": "invalid_order"}
  'GET /orders/{order_id}':`));
    expect(() => build(t)).toThrow(/dispatch identically/);
  });

  test("an examples file naming no spec is refused", () => {
    const t = tree();
    patch(path.join(t.mocks, "orders.rest.examples.yaml"), "version: 3.1.0", "version: 9.9.9");
    expect(() => build(t)).toThrow(/which no spec in/);
  });

  test("a spec with no examples is a gap, not a failure", () => {
    const t = tree();
    rmSync(path.join(t.mocks, "payments.events.examples.yaml"));
    const { bundle, gaps } = build(t);
    expect(bundle.services.some((s) => s.title === "Payments")).toBe(false);
    expect(gaps).toEqual([expect.stringMatching(/no event examples for Payments 2\.0\.0/)]);
  });
});

suite("runBundle", () => {
  test("writes the bundle, creating the output directory", () => {
    const t = tree();
    // A deploy bakes the bundle into a gitignored directory, which a fresh
    // checkout does not have.
    const out = path.join(path.dirname(t.specs), "deploy", "generated", "mocks-bundle.json");
    expect(existsSync(path.dirname(out))).toBe(false);
    expect(runBundle(null, t.specs, t.mocks, out, "abc123")).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf-8"));
    expect(written.source).toBe("abc123");
    expect(written.services).toHaveLength(3);
  });
});

suite("dispatch", () => {
  const bundle = () => build(tree()).bundle;
  const base = (b = bundle()) => restBase(b.services.find((s) => s.kind === "rest")!);

  test("a path parameter selects its case", () => {
    const b = bundle();
    const res = dispatch(b, "GET", `${base(b)}/orders/11111111-1111-1111-1111-111111111111`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("placed");
  });

  test("a title may arrive plus-encoded or percent-encoded", () => {
    const b = bundle();
    for (const title of ["Orders+API", "Orders%20API"]) {
      expect(dispatch(b, "POST", `/rest/${title}/3.1.0/orders`).status).toBe(201);
    }
  });

  test("a request no example dispatches is a 404 that names the cases", () => {
    const b = bundle();
    const res = dispatch(b, "GET", `${base(b)}/orders/nope`);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).cases).toHaveLength(1);
  });

  test("an unmocked operation and an unknown service are distinct 404s", () => {
    const b = bundle();
    expect(JSON.parse(dispatch(b, "DELETE", `${base(b)}/orders`).body).error).toMatch(
      /no mocked operation/,
    );
    expect(JSON.parse(dispatch(b, "GET", "/rest/Ledger/1.0.0/entries").body).error).toMatch(
      /No mock service/,
    );
  });

  test("preflight and CORS headers let a browser consumer call the mocks", () => {
    const b = bundle();
    const pre = dispatch(b, "OPTIONS", `${base(b)}/orders`);
    expect(pre.status).toBe(204);
    expect(pre.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(dispatch(b, "POST", `${base(b)}/orders`).headers["Access-Control-Allow-Origin"]).toBe(
      "*",
    );
  });

  test("the root path describes what is mocked", () => {
    const b = bundle();
    const index = JSON.parse(dispatch(b, "GET", "/").body);
    expect(index.services.map((s: { title: string }) => s.title)).toContain("Orders API");
  });

  test("event channels match on the minion's own path shape", () => {
    const b = bundle();
    expect(matchChannel(b, "/api/ws/Orders/3.0.0/publishOrderPlaced")).not.toBeNull();
    expect(matchChannel(b, "/api/ws/Orders/3.0.0/publishNothing")).toBeNull();
    expect(matchChannel(b, "/api/ws/Orders/3.0.0")).toBeNull();
  });
});

suite("serve", () => {
  test("answers REST over HTTP and publishes examples over WebSocket", async () => {
    const { bundle } = build(tree());
    const server = await serve(bundle, 0, "127.0.0.1", 50);
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/rest/Orders+API/3.1.0/orders`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(201);
      expect((await res.json()).order_id).toBe("11111111-1111-1111-1111-111111111111");

      const { default: WebSocket } = await import("ws");
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/ws/Orders/3.0.0/publishOrderPlaced`,
      );
      const message = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no event published")), 5000);
        ws.on("message", (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
        ws.on("error", reject);
      });
      ws.close();
      expect(JSON.parse(message).type).toContain("orders.placed");

      const missed = new WebSocket(`ws://127.0.0.1:${port}/api/ws/Orders/3.0.0/nope`);
      await expect(
        new Promise((_, reject) => missed.on("error", reject)),
      ).rejects.toThrow(/404/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
