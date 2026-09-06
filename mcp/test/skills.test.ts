/** The skills tools serve the baked-in bundle — source-independent (no
 * SpecSource), so this suite runs once, not per spec source.
 */

import { describe, expect, test } from "vitest";
import { getSkill, listSkills } from "../src/skills.js";

const NAMES = ["consume-service", "implement-service", "sysspec"];

describe("list_skills", () => {
  test("names and descriptions only, no bodies", () => {
    const out: any = listSkills();
    expect(out.map((s: any) => s.name).sort()).toEqual(NAMES);
    for (const s of out) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.total_bytes).toBeGreaterThan(0);
      expect(s).not.toHaveProperty("body");
      expect(s).not.toHaveProperty("content");
    }
  });

  test("companion files are listed", () => {
    const out: any = listSkills();
    const impl = out.find((s: any) => s.name === "implement-service");
    expect(impl.files).toContain("templates/renovate.json");
    expect(impl.files).toContain("templates/contract-converge.yml");
  });
});

describe("get_skill", () => {
  test("returns the full markdown body", () => {
    const out: any = getSkill({ name: "implement-service" });
    expect(out.content).toContain("# Implement a sysspec service");
    expect(out.truncated).toBe(false);
    expect(out.file).toBeNull();
    expect(out.files).toContain("templates/renovate.json");
  });

  test("unknown skill lists the available names", () => {
    expect(() => getSkill({ name: "nope" })).toThrow(
      "No skill 'nope'. Available: ['consume-service', 'implement-service', 'sysspec']",
    );
  });

  test("truncates honestly at max_bytes", () => {
    const out: any = getSkill({ name: "sysspec", max_bytes: 200 });
    expect(out.truncated).toBe(true);
    expect(new TextEncoder().encode(out.content).length).toBeLessThanOrEqual(200);
    expect(out.total_bytes).toBeGreaterThan(200);
    expect(out.note).toContain("max_bytes");
  });

  test("fetches one companion file", () => {
    const out: any = getSkill({ name: "implement-service", file: "templates/renovate.json" });
    expect(out.file).toBe("templates/renovate.json");
    expect(() => JSON.parse(out.content)).not.toThrow();
  });

  test("unknown companion file lists the available ones", () => {
    expect(() => getSkill({ name: "implement-service", file: "nope.yml" })).toThrow(/Files:/);
  });
});
