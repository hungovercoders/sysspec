/** The context-efficiency contract of the seven spec tools.
 *
 * Every test runs twice: against the filesystem source (stdio / node HTTP)
 * and against a bundle built from the same tree (the data path bundled
 * deployments use).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import {
  getAcceptanceCriteria,
  getArtifact,
  getMessageSchema,
  getService,
  listServices,
  searchSpecs,
  traceChannel,
} from "../src/core.js";
import { BundledSpecSource, SpecsBundle } from "../src/source/bundle.js";
import { FsSpecSource } from "../src/source/fs.js";
import { SpecSource } from "../src/source/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const specsDir = path.join(repoRoot, "specs");

const sources: [string, () => SpecSource][] = [
  ["fs", () => new FsSpecSource(specsDir)],
  [
    "bundle",
    () => {
      const bundlePath = path.join(here, "..", "src", "generated", "specs-bundle.json");
      execFileSync(process.execPath, [path.join(here, "..", "scripts", "bundle-specs.mjs")], {
        env: { ...process.env, SPECS_DIR: specsDir },
      });
      return new BundledSpecSource(JSON.parse(readFileSync(bundlePath, "utf-8")) as SpecsBundle);
    },
  ],
];

describe.each(sources)("%s source", (_label, makeSource) => {
  let source: SpecSource;
  beforeAll(() => {
    source = makeSource();
  });

  // -- get_artifact ---------------------------------------------------------

  test("get_artifact_full_content_by_default", async () => {
    const out: any = await getArtifact(source, {
      service: "orders",
      path: "openapi/orders.openapi.yaml",
    });
    expect(out.authority).toBe("contract of record");
    expect(out.truncated).toBe(false);
    expect(out.section).toBeNull();
    expect(out.content).toContain("openapi");
    expect(out.total_bytes).toBe(new TextEncoder().encode(out.content).length);
  });

  test("get_artifact_section_returns_subtree_only", async () => {
    const out: any = await getArtifact(source, {
      service: "orders",
      path: "openapi/orders.openapi.yaml",
      section: "/components/schemas/Order",
    });
    expect(out.section).toBe("/components/schemas/Order");
    expect(out.content).toContain("order_id");
    expect(out.content).not.toContain("openapi:"); // not the whole document
  });

  test("get_artifact_bad_section_lists_available_keys", async () => {
    await expect(
      getArtifact(source, {
        service: "orders",
        path: "openapi/orders.openapi.yaml",
        section: "/components/schemas/Nope",
      }),
    ).rejects.toThrow(/Available there/);
  });

  test("get_artifact_truncates_honestly", async () => {
    const out: any = await getArtifact(source, {
      service: "orders",
      path: "openapi/orders.openapi.yaml",
      max_bytes: 200,
    });
    expect(out.truncated).toBe(true);
    expect(new TextEncoder().encode(out.content).length).toBeLessThanOrEqual(200);
    expect(out.total_bytes).toBeGreaterThan(200);
    expect(out.note).toContain("section=");
  });

  test("get_artifact_section_rejected_for_features", async () => {
    await expect(
      getArtifact(source, {
        service: "orders",
        path: "features/place-order.feature",
        section: "/anything",
      }),
    ).rejects.toThrow(/get_acceptance_criteria/);
  });

  // -- get_message_schema ---------------------------------------------------

  test("get_message_schema_lists_names_without_bodies", async () => {
    const out: any = await getMessageSchema(source, "orders");
    const names = out.messages.map((m: any) => m.name);
    expect(names).toContain("OrderPlaced");
    expect(out.schemas.length, "expected OpenAPI component schemas to be listed").toBeGreaterThan(0);
    expect(out).not.toHaveProperty("payload");
  });

  test("get_message_schema_asyncapi_hit", async () => {
    const out: any = await getMessageSchema(source, "orders", "OrderPlaced");
    expect(out.source).toBe("asyncapi");
    expect(out.payload).toBeTruthy();
  });

  test("get_message_schema_openapi_fallback", async () => {
    const index: any = await getMessageSchema(source, "orders");
    const schemaName = index.schemas[0].name;
    const out: any = await getMessageSchema(source, "orders", schemaName);
    expect(out.source).toBe("openapi");
    expect(out.payload).toBeTruthy();
  });

  test("get_message_schema_miss_lists_names", async () => {
    await expect(getMessageSchema(source, "orders", "NoSuchThing")).rejects.toThrow(/OrderPlaced/);
  });

  // -- get_acceptance_criteria ----------------------------------------------

  test("acceptance_criteria_names_only_has_no_gherkin", async () => {
    const out: any = await getAcceptanceCriteria(source, { service: "orders", names_only: true });
    expect(out.truncated).toBe(false);
    for (const feature of out.features) {
      expect(feature.scenarios.length).toBeGreaterThan(0);
      expect(feature).not.toHaveProperty("gherkin");
    }
  });

  test("acceptance_criteria_scenario_filter_includes_header", async () => {
    const index: any = await getAcceptanceCriteria(source, { service: "orders", names_only: true });
    const firstScenario = index.features[0].scenarios[0];
    const out: any = await getAcceptanceCriteria(source, {
      service: "orders",
      scenario: firstScenario,
    });
    const feature = out.features[0];
    expect(feature.header.trimStart()).toMatch(/^(@|#|Feature:)/);
    expect(feature.matched.some((m: any) => m.name.includes(firstScenario))).toBe(true);
    expect(feature.total_scenarios).toBeGreaterThanOrEqual(feature.matched.length);
  });

  test("acceptance_criteria_scenario_miss_lists_scenarios", async () => {
    await expect(
      getAcceptanceCriteria(source, { service: "orders", scenario: "zzz-no-such-scenario" }),
    ).rejects.toThrow(/Scenarios:/);
  });

  test("acceptance_criteria_path_filter", async () => {
    const out: any = await getAcceptanceCriteria(source, {
      service: "orders",
      path: "features/place-order.feature",
    });
    expect(out.features.map((f: any) => f.path)).toEqual(["features/place-order.feature"]);
    expect(out.features[0].gherkin).toContain("Feature");
  });

  test("acceptance_criteria_unknown_path_raises", async () => {
    await expect(
      getAcceptanceCriteria(source, { service: "orders", path: "features/nope.feature" }),
    ).rejects.toThrow(/not declared/);
  });

  test("acceptance_criteria_budget_degrades_to_index", async () => {
    const out: any = await getAcceptanceCriteria(source, { service: "orders", max_bytes: 10 });
    expect(out.truncated).toBe(true);
    expect(out.features[0].gherkin_omitted).toBe(true);
    expect(out.features[0].scenarios.length).toBeGreaterThan(0);
    expect(out.note).toContain("path=");
  });

  // -- trace_channel --------------------------------------------------------

  test("trace_channel_known_address", async () => {
    const produces = (await getService(source, "orders") as any).produces;
    const out: any = await traceChannel(source, produces[0]);
    expect(out.produced_by).toEqual(["orders"]);
  });

  test("trace_channel_unknown_address_returns_empty_not_error", async () => {
    const out: any = await traceChannel(source, "no.such.channel.v9");
    expect(out.produced_by).toEqual([]);
    expect(out.consumed_by).toEqual([]);
    expect(out.note).toContain("No service");
  });

  // -- search_specs ---------------------------------------------------------

  test("search_specs_limit_and_truncation_metadata", async () => {
    const out: any = await searchSpecs(source, { query: "the", limit: 1 });
    expect(out.returned).toBe(1);
    expect(out.total_matches).toBeGreaterThan(1);
    expect(out.truncated).toBe(true);
  });

  test("search_specs_service_filter", async () => {
    const out: any = await searchSpecs(source, { query: "order", service: "orders" });
    expect(out.hits.length).toBeGreaterThan(0);
    expect(new Set(out.hits.map((h: any) => h.service))).toEqual(new Set(["orders"]));
    expect(out.truncated).toBe(out.total_matches > out.returned);
  });

  test("search_specs_bad_kind_raises", async () => {
    await expect(searchSpecs(source, { query: "order", kind: "yaml" })).rejects.toThrow(
      /Valid kinds/,
    );
  });

  test("search_specs_unknown_service_raises", async () => {
    await expect(searchSpecs(source, { query: "order", service: "nope" })).rejects.toThrow(
      /Available/,
    );
  });

  // -- discovery sanity ------------------------------------------------------

  test("list_services_returns_orders_and_payments", async () => {
    const out: any = await listServices(source);
    const names = out.map((s: any) => s.name);
    expect(names).toContain("orders");
    expect(names).toContain("payments");
  });
});
