/** Golden test for the docs data emitter: a frozen copy of the living
 * spec tree, rendered in a fresh git repo (no release tags, so the
 * changelog branch is deterministic), must produce byte-identical
 * specs.json to the frozen snapshot (test/fixtures/expected-specs.json).
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const cliEntry = path.join(here, "..", "dist", "cli.mjs");

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sysspec-golden-"));
  cpSync(path.join(fixtures, "tree-specs"), path.join(tmp, "specs"), { recursive: true });
  cpSync(path.join(fixtures, "tree-mocks"), path.join(tmp, "mocks"), { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: tmp });
  execFileSync("git", ["add", "-A"], { cwd: tmp });
  execFileSync(
    "git",
    ["-c", "user.email=t@e.c", "-c", "user.name=t", "commit", "-qm", "fixture"],
    { cwd: tmp },
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("docs data emits byte-identical specs.json to the golden snapshot", () => {
  execFileSync(process.execPath, [cliEntry, "docs", "data", "--site-dir", "site"], {
    cwd: tmp,
  });
  const emitted = readFileSync(path.join(tmp, "site", "src", "data", "specs.json"), "utf-8");
  const expected = readFileSync(path.join(fixtures, "expected-specs.json"), "utf-8");
  expect(emitted).toBe(expected);
});

test("docs data copies raw artifacts under public/specs", () => {
  const copied = path.join(tmp, "site", "public", "specs", "orders", "openapi", "orders.openapi.yaml");
  const original = path.join(tmp, "specs", "orders", "openapi", "orders.openapi.yaml");
  expect(readFileSync(copied, "utf-8")).toBe(readFileSync(original, "utf-8"));
});
