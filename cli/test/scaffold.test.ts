/** The init scaffold: renames land, substitutions apply, refusals hold. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runInit } from "../src/scaffold.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "sysspec-init-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("scaffold writes renamed dotfiles and substituted pins", () => {
  const target = path.join(tmp, "repo");
  expect(runInit(target, "com.example", "hungovercoders/sysspec")).toBe(0);

  for (const dotfile of [".gitignore", ".gherkin-lintrc", ".spectral.yaml", ".mcp.json", ".github"]) {
    expect(existsSync(path.join(target, dotfile)), dotfile).toBe(true);
  }
  // npm's always-ignore list must not have eaten the docs-site lockfile.
  expect(existsSync(path.join(target, "docs-site", "package-lock.json"))).toBe(true);

  const ownVersion = JSON.parse(
    readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf-8"),
  ).version as string;
  const taskfile = readFileSync(path.join(target, "Taskfile.yml"), "utf-8");
  expect(taskfile).toContain(`sysspec@${ownVersion}`);
  expect(taskfile).not.toContain("__KIT_VERSION__");

  const mcp = readFileSync(path.join(target, ".mcp.json"), "utf-8");
  expect(mcp).toContain("sysspec-mcp@");
  expect(mcp).not.toContain("__MCP_VERSION__");
  expect(JSON.parse(mcp).mcpServers.sysspec.env.SPECS_DIR).toBe("specs");

  const workflows = readFileSync(path.join(target, ".github", "workflows", "ci.yml"), "utf-8");
  expect(workflows).toContain(`@v${ownVersion.split(".")[0]}`);

  // Agent entry point: canonical AGENTS.md, CLAUDE.md as a pointer to it.
  expect(readFileSync(path.join(target, "CLAUDE.md"), "utf-8")).toBe("@AGENTS.md\n");
  const agents = readFileSync(path.join(target, "AGENTS.md"), "utf-8");
  expect(agents).toContain("list_skills");
  expect(agents).not.toContain("__");

  const asyncapi = readFileSync(
    path.join(target, "specs", "greeter", "asyncapi", "greeter.asyncapi.yaml"),
    "utf-8",
  );
  expect(asyncapi).toContain("com.example");
  expect(asyncapi).not.toContain("__ORG__");
});

test("a non-reverse-DNS org is refused", () => {
  expect(() => runInit(path.join(tmp, "x"), "acme", "o/r")).toThrow("--org must be reverse-DNS");
});

test("a non-empty target is refused", () => {
  const target = path.join(tmp, "busy");
  runInit(target, "com.example", "o/r");
  expect(() => runInit(target, "com.example", "o/r")).toThrow("exists and is not empty");
});
