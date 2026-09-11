/** The third-party notices generator (scripts/third-party-notices.mjs):
 * the committed CLI bundle must yield a notices file naming every package
 * tsup inlined, with each package's own license text, and the module-id
 * mapping the Astro sites rely on must resolve scoped and nested packages.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
// @ts-expect-error - plain ESM script, no declaration file
import { generateNotices, packageDirsFromIds } from "../../scripts/third-party-notices.mjs";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("third-party notices", () => {
  test("every package inlined into dist/cli.mjs is listed with its license text", () => {
    const bundle = readFileSync(path.join(cliDir, "dist/cli.mjs"), "utf8");
    const inlined = new Set(
      [...bundle.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)].map((m) => m[1]),
    );
    expect(inlined.size).toBeGreaterThan(0);

    const { packages, text } = generateNotices({
      root: cliDir,
      bundles: ["dist/cli.mjs"],
      title: "test",
    });
    const names = new Set(packages.map((p: { name: string }) => p.name));
    for (const name of inlined) expect(names, `${name} missing from notices`).toContain(name);
    for (const p of packages) {
      expect(p.license, `${p.name} has no license id`).not.toBe("UNKNOWN");
      expect(p.licenseText.length, `${p.name} has no license file`).toBeGreaterThan(0);
    }
    // Deterministic (the file is committed under dist/ and gated by check:cli:dist).
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).toContain("smol-toml@");
    expect(text).toContain("BSD-3-Clause");
  });

  test("the committed dist/THIRD_PARTY_NOTICES.txt matches the bundle", () => {
    const file = path.join(cliDir, "dist/THIRD_PARTY_NOTICES.txt");
    expect(existsSync(file)).toBe(true);
    const { text } = generateNotices({
      root: cliDir,
      bundles: ["dist/cli.mjs"],
      title: "the sysspec CLI (dist/cli.mjs)",
    });
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("module ids map to their package directory, scoped and nested included", () => {
    const dirs = packageDirsFromIds([
      "/p/node_modules/react/index.js",
      "/p/node_modules/@scalar/api-reference/dist/index.js?astro",
      "/p/node_modules/mermaid/node_modules/dompurify/dist/purify.es.mjs",
      "\0virtual:starlight/user-config",
      "/p/src/pages/index.astro",
    ]);
    expect([...dirs].sort()).toEqual([
      "/p/node_modules/@scalar/api-reference",
      "/p/node_modules/mermaid/node_modules/dompurify",
      "/p/node_modules/react",
    ]);
  });
});
