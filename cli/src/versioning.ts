/** Fail when a gated artifact changes without its declared version moving.
 *
 * Gated artifacts are contracts of record: AsyncAPI, OpenAPI, ODCS data
 * contracts, and Gherkin feature files. Docs are ungated and free to edit.
 *
 * The manifest is the single source of truth for an artifact's version, so
 * there is no second place to forget to update.
 */

import { parse } from "yaml";
import { blob, Exit, git, mergeBase, splitLines } from "./util.js";

export const GATED_KINDS = new Set(["asyncapi", "openapi", "data-contract", "feature"]);

export function major(version: string | null | undefined): number {
  if (!version) return -1;
  return parseInt(version.split(".")[0], 10);
}

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

export function runGate(base: string, specsDir: string): number {
  // Diff the working tree against the merge-base so the gate also bites in
  // the pre-commit hook, not only on committed CI state.
  const mb = mergeBase(base);
  if (mb === null) {
    console.log(`base ref '${base}' not found - nothing to diff against, skipping.`);
    return 0;
  }
  const changed = splitLines(git("diff", "--name-only", mb));

  const failures: string[] = [];
  let checked = 0;

  for (const manifestPath of listManifests(specsDir)) {
    const serviceDir = manifestPath.slice(0, manifestPath.lastIndexOf("/"));
    const service = serviceDir.split("/").pop()!;

    const manifestText = readFileText(manifestPath);
    const baseText = blob(base, manifestPath);
    const now = manifestVersions(manifestText);
    const before = manifestVersions(baseText);

    let artifactBumped = false;
    let artifactMajorBumped = false;

    for (const [rel, [kind, versionNow]] of now) {
      const full = `${serviceDir}/${rel}`;
      if (!changed.includes(full)) continue;
      checked += 1;
      const versionBefore = before.get(rel)?.[1] ?? null;

      if (versionBefore === null) {
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
    // tagged and pinned by consumers, so it must move with its artifacts.
    const svcNow = serviceVersion(manifestText);
    const svcBefore = serviceVersion(baseText);
    if (svcBefore === null && svcNow !== null) {
      if (baseText !== null) console.log(`new service version: ${service} @ ${svcNow}`);
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

import { readFileSync } from "node:fs";
function readFileText(path: string): string {
  return readFileSync(path, "utf-8");
}
