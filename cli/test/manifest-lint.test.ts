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
