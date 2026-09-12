/** Require every added schema element to be named in the service's features.
 *
 * A schema addition carries intent: nobody adds a message, payload property,
 * endpoint or parameter hoping it stays unused. The compat gate rightly passes
 * additions, so without this gate that intent rots silently. Every element
 * added versus the base ref must appear, by name, somewhere in the service's
 * feature files. There is no escape hatch: if it is not worth a scenario, it
 * is not worth adding to the contract yet.
 *
 * Known limitation: new enum values are not gated (they carry no unique name).
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { asyncapiChanges, removeTmp, writeTmp } from "./compat.js";
import { blob, git, isDigits, mergeBase, run, splitLines } from "./util.js";
import { listManifests, manifestVersions } from "./versioning.js";

const BACKTICK = /`([^`]+)`/g;
const PROSE_SUFFIX = /\/(description|summary|title|examples)$/;

// oasdiff names a nested request property by its path -
// `lines/items/unit_price_pence` - where a top-level one comes through bare.
// Gate each property name along that path rather than the path itself, which
// no scenario would ever contain. This is what the AsyncAPI branch already
// does; these are the structural keywords that are not property names.
const SCHEMA_KEYWORDS = new Set([
  "items", "properties", "additionalProperties", "allOf", "anyOf", "oneOf", "not",
]);

export function pathNames(token: string): Set<string> {
  return new Set(
    token.split("/").filter((s) => s && !SCHEMA_KEYWORDS.has(s) && !isDigits(s)),
  );
}

// oasdiff changelog check ids that introduce a named element, and where the
// name lives. "backtick" means the last backtick-quoted token in the text
// (the first can be the parameter location).
const OASDIFF_GATED: Record<string, string> = {
  "endpoint-added": "operationId",
  "new-optional-request-property": "backtick",
  "new-required-request-property": "backtick",
  "new-required-request-property-with-default": "backtick",
  "response-optional-property-added": "backtick",
  "response-required-property-added": "backtick",
  "new-optional-request-parameter": "backtick",
  "new-required-request-parameter": "backtick",
};

/** A synthetic empty spec so a brand-new file gates everything it adds. */
export function emptyBase(kind: string, currentText: string): string {
  const doc = (parse(currentText) ?? {}) as Record<string, any>;
  const skeleton =
    kind === "openapi"
      ? { openapi: doc.openapi ?? "3.0.3", info: doc.info ?? {}, paths: {} }
      : {
          asyncapi: doc.asyncapi ?? "3.0.0",
          info: doc.info ?? {},
          channels: {},
          operations: {},
          components: { messages: {} },
        };
  return stringify(skeleton);
}

/** Token extraction from oasdiff changelog entries — exported for unit
 * tests over captured changelog JSON. */
export function openapiTokens(entries: Record<string, any>[]): Set<string> {
  const tokens = new Set<string>();
  for (const entry of entries) {
    const source = OASDIFF_GATED[entry.id];
    if (source === undefined) continue;
    if (source === "operationId") {
      tokens.add(entry.operationId || entry.path || "");
    } else {
      const ticks = [...String(entry.text ?? "").matchAll(BACKTICK)].map((m) => m[1]);
      if (ticks.length) {
        for (const t of pathNames(ticks[ticks.length - 1])) tokens.add(t);
      }
    }
  }
  tokens.delete("");
  return tokens;
}

export function openapiAdded(baseFile: string, current: string): Set<string> {
  const res = run(["oasdiff", "changelog", baseFile, current, "--format", "json"]);
  if (res.status !== 0) throw new Error(`oasdiff changelog failed: ${res.stderr.trim()}`);
  return openapiTokens(JSON.parse(res.stdout || "[]") ?? []);
}

/** Token extraction from @asyncapi/cli diff changes — exported for unit
 * tests over captured diff JSON. */
