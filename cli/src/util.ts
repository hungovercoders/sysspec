/** Shared helpers for the gates. Conventions: gate verdict lines are
 * user-facing contract (the tests match on them), subprocess glue is
 * blocking, and JSON written to disk uses two-space indent with non-ASCII
 * escaped so generated artifacts are stable across environments.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** An error whose message is printed plainly, without a stack trace. */
export class Exit extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function run(cmd: string[], opts: { inherit?: boolean; env?: NodeJS.ProcessEnv } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const [file, ...args] = cmd;
  const res = spawnSync(file, args, {
    encoding: "utf-8",
    stdio: opts.inherit ? "inherit" : "pipe",
    env: opts.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    // A missing tool is a setup problem with a known fix, not a crash.
    if ((res.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Exit(
        `'${file}' is not installed or not on PATH - run 'mise install' ` +
          "(the repo pins its toolchain in mise.toml) and retry",
      );
    }
    throw res.error;
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** subprocess.run(..., check=True, capture_output=True).stdout */
export function git(...args: string[]): string {
  const res = run(["git", ...args]);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return res.stdout;
}

/** Content of path at ref, or null when it does not exist there. */
export function blob(ref: string, path: string): string | null {
  const res = run(["git", "show", `${ref}:${path}`]);
  return res.status === 0 ? res.stdout : null;
}

/** Merge-base of base and HEAD, or null when the base ref doesn't exist
 * (a fresh repo with no origin) - diff gates then have nothing to compare. */
export function mergeBase(base: string): string | null {
  const res = run(["git", "merge-base", base, "HEAD"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Verdict for a diff gate whose base ref is missing. Locally that is a
 * fresh repo with no origin and there is honestly nothing to compare, so
 * the gate skips. In CI (the CI env var is set) it almost always means a
 * shallow checkout, and skipping there would pass a gate that checked
 * nothing - so it fails unless the caller opts out explicitly. */
export function missingBase(base: string, allow: boolean): number {
  if (process.env.CI && !allow) {
    console.error(
      `base ref '${base}' not found - in CI a diff gate with nothing to diff ` +
        "against has checked nothing. Fetch the base (actions/checkout with " +
        "fetch-depth: 0) or pass --allow-missing-base where skipping is intended.",
    );
    return 1;
  }
  console.log(`base ref '${base}' not found - nothing to diff against, skipping.`);
  return 0;
}

/** Semver-ish comparison of dotted numeric versions: true when a is
 * strictly greater than b. Equal prefixes defer to length. */
export function greater(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}

/** "1.2.3" -> [1, 2, 3]; any pre-release or build suffix is ignored. */
export function versionParts(version: string): number[] {
  return version
    .split(/[-+]/)[0]
    .split(".")
    .map((p) => parseInt(p, 10));
}

/** Non-empty stdout lines of a git command, [] on any failure -
 * generation must degrade in a checkout without tags (a fresh scaffold,
 * a shallow CI clone) rather than fail or emit broken pages. */
export function gitLines(...args: string[]): string[] {
  const res = run(["git", ...args]);
  if (res.status !== 0) return [];
  return res.stdout.split("\n").filter((l) => l.trim());
}

/** Split into lines with no trailing empty element. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Stable JSON: two-space indent, non-ASCII escaped as \\uXXXX. */
export function pyJson(data: unknown): string {
  return JSON.stringify(data, null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** " ".join(text.split()) */
export function clean(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

export function isDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** repr()-style quoting for the messages that embed quoted values. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return String(v);
  const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of v) {
    if (ch === "\\" || ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + quote;
}

export function pySorted(items: Iterable<string>): string[] {
  return [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reverse-DNS org namespace, e.g. com.acme - the CloudEvents type prefix. */
export const ORG_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The .yaml/.yml files directly in dir, sorted; [] when dir is absent. */
export function globYaml(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Every <specsDir>/<service> directory holding a service.yaml, sorted;
 * [] when specsDir is absent. */
export function serviceDirs(specsDir: string): string[] {
  if (!isDir(specsDir)) return [];
  return readdirSync(specsDir)
    .sort()
    .map((d) => path.join(specsDir, d))
    .filter((d) => isFile(path.join(d, "service.yaml")));
}
