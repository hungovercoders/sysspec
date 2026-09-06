/** Classify gated contract changes and require a MAJOR bump for breaking ones.
 *
 * Composes with the version gate rather than copying pizza-pattern's
 * "a version bump opts out" rule: here every gated change already requires a
 * bump, so opting out on any bump would make this gate vacuous. Instead the
 * bump's size must match the change's nature - breaking changes need a new
 * major version in the service manifest (the single source of truth).
 *
 * Classification: `oasdiff breaking` for OpenAPI; a structural diff via
 * `@asyncapi/cli diff` for AsyncAPI (removals and edits are breaking,
 * additions are fine; parser noise and prose fields are ignored). ODCS data
 * contracts and feature files have no reliable differ and stay covered by
 * the version gate alone.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ASYNCAPI_CLI } from "./pins.js";
import { blob, git, mergeBase, run, splitLines } from "./util.js";
import {
  GATED_KINDS,
  listManifests,
  major,
  manifestVersions,
  serviceVersion,
} from "./versioning.js";

const PROSE_PATH = /\/(description|summary|title)$/;

export function writeTmp(text: string, suffix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sysspec-"));
  const file = path.join(dir, `base${suffix}`);
  writeFileSync(file, text);
  return file;
}

export function removeTmp(file: string): void {
  rmSync(path.dirname(file), { recursive: true, force: true });
}

export function openapiBreaking(baseFile: string, current: string): [boolean, string] {
  const res = run(["oasdiff", "breaking", baseFile, current, "--fail-on", "ERR"]);
  return [res.status !== 0, (res.stdout + res.stderr).trim()];
}

/** The structural filter over @asyncapi/cli diff output — exported for
 * unit tests over captured diff JSON. */
export function asyncapiBad(changes: { action: string; path: string }[]): string[] {
  return changes
    .filter(
      (c) =>
        (c.action === "remove" || c.action === "edit") &&
        !c.path.includes("x-parser") &&
        !c.path.startsWith("/info/") &&
        !PROSE_PATH.test(c.path),
    )
    .map((c) => `${c.action} ${c.path}`);
}

export function asyncapiBreaking(baseFile: string, current: string): [boolean, string] {
  const res = run([
    "npx", "-y", ASYNCAPI_CLI, "diff", baseFile, current, "--format", "json", "--no-error",
  ]);
  if (res.status !== 0) {
    throw new Error(`asyncapi diff failed: ${res.stderr.trim()}`);
  }
  const bad = asyncapiBad(JSON.parse(res.stdout).changes ?? []);
  return [bad.length > 0, bad.join("\n")];
}

const CLASSIFIERS: Record<string, (base: string, current: string) => [boolean, string]> = {
  openapi: openapiBreaking,
  asyncapi: asyncapiBreaking,
};

export function runGate(base: string, only: string | null, specsDir: string): number {
  const mb = mergeBase(base);
  if (mb === null) {
    console.log(`base ref '${base}' not found - nothing to diff against, skipping.`);
    return 0;
  }
  const changed = new Set(splitLines(git("diff", "--name-only", mb)));

  const failures: string[] = [];
  let checked = 0;

  for (const manifestPath of listManifests(specsDir)) {
    const serviceDir = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
    if (only && serviceDir.split("/").pop() !== only) continue;

    const manifestText = readFileSync(manifestPath, "utf-8");
    const baseManifestText = blob(mb, manifestPath);
    const now = manifestVersions(manifestText);
    const before = manifestVersions(baseManifestText);
    let svcBreaking = false;

    for (const [rel, [kind, versionNow]] of now) {
      const full = `${serviceDir}/${rel}`;
      if (!changed.has(full) || !GATED_KINDS.has(kind)) continue;
      const baseText = blob(mb, full);
      if (baseText === null) {
        console.log(`new artifact, nothing to compare: ${full}`);
        continue;
      }
      const classify = CLASSIFIERS[kind];
      if (classify === undefined) {
        console.log(`unclassified (${kind}) - version gate only: ${full}`);
        continue;
      }

      checked += 1;
      const baseFile = writeTmp(baseText, path.extname(rel));
      let breaking: boolean, detail: string;
      try {
        [breaking, detail] = classify(baseFile, full);
      } finally {
        removeTmp(baseFile);
      }
      if (!breaking) {
        console.log(`additive ok: ${full}`);
        continue;
      }

      svcBreaking = true;
      const versionBefore = before.get(rel)?.[1] ?? null;
      if (major(versionNow) > major(versionBefore)) {
        console.log(`breaking ok (major bump ${versionBefore} -> ${versionNow}): ${full}`);
      } else {
        failures.push(
          `${full}: breaking change requires a major bump ` +
            `(version ${versionBefore} -> ${versionNow})\n` +
            splitLines(detail)
              .slice(0, 20)
              .map((line) => `    ${line}`)
              .join("\n"),
        );
      }
    }

    // A breaking artifact breaks the whole contract surface: the service
    // version consumers pin must also take a major bump.
    if (svcBreaking) {
      const svcNow = serviceVersion(manifestText);
      const svcBefore = serviceVersion(baseManifestText);
      if (svcBefore !== null && major(svcNow) <= major(svcBefore)) {
        failures.push(
          `${serviceDir}: breaking change requires a service major bump ` +
            `(version ${svcBefore} -> ${svcNow})`,
        );
      } else if (svcBefore !== null) {
        console.log(
          `breaking ok (service major bump ${svcBefore} -> ${svcNow}): ${serviceDir}`,
        );
      }
    }
  }

  if (failures.length) {
    console.error(
      "\nBreaking contract changes without a major bump:\n  " + failures.join("\n  "),
    );
    return 1;
  }
  console.log(`\n${checked} classifiable artifact(s) checked for compatibility.`);
  return 0;
}
