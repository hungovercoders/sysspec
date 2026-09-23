/** Pure-logic units of the diff gates: intent token extraction, the
 * compat structural filter, and version/surface comparisons in scratch
 * git repos.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  asyncapiBad,
  normalizeOdcs,
  odcsBreakingDetail,
  parseAsyncapiDiff,
} from "../src/compat.js";
import { parseOdcsRef } from "../src/docs-gen.js";
import { resolveOdcsTarget } from "../src/manifest-lint.js";
import {
  asyncapiTokens,
  emptyBase,
  mentioned,
  odcsIndex,
  openapiTokens,
  pathNames,
} from "../src/intent.js";
import { openapiBreaking } from "../src/compat.js";
import { runGate as surfaceGate, versionOf } from "../src/surface.js";
import { greater, versionParts } from "../src/util.js";
import { manifestVersions, runGate as versionGate, serviceVersion } from "../src/versioning.js";

describe("intent token extraction", () => {
  test("pathNames drops schema keywords and indexes", () => {
    expect(pathNames("lines/items/unit_price_pence")).toEqual(
      new Set(["lines", "unit_price_pence"]),
    );
    expect(pathNames("properties/0/allOf/name")).toEqual(new Set(["name"]));
  });

  test("openapiTokens takes the last backtick token and operation ids", () => {
    const tokens = openapiTokens([
      { id: "endpoint-added", operationId: "placeOrder" },
      {
        id: "new-required-request-property",
        text: "added the required request property `lines/items/unit_price_pence`",
      },
      { id: "irrelevant-noise", text: "`ignored`" },
    ]);
    expect(tokens).toEqual(new Set(["placeOrder", "lines", "unit_price_pence"]));
  });

  test("asyncapiTokens names messages, channel addresses and payload properties", () => {
    const channels = { orderPlaced: { address: "orders.placed.v2" } };
    const tokens = asyncapiTokens(
      [
        { action: "add", path: "/components/messages/OrderPlaced" },
        { action: "add", path: "/channels/orderPlaced" },
        { action: "add", path: "/channels/orderPlaced/messages/OrderPlaced/payload/properties/data/properties/order_id" },
        { action: "add", path: "/operations/sendOrderPlaced" },
        { action: "add", path: "/info/title" },
        { action: "remove", path: "/components/messages/Gone" },
        { action: "add", path: "/components/messages/OrderPlaced/payload/properties/data/description" },
      ],
      channels,
    );
    expect(tokens).toEqual(new Set(["OrderPlaced", "orders.placed.v2", "data", "order_id"]));
  });

  test("mentioned uses word boundaries only where they exist", () => {
    expect(mentioned("order_id", 'the "order_id" field')).toBe(true);
    expect(mentioned("order_id", "reorder_ids everywhere")).toBe(false);
    expect(mentioned("orders.placed.v2", 'publishes "orders.placed.v2" events')).toBe(true);
  });

  test("mentioned is case-insensitive - oasdiff lowercases header names", () => {
    expect(mentioned("idempotency-key", 'with "Idempotency-Key" header "idem-99"')).toBe(true);
    expect(mentioned("Status", "the status field")).toBe(true);
  });

  test("emptyBase keeps the info block so diffs gate only real additions", () => {
    const base = emptyBase("openapi", "openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths: {}\n");
    expect(base).toContain("title: T");
    expect(base).toContain("paths: {}");
  });
});

describe("asyncapi diff output", () => {
  test("parseAsyncapiDiff skips the CLI's telemetry prose ahead of the JSON", () => {
    const stdout = [
      "Skipping submitting anonymous metrics due to the following error: Error: Failed to send metrics to New Relic Metrics API: 403 Forbidden",
      "",
      '{ "changes": [ { "action": "add", "path": "/channels/x" } ] }',
      "",
    ].join("\n");
    expect(parseAsyncapiDiff(stdout)).toEqual([{ action: "add", path: "/channels/x" }]);
    expect(parseAsyncapiDiff('{"changes":[]}')).toEqual([]);
    // Prose that itself opens with a bracket must not be mistaken for the document.
    const bracketed = ["[asyncapi] anonymous metrics are enabled", "{not json either", '{"changes":[]}'].join("\n");
    expect(parseAsyncapiDiff(bracketed)).toEqual([]);
    expect(() => parseAsyncapiDiff("only prose")).toThrow("produced no JSON");
    expect(() => parseAsyncapiDiff("[asyncapi] prose only")).toThrow("produced no JSON");
  });
});

describe("compat asyncapi filter", () => {
  test("removals and edits are breaking; noise and prose are not", () => {
    const bad = asyncapiBad([
      { action: "remove", path: "/components/messages/OrderPlaced" },
      { action: "edit", path: "/channels/orderPlaced/address" },
      { action: "add", path: "/components/messages/New" },
      { action: "edit", path: "/x-parser-spec-parsed" },
      { action: "edit", path: "/info/version" },
      { action: "edit", path: "/components/messages/OrderPlaced/description" },
    ]);
    expect(bad).toEqual([
      "remove /components/messages/OrderPlaced",
      "edit /channels/orderPlaced/address",
    ]);
  });
});

describe("odcs data contracts", () => {
  const contract = (reason: string) =>
    [
      "apiVersion: v3.2.0",
      "kind: DataContract",
      "id: orders-events",
      "name: Order events",
      "version: 1.0.0",
      "schema:",
      "  - name: order_placed_events",
      "    properties:",
      "      - name: order_id",
      "      - name: reason",
      reason,
    ].join("\n");
  const asEnum = ["        enum:", "          - value: customer_request", "          - value: out_of_stock"].join("\n");
  const asQuality = [
    "        quality:",
    "          - rule: validValues",
    "            validValues: [customer_request, out_of_stock]",
  ].join("\n");

  test("odcsIndex keys elements structurally and reads either vocabulary spelling", () => {
    const fromEnum = odcsIndex(parse(contract(asEnum)));
    const fromQuality = odcsIndex(parse(contract(asQuality)));
    expect([...fromEnum.names.keys()]).toEqual([
      "order_placed_events",
      "order_placed_events/order_id",
      "order_placed_events/reason",
    ]);
    expect(fromEnum.enums.get("order_placed_events/reason")).toEqual(
      fromQuality.enums.get("order_placed_events/reason"),
    );
  });

  test("normalizeOdcs turns a legacy validValues rule into the 3.2 enum", () => {
    const normalized = parse(normalizeOdcs(contract(asQuality)));
    const reason = normalized.schema[0].properties[1];
    expect(reason.enum).toEqual([{ value: "customer_request" }, { value: "out_of_stock" }]);
    expect(reason.quality).toBeUndefined();
  });

  test("odcsBreakingDetail reads the details table, not the summary rollup", () => {
    const output = [
      "Summary",
      "│ ERROR │ Added │ schema.orders.properties.reason │",
      "│ ERROR │ Removed │ schema.orders.properties.reason.enum.payment_failed │",
      "Details",
      "│ ERROR  │ Rem… │ schema.orders.properties.reason.enum.payment_failed.value │ payment_failed │  │ Removed allowed values at │",
    ].join("\n");
    expect(odcsBreakingDetail(output)).toEqual([
      "schema.orders.properties.reason.enum.payment_failed.value (was payment_failed)",
    ]);
  });

  test("emptyBase gives a data contract an empty schema to diff against", () => {
    const skeleton = parse(emptyBase("data-contract", contract(asEnum)));
    expect(skeleton.schema).toEqual([]);
    expect(skeleton.apiVersion).toBe("v3.2.0");
  });

  test("resolveOdcsTarget resolves by name for shorthand and by id when qualified", () => {
    const doc = {
      schema: [
        {
          id: "placed",
          name: "order_placed_events",
          properties: [{ id: "oid", name: "order_id" }, { name: "customer_id" }],
        },
      ],
    };
    expect(resolveOdcsTarget(doc, "order_placed_events.order_id")).toBeNull();
    expect(resolveOdcsTarget(doc, "/schema/placed/properties/oid")).toBeNull();
    expect(resolveOdcsTarget(doc, "order_placed_events.nope")).toMatch(/does not exist/);
    // Declared with a name but referenced by id: resolvable today, a trap
    // the moment the name changes - so it is reported, not accepted.
    expect(resolveOdcsTarget(doc, "/schema/placed/properties/customer_id")).toMatch(/add 'id:/);
  });

  test("parseOdcsRef splits shorthand, qualified and cross-file references", () => {
    expect(parseOdcsRef("orders.order_id")).toEqual({
      file: null,
      object: "orders",
      property: "order_id",
    });
    expect(parseOdcsRef("../other.odcs.yaml#/schema/placed/properties/oid")).toEqual({
      file: "../other.odcs.yaml",
      object: "placed",
      property: "oid",
    });
    expect(parseOdcsRef("nonsense")).toBeNull();
  });
});

describe("versioning helpers", () => {
  test("greater compares dotted versions numerically, not as strings", () => {
    expect(greater(versionParts("1.10.0"), versionParts("1.9.0"))).toBe(true);
    expect(greater(versionParts("1.1.0"), versionParts("1.2.0"))).toBe(false);
    expect(greater(versionParts("2.0.0"), versionParts("2.0.0"))).toBe(false);
    expect(versionParts("3.1.0-rc.1")).toEqual([3, 1, 0]);
  });

  test("manifestVersions keeps gated artifacts only, honoring explicit gated:", () => {
    const text = [
      "artifacts:",
      "  - { kind: openapi, path: a.yaml, version: 1.0.0 }",
      "  - { kind: doc, path: b.md }",
      "  - { kind: doc, path: c.md, gated: true }",
      "  - { kind: feature, path: d.feature, version: 2.0.0, gated: false }",
    ].join("\n");
    const versions = manifestVersions(text);
    expect([...versions.keys()]).toEqual(["a.yaml", "c.md"]);
    expect(versions.get("a.yaml")).toEqual(["openapi", "1.0.0"]);
  });

  test("serviceVersion stringifies whatever YAML parsed", () => {
    expect(serviceVersion("version: 1.2.3")).toBe("1.2.3");
    expect(serviceVersion("name: x")).toBeNull();
    expect(serviceVersion(null)).toBeNull();
  });
});

describe("gates in a scratch git repo", () => {
  let repo: string;
  let logs: string[];
  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8" });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sysspec-gate-"));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m) => logs.push(String(m)));
    process.chdir(repo);
    g("init", "-q", "-b", "main", ".");
    mkdirSync(path.join(repo, "specs", "svc"), { recursive: true });
    writeFileSync(
      path.join(repo, "specs", "svc", "service.yaml"),
      [
        "name: svc",
        "version: 1.0.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.0.0 }",
        "",
      ].join("\n"),
    );
    mkdirSync(path.join(repo, "specs", "svc", "features"), { recursive: true });
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: a\n");
    writeFileSync(path.join(repo, "v.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(path.join(repo, "surface.txt"), "s1\n");
    g("add", "-A");
    g("-c", "user.email=t@e.c", "-c", "user.name=t", "commit", "-qm", "base");
  });

  afterEach(() => {
    process.chdir(path.dirname(repo));
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("version gate: missing base ref skips locally", () => {
    vi.stubEnv("CI", "");
    expect(versionGate("origin/nope", "specs")).toBe(0);
    expect(logs.join("\n")).toContain("nothing to diff against");
  });

  test("diff gates: missing base ref fails in CI unless explicitly allowed", () => {
    vi.stubEnv("CI", "true");
    expect(versionGate("origin/nope", "specs")).toBe(1);
    expect(logs.join("\n")).toContain("fetch-depth: 0");
    expect(surfaceGate("origin/nope", "v.json", "version", ["surface.txt"])).toBe(1);

    logs.length = 0;
    expect(versionGate("origin/nope", "specs", true)).toBe(0);
    expect(surfaceGate("origin/nope", "v.json", "version", ["surface.txt"], true)).toBe(0);
    expect(logs.join("\n")).toContain("nothing to diff against");
  });

  test("version gate: an artifact version moving backwards is red", () => {
    const manifest = path.join(repo, "specs", "svc", "service.yaml");
    writeFileSync(
      manifest,
      [
        "name: svc",
        "version: 1.2.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.2.0 }",
        "",
      ].join("\n"),
    );
    g("add", "-A");
    g("-c", "user.email=t@e.c", "-c", "user.name=t", "commit", "-qm", "at 1.2.0");
    g("checkout", "-q", "-b", "feature");
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: a2\n");
    writeFileSync(
      manifest,
      [
        "name: svc",
        "version: 1.3.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.1.0 }",
        "",
      ].join("\n"),
    );
    expect(versionGate("main", "specs")).toBe(1);
    expect(logs.join("\n")).toContain("version moved backwards 1.2.0 -> 1.1.0");
  });

  test("version gate: a service version moving backwards is red", () => {
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: a2\n");
    writeFileSync(
      path.join(repo, "specs", "svc", "service.yaml"),
      [
        "name: svc",
        "version: 0.9.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.1.0 }",
        "",
      ].join("\n"),
    );
    expect(versionGate("main", "specs")).toBe(1);
    expect(logs.join("\n")).toContain("service version moved backwards 1.0.0 -> 0.9.0");
  });

  test("version gate: gated edit without a bump is red, with a bump green", () => {
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: a2\n");
    expect(versionGate("main", "specs")).toBe(1);
    expect(logs.join("\n")).toContain("changed but version stayed at 1.0.0");

    logs.length = 0;
    const manifest = path.join(repo, "specs", "svc", "service.yaml");
    writeFileSync(
      manifest,
      [
        "name: svc",
        "version: 1.1.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.1.0 }",
        "",
      ].join("\n"),
    );
    expect(versionGate("main", "specs")).toBe(0);
    expect(logs.join("\n")).toContain("ok: specs/svc/features/a.feature 1.0.0 -> 1.1.0");
  });

  test("version gate: baseline comes from the merge-base, not the moved base head", () => {
    // Branch off, then let main advance with its own bump: the gate must
    // compare against the fork point, not main's head.
    g("checkout", "-q", "-b", "feature");
    g("checkout", "-q", "main");
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: main-side\n");
    writeFileSync(
      path.join(repo, "specs", "svc", "service.yaml"),
      [
        "name: svc",
        "version: 1.1.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.1.0 }",
        "",
      ].join("\n"),
    );
    g("add", "-A");
    g("-c", "user.email=t@e.c", "-c", "user.name=t", "commit", "-qm", "main moves");
    g("checkout", "-q", "feature");
    // The branch makes the same 1.0.0 -> 1.1.0 bump independently. Against
    // main's head that would look like "changed but version stayed"; against
    // the merge-base it is a clean bump.
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: branch-side\n");
    writeFileSync(
      path.join(repo, "specs", "svc", "service.yaml"),
      [
        "name: svc",
        "version: 1.1.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 1.1.0 }",
        "",
      ].join("\n"),
    );
    expect(versionGate("main", "specs")).toBe(0);
    expect(logs.join("\n")).toContain("ok: specs/svc/features/a.feature 1.0.0 -> 1.1.0");
  });

  test("version gate: artifact major requires service major", () => {
    writeFileSync(path.join(repo, "specs", "svc", "features", "a.feature"), "Feature: a2\n");
    writeFileSync(
      path.join(repo, "specs", "svc", "service.yaml"),
      [
        "name: svc",
        "version: 1.1.0",
        "artifacts:",
        "  - { kind: feature, path: features/a.feature, version: 2.0.0 }",
        "",
      ].join("\n"),
    );
    expect(versionGate("main", "specs")).toBe(1);
    expect(logs.join("\n")).toContain("a major artifact change is a major surface change");
  });

  test("surface gate: unchanged, unbumped, and bumped", () => {
    expect(surfaceGate("main", "v.json", "version", ["surface.txt"])).toBe(0);
    expect(logs.join("\n")).toContain("surface unchanged");

    logs.length = 0;
    writeFileSync(path.join(repo, "surface.txt"), "s2\n");
    expect(surfaceGate("main", "v.json", "version", ["surface.txt"])).toBe(1);
    expect(logs.join("\n")).toContain("Surface changed without a version bump");

    logs.length = 0;
    writeFileSync(path.join(repo, "v.json"), JSON.stringify({ version: "1.0.1" }));
    expect(surfaceGate("main", "v.json", "version", ["surface.txt"])).toBe(0);
    expect(logs.join("\n")).toContain("1.0.0 -> 1.0.1 - ok");
  });

  test("compat: an oasdiff failure is a tool error, not a breaking verdict", () => {
    const good = path.join(repo, "a.yaml");
    writeFileSync(
      good,
      "openapi: 3.0.3\ninfo: {title: t, version: 1.0.0}\npaths:\n  /x:\n    get:\n      responses: {'200': {description: ok}}\n",
    );
    const gone = path.join(repo, "b.yaml");
    writeFileSync(gone, "openapi: 3.0.3\ninfo: {title: t, version: 1.0.0}\npaths: {}\n");
    expect(openapiBreaking(good, good)[0]).toBe(false);
    expect(openapiBreaking(good, gone)[0]).toBe(true);
    expect(() => openapiBreaking(good, path.join(repo, "missing.yaml"))).toThrow(
      /oasdiff breaking failed .* \(exit 1\d\d\)/,
    );
  });

  test("versionOf reads dotted keys from JSON and TOML", () => {
    expect(versionOf('{"project": {"version": "1.2.3"}}', "x.json", "project.version")).toEqual([1, 2, 3]);
    expect(versionOf('[project]\nversion = "4.5.6"\n', "x.toml", "project.version")).toEqual([4, 5, 6]);
    expect(versionOf(null, "x.json", "version")).toBeNull();
  });
});
