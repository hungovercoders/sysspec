/** The manifest lint over the frozen fixture tree: consistent as shipped,
 * and each drift class is detected when introduced.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runLint } from "../src/manifest-lint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "tree-specs");

let tmp: string;
let specs: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sysspec-mlint-"));
  specs = path.join(tmp, "specs");
  cpSync(fixtures, specs, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureErr(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((msg) => lines.push(String(msg)));
  vi.spyOn(console, "log").mockImplementation(() => {});
  return lines;
}

test("the shipped tree lints clean", () => {
  captureErr();
  expect(runLint(null, specs)).toBe(0);
});

test("a declared artifact missing on disk is drift", () => {
  const errs = captureErr();
  unlinkSync(path.join(specs, "orders", "openapi", "orders.openapi.yaml"));
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain("declared artifact missing on disk");
});

test("a gated file on disk but not in the manifest is drift", () => {
  const errs = captureErr();
  writeFileSync(path.join(specs, "orders", "features", "phantom.feature"), "Feature: x\n");
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain("file on disk but not in manifest: features/phantom.feature");
});

test("a feature referencing an unknown message is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "features", "place-order.feature");
  writeFileSync(f, readFileSync(f, "utf-8") + '\n# see "PhantomThing"\n');
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain('references message "PhantomThing"');
});

test("consuming an unproduced channel is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "service.yaml");
  writeFileSync(
    f,
    readFileSync(f, "utf-8").replace(/^consumes:\n/m, "consumes:\n  - phantom.topic.v1\n"),
  );
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain("consumes 'phantom.topic.v1' but no service produces it");
});

test("unknown service name fails", () => {
  captureErr();
  expect(runLint("nope", specs)).toBe(1);
});

test("a relationship pointing at a column that does not exist is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "payments", "data-contracts", "payments-events.odcs.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace("properties/order_id", "properties/nope"));
  expect(runLint(null, specs)).toBe(1);
  expect(errs.join("\n")).toContain("does not exist");
});

test("a relationship pointing at a contract that is not there is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "payments", "data-contracts", "payments-events.odcs.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace("orders-events.odcs.yaml", "gone.odcs.yaml"));
  expect(runLint(null, specs)).toBe(1);
  expect(errs.join("\n")).toContain("no contract at");
});

test("a data contract whose own version drifts from the manifest is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "data-contracts", "orders-events.odcs.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^version: .*$/m, "version: 9.9.9"));
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain("!= manifest version");
});

test("a system manifest missing its domain is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "system.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^domain:.*$/m, ""));
  expect(runLint(null, specs)).toBe(1);
  expect(errs.join("\n")).toContain("domain is required");
});

test("a system manifest with a non-reverse-DNS org is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "system.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^org:.*$/m, "org: acme"));
  expect(runLint(null, specs)).toBe(1);
  expect(errs.join("\n")).toContain("org must be reverse-DNS");
});

test("a system manifest with a non-URL mcp endpoint is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "system.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^mcp:.*$/m, "mcp: specs.example.com/mcp"));
  expect(runLint(null, specs)).toBe(1);
  expect(errs.join("\n")).toContain("mcp must be the http(s) URL");
});

test("no mcp endpoint is fine - it is the one optional field", () => {
  captureErr();
  const f = path.join(specs, "system.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^mcp:.*$/m, ""));
  expect(runLint(null, specs)).toBe(0);
});

test("no system manifest at all is fine - the catalog just reads generically", () => {
  captureErr();
  unlinkSync(path.join(specs, "system.yaml"));
  expect(runLint(null, specs)).toBe(0);
});

test("a manifest name that differs from its directory is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "service.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^name: orders$/m, "name: ordering"));
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain("manifest name 'ordering' must equal its directory name 'orders'");
});

test("a manifest without a summary is drift", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "service.yaml");
  const text = readFileSync(f, "utf-8");
  // summary may be a folded block; drop it and any indented continuation.
  writeFileSync(f, text.replace(/^summary:.*\n(?:[ \t]+.*\n)*/m, ""));
  expect(runLint("orders", specs)).toBe(1);
  expect(errs.join("\n")).toContain("orders: summary is required");
});

test("two services producing the same channel is drift", () => {
  const errs = captureErr();
  const orders = readFileSync(path.join(specs, "orders", "service.yaml"), "utf-8");
  const address = /produces:\s*\n\s*-\s*([\w.-]+)/.exec(orders)![1];
  const f = path.join(specs, "payments", "service.yaml");
  writeFileSync(f, readFileSync(f, "utf-8").replace(/^produces:\s*\n/m, `produces:\n  - ${address}\n`));
  expect(runLint(null, specs)).toBe(1);
  const out = errs.join("\n");
  expect(out).toContain(`channel '${address}' is produced by orders, payments`);
  // One conflict, one message - not one per producer.
  expect(out.split(`channel '${address}'`).length - 1).toBe(1);
});

test("a copied manifest repeating another service's name still counts as a second producer", () => {
  const errs = captureErr();
  cpSync(path.join(specs, "orders"), path.join(specs, "orders-copy"), { recursive: true });
  expect(runLint(null, specs)).toBe(1);
  const out = errs.join("\n");
  // Keyed by directory, so the shared `name: orders` cannot hide it.
  expect(out).toMatch(/channel '[\w.-]+' is produced by orders, orders-copy/);
});

test("a channel listed twice in one service's produces is its own problem, not a second producer", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "service.yaml");
  const text = readFileSync(f, "utf-8");
  const address = /produces:\s*\n\s*-\s*([\w.-]+)/.exec(text)![1];
  writeFileSync(f, text.replace(/^produces:\s*\n/m, `produces:\n  - ${address}\n`));
  expect(runLint("orders", specs)).toBe(1);
  const out = errs.join("\n");
  expect(out).toContain(`orders: lists '${address}' in produces more than once`);
  expect(out).not.toContain("is produced by");
});

test("produces that is not a list is a lint problem, not a crash", () => {
  const errs = captureErr();
  const f = path.join(specs, "orders", "service.yaml");
  const text = readFileSync(f, "utf-8");
  // Replace the produces list with a mapping.
  writeFileSync(f, text.replace(/^produces:\s*\n(?:\s+-.*\n)+/m, "produces:\n  orders.placed.v2: true\n"));
  expect(() => runLint("orders", specs)).not.toThrow();
  expect(errs.join("\n")).toContain("orders: produces must be a list of channel addresses");
});
