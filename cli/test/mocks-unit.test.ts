/** Pure pieces of the mock orchestration: the structural body matcher,
 * the info() extraction Microcks uploads depend on, service discovery, and
 * the registry-pull retry (its subprocess stubbed).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { bodyMatches, info, pull, serviceDirs } from "../src/mocks.js";
import { Exit, run } from "../src/util.js";

vi.mock("../src/util.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/util.js")>()),
  run: vi.fn(),
}));

const runMock = vi.mocked(run);
const exits = (...statuses: number[]) => {
  for (const status of statuses) {
    runMock.mockReturnValueOnce({ status, stdout: "", stderr: "" });
  }
};

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

describe("pull", () => {
  afterEach(() => {
    runMock.mockReset();
    vi.useRealTimers();
  });

  test("a registry 5xx is retried, and the run continues once it succeeds", async () => {
    vi.useFakeTimers();
    exits(1, 0);
    const pulled = pull("compose.yml");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pulled).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  test("a pull failing every attempt is an error, not a silent start", async () => {
    vi.useFakeTimers();
    exits(1, 1, 1);
    const pulled = pull("compose.yml");
    const settled = expect(pulled).rejects.toThrow(/pull failed \(exit 1\) after 3 attempts/);
    await vi.advanceTimersByTimeAsync(15000);
    await settled;
    expect(runMock).toHaveBeenCalledTimes(3);
  });

  test("a pull that works first time neither retries nor sleeps", async () => {
    exits(0);
    await pull("compose.yml");
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      ["docker", "compose", "-f", "compose.yml", "pull"],
      { inherit: true },
    );
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
