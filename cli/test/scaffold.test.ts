/** The init scaffold: renames land, substitutions apply, refusals hold. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SYSSPEC_MCP } from "../src/pins.js";
import { runInit } from "../src/scaffold.js";
import { compareVersions } from "../src/util.js";

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

  for (const dotfile of [".gitignore", ".gherkin-lintrc", ".spectral.yaml", ".mcp.json", ".github", ".githooks"]) {
    expect(existsSync(path.join(target, dotfile)), dotfile).toBe(true);
  }
  // The README promises the hooks; git ignores one without its execute bit.
  for (const name of ["pre-commit", "pre-push"]) {
    const hook = path.join(target, ".githooks", name);
    expect(statSync(hook).mode & 0o111, `${name} is executable`).not.toBe(0);
  }
  // The commit tier stays fast: no docs build before every commit.
  expect(readFileSync(path.join(target, ".githooks", "pre-commit"), "utf-8")).toContain("task check:fast");
  expect(readFileSync(path.join(target, "Taskfile.yml"), "utf-8")).toContain("core.hooksPath .githooks");
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

  const asyncapi = readFileSync(
    path.join(target, "specs", "greeter", "asyncapi", "greeter.asyncapi.yaml"),
    "utf-8",
  );
  expect(asyncapi).toContain("com.example");
  expect(asyncapi).not.toContain("__ORG__");
});

test("the system manifest carries the instance's own name, domain and org", () => {
  const target = path.join(tmp, "named");
  runInit(target, "com.acme", "o/r", "Acme Commerce", "Commerce");
  const system = readFileSync(path.join(target, "specs", "system.yaml"), "utf-8");
  expect(system).toContain("name: acme-commerce");
  expect(system).toContain("title: Acme Commerce");
  expect(system).toContain("domain: Commerce");
  expect(system).toContain("org: com.acme");
  expect(system).not.toContain("__SYSTEM");
  // The README heads with the same name, so the repo introduces itself.
  expect(readFileSync(path.join(target, "README.md"), "utf-8")).toContain("# Acme Commerce");
});

test("without --system the title falls back to the org's last label", () => {
  const target = path.join(tmp, "derived");
  runInit(target, "com.example", "o/r");
  const system = readFileSync(path.join(target, "specs", "system.yaml"), "utf-8");
  expect(system).toContain("title: Example");
  expect(system).toContain("name: example");
  expect(system).toContain("domain: Examples");
});

test("a non-reverse-DNS org is refused", () => {
  expect(() => runInit(path.join(tmp, "x"), "acme", "o/r")).toThrow("--org must be reverse-DNS");
});

test("a non-empty target is refused", () => {
  const target = path.join(tmp, "busy");
  runInit(target, "com.example", "o/r");
  expect(() => runInit(target, "com.example", "o/r")).toThrow("exists and is not empty");
});

test("the scaffolded sysspec-mcp pin never runs ahead of the server package", () => {
  // Scaffolds pin a *published* release; a pin above mcp/package.json names
  // a version that cannot exist yet, and every adopter's .mcp.json breaks.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const mcpPkg = JSON.parse(readFileSync(path.join(here, "..", "..", "mcp", "package.json"), "utf-8"));
  const pinned = SYSSPEC_MCP.split("@")[1];
  expect(compareVersions(pinned, mcpPkg.version), `${SYSSPEC_MCP} vs ${mcpPkg.version}`).toBeLessThanOrEqual(0);
});
