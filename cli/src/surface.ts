/** Require a version bump when a declared surface changes.
 *
 * A "surface" is any set of paths whose contents ship somewhere - a plugin,
 * a package, a template bundle. Any change under those paths without a
 * semver-greater version in the named file (JSON or TOML, dotted key path)
 * means installs silently lag the repo.
 */

import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { blob, git, mergeBase, splitLines } from "./util.js";

export function versionOf(
  text: string | null,
  versionFile: string,
  key: string,
): number[] | null {
  if (text === null) return null;
  let doc: any = versionFile.endsWith(".toml") ? parseToml(text) : JSON.parse(text);
  for (const part of key.split(".")) doc = doc[part];
  return String(doc)
    .split(".")
    .map((p) => parseInt(p, 10));
}

/** Element-wise version comparison; equal prefixes defer to length. */
function greater(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}

const dotted = (v: number[]) => v.join(".");

export function runGate(
  base: string,
  versionFile: string,
  jsonKey: string,
  paths: string[],
): number {
  const mb = mergeBase(base);
  if (mb === null) {
    console.log(`base ref '${base}' not found - nothing to diff against, skipping.`);
    return 0;
  }
  const changed = splitLines(git("diff", "--name-only", mb)).filter((f) =>
    paths.some((p) => f.startsWith(p)),
  );
  if (changed.length === 0) {
    console.log("surface unchanged - no bump needed.");
    return 0;
  }

  const before = versionOf(blob(mb, versionFile), versionFile, jsonKey);
  const now = versionOf(readFileSync(versionFile, "utf-8"), versionFile, jsonKey)!;
  if (before === null) {
    console.log(`new surface manifest @ ${dotted(now)}`);
    return 0;
  }
  if (greater(now, before)) {
    console.log(
      `surface changed (${changed.length} file(s)), version ` +
        `${dotted(before)} -> ${dotted(now)} - ok`,
    );
    return 0;
  }

  console.error(
    "Surface changed without a version bump:\n  " +
      changed.slice(0, 20).join("\n  ") +
      `\n\n${versionFile} version is ${dotted(now)} ` +
      `(base ${dotted(before)}) - bump it semver-greater in ` +
      "the same change.",
  );
  return 1;
}
