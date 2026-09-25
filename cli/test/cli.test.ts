/** Dispatch through main(): help and version exit 0, stray arguments and
 * unknown subcommands are errors, and typo'd mocks subcommands leave no
 * .sysspec/ behind. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.js";
import { ownVersion } from "../src/scaffold.js";

let out: string[];
let cwd: string;
let tmp: string;

beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((m) => out.push(String(m)));
  vi.spyOn(console, "error").mockImplementation((m) => out.push(String(m)));
  cwd = process.cwd();
  tmp = mkdtempSync(path.join(tmpdir(), "sysspec-cli-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("--help and no arguments print usage and exit 0", async () => {
  expect(await main(["--help"])).toBe(0);
  expect(out.join("\n")).toContain("usage: sysspec <command>");
  out.length = 0;
  expect(await main([])).toBe(0);
  expect(out.join("\n")).toContain("usage: sysspec <command>");
});

test("<command> --help prints that command's flags", async () => {
  expect(await main(["lint", "specs", "--help"])).toBe(0);
  expect(out.join("\n")).toContain("usage: sysspec lint");
  expect(out.join("\n")).toContain("--service <name>");
  out.length = 0;
  expect(await main(["check", "-h"])).toBe(0);
  expect(out.join("\n")).toContain("--allow-missing-base");
});

test("--version prints the package version", async () => {
  expect(await main(["--version"])).toBe(0);
  expect(out).toEqual([ownVersion()]);
});

test("a stray positional argument is an error, with a hint", async () => {
  await expect(main(["lint", "specs", "orders"])).rejects.toThrow(
    "sysspec lint specs: unexpected argument 'orders' - did you mean --service?",
  );
});

test("an unknown subcommand prints the command's help and exits 2", async () => {
  expect(await main(["lint", "everything"])).toBe(2);
  expect(out.join("\n")).toContain("usage: sysspec lint");
});

test("an unknown mocks subcommand does not materialize .sysspec/", async () => {
  expect(await main(["mocks", "nope"])).toBe(2);
  expect(existsSync(path.join(tmp, ".sysspec"))).toBe(false);
});

test("a missing external tool is a setup message, not a stack trace", async () => {
  const { run, Exit } = await import("../src/util.js");
  expect(() => run(["sysspec-no-such-tool-xyz"])).toThrow(Exit);
  expect(() => run(["sysspec-no-such-tool-xyz"])).toThrow(/not installed or not on PATH - run 'mise install'/);
});

test("which searches PATH in-process", async () => {
  const { which } = await import("../src/docs-gen.js");
  expect(which("node")).toMatch(/node(\.exe)?$/);
  expect(which("sysspec-no-such-tool-xyz")).toBeNull();
});

test("flags may come before the subcommand, and a presence flag keeps the next word", async () => {
  // `--allow-missing-base version` must read as a flag and the subcommand,
  // not as the flag with the value "version".
  await expect(main(["check", "--allow-missing-base", "nope"])).resolves.toBe(2);
  expect(out.join("\n")).toContain("usage: sysspec check");
  await expect(main(["lint", "--specs-dir", "specs", "specs", "extra"])).rejects.toThrow(
    "unexpected argument 'extra'",
  );
});
