/** Pure pieces of the mock orchestration: the structural body matcher,
 * the info() extraction Microcks uploads depend on, and service discovery.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { bodyMatches, info, serviceDirs } from "../src/mocks.js";
import { Exit } from "../src/util.js";

describe("bodyMatches", () => {
  test("templated values ({{...}}) are not asserted", () => {
    expect(bodyMatches("{{uuid()}}", "anything-at-all")).toBe(true);
  });

  test("every expected key must appear, extra actual keys are fine", () => {
    expect(bodyMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(bodyMatches({ a: 1, c: 3 }, { a: 1, b: 2 })).toBe(false);
  });

  test("nested objects match recursively", () => {
    expect(bodyMatches({ a: { b: "x" } }, { a: { b: "x", c: 1 } })).toBe(true);
    expect(bodyMatches({ a: { b: "x" } }, { a: { b: "y" } })).toBe(false);
  });

  test("arrays must match length and elements in order", () => {
    expect(bodyMatches([1, 2], [1, 2])).toBe(true);
    expect(bodyMatches([1, 2], [1, 2, 3])).toBe(false);
    expect(bodyMatches([1, 2], [2, 1])).toBe(false);
    expect(bodyMatches([{ a: "{{now()}}" }], [{ a: "2026-01-01" }])).toBe(true);
  });

  test("scalars compare strictly", () => {
    expect(bodyMatches(1, "1")).toBe(false);
    expect(bodyMatches(null, null)).toBe(true);
    expect(bodyMatches({ a: 1 }, null)).toBe(false);
  });
});

describe("info", () => {
  test("returns title and version as strings", () => {
    expect(info({ info: { title: "Orders", version: 3 } })).toEqual(["Orders", "3"]);
  });

  test("a spec without info.title or info.version is an error, not a TypeError", () => {
    expect(() => info({})).toThrow(Exit);
    expect(() => info({ info: { version: "1.0.0" } })).toThrow(/info\.title/);
    expect(() => info({ info: { title: "Orders" } })).toThrow(/info\.version/);
  });
});

describe("serviceDirs", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "sysspec-mocks-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test("finds only directories carrying a service.yaml, honoring the filter", () => {
    for (const name of ["orders", "payments"]) {
      mkdirSync(path.join(scratch, name), { recursive: true });
      writeFileSync(path.join(scratch, name, "service.yaml"), "name: " + name + "\n");
    }
    mkdirSync(path.join(scratch, "not-a-service"), { recursive: true });
    expect(serviceDirs(scratch, null).map((d) => path.basename(d))).toEqual([
      "orders",
      "payments",
    ]);
    expect(serviceDirs(scratch, "orders").map((d) => path.basename(d))).toEqual(["orders"]);
  });

  test("no match is an error, not an empty loop", () => {
    expect(() => serviceDirs(scratch, "nope")).toThrow(/no services matching 'nope'/);
    expect(() => serviceDirs(path.join(scratch, "absent"), null)).toThrow(Exit);
  });
});
