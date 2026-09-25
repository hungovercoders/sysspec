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
  Exit,
  git,
  isRankable,
  majorOf,
  mergeBase,
  missingBase,
  orderVersions,
  pyRepr,
  splitLines,
} from "./util.js";

export const GATED_KINDS = new Set(["asyncapi", "openapi", "data-contract", "feature"]);

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

/** How a version moved, when it did not simply go up. */
export interface NotABump {
  kind: "backwards" | "lost" | "same" | "unrankable" | "unordered";
  message: string;
}

/** Why a version change is not a plain bump, or null when it is one (or
 * did not change). A version only goes up: a downgrade would re-tag a
 * surface consumers may already have pinned. Ordering is the one both
 * version gates share (util.orderVersions). "same" is an equal version
 * respelled - harmless on its own, never the bump a change needs;
 * "unrankable" is a rankable version replaced by one no rule can rank
 * (1.2.3 -> dev, or an empty string) - the direction is lost, so it fails
 * like a downgrade; "unordered" is any other change no rule can rank
 * (from an unrankable version, or across schemes), accepted by callers
 * with a note. `what` names the version in messages. */
export function notABump(
  now: string | null,
  before: string | null,
  what = "version",
): NotABump | null {
  if (before === null || now === before) return null;
  if (now === null) return { kind: "lost", message: `lost its ${what} (was ${before})` };
  const order = orderVersions(now, before);
  if (order === null && isRankable(before) && !isRankable(now)) {
    return {
      kind: "unrankable",
      message: `${what} ${before} -> ${pyRepr(now)} is not a version any rule here can rank - versions only go up`,
    };
  }
  if (order === null) {
    return {
      kind: "unordered",
      message: `${what} ${before} -> ${now}: cannot order these versions; accepted`,
    };
  }
  if (order < 0) {
    return {
      kind: "backwards",
      message: `${what} moved backwards ${before} -> ${now} - versions only go up`,
    };
  }
  if (order === 0) {
    // The same version: the difference is build metadata or spelling
    // (a `v` prefix, 1.2 vs 1.2.0), and the message should say which.
    const build = (v: string) => v.split("+")[1] ?? "";
    return {
      kind: "same",
      message: build(before) !== build(now)
        ? `${what} ${before} -> ${now} differs only in build metadata - not a bump`
        : `${what} ${before} -> ${now} is the same version, respelled - not a bump`,
    };
  }
  return null;
}

export function runGate(base: string, specsDir: string, allowMissingBase = false): number {
  // Diff the working tree against the merge-base so the gate also bites in
  // the pre-commit hook, not only on committed CI state.
  const mb = mergeBase(base);
  if (mb === null) return missingBase(base, allowMissingBase);
  const changed = new Set(splitLines(git("diff", "--name-only", mb)));

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
      const fileChanged = changed.has(full);

      // Direction is checked for every declared version, not only when the
      // artifact's file changed: a manifest-only downgrade re-tags too. A
      // respelling of the same version is harmless on an untouched file,
      // but never counts as the bump a changed file needs.
      const wrong = notABump(versionNow, versionBefore);
      if (wrong?.kind === "unordered") {
        if (fileChanged) console.log(`note: ${full} ${wrong.message}`);
      } else if (wrong && (wrong.kind !== "same" || fileChanged)) {
        failures.push(`${full} (${kind}) ${wrong.message}`);
        continue;
      }
      if (!fileChanged) continue;
      checked += 1;

      if (versionBefore === null) {
        console.log(`new gated artifact: ${full} @ ${versionNow}`);
        artifactBumped = true;
      } else if (versionBefore === versionNow) {
        failures.push(`${full} (${kind}) changed but version stayed at ${versionBefore}`);
      } else {
        console.log(`ok: ${full} ${versionBefore} -> ${versionNow}`);
        artifactBumped = true;
        if (majorOf(versionNow) > majorOf(versionBefore)) artifactMajorBumped = true;
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
    const svcWrong = notABump(svcNow, svcBefore, "top-level version");
    if (svcWrong?.kind === "unordered") console.log(`note: ${service}: ${svcWrong.message}`);
    if (svcBefore === null && svcNow !== null) {
      if (baseText !== null) console.log(`new service version: ${service} @ ${svcNow}`);
    } else if (svcWrong && svcWrong.kind !== "unordered" && (svcWrong.kind !== "same" || artifactBumped)) {
      failures.push(`${service}: service ${svcWrong.message} - consumers pin it`);
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
      } else if (artifactMajorBumped && majorOf(svcNow) <= majorOf(svcBefore)) {
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
