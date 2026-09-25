/** Shared helpers for the gates. Conventions: gate verdict lines are
 * user-facing contract (the tests match on them), subprocess glue is
 * blocking, and JSON written to disk uses two-space indent with non-ASCII
 * escaped so generated artifacts are stable across environments.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { constants } from "node:os";
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
  // A tool killed by a signal has no exit status. Report it the shell way
  // (128 + signal) rather than as 1, which callers may read as a verdict
  // - oasdiff's "breaking changes found", for one.
  if (res.status === null) {
    const signal = res.signal ?? "an unknown signal";
    const code = res.signal ? (constants.signals as Record<string, number>)[res.signal] ?? 0 : 0;
    return {
      status: 128 + code,
      stdout: res.stdout ?? "",
      stderr: `${res.stderr ?? ""}\n${file} was killed by ${signal}`.trimStart(),
    };
  }
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
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

/** True when running under CI: the CI env var is set to anything but an
 * explicit "false" or "0" (some tools export CI=false locally). */
export function isCI(): boolean {
  const v = (process.env.CI ?? "").trim().toLowerCase();
  return v !== "" && v !== "false" && v !== "0";
}

function refExists(ref: string): boolean {
  return run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

function headIsBorn(): boolean {
  return run(["git", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).status === 0;
}

function isShallow(): boolean {
  return run(["git", "rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
}

/** Verdict for a diff gate that found no merge-base with its base ref.
 * Diagnosed rather than assumed:
 *
 * - The ref exists but shares no history with HEAD: the checkout is cut
 *   short (shallow) or the histories are unrelated. Nothing to diff
 *   against is a checkout problem, so the gate fails wherever it runs.
 * - The ref does not exist: locally that is a fresh repo with no remote
 *   and there is honestly nothing to compare, so the gate skips. In CI or
 *   a shallow clone it almost always means the base was never fetched,
 *   and skipping would pass a gate that checked nothing - so it fails.
 *
 * `allow` (--allow-missing-base) skips in every case, saying why. */
export function missingBase(base: string, allow: boolean): number {
  // Before the first commit HEAD does not exist yet, so there is no
  // merge-base with anything: the working tree is all new, and there is
  // no history to diff against (the scaffold's first commit hits this).
  if (!headIsBorn()) {
    console.log("HEAD has no commits yet - nothing to diff against, skipping.");
    return 0;
  }
  const shallow = isShallow();
  let problem: string;
  if (refExists(base)) {
    problem =
      `base ref '${base}' shares no history with HEAD` +
      (shallow ? " (this is a shallow clone)" : "") +
      " - the diff gates cannot tell what changed. Fetch full history " +
      "(git fetch --unshallow, or actions/checkout with fetch-depth: 0).";
  } else if (isCI() || shallow) {
    problem =
      `base ref '${base}' not found - in ${shallow ? "a shallow clone" : "CI"} a diff ` +
      "gate with nothing to diff against has checked nothing. Fetch the base " +
      "(actions/checkout with fetch-depth: 0) or pass --allow-missing-base " +
      "where skipping is intended.";
  } else {
    console.log(`base ref '${base}' not found - nothing to diff against, skipping.`);
    return 0;
  }
  if (allow) {
    console.log(`${problem}\n--allow-missing-base: skipping.`);
    return 0;
  }
  console.error(problem);
  return 1;
}

interface Semver {
  core: [number, number, number];
  pre: string[];
}

/** Parse "1.2.3", "v1.2.3", "1.2.3-rc.1" or "1.2.3+build.5"; null for
 * anything that is not semver. Build metadata is dropped: it carries no
 * precedence. */
export function parseSemver(version: string): Semver | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    version.trim(),
  );
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver 2.0.0 precedence (section 11): negative when a < b, 0 when
 * equal, positive when a > b; null when either is not semver. A release
 * outranks its own pre-releases; numeric identifiers compare numerically
 * and rank below alphanumeric ones; build metadata is ignored. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  }
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

/** Order two versions: semver precedence when both are semver, otherwise
 * their leading dotted numbers ("1.2" < "1.3", PEP 440 "1.0.0.post1" by
 * its "1.0.0" release part). null when they cannot be ordered - no
 * numeric part on either side, or equal numbers with different spelling
 * (1.0.0 vs 1.0.0.post1) that this parser does not rank. */
export function orderVersions(a: string, b: string): number | null {
  const semver = compareVersions(a, b);
  if (semver !== null) return semver;
  const nums = (v: string) => /^v?(\d+(?:\.\d+)*)/.exec(v.trim())?.[1].split(".").map(Number) ?? null;
  const [x, y] = [nums(a), nums(b)];
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.trim() === b.trim() ? 0 : null;
}

/** Major version of a semver string; -1 when there is none to read. */
export function majorOf(version: string | null | undefined): number {
  if (!version) return -1;
  const v = parseSemver(version);
  if (v) return v.core[0];
  const n = parseInt(version.replace(/^v/, ""), 10);
  return Number.isNaN(n) ? -1 : n;
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
