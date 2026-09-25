/** Pure helpers under the tools: JSON pointer resolution and Gherkin
 * splitting, over synthetic inputs the demo specs do not exercise. */

import { describe, expect, test } from "vitest";
import { getAcceptanceCriteria } from "../src/core.js";
import { splitGherkin } from "../src/gherkin.js";
import { BundledSpecSource } from "../src/source/bundle.js";
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
    // Scenarios inside the Rule carry its block; the one before it does not.
    expect(scenarios[0].rule).toBeUndefined();
    for (const s of scenarios.slice(1)) {
      expect(s.rule).toContain("Rule: grouped");
      expect(s.rule).toContain("Given a rule step");
    }
  });

  test("each Rule's Background goes with its own scenarios, never into the header", () => {
    const text = [
      "Feature: f",
      "",
      "  Rule: R1",
      "    Background:",
      "      Given B1",
      "",
      "    Scenario: s1",
      "      Given one",
      "",
      "  Rule: R2",
      "    Background:",
      "      Given B2",
      "",
      "    Scenario: s2",
      "      Given two",
      "",
    ].join("\n");
    const { header, scenarios } = splitGherkin(text);
    expect(header).toBe("Feature: f");
    const [s1, s2] = scenarios;
    expect(s1.rule).toContain("Given B1");
    expect(s1.gherkin).not.toContain("Rule: R2");
    expect(s2.rule).toContain("Rule: R2");
    expect(s2.rule).toContain("Given B2");
    expect(s2.rule).not.toContain("B1");
    expect(s2.gherkin).toBe("    Scenario: s2\n      Given two");
  });
});

describe("splitGherkin docstrings", () => {
  test("keywords inside a docstring are data, not structure", () => {
    const text = [
      "Feature: f",
      "",
      "  Rule: R1",
      "    Scenario: s1",
      '      Given the payload """',
      '      """',
      "      Rule: fake",
      "      Background: also fake",
      "      Scenario: not a scenario",
      '      """',
      "      Then done",
      "",
      "  Rule: R2",
      "    Scenario: s2",
      "      Given two",
      "",
    ].join("\n");
    const { scenarios } = splitGherkin(text);
    expect(scenarios.map((s) => s.name)).toEqual(["s1", "s2"]);
    expect(scenarios[0].gherkin).toContain("Rule: fake");
    expect(scenarios[0].gherkin).toContain("Then done");
    expect(scenarios[1].rule).toContain("Rule: R2");
    expect(scenarios[1].rule).not.toContain("fake");
  });
});

// A one-service bundle around a feature file the demo specs do not have.
function sourceWith(feature: string): BundledSpecSource {
  return new BundledSpecSource({
    services: [
      {
        dir: "svc",
        manifestYaml:
          "name: svc\nversion: 1.0.0\nartifacts:\n  - { kind: feature, path: features/f.feature, version: 1.0.0 }\n",
        files: { "features/f.feature": feature },
      },
    ],
  });
}

describe("get_acceptance_criteria budgets", () => {
  const background = "      Given " + "a long shared precondition ".repeat(40);
  const feature = [
    "Feature: f",
    "",
    "  Rule: shared",
    "    Background:",
    background,
    "",
    ...[1, 2, 3, 4, 5].flatMap((n) => [`    Scenario: match ${n}`, `      Given step ${n}`, ""]),
  ].join("\n");

  test("a Rule block shared by several matches is sent and charged once", async () => {
    const out: any = await getAcceptanceCriteria(sourceWith(feature), {
      service: "svc",
      scenario: "match",
    });
    const f = out.features[0];
    expect(f.rules).toHaveLength(1);
    expect(f.rules[0]).toContain("a long shared precondition");
    expect(f.matched).toHaveLength(5);
    for (const m of f.matched) expect(m.rule_index).toBe(0);
    expect(out.truncated).toBe(false);

    // Room for the Rule once plus every body - enough only because the
    // Rule is not charged per match.
    const bytes = (t: string) => new TextEncoder().encode(t).length;
    const need =
      bytes(f.header) + bytes(f.rules[0]) +
      f.matched.reduce((n: number, m: any) => n + bytes(m.name) + bytes(m.gherkin), 0);
    const tight: any = await getAcceptanceCriteria(sourceWith(feature), {
      service: "svc",
      scenario: "match",
      max_bytes: need,
    });
    expect(tight.truncated).toBe(false);
    expect(tight.features[0].matched.every((m: any) => m.gherkin)).toBe(true);
  });

  test("full mode's fallback index spends the budget, like names_only", async () => {
    const out: any = await getAcceptanceCriteria(sourceWith(feature), {
      service: "svc",
      max_bytes: 5,
    });
    const f = out.features[0];
    expect(out.truncated).toBe(true);
    expect(f.gherkin_omitted).toBe(true);
    expect(f.names_omitted).toBe(true);
    expect(f).not.toHaveProperty("scenarios");
    expect(f.scenario_count).toBe(5);
  });
});
