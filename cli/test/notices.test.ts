/** The third-party notices generator (scripts/third-party-notices.mjs):
 * the committed CLI bundle must yield a notices file naming every package
 * tsup inlined, with each package's own license text; the Vite plugin the
 * Astro sites rely on must keep browser-bound modules and drop server-only
 * ones without carrying state over from an earlier build; and a package
 * with no license text must fail the build rather than ship a pointer.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
// @ts-expect-error - plain ESM script, no declaration file
import { bundledPackagesPlugin, generateNotices, packageDirsFromIds } from "../../scripts/third-party-notices.mjs";

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

describe("bundledPackagesPlugin + generateNotices on a fixture site", () => {
  const site = mkdtempSync(path.join(tmpdir(), "sysspec-notices-"));
  afterAll(() => rmSync(site, { recursive: true, force: true }));

  const pkg = (name: string, manifest: Record<string, unknown>, license?: string) => {
    const dir = path.join(site, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
    if (license) writeFileSync(path.join(dir, "LICENSE"), license);
    return dir;
  };
  const alpha = pkg("alpha", { license: "MIT", author: "Alice" }, "MIT License\n\nCopyright (c) Alice\n\nPermission is hereby granted, free of charge...");
  const beta = pkg("@scope/beta", { license: "Apache-2.0", author: { name: "Bob" } });
  const serverOnly = pkg("server-only", { license: "MIT" }, "MIT License\n\nCopyright (c) Server\n\nPermission is hereby granted, free of charge...");
  const odd = pkg("odd", { license: "WTFPL", author: "Oscar" });
  const out = ".astro/bundled-packages.json";
  const outFile = path.join(site, out);

  // Two client-facing modules, a server-side stylesheet and a font (both
  // emitted as assets), and a server-only JS module that never ships.
  const clientIds = [
    path.join(alpha, "index.js") + "?astro",
    path.join(odd, "index.js"),
    path.join(site, "src/pages/index.astro"),
    "\0virtual:whatever",
  ];
  const serverIds = [
    path.join(beta, "style.css"),
    path.join(beta, "fonts/beta.woff2"),
    path.join(serverOnly, "index.js"),
    path.join(alpha, "server.js"),
  ];

  const runBuild = () => {
    const plugin = bundledPackagesPlugin({ out });
    plugin.configResolved({ root: site, build: {} });
    const ctx = (env: string, ids: string[]) => ({ environment: { name: env }, getModuleIds: () => ids });
    plugin.generateBundle.call(ctx("prerender", serverIds));
    plugin.generateBundle.call(ctx("client", clientIds));
    return JSON.parse(readFileSync(outFile, "utf8")) as string[];
  };

  test("keeps browser JS, server stylesheets and fonts; drops server-only JS and virtual modules", () => {
    const ids = runBuild();
    expect(ids).toContain(path.join(alpha, "index.js"));
    expect(ids).toContain(path.join(odd, "index.js"));
    expect(ids).toContain(path.join(beta, "style.css"));
    expect(ids).toContain(path.join(beta, "fonts/beta.woff2"));
    expect(ids.some((id) => id.includes("server-only"))).toBe(false);
    expect(ids.some((id) => id.endsWith("server.js"))).toBe(false);
    expect(ids.some((id) => id.startsWith("\0") || id.includes("src/pages"))).toBe(false);
  });

  test("a build starts from an empty set, so a previous build's packages do not linger", () => {
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify([path.join(site, "node_modules/stale-pkg/index.js")]));
    const ids = runBuild();
    expect(ids.some((id) => id.includes("stale-pkg"))).toBe(false);
  });

  test("a package with no license text fails generation unless explicitly allowed", () => {
    runBuild();
    const base = { root: site, packageLists: [out], title: "fixture" };
    expect(() => generateNotices(base)).toThrow(/odd@1\.0\.0 \(WTFPL\)/);

    const { packages, text } = generateNotices({ ...base, allowMissing: ["odd"] });
    expect(packages.map((p: { name: string }) => p.name).sort()).toEqual(["@scope/beta", "alpha", "odd"]);
    // alpha's own license file, verbatim
    expect(text).toContain("Copyright (c) Alice");
    // Apache-2.0 without a shipped file: the canonical License text, attributed
    expect(text).toContain("Copyright (c) Bob");
    expect(text).toContain("Version 2.0, January 2004");
    expect(text).toContain("END OF TERMS AND CONDITIONS");
    // ...and nobody else's copyright: the appendix keeps its placeholders
    expect(text).toContain("Copyright [yyyy] [name of copyright owner]");
    expect(text).not.toMatch(/Copyright \d{4}/);
    // the allowed one carries the pointer
    expect(text).toMatch(/odd@1\.0\.0\nLicense: WTFPL[\s\S]*ships no license file/);
  });
});
