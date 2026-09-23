/** Pure helpers under the tools: JSON pointer resolution and Gherkin
 * splitting, over synthetic inputs the demo specs do not exercise. */

import { describe, expect, test } from "vitest";
import { splitGherkin } from "../src/gherkin.js";
import { resolvePointer } from "../src/pointer.js";

describe("resolvePointer", () => {
  const doc = {
    paths: { "/orders/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    "a~b": 1,
    list: ["zero", "one"],
  };

  test("~1 and ~0 escapes, numeric keys and array indexes resolve", () => {
    expect(resolvePointer(doc, "/paths/~1orders~1{id}/get/responses/200/description")).toBe("ok");
    expect(resolvePointer(doc, "/a~0b")).toBe(1);
    expect(resolvePointer(doc, "/list/1")).toBe("one");
  });

  test("inherited properties never resolve", () => {
    expect(() => resolvePointer(doc, "/constructor")).toThrow(/'constructor' not found/);
    expect(() => resolvePointer(doc, "/paths/hasOwnProperty")).toThrow(/not found/);
  });

  test("out-of-range indexes and non-pointers are rejected", () => {
    expect(() => resolvePointer(doc, "/list/2")).toThrow(/indexes 0\.\.1/);
    expect(() => resolvePointer(doc, "paths")).toThrow(/must be a JSON pointer/);
  });
});

describe("splitGherkin", () => {
  test("Example and Scenario Template open scenarios; Rule and Background close them", () => {
    const text = [
      "Feature: f",
      "",
      "  Background:",
      "    Given a shared step",
      "",
      "  Scenario: one",
      "    Given a",
      "",
      "  Rule: grouped",
      "",
      "    Background:",
      "      Given a rule step",
      "",
      "    @tagged",
      "    Example: two",
      "      Given b",
      "",
      "    Scenario Template: three <x>",
      "      Given c",
      "      Examples:",
      "        | x |",
      "        | 1 |",
      "",
    ].join("\n");
    const { header, scenarios } = splitGherkin(text);
    expect(header).toContain("Given a shared step");
    expect(scenarios.map((s) => s.name)).toEqual(["one", "two", "three <x>"]);
    // The Rule line and its Background belong to no earlier scenario.
    expect(scenarios[0].gherkin).not.toContain("Rule:");
    expect(scenarios[0].gherkin).not.toContain("a rule step");
    expect(scenarios[1].gherkin.startsWith("    @tagged")).toBe(true);
    // Examples: is part of an outline, not a new scenario.
    expect(scenarios[2].gherkin).toContain("| 1 |");
  });
});
