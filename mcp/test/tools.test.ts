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
import { getDataContract, getOperation, impact, validatePayload } from "../src/contracts.js";
import {
  getAcceptanceCriteria,
  getArtifact,
  getMessageSchema,
  getService,
  getSystem,
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

  test("acceptance_criteria_scenario_filter_respects_budget", async () => {
    const index: any = await getAcceptanceCriteria(source, { service: "orders", names_only: true });
    const out: any = await getAcceptanceCriteria(source, {
      service: "orders",
      scenario: index.features[0].scenarios[0],
      max_bytes: 10,
    });
    expect(out.truncated).toBe(true);
    expect(out.features[0].matched[0].gherkin_omitted).toBe(true);
    expect(out.features[0].matched[0]).not.toHaveProperty("gherkin");
  });

  test("acceptance_criteria_names_only_respects_budget", async () => {
    const out: any = await getAcceptanceCriteria(source, {
      service: "orders",
      names_only: true,
      max_bytes: 5,
    });
    expect(out.truncated).toBe(true);
    expect(out.features[0].names_omitted).toBe(true);
    expect(out.features[0].scenario_count).toBeGreaterThan(0);
  });

  test("get_artifact_section_ignores_inherited_properties", async () => {
    await expect(
      getArtifact(source, {
        service: "orders",
        path: "asyncapi/orders.asyncapi.yaml",
        section: "/constructor",
      }),
    ).rejects.toThrow(/'constructor' not found/);
  });

  // -- system and versions ----------------------------------------------------

  test("get_system_describes_the_suite", async () => {
    const out: any = await getSystem(source);
    expect(out.present).toBe(true);
    expect(out.name).toBe("sysspec-demo");
    expect(out.org).toBe("com.hungovercoders");
    expect(out.service_count).toBe(2);
  });

  test("service_listings_carry_the_pinned_version", async () => {
    const list: any[] = (await listServices(source)) as any[];
    for (const svc of list) expect(svc.version).toMatch(/^\d+\.\d+\.\d+$/);
    const orders: any = await getService(source, "orders");
    expect(orders.version).toBe(list.find((s) => s.name === "orders").version);
  });

  // -- get_operation --------------------------------------------------------

  test("get_operation_indexes_then_resolves_refs", async () => {
    const index: any = await getOperation(source, { service: "orders" });
    const ids = index.operations.map((o: any) => o.operation_id);
    expect(ids).toEqual(expect.arrayContaining(["placeOrder", "getOrder"]));

    const out: any = await getOperation(source, { service: "orders", operation_id: "placeOrder" });
    expect(out.method).toBe("POST");
    expect(out.path).toBe("/orders");
    expect(out.refs_resolved).toBe(true);
    expect(JSON.stringify(out.operation)).not.toContain('"$ref"');

    const byRoute: any = await getOperation(source, { service: "orders", method: "get", path: "/orders/{order_id}" });
    expect(byRoute.operation_id).toBe("getOrder");
  });

  test("get_operation_miss_lists_operations_and_budget_keeps_refs", async () => {
    await expect(getOperation(source, { service: "orders", operation_id: "nope" })).rejects.toThrow(
      /Operations: .*placeOrder/,
    );
    await expect(getOperation(source, { service: "payments" })).rejects.toThrow(/no OpenAPI contract/);
    await expect(getOperation(source, { service: "orders", method: "GET" })).rejects.toThrow(/go together/);
    const tight: any = await getOperation(source, { service: "orders", operation_id: "placeOrder", max_bytes: 50 });
    expect(tight.refs_resolved).toBe(false);
    expect(tight.truncated).toBe(true);
  });

  // -- get_data_contract ----------------------------------------------------

  test("get_data_contract_index_contract_and_table", async () => {
    const index: any = await getDataContract(source, { service: "orders" });
    expect(index.contracts[0].tables.map((t: any) => t.name)).toContain("order_placed_events");

    const contract: any = await getDataContract(source, {
      service: "orders",
      path: index.contracts[0].path,
    });
    expect(contract.context.verifiedStatements.length).toBeGreaterThan(0);

    const table: any = await getDataContract(source, { service: "orders", table: "order_cancelled_events" });
    expect(table.columns.map((c: any) => c.name)).toContain("order_id");
    expect(table.relationships[0].to).toBe("order_placed_events.order_id");
    const reason = table.columns.find((c: any) => c.name === "reason");
    expect(reason?.enum?.length).toBeGreaterThan(0);
  });

  test("get_data_contract_miss_lists_tables", async () => {
    await expect(getDataContract(source, { service: "orders", table: "nope" })).rejects.toThrow(
      /Tables: .*order_placed_events/,
    );
  });

  // -- impact ---------------------------------------------------------------

  test("impact_of_a_message_reaches_consumers_features_and_records", async () => {
    const out: any = await impact(source, { service: "orders", message: "OrderPlaced" });
    expect(out.channels).toEqual([
      { address: "orders.placed.v2", produced_by: ["orders"], consumed_by: ["payments"] },
    ]);
    expect(out.consumers).toEqual(["payments"]);
    expect(out.features.map((f: any) => f.service)).toEqual(expect.arrayContaining(["orders"]));
    expect(out.data_contracts.some((d: any) => d.service === "orders")).toBe(true);
    expect(out.note).toContain("payments");
  });

  test("impact_of_a_column_follows_odcs_relationships_across_services", async () => {
    const out: any = await impact(source, { service: "orders", column: "order_placed_events.order_id" });
    const found = out.relationships.map((r: any) => `${r.service}:${r.id}`);
    expect(found).toEqual(
      expect.arrayContaining(["orders:cancellation_of_order", "payments:settles_order"]),
    );
    await expect(impact(source, { service: "orders", column: "order_placed_events.nope" })).rejects.toThrow(
      /No column/,
    );
    await expect(impact(source, { service: "orders" })).rejects.toThrow(/exactly one/);
  });

  // -- validate_payload -----------------------------------------------------

  test("validate_payload_accepts_a_valid_event_and_names_each_fault", async () => {
    const good = {
      specversion: "1.0",
      id: "3f1b8a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b",
      source: "/orders",
      type: "com.hungovercoders.orders.placed.v2",
      subject: "3f1b8a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5c",
      time: "2026-01-01T00:00:00Z",
      datacontenttype: "application/json",
      data: {
        order_id: "3f1b8a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5c",
        customer_id: "3f1b8a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5d",
        placed_at: "2026-01-01T00:00:00Z",
        total_pence: 1200,
      },
    };
    const ok: any = await validatePayload(source, { service: "orders", message: "OrderPlaced", payload: good });
    expect(ok).toMatchObject({ valid: true, errors: [], source: "asyncapi" });

    const bad = { ...good, data: { ...good.data, total_pence: -1, surprise: true } };
    const out: any = await validatePayload(source, {
      service: "orders",
      message: "OrderPlaced",
      payload: JSON.stringify(bad),
    });
    expect(out.valid).toBe(false);
    expect(out.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/data/total_pence" }),
        expect.objectContaining({ path: "/data/surprise", message: expect.stringContaining("unexpected property") }),
      ]),
    );
    // A declared property that failed is not also reported as "additional".
    expect(out.errors.filter((e: any) => e.path === "/data/total_pence")).toHaveLength(1);
  });

  test("validate_payload_miss_and_bad_json", async () => {
    await expect(
      validatePayload(source, { service: "orders", message: "Nope", payload: {} }),
    ).rejects.toThrow(/Known: .*OrderPlaced/);
    await expect(
      validatePayload(source, { service: "orders", message: "OrderPlaced", payload: "{not json" }),
    ).rejects.toThrow(/not valid JSON/);
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

  test("search_specs_splits_terms_and_ranks_exact_first", async () => {
    const out: any = await searchSpecs(source, { query: "order placed" });
    expect(out.terms).toEqual(["order", "placed"]);
    const texts = out.hits.map((h: any) => h.text).join("\n");
    expect(texts).toMatch(/OrderPlaced|orders\.placed\.v2/);
    const scores = out.hits.map((h: any) => h.score);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
  });

  test("search_specs_gives_yaml_hits_a_usable_pointer", async () => {
    const out: any = await searchSpecs(source, { query: "total_pence", kind: "asyncapi", service: "orders" });
    const hit = out.hits.find((h: any) => h.pointer?.includes("/properties/total_pence"));
    expect(hit).toBeDefined();
    const section: any = await getArtifact(source, {
      service: "orders",
      path: hit.path,
      section: hit.pointer,
    });
    expect(section.content).toContain("integer");
  });

  test("search_specs_reads_manifests_and_rejects_empty_queries", async () => {
    const out: any = await searchSpecs(source, { query: "team-commerce", kind: "manifest" });
    expect(out.hits.every((h: any) => h.path === "service.yaml")).toBe(true);
    expect(out.returned).toBeGreaterThan(0);
    await expect(searchSpecs(source, { query: "   " })).rejects.toThrow(/must not be empty/);
  });

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
