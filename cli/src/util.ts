/** Shared helpers for the gates. Conventions: gate verdict lines are
 * user-facing contract (the tests match on them), subprocess glue is
 * blocking, and JSON written to disk uses two-space indent with non-ASCII
 * escaped so generated artifacts are stable across environments.
 */

import { spawnSync } from "node:child_process";

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