export function asyncapiTokens(
  changes: Record<string, any>[],
  channels: Record<string, any>,
): Set<string> {
  const tokens = new Set<string>();
  for (const c of changes) {
    const p: string = c.path ?? "";
    if (c.action !== "add") continue;
    if (
      p.includes("x-parser") ||
      p.startsWith("/info") ||
      p.startsWith("/servers") ||
      p.startsWith("/tags") ||
      p.startsWith("/defaultContentType") ||
      p.startsWith("/operations/") || // wiring; its channel and message are gated
      p.includes("/bindings") ||
      p.includes("/required/") || // accompanies a property add, which is gated
      p.includes("/enum/") ||
      PROSE_SUFFIX.test(p)
    ) {
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/components\/messages\/([^/]+)$/))) {
      tokens.add(m[1]);
    } else if ((m = p.match(/^\/channels\/([^/]+)$/))) {
      tokens.add(channels[m[1]]?.address || m[1]);
    } else if (p.includes("/payload/")) {
      // Every property name after the payload, nested included. The
      // same add echoes under channels/operations/components - the set
      // dedupes it.
      const segments = p.split("/");
      const payloadAt = segments.indexOf("payload");
      for (let i = payloadAt; i < segments.length - 1; i++) {
        if (segments[i] === "properties") tokens.add(segments[i + 1]);
      }
    }
  }
  tokens.delete("");
  return tokens;
}

export function asyncapiAdded(baseFile: string, current: string): Set<string> {
  const channels =
    ((parse(readFileSync(current, "utf-8")) ?? {}) as Record<string, any>).channels ?? {};
  return asyncapiTokens(asyncapiChanges(baseFile, current), channels);
}

const ADDED: Record<string, (base: string, current: string) => Set<string>> = {
  openapi: openapiAdded,
  asyncapi: asyncapiAdded,
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentioned(token: string, corpus: string): boolean {
  // Case-insensitive: oasdiff reports header parameters lowercased
  // (HTTP header names are case-insensitive), so `idempotency-key` must
  // match a scenario's canonical `Idempotency-Key`.
  const left = /^\w/.test(token) ? "\\b" : "";
  const right = /\w$/.test(token) ? "\\b" : "";
  return new RegExp(left + escapeRe(token) + right, "i").test(corpus);
}

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
    const service = serviceDir.split("/").pop()!;
    if (only && service !== only) continue;

    const featuresDir = path.join(serviceDir, "features");
    let featureFiles: string[] = [];
    try {
      featureFiles = readdirSync(featuresDir)
        .filter((f) => f.endsWith(".feature"))
        .sort()
        .map((f) => path.join(featuresDir, f));
    } catch {
      featureFiles = [];
    }
    const corpus = featureFiles.map((p) => readFileSync(p, "utf-8")).join("\n");

    for (const [rel, [kind]] of manifestVersions(readFileSync(manifestPath, "utf-8"))) {
      const full = `${serviceDir}/${rel}`;
      const extract = ADDED[kind];
      if (!changed.has(full) || extract === undefined) continue;
      checked += 1;
      const baseText = blob(mb, full) ?? emptyBase(kind, readFileSync(full, "utf-8"));
      const baseFile = writeTmp(baseText, path.extname(rel));
      let tokens: string[];
      try {
        tokens = [...extract(baseFile, full)].sort();
      } finally {
        removeTmp(baseFile);
      }
      for (const token of tokens) {
        if (mentioned(token, corpus)) {
          console.log(`intent ok: ${full} adds '${token}', named in features`);
        } else {
          failures.push(
            `${service}: new schema element '${token}' (${rel}) is not ` +
              `mentioned in ${serviceDir}/features/*.feature - state ` +
              "the behaviour in a scenario (and bump the feature " +
              "artifact version)",
          );
        }
      }
    }
  }

  if (failures.length) {
    console.error(
      "\nSchema additions with no stated behaviour:\n  " + failures.join("\n  "),
    );
    console.error(
      "\nEvery added element must be named in the service's features. " +
        "There is no escape hatch: if it is not worth a scenario, it is " +
        "not worth adding to the contract.",
    );
    return 1;
  }
  console.log(`\n${checked} changed spec(s) checked for stated intent.`);
  return 0;
}
