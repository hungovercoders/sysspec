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
 * additions are fine; parser noise and prose fields are ignored);
 * `datacontract breaking` for ODCS data contracts, which since ODCS 3.2
 * sees removed columns *and* removed enum values. Feature files have no
 * reliable differ and stay covered by the version gate alone.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { ASYNCAPI_CLI, DATACONTRACT_CLI } from "./pins.js";
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

/** The JSON document in `@asyncapi/cli diff` stdout, skipping any prose
 * the CLI prints ahead of it — exported for unit tests. */
export function parseAsyncapiDiff(stdout: string): Record<string, any>[] {
  // A prose line can start with a bracket too ("[asyncapi] ..."), so each
  // candidate is tried as the document start and skipped when it is not.
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[{[]/.test(lines[i])) continue;
    try {
      const doc = JSON.parse(lines.slice(i).join("\n"));
      if (doc && typeof doc === "object") return doc.changes ?? [];
    } catch {
      // not the document yet
    }
  }
  throw new Error(`asyncapi diff produced no JSON: ${stdout.trim()}`);
}

/** Structural changes between two AsyncAPI documents, via `@asyncapi/cli diff`.
 *
 * The CLI records anonymous adoption metrics and, when that fails (a
 * runner whose egress cannot reach its metrics API), logs the failure to
 * stdout ahead of the JSON — as it does its first-run notice. CI=true is
 * the CLI's own off-switch for both; the parse tolerates prose before the
 * document regardless. */
export function asyncapiChanges(baseFile: string, current: string): Record<string, any>[] {
  const res = run(
    ["npx", "-y", ASYNCAPI_CLI, "diff", baseFile, current, "--format", "json", "--no-error"],
    { env: { ...process.env, CI: "true" } },
  );
  if (res.status !== 0) {
    throw new Error(`asyncapi diff failed: ${res.stderr.trim()}`);
  }
  return parseAsyncapiDiff(res.stdout);
}

export function asyncapiBreaking(baseFile: string, current: string): [boolean, string] {
  const bad = asyncapiBad(asyncapiChanges(baseFile, current) as { action: string; path: string }[]);
  return [bad.length > 0, bad.join("\n")];
}

/** The ERROR rows of a `datacontract breaking` report, unboxed.
 *
 * The tool prints two rich tables: a summary, which rolls a child's
 * severity up onto its parent path (so a removed enum value also lights
 * up the column above it), and the details, which names each breaking
 * change once. Only the details are read, so the failure message says
 * what actually broke rather than what contains it. Exported for unit
 * tests over captured output.
 */
export function odcsBreakingDetail(output: string): string[] {
  const seen = new Set<string>();
  let inDetails = false;
  for (const line of splitLines(output)) {
    if (/^\s*Details\s*$/.test(line)) {
      inDetails = true;
      continue;
    }
    if (!inDetails || !/│\s*ERROR\s*│/.test(line)) continue;
    // Severity │ Change │ Path │ Old Value │ New Value │ Message. Rich
    // truncates the narrow columns; Path and Old Value are what identify
    // the change, and they are the ones it keeps whole.
    const cells = line.split("│").map((c) => c.trim());
    const severity = cells.indexOf("ERROR");
    const path = cells[severity + 2];
    const oldValue = cells[severity + 3];
    if (!path) continue;
    const detail = oldValue ? `${path} (was ${oldValue})` : path;
    if (!seen.has(detail)) seen.add(detail);
  }
  return [...seen];
}

/** A controlled vocabulary, wherever the document happens to put it.
 *
 * Before ODCS 3.2 the only way to declare one was a `validValues` quality
 * rule; 3.2 made `enum` first class. They say the same thing, so both
 * sides of a diff are normalised to the 3.2 spelling first - otherwise
 * moving a vocabulary from one to the other reads as "a constraint
 * appeared", which the differ rightly calls breaking, for a change that
 * constrains nothing that was not already constrained. Exported for unit
 * tests.
 */
export function normalizeOdcs(text: string): string {
  const doc = (parse(text) ?? {}) as Record<string, any>;
  for (const obj of doc.schema ?? []) {
    for (const p of obj.properties ?? []) {
      const quality: Record<string, any>[] = p.quality ?? [];
      const vocab = quality.find((q) => Array.isArray(q?.validValues));
      if (!vocab) continue;
      if (!p.enum) p.enum = vocab.validValues.map((value: unknown) => ({ value }));
      p.quality = quality.filter((q) => q !== vocab);
      if (p.quality.length === 0) delete p.quality;
    }
  }
  return stringify(doc);
}

/** Breaking-change classification for ODCS data contracts.
 *
 * `datacontract breaking` exits 0 when every change is compatible and 1
 * when any is not; it understands the 3.2 shapes, so a removed column and
 * a removed enum value both land here. Any other exit is the differ
 * itself failing, which must be loud rather than a silent pass.
 *
 * `--no-inline-references` keeps the gate hermetic: without it the tool
 * resolves external `authoritativeDefinitions` over the network, and a
 * gate that needs the internet to agree with itself is not a gate.
 */
export function odcsBreaking(baseFile: string, current: string): [boolean, string] {
  const base = writeTmp(normalizeOdcs(readFileSync(baseFile, "utf-8")), ".yaml");
  const head = writeTmp(normalizeOdcs(readFileSync(current, "utf-8")), ".yaml");
  let res;
  try {
    res = run([
      "uvx",
      "--from",
      DATACONTRACT_CLI,
      "datacontract",
      "breaking",
      "--no-inline-references",
      base,
      head,
    ]);
  } finally {
    removeTmp(base);
    removeTmp(head);
  }
  const output = res.stdout + res.stderr;
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`datacontract breaking failed (exit ${res.status}): ${output.trim()}`);
  }
  if (res.status === 0) return [false, ""];
  const detail = odcsBreakingDetail(output);
  return [true, (detail.length ? detail.join("\n") : output).trim()];
}

const CLASSIFIERS: Record<string, (base: string, current: string) => [boolean, string]> = {
  openapi: openapiBreaking,
  asyncapi: asyncapiBreaking,
  "data-contract": odcsBreaking,
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
