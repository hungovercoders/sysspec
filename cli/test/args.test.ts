/** The hand-rolled flag parser: value forms, defaults, and the failure
 * modes that used to pass silently (unknown flags, non-numeric ints).
 */

import { describe, expect, test } from "vitest";
import { Args } from "../src/args.js";
import { Exit } from "../src/util.js";

describe("Args", () => {
  test("--flag=value and --flag value both parse", () => {
    const args = new Args(["--base=origin/main", "--specs-dir", "specs"], "t");
    expect(args.get("base")).toBe("origin/main");
    expect(args.get("specs-dir")).toBe("specs");
  });

  test("a boolean flag followed by another flag needs a value when read", () => {
    const args = new Args(["--service", "--base", "x"], "t");
    expect(() => args.get("service")).toThrow(Exit);
  });

  test("get falls back, require throws when absent", () => {
    const args = new Args([], "t");
    expect(args.get("base", "origin/main")).toBe("origin/main");
    expect(() => args.require("org")).toThrow(/--org is required/);
  });

  test("int parses, falls back, and rejects garbage instead of NaN", () => {
    expect(new Args(["--port", "9099"], "t").int("port", 1)).toBe(9099);
    expect(new Args([], "t").int("port", 9099)).toBe(9099);
    expect(() => new Args(["--port", "nine"], "t").int("port", 1)).toThrow(
      /--port needs an integer/,
    );
  });

  test("only() rejects a typo'd flag instead of silently using defaults", () => {
    const args = new Args(["--bsae", "origin/main"], "sysspec check version");
    expect(() => args.only("base", "specs-dir")).toThrow(/unknown flag --bsae/);
  });

  test("only() accepts the declared flags", () => {
    const args = new Args(["--base", "origin/main", "--service", "orders"], "t");
    expect(() => args.only("base", "specs-dir", "service")).not.toThrow();
  });

  test("positional arguments pass through untouched", () => {
    const args = new Args(["dir-a", "--org", "com.acme", "dir-b"], "t");
    expect(args.positional).toEqual(["dir-a", "dir-b"]);
  });

  test("a presence flag never swallows the word after it", () => {
    const args = new Args(["check", "--allow-missing-base", "version"], "t");
    expect(args.bool("allow-missing-base")).toBe(true);
    expect(args.positional).toEqual(["check", "version"]);
    const trailing = new Args(["version", "--allow-missing-base", "extra"], "t");
    expect(trailing.bool("allow-missing-base")).toBe(true);
    expect(trailing.positional).toEqual(["version", "extra"]);
  });

  test("a presence flag takes an explicit true/false, and nothing else", () => {
    const off = new Args(["check", "--allow-missing-base", "false", "version"], "t");
    expect(off.bool("allow-missing-base")).toBe(false);
    expect(off.positional).toEqual(["check", "version"]);
    const on = new Args(["check", "--allow-missing-base", "true", "version"], "t");
    expect(on.bool("allow-missing-base")).toBe(true);
    expect(on.positional).toEqual(["check", "version"]);
  });
});
