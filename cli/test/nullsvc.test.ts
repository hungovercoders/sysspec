/** The falsifiability gate: hollow passes go red, honest failures go
 * green, and the end-to-end run serves 200 {} while the suite runs.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { check, passedScenarios, runNull } from "../src/nullsvc.js";

let tmp: string;
let logs: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sysspec-null-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const hollow = [
  {
    uri: "features/hollow.feature",
    elements: [
      { type: "scenario", name: "empty stub passes", line: 3, steps: [{ result: { status: "passed" } }] },
    ],
  },
];
const honest = [
  {
    uri: "features/honest.feature",
    elements: [
      { type: "scenario", name: "real assertion fails", line: 3, steps: [{ result: { status: "failed" } }] },
    ],
  },
];

test("passedScenarios counts fully-passing scenarios only", () => {
  expect(passedScenarios(hollow)).toEqual([["features/hollow.feature:3 empty stub passes"], 1]);
  expect(passedScenarios(honest)).toEqual([[], 1]);
  expect(passedScenarios([{ elements: [{ type: "background", steps: [] }] }])).toEqual([[], 0]);
});

test("check: hollow results are red, honest results green, junk is red", () => {
  const f = path.join(tmp, "r.json");
  writeFileSync(f, JSON.stringify(hollow));
  expect(check(f)).toBe(1);
  writeFileSync(f, JSON.stringify(honest));
  expect(check(f)).toBe(0);
  writeFileSync(f, "not json");
  expect(check(f)).toBe(1);
  writeFileSync(f, "{}");
  expect(check(f)).toBe(1);
  expect(check(path.join(tmp, "missing.json"))).toBe(1);
});

test("runNull serves 200 {} and judges the suite's results", async () => {
  const results = path.join(tmp, "out.json");
  const script = path.join(tmp, "suite.mjs");
  writeFileSync(
    script,
    `const resp = await fetch("http://127.0.0.1:19917/anything", { method: "POST", body: "x" });
const body = await resp.text();
if (resp.status !== 200 || body !== "{}") process.exit(3);
const { writeFileSync } = await import("node:fs");
writeFileSync(${JSON.stringify(results)}, JSON.stringify(${JSON.stringify(honest)}));
process.exit(1);`,
  );
  expect(await runNull(19917, results, 60, [process.execPath, script])).toBe(0);
  expect(logs.join("\n")).toContain("suite exited 1 (non-zero expected here)");
  expect(logs.join("\n")).toContain("the suite is falsifiable");
});

test("runNull without a suite command is red", async () => {
  expect(await runNull(19918, path.join(tmp, "r.json"), 5, [])).toBe(1);
});
