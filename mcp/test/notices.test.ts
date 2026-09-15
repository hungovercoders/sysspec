/** The committed MCP notices must cover exactly what the two shipped
 * bundles inline: every package tsup marked in dist/stdio.mjs and
 * dist/index.mjs appears with its license text, and the file is what the
 * generator produces from those bundles (so a parser regression that
 * dropped a package unique to either bundle would fail here, not only in
 * the CLI's own test).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
// @ts-expect-error - plain ESM script, no declaration file
import { generateNotices } from "../../scripts/third-party-notices.mjs";

const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundles = ["dist/stdio.mjs", "dist/index.mjs"];
const noticesFile = path.join(mcpDir, "dist/THIRD_PARTY_NOTICES.txt");

const inlinedIn = (bundle: string) =>
  new Set(
    [...readFileSync(path.join(mcpDir, bundle), "utf8").matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)].map((m) => m[1]),
  );

describe("MCP third-party notices", () => {
  test("every package inlined into either bundle is listed with its license text", () => {
    expect(existsSync(noticesFile)).toBe(true);
    const notices = readFileSync(noticesFile, "utf8");
    for (const bundle of bundles) {
      const inlined = inlinedIn(bundle);
      expect(inlined.size, `${bundle} inlines nothing?`).toBeGreaterThan(0);
      for (const name of inlined) {
        const block = notices.slice(notices.indexOf(`\n${name}@`) + 1);
        expect(block.startsWith(`${name}@`), `${name} (from ${bundle}) missing from notices`).toBe(true);
        const body = block.slice(0, block.indexOf("\n" + "-".repeat(72)));
        expect(body, `${name} has no license text`).toMatch(/Permission|Redistribution|Apache License|Licensed under/);
        expect(body).not.toMatch(/ships no license file; it is distributed under/);
      }
    }
  });

  test("the committed file is what the generator produces from both bundles", () => {
    const { packages, text } = generateNotices({
      root: mcpDir,
      bundles,
      title: "sysspec-mcp (dist/stdio.mjs, dist/index.mjs)",
    });
    expect(readFileSync(noticesFile, "utf8")).toBe(text);
    const union = new Set(bundles.flatMap((b) => [...inlinedIn(b)]));
    expect(new Set(packages.map((p: { name: string }) => p.name))).toEqual(union);
    // License text may be the package's own file or the canonical text of
    // its license (a supported path); only the --allow-missing pointer is rejected.
    expect(text).not.toMatch(/ships no license file; it is distributed under/);
    for (const p of packages) expect(p.license, `${p.name} has no license id`).not.toBe("UNKNOWN");
  });
});
