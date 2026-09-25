/** Require a version bump when a declared surface changes.
 *
 * A "surface" is any set of paths whose contents ship somewhere - a plugin,
 * a package, a template bundle. Any change under those paths without a
 * semver-greater version in the named file (JSON or TOML, dotted key path)
 * means installs silently lag the repo.
 */

import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { blob, git, mergeBase, missingBase, orderVersions, splitLines } from "./util.js";

/** The version string at a dotted key of a JSON or TOML file's text. */
export function versionOf(
  text: string | null,
  versionFile: string,
  key: string,
): string | null {
  if (text === null) return null;
  let doc: any = versionFile.endsWith(".toml") ? parseToml(text) : JSON.parse(text);
  for (const part of key.split(".")) doc = doc?.[part];
  // Only a scalar is a version: a key that lands on a table or object
  // must not read as "[object Object]".
  return typeof doc === "string" || typeof doc === "number" ? String(doc) : null;
}

export function runGate(
  base: string,
  versionFile: string,
  jsonKey: string,
  paths: string[],
  allowMissingBase = false,
): number {
  const mb = mergeBase(base);
  if (mb === null) return missingBase(base, allowMissingBase);
  const changed = splitLines(git("diff", "--name-only", mb)).filter((f) =>
    paths.some((p) => f.startsWith(p)),
  );
  if (changed.length === 0) {
    console.log("surface unchanged - no bump needed.");
    return 0;
  }

  const before = versionOf(blob(mb, versionFile), versionFile, jsonKey);
  const now = versionOf(readFileSync(versionFile, "utf-8"), versionFile, jsonKey);
  if (now === null) {
    console.error(`${versionFile} has no version string at '${jsonKey}'`);
    return 1;
  }
  if (before === null) {
    console.log(`new surface manifest @ ${now}`);
    return 0;
  }
  const order = orderVersions(now, before);
  if (order === null && now !== before) {
    // Same rule as check version: a change between versions this parser
    // cannot rank is accepted, and said so.
    console.log(
      `surface changed (${changed.length} file(s)), version ${before} -> ${now} - ` +
        "cannot order these versions; accepted",
    );
    return 0;
  }
  if (order !== null && order > 0) {
    console.log(
      `surface changed (${changed.length} file(s)), version ` +
        `${before} -> ${now} - ok`,
    );
    return 0;
  }

  console.error(
    "Surface changed without a version bump:\n  " +
      changed.slice(0, 20).join("\n  ") +
      `\n\n${versionFile} version is ${now} ` +
      `(base ${before}) - bump it semver-greater in ` +
      "the same change.",
  );
  return 1;
}
