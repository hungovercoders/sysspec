/** Fail when a gated artifact changes without its declared version moving.
 *
 * Gated artifacts are contracts of record: AsyncAPI, OpenAPI, ODCS data
 * contracts, and Gherkin feature files. Docs are ungated and free to edit.
 *
 * The manifest is the single source of truth for an artifact's version, so
 * there is no second place to forget to update.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  blob,
  compareVersions,
  Exit,
  git,
  majorOf,
  mergeBase,
  missingBase,
  splitLines,
} from "./util.js";

export const GATED_KINDS = new Set(["asyncapi", "openapi", "data-contract", "feature"]);

/** Major of a version string (`v` prefix and pre-release tolerated);
 * -1 when there is none. */
export const major = majorOf;

export function listManifests(specsDir: string): string[] {
  const manifests = splitLines(git("ls-files", `${specsDir}/*/service.yaml`)).sort();
  if (manifests.length === 0) {
    throw new Exit(
      `no service manifests found under ${specsDir}/*/service.yaml - ` +
        "wrong --specs-dir, or the manifests are not committed",
    );
  }
  return manifests;
}

/** Map artifact path -> [kind, version] for gated artifacts. */
export function manifestVersions(text: string | null): Map<string, [string, string | null]> {
  const out = new Map<string, [string, string | null]>();
  if (text === null) return out;
  const doc = (parse(text) ?? {}) as Record<string, any>;
  for (const a of doc.artifacts ?? []) {
    const kind = a.kind;
    const gated = "gated" in a && a.gated !== undefined ? a.gated : GATED_KINDS.has(kind);
    if (gated) out.set(a.path, [kind, a.version != null ? String(a.version) : null]);
  }
  return out;
}

/** Top-level contract-surface version of a manifest. */
export function serviceVersion(text: string | null): string | null {
  if (text === null) return null;
  const doc = (parse(text) ?? {}) as Record<string, any>;
  return doc.version != null ? String(doc.version) : null;
}

/** Why a version change is not a bump, or null when it is one. A version
 * only goes up: a downgrade would re-tag a surface consumers may already
 * have pinned. Unparseable versions cannot be ordered, so any change to
 * one is accepted (equality was always the only check for those). */
export function notABump(now: string | null, before: string | null): string | null {
  if (before === null || now === before) return null;
  if (now === null) return `lost its version (was ${before})`;
  const cmp = compareVersions(now, before);
  if (cmp === null) {
    console.log(`note: cannot order non-semver versions ${before} -> ${now}; accepted`);
    return null;
  }
  if (cmp < 0) return `version moved backwards ${before} -> ${now} - versions only go up`;
  if (cmp === 0) {
    return `version ${before} -> ${now} has the same precedence - build metadata is not a bump`;
  }
  return null;
}

export function runGate(base: string, specsDir: string, allowMissingBase = false): number {
  // Diff the working tree against the merge-base so the gate also bites in
  // the pre-commit hook, not only on committed CI state.
  const mb = mergeBase(base);
  if (mb === null) return missingBase(base, allowMissingBase);
  const changed = splitLines(git("diff", "--name-only", mb));

  const failures: string[] = [];
  let checked = 0;

  for (const manifestPath of listManifests(specsDir)) {
    const serviceDir = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
    const service = serviceDir.split("/").pop()!;

    const manifestText = readFileSync(manifestPath, "utf-8");
    // Baseline from the merge-base, matching the diff scope above — the
    // base ref's head may have moved past it.
    const baseText = blob(mb, manifestPath);
    const now = manifestVersions(manifestText);
    const before = manifestVersions(baseText);

    let artifactBumped = false;
    let artifactMajorBumped = false;

    for (const [rel, [kind, versionNow]] of now) {
      const full = `${serviceDir}/${rel}`;
      const versionBefore = before.get(rel)?.[1] ?? null;
      const fileChanged = changed.includes(full);

      // Direction is checked for every declared version, not only when the
      // artifact's file changed: a manifest-only downgrade re-tags too.
      const wrong = before.has(rel) ? notABump(versionNow, versionBefore) : null;
      if (wrong) {
        failures.push(`${full} (${kind}) ${wrong}`);
        continue;
      }
      if (!fileChanged) continue;
      checked += 1;

      if (!before.has(rel) || versionBefore === null) {
        console.log(`new gated artifact: ${full} @ ${versionNow}`);
        artifactBumped = true;
      } else if (versionBefore === versionNow) {
        failures.push(`${full} (${kind}) changed but version stayed at ${versionBefore}`);
      } else {
        console.log(`ok: ${full} ${versionBefore} -> ${versionNow}`);
        artifactBumped = true;
        if (major(versionNow) > major(versionBefore)) artifactMajorBumped = true;
      }
    }

    // An artifact silently dropped from the manifest is also drift.
    for (const rel of before.keys()) {
      if (!now.has(rel)) {
        failures.push(`${serviceDir}/${rel} was removed from ${service}'s manifest`);
      }
    }

    // The contract surface as a whole is versioned too: it is what gets
    // tagged and pinned by consumers, so it must move with its artifacts,
    // and it never moves backwards - with or without an artifact change.
    const svcNow = serviceVersion(manifestText);
    const svcBefore = serviceVersion(baseText);
    const svcWrong = notABump(svcNow, svcBefore);
    if (svcBefore === null && svcNow !== null) {
      if (baseText !== null) console.log(`new service version: ${service} @ ${svcNow}`);
    } else if (svcWrong) {
      failures.push(
        `${service}: service ${svcWrong.replace("lost its version", "lost its top-level version")}` +
          " - consumers pin it",
      );
    } else if (artifactBumped) {
      if (svcNow === null) {
        failures.push(
          `${service}: gated artifact changed but the manifest has no top-level version`,
        );
      } else if (svcNow === svcBefore) {
        failures.push(
          `${service}: gated artifact bumped but the service version ` +
            `stayed at ${svcBefore} - bump the top-level version`,
        );
      } else if (artifactMajorBumped && major(svcNow) <= major(svcBefore)) {
        failures.push(
          `${service}: an artifact took a major bump but the service ` +
            `version only moved ${svcBefore} -> ${svcNow} - a major ` +
            "artifact change is a major surface change",
        );
      } else {
        console.log(`ok: ${service} service version ${svcBefore} -> ${svcNow}`);
      }
    }
  }

  if (failures.length) {
    console.error("\nGated artifact drift:\n  " + failures.join("\n  "));
    console.error(
      "\nBump the version in service.yaml, or revert. Contracts and " +
        "feature files are not edited to match implementations.",
    );
    return 1;
  }

  console.log(`\n${checked} gated artifact(s) changed, all versioned correctly.`);
  return 0;
}
