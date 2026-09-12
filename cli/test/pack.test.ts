/** The published tarball must carry the scaffold templates intact — npm's
 * always-ignore rules (dotfiles, lockfiles) are exactly the packaging
 * hazard the undotted template names exist for, so pin what actually
 * ships.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// After a docs build, templates/init/docs-site carries a large ignored
// node_modules tree; npm pack excludes it from the tarball but still
// walks it, so this test gets its own generous timeout.
test("npm pack ships templates, lockfile and rulesets; excludes build junk", { timeout: 300_000 }, () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: pkgDir,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);

  for (const wanted of [
    "LICENSE",
    "dist/cli.mjs",
    "dist/THIRD_PARTY_NOTICES.txt",
    "templates/init/docs-site/scripts/third-party-notices.mjs",
    "templates/docker-compose.yml",
    "templates/spectral/datacontracts.yaml",
    "templates/init/gitignore",
    "templates/init/githooks/pre-commit",
    "templates/init/mcp.json",
    "templates/init/Taskfile.yml",
    "templates/init/mise.toml",
    "templates/init/renovate.json",
    "templates/init/docs-site/package-lock.json",
    "templates/init/docs-site/gitignore",
    "templates/init/specs/greeter/service.yaml",
  ]) {
    expect(files, wanted).toContain(wanted);
  }
  expect(files.some((f) => f.startsWith("templates/init/github/workflows/"))).toBe(true);
  expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  expect(files.some((f) => f.includes("/.astro/") || f.endsWith("/.astro"))).toBe(false);
  expect(files).not.toContain("templates/init/docs-site/src/data/specs.json");
});
