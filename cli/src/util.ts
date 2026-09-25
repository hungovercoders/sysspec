/** Shared helpers for the gates. Conventions: gate verdict lines are
 * user-facing contract (the tests match on them), subprocess glue is
 * blocking, and JSON written to disk uses two-space indent with non-ASCII
 * escaped so generated artifacts are stable across environments.
 */

import { spawnSync } from "node:child_process";
import { constants } from "node:os";

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
  if (res.error) throw res.error;
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

/** True when env var `name` is set to anything but empty, "false" or
 * "0" (some tools export CI=false locally). */
export function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v !== "" && v !== "false" && v !== "0";
}

/** True when running under CI. */
export function isCI(): boolean {
  return envFlag("CI");
}

/** The diff gates' default base ref: SYSSPEC_BASE when set, else the
 * pull request's base branch on GitHub Actions (GITHUB_BASE_REF), else
 * origin/main - so a repo whose trunk is not main needs no flag. */
export function defaultBase(): string {
  const explicit = (process.env.SYSSPEC_BASE ?? "").trim();
  if (explicit) return explicit;
  const prBase = (process.env.GITHUB_BASE_REF ?? "").trim();
  return `origin/${prBase || "main"}`;
}

function refExists(ref: string): boolean {
  return run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

function inWorkTree(): boolean {
  return run(["git", "rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
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
 * Outside a git work tree (no checkout, an extracted tarball) nothing can
 * be diffed at all, so that fails too. `allow` (--allow-missing-base)
 * skips in every one of these cases, saying why. */
export function missingBase(base: string, allow: boolean): number {
  if (!inWorkTree()) {
    return skipOrFail(
      "not inside a git work tree - the diff gates need the repository's history. " +
        "Run them from a git checkout (actions/checkout with fetch-depth: 0).",
      allow,
    );
  }
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
  return skipOrFail(problem, allow);
}

function skipOrFail(problem: string, allow: boolean): number {
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

// PEP 440-style release with optional pre (a/b/rc), post and dev parts,
// in any of the spellings pip normalizes: 1.2rc1, 1.2.0-rc.1, 1.0.post2,
// 2.0.dev3. A bare dotted number (1.2, v1.2.0) is the degenerate case.
const LOOSE_RE =
  /^v?(\d+(?:\.\d+)*)(?:[-._]?(a|alpha|b|beta|c|rc|pre|preview)[-._]?(\d*))?(?:[-._]?(post|rev|r)[-._]?(\d*))?(?:[-._]?(dev)[-._]?(\d*))?$/i;

/** Sort key for a loose version, or null when it is not one. Each part
 * compares as a tuple: release numbers (zero-padded), then phase - dev <
 * pre-release < release < post-release - then the part's number. */
function looseKey(v: string): { release: number[]; phase: number[] } | null {
  const m = LOOSE_RE.exec(v.trim());
  if (!m) return null;
  const n = (x: string | undefined) => (x ? Number(x) : 0);
  const preRank: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };
  // phase: [stage, pre rank, pre number, post number, dev flag, dev number]
  // stage: -1 = dev-only release, 0 = pre-release, 1 = release. Rank and
  // number are separate fields: packed into one, b1000 would tie rc0.
  const pre = m[2] ? [0, preRank[m[2].toLowerCase()], n(m[3])] : [1, 0, 0];
  const post = m[4] ? n(m[5]) + 1 : 0;
  const dev = m[6] ? [0, n(m[7])] : [1, 0];
  const devOnly = m[6] && !m[2] && !m[4];
  return {
    release: m[1].split(".").map(Number),
    phase: devOnly ? [-1, 0, 0, 0, ...dev] : [...pre, post, ...dev],
  };
}

/** What either scheme can say about a version: its release numbers, its
 * coarse phase (0 = pre-release, 1 = release, 2 = post-release) and, for
 * a PEP 440-style version, the full phase tuple. The loose reading wins
 * where both apply (it ranks rc1 against rc2); semver-only spellings -
 * build metadata, multi-part or named pre-releases - fall back to the
 * semver reading. null when neither scheme reads it. */
function versionKey(v: string): { release: number[]; coarse: number; phase?: number[] } | null {
  const loose = looseKey(v);
  if (loose) {
    const [stage, , , post] = loose.phase;
    return { release: loose.release, coarse: stage < 1 ? 0 : post > 0 ? 2 : 1, phase: loose.phase };
  }
  const semver = parseSemver(v);
  if (semver) return { release: [...semver.core], coarse: semver.pre.length ? 0 : 1 };
  return null;
}

/** True when some ordering rule here can rank the version. */
export function isRankable(v: string): boolean {
  return versionKey(v) !== null;
}

/** Order two versions for the "versions only go up" gates: negative when
 * a < b, 0 when they are the same version however spelled (1.2 and
 * 1.2.0, v1.0.0 and 1.0.0, build metadata aside), positive when a > b.
 * Semver precedence when both are semver; otherwise release numbers
 * first, then phase (1.2 < 1.3, 1.2.3rc1 < 1.2.3 < 1.2.3.post1). null
 * when either side is unrankable, and when a semver-only pre-release
 * meets a PEP 440 one on the same release - the schemes rank
 * pre-release labels differently, and guessing could pass a downgrade. */
export function orderVersions(a: string, b: string): number | null {
  const semver = compareVersions(a, b);
  if (semver !== null) return semver;
  const [x, y] = [versionKey(a), versionKey(b)];
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.release.length, y.release.length); i++) {
    const d = (x.release[i] ?? 0) - (y.release[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.coarse !== y.coarse) return x.coarse - y.coarse;
  if (x.phase && y.phase) {
    for (let i = 0; i < x.phase.length; i++) {
      const d = x.phase[i] - y.phase[i];
      if (d !== 0) return d;
    }
    return 0;
  }
  // One side is semver-only: two releases are the same version (1.2 and
  // 1.2.0+build.5); two pre-releases cannot be ranked across schemes.
  return x.coarse === 1 ? 0 : null;
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
