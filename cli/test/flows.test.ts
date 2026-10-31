/** The scenario → contract extractor, the charts drawn from it, and the
 * journeys it chains across services. Pure functions over the frozen
 * spec tree (test/fixtures/tree-specs) and hand-built edge cases, so
 * the rules are pinned here before the golden snapshot sees them.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildData, featureData, structuredSteps } from "../src/docs-data.js";
import { loadManifests, parseFeature } from "../src/docs-gen.js";
import {
  backLinks,
  deriveFlows,
  extractRefs,
  featureActor,
  featureFlow,
  FlowContext,
  MAX_JOURNEYS,
  scenarioSequence,
} from "../src/flows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const specs = path.join(here, "fixtures", "tree-specs");
const mocks = path.join(here, "fixtures", "tree-mocks");
const greeter = path.join(here, "..", "templates", "init", "specs", "greeter", "features", "greet.feature");

const lookups = {
  messageChannel: new Map([
    ["OrderPlaced", "orders.placed.v2"],
    ["OrderCancelled", "orders.cancelled.v2"],
    ["PaymentSettled", "payments.settled.v2"],
  ]),
  channelProducer: new Map([
    ["orders.placed.v2", "orders"],
    ["orders.cancelled.v2", "orders"],
    ["payments.settled.v2", "payments"],
  ]),
  channelPage: new Map([
    ["orders.placed.v2", { service: "orders", stem: "orders.asyncapi" }],
    ["orders.cancelled.v2", { service: "orders", stem: "orders.asyncapi" }],
    ["payments.settled.v2", { service: "payments", stem: "payments.asyncapi" }],
  ]),
};

const orders: FlowContext = {
  service: "orders",
  title: "Orders",
  actor: "Customer",
  ops: [
    { op_id: "placeOrder", method: "POST", path: "/orders", statuses: ["201", "400", "409"], stem: "orders.openapi" },
    { op_id: "getOrder", method: "GET", path: "/orders/{order_id}", statuses: ["200", "404"], stem: "orders.openapi" },
  ],
  produces: ["orders.placed.v2", "orders.cancelled.v2"],
  consumes: ["payments.settled.v2"],
  ...lookups,
};

const payments: FlowContext = {
  service: "payments",
  title: "Payments",
  actor: "Client",
  ops: [],
  produces: ["payments.settled.v2"],
  consumes: ["orders.placed.v2"],
  ...lookups,
};

/** [title, refs] per scenario of a feature file, background included. */
function refsOf(file: string, ctx: FlowContext) {
  const [, , background, scenarios] = parseFeature(readFileSync(file, "utf-8"));
  const bg = structuredSteps(background);
  return scenarios.map(([title, lines]) => [title, extractRefs([...bg, ...structuredSteps(lines)], ctx).refs] as const);
}

const steps = (...lines: string[]) => structuredSteps(lines);
const out = (channel: string, message: string | null, negated = false) => ({ channel, message, negated });

describe("extractRefs over the demo features", () => {
  test("orders: every scenario resolves to the contract it names", () => {
    const refs = Object.fromEntries(refsOf(path.join(specs, "orders", "features", "place-order.feature"), orders));
    const placeOrder = { op_id: "placeOrder", via: "status" };
    expect(refs["A valid order is accepted and its event is guaranteed"]).toEqual({
      operations: [placeOrder],
      inbound: [],
      outbound: [out("orders.placed.v2", "OrderPlaced")],
      statuses: ["201"],
    });
    // "no order ever exists without its OrderPlaced event" is a double
    // negative five words long: the mention stays positive.
    expect(refs["The order and its event succeed or fail together"].outbound).toEqual([
      out("orders.placed.v2", "OrderPlaced"),
    ]);
    expect(refs["Replaying an idempotency key returns the original order"].outbound).toEqual([
      out("orders.placed.v2", "OrderPlaced", true),
    ]);
    expect(refs["A conflicting body on a used idempotency key is rejected"]).toEqual({
      operations: [placeOrder],
      inbound: [],
      outbound: [],
      statuses: ["409"],
    });
    expect(refs["Order events are CloudEvents envelopes"].operations).toEqual([]);
    expect(refs["Cancellation is a CloudEvents envelope too"].outbound).toEqual([
      out("orders.cancelled.v2", "OrderCancelled"),
    ]);
    // Names no contract at all - the catalog shows the gap, not an error.
    expect(refs["An order is only cancelled for a declared reason"]).toEqual({
      operations: [],
      inbound: [],
      outbound: [],
      statuses: [],
    });
    // Direction from the graph: orders consumes payments.settled.v2.
    expect(refs["A settled payment marks the order paid"].inbound).toEqual([
      { channel: "payments.settled.v2", message: "PaymentSettled", producer: "payments" },
    ]);
    // Named ops, in first-mention order, and a status that resolves to an
    // op already named does not add a second entry.
    expect(refs["An order can be fetched by its id"]).toEqual({
      operations: [
        { op_id: "placeOrder", via: "name" },
        { op_id: "getOrder", via: "name" },
      ],
      inbound: [],
      outbound: [],
      statuses: ["200"],
    });
    expect(refs["Fetching an unknown order returns 404"].operations).toEqual([{ op_id: "getOrder", via: "name" }]);
    // Outline placeholders and Examples rows never become references.
    expect(refs["Orders must have at least one valid line"]).toEqual({
      operations: [placeOrder],
      inbound: [],
      outbound: [],
      statuses: ["400"],
    });
  });

  test("payments: inbound hop, negations, no HTTP surface", () => {
    const refs = Object.fromEntries(refsOf(path.join(specs, "payments", "features", "settle-payment.feature"), payments));
    expect(refs["Settlement is anchored to an observed order placement"]).toEqual({
      operations: [],
      inbound: [{ channel: "orders.placed.v2", message: "OrderPlaced", producer: "orders" }],
      outbound: [out("payments.settled.v2", "PaymentSettled")],
      statuses: [],
    });
    expect(refs["Duplicate settlement callbacks are idempotent"].outbound).toEqual([
      out("payments.settled.v2", "PaymentSettled", true),
    ]);
    expect(refs["A reversal after authorisation does not emit settlement"].outbound).toEqual([
      out("payments.settled.v2", "PaymentSettled", true),
    ]);
  });

  test("the init scaffold's greeter publishes one event and nothing else", () => {
    const ctx: FlowContext = {
      service: "greeter",
      title: "Greeter",
      actor: "Client",
      ops: [],
      produces: ["greeter.greeted.v1"],
      consumes: [],
      messageChannel: new Map([["GreeterGreeted", "greeter.greeted.v1"]]),
      channelProducer: new Map([["greeter.greeted.v1", "greeter"]]),
      channelPage: new Map([["greeter.greeted.v1", { service: "greeter", stem: "greeter.asyncapi" }]]),
    };
    const [[, refs]] = refsOf(greeter, ctx);
    expect(refs).toEqual({
      operations: [],
      inbound: [],
      outbound: [out("greeter.greeted.v1", "GreeterGreeted")],
      statuses: [],
    });
  });
});

describe("extractRefs edge cases", () => {
  test("positive wins over a negated mention of the same message", () => {
    const { refs } = extractRefs(
      steps('    Then no second "OrderPlaced" event is published', '    And an "OrderPlaced" event is published'),
      orders,
    );
    expect(refs.outbound).toEqual([out("orders.placed.v2", "OrderPlaced")]);
  });

  test("a status two ops can answer infers neither", () => {
    const ctx = { ...orders, ops: orders.ops.map((o) => ({ ...o, statuses: ["200"] })) };
    const { refs } = extractRefs(steps("    Then the response status is 200"), ctx);
    expect(refs.operations).toEqual([]);
    expect(refs.statuses).toEqual(["200"]);
  });

  test("a status does not read the order's own status field", () => {
    const { refs } = extractRefs(steps('    Then the order status is "paid"'), orders);
    expect(refs.statuses).toEqual([]);
  });

  test("unknown messages and channels the service neither produces nor consumes are dropped", () => {
    const { refs } = extractRefs(
      steps('    Then a "NotAThing" event is published', '    And "OrderCancelled" arrives on "orders.cancelled.v2"'),
      payments,
    );
    expect(refs.outbound).toEqual([]);
    expect(refs.inbound).toEqual([]);
  });

  test("operation ids match whole words, case-sensitively", () => {
    const hit = extractRefs(steps("    When the order is fetched via getOrder"), orders);
    expect(hit.refs.operations).toEqual([{ op_id: "getOrder", via: "name" }]);
    const miss = extractRefs(steps("    When the caller tries getorder and regetOrders"), orders);
    expect(miss.refs.operations).toEqual([]);
  });

  test("outline placeholders are not references", () => {
    const { refs } = extractRefs(
      steps('    When "<message>" is published on "<channel>" via <op>', "    Then the response status is <status>"),
      orders,
    );
    expect(refs).toEqual({ operations: [], inbound: [], outbound: [], statuses: [] });
  });

  test("a message decides its channel; another quoted address is a channel-level reference", () => {
    const { refs } = extractRefs(
      steps('    Then an "OrderPlaced" event is published on "orders.placed.v2"', '    And something lands on "orders.cancelled.v2"'),
      orders,
    );
    expect(refs.outbound).toEqual([
      out("orders.placed.v2", "OrderPlaced"),
      out("orders.cancelled.v2", null),
    ]);
  });

  test("naming an op beats inferring it, whichever comes first", () => {
    const { refs } = extractRefs(
      steps("    Then the response status is 404", "    And the lookup went via getOrder"),
      orders,
    );
    expect(refs.operations).toEqual([{ op_id: "getOrder", via: "name" }]);
  });

  test("the global regexes carry no state between calls", () => {
    const line = steps('    Then an "OrderPlaced" event is published on "orders.placed.v2"');
    const a = extractRefs(line, orders).refs;
    const b = extractRefs(line, orders).refs;
    expect(b).toEqual(a);
    expect(a.outbound).toHaveLength(1);
  });

  test("featureActor reads the As-a line and defaults to Client", () => {
    expect(featureActor(["As a customer", "I want to place an order"])).toBe("Customer");
    expect(featureActor(["As an operator,", "I want"])).toBe("Operator");
    expect(featureActor(["Settlement is terminal."])).toBe("Client");
  });
});

describe("charts", () => {
  const ordersFeature = () => {
    const file = path.join(specs, "orders", "features", "place-order.feature");
    return featureData({ path: "features/place-order.feature" }, readFileSync(file, "utf-8"), orders);
  };

  test("a scenario with an inferred request draws request, answer and event", () => {
    const [, , background, scenarios] = parseFeature(
      readFileSync(path.join(specs, "orders", "features", "place-order.feature"), "utf-8"),
    );
    const bg = structuredSteps(background);
    const first = extractRefs([...bg, ...structuredSteps(scenarios[0][1])], orders);
    expect(scenarioSequence(first, orders).join("\n")).toBe(
      [
        "```mermaid",
        "sequenceDiagram",
        "    autonumber",
        "    participant client as Customer",
        "    participant svc as Orders",
        "    participant c_orders_placed_v2 as orders.placed.v2",
        "    client->>svc: POST /orders · placeOrder",
        "    svc-->>client: 201",
        "    svc-)c_orders_placed_v2: OrderPlaced",
        "```",
      ].join("\n"),
    );
    const settled = scenarios.find(([t]) => t === "A settled payment marks the order paid")!;
    const eighth = extractRefs([...bg, ...structuredSteps(settled[1])], orders);
    expect(scenarioSequence(eighth, orders).join("\n")).toBe(
      [
        "```mermaid",
        "sequenceDiagram",
        "    autonumber",
        "    participant c_payments_settled_v2 as payments.settled.v2",
        "    participant svc as Orders",
        "    c_payments_settled_v2--)svc: PaymentSettled",
        "```",
      ].join("\n"),
    );
  });

  test("a scenario with no trigger opens with its When as a note; a withheld event is a crossed arrow", () => {
    const chart = scenarioSequence(
      extractRefs(steps("    When the order is cancelled", '    Then no "OrderCancelled" event is published'), orders),
      orders,
    );
    expect(chart).toContain("    Note over svc: When the order is cancelled");
    expect(chart).toContain("    svc-xc_orders_cancelled_v2: no OrderCancelled");
    expect(chart.some((l) => l.includes("client"))).toBe(false);
  });

  test("a scenario naming nothing draws nothing", () => {
    expect(scenarioSequence(extractRefs(steps("    Then it works"), orders), orders)).toEqual([]);
  });

  test("labels never carry the characters that break mermaid", () => {
    const chart = scenarioSequence(
      extractRefs(steps('    When <thing> is "quoted"; # then', '    Then an "OrderPlaced" event is published'), orders),
      orders,
    );
    const note = chart.find((l) => l.includes("Note over svc"))!;
    expect(note).toBe("    Note over svc: When \u2039thing\u203a is 'quoted'    then");
  });

  test("the feature flow map groups triggers, scenarios and outcomes and links them", () => {
    const f = ordersFeature();
    const lines: string[] = f.flow_mermaid.split("\n");
    expect(lines[0]).toBe("flowchart LR");
    expect(lines).toContain('        http_placeOrder["POST /orders · placeOrder"]');
    expect(lines).toContain('        ch_in_payments_settled_v2>"payments.settled.v2"]');
    expect(lines).toContain('        sc_7("An order is only cancelled for a declared reason")');
    expect(lines).toContain('        ch_out_orders_placed_v2[["orders.placed.v2"]]');
    expect(lines).toContain('    sc_1 -->|"OrderPlaced"| ch_out_orders_placed_v2');
    expect(lines).toContain('    sc_3 -.->|"no OrderPlaced"| ch_out_orders_placed_v2');
    expect(lines).toContain('    ch_in_payments_settled_v2 -->|"PaymentSettled"| sc_8');
    expect(lines).toContain('    click http_placeOrder "../orders.openapi/#placeOrder"');
    expect(lines).toContain('    click ch_in_payments_settled_v2 "../../payments/payments.asyncapi/#payments-settled-v2"');
    expect(lines).toContain('    click sc_8 "#a-settled-payment-marks-the-order-paid"');
    // The orphan scenario has a node and nothing else.
    expect(lines.filter((l) => /\bsc_7\b/.test(l) && l.includes("-->"))).toEqual([]);
    expect(f.actor).toBe("Customer");
    expect(f.scenarios[0].sequence_mermaid).toMatch(/^sequenceDiagram\n/);
    expect(f.scenarios[6].sequence_mermaid).toBeNull();
  });

  test("a feature with no triggers has no Triggers subgraph", () => {
    const chart = featureFlow(
      [{ title: "Only publishes", refs: { operations: [], inbound: [], outbound: [out("orders.placed.v2", "OrderPlaced")], statuses: [] } }],
      orders,
    );
    expect(chart.some((l) => l.includes("sg_triggers"))).toBe(false);
    expect(chart).toContain('    subgraph sg_outcomes["Outcomes"]');
  });
});

describe("journeys over the fixture tree", () => {
  const data = buildData(loadManifests(specs), specs, mocks);

  test("the demo chains placing an order through settlement and back", () => {
    expect(data.flows.truncated).toBe(false);
    expect(data.flows.journeys.map((j: any) => [j.id, j.title])).toEqual([
      ["orders:place-order:1>payments:settle-payment:3>orders:place-order:8", "placeOrder → OrderPlaced → PaymentSettled"],
      ["orders:place-order:2>payments:settle-payment:3>orders:place-order:8", "placeOrder → OrderPlaced → PaymentSettled"],
      ["orders:place-order:5>payments:settle-payment:3>orders:place-order:8", "OrderPlaced → PaymentSettled"],
      ["payments:settle-payment:1>orders:place-order:8", "PaymentSettled"],
      ["payments:settle-payment:2>orders:place-order:8", "PaymentSettled"],
    ]);
    const first = data.flows.journeys[0];
    expect(first.services).toEqual(["orders", "payments"]);
    expect(first.steps.map((s: any) => [s.scenario, s.trigger, s.inbound])).toEqual([
      ["A valid order is accepted and its event is guaranteed", { op_id: "placeOrder" }, null],
      ["Settlement is anchored to an observed order placement", null, { channel: "orders.placed.v2", message: "OrderPlaced" }],
      ["A settled payment marks the order paid", null, { channel: "payments.settled.v2", message: "PaymentSettled" }],
    ]);
    expect(first.sequence_mermaid).toBe(
      [
        "sequenceDiagram",
        "    autonumber",
        "    participant client as Customer",
        "    participant s_orders as Orders",
        "    participant c_orders_placed_v2 as orders.placed.v2",
        "    participant s_payments as Payments",
        "    participant c_payments_settled_v2 as payments.settled.v2",
        "    Note over s_orders: A valid order is accepted and its event is guaranteed",
        "    client->>s_orders: POST /orders · placeOrder",
        "    s_orders-->>client: 201",
        "    s_orders-)c_orders_placed_v2: OrderPlaced",
        "    c_orders_placed_v2--)s_payments: OrderPlaced",
        "    Note over s_payments: Settlement is anchored to an observed order placement",
        "    s_payments-)c_payments_settled_v2: PaymentSettled",
        "    c_payments_settled_v2--)s_orders: PaymentSettled",
        "    Note over s_orders: A settled payment marks the order paid",
      ].join("\n"),
    );
  });

  test("the scenario graph shows only scenarios on a message edge, grouped by service", () => {
    const graph: string = data.flows.graph_mermaid;
    expect(graph).toContain('    subgraph sg_orders["Orders"]');
    expect(graph).toContain('    sc_orders_place_order_1 -->|"OrderPlaced"| sc_payments_settle_payment_3');
    expect(graph).toContain('    click sc_payments_settle_payment_3 "../services/payments/features/#settlement-is-anchored-to-an-observed-order-placement"');
    expect(graph).toContain('    click http_orders_placeOrder "../services/orders/orders.openapi/#placeOrder"');
    expect(graph).not.toContain("sc_orders_place_order_7");
  });

  test("scenarios are written back onto the operations and channels they exercise", () => {
    const ordersSvc = data.services.find((s: any) => s.name === "orders");
    const placeOrder = ordersSvc.operations.find((o: any) => o.op_id === "placeOrder");
    expect(placeOrder.scenarios.map((s: any) => s.title)).toEqual([
      "A valid order is accepted and its event is guaranteed",
      "The order and its event succeed or fail together",
      "Replaying an idempotency key returns the original order",
      "A conflicting body on a used idempotency key is rejected",
      "An order can be fetched by its id",
      "Orders must have at least one valid line",
    ]);
    const placed = ordersSvc.channels.find((c: any) => c.address === "orders.placed.v2");
    expect(placed.scenarios.map((s: any) => [s.service, s.direction, s.negated])).toEqual([
      ["orders", "publishes", false],
      ["orders", "publishes", false],
      ["orders", "publishes", true],
      ["orders", "publishes", false],
      ["payments", "consumes", false],
    ]);
  });

  test("running the derivation twice gives the same answer", () => {
    const again = buildData(loadManifests(specs), specs, mocks);
    expect(again.flows).toEqual(data.flows);
  });
});

describe("journeys: bounds", () => {
  /** A synthetic catalog: services with one feature each, scenarios as
   * [title, refs]. */
  const synth = (
    defs: { name: string; produces: string[]; consumes: string[]; scenarios: [string, any][] }[],
  ) =>
    defs.map((d) => ({
      name: d.name,
      title: d.name,
      produces: d.produces,
      consumes: d.consumes,
      operations: [],
      channels: d.produces.map((address) => ({ address })),
      artifacts: [
        {
          kind: "feature",
          stem: "f",
          path: "features/f.feature",
          feature: {
            actor: "Client",
            scenarios: d.scenarios.map(([title, refs]) => ({ title, refs })),
          },
        },
      ],
    }));
  const pub = (channel: string, message: string) => ({
    operations: [],
    inbound: [],
    outbound: [out(channel, message)],
    statuses: [],
  });
  const relay = (inChannel: string, inMessage: string, outChannel: string, outMessage: string) => ({
    operations: [],
    inbound: [{ channel: inChannel, message: inMessage, producer: null }],
    outbound: [out(outChannel, outMessage)],
    statuses: [],
  });

  test("a cycle terminates and never revisits a scenario", () => {
    const services = synth([
      { name: "a", produces: ["a.x.v1"], consumes: ["b.y.v1"], scenarios: [["start", pub("a.x.v1", "AX")], ["back", relay("b.y.v1", "BY", "a.x.v1", "AX")]] },
      { name: "b", produces: ["b.y.v1"], consumes: ["a.x.v1"], scenarios: [["relay", relay("a.x.v1", "AX", "b.y.v1", "BY")]] },
    ]);
    const flows = deriveFlows(services);
    expect(flows.truncated).toBe(false);
    for (const j of flows.journeys) {
      const keys = j.steps.map((s) => `${s.service}:${s.index}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(flows.journeys.map((j) => j.id)).toEqual(["a:f:1>b:f:1>a:f:2"]);
  });

  test("more journeys than the cap are truncated, and said so", () => {
    const consumers: [string, any][] = Array.from({ length: MAX_JOURNEYS + 5 }, (_, i) => [
      `consumer ${i}`,
      { operations: [], inbound: [{ channel: "a.x.v1", message: "AX", producer: null }], outbound: [], statuses: [] },
    ]);
    const services = synth([
      { name: "a", produces: ["a.x.v1"], consumes: [], scenarios: [["start", pub("a.x.v1", "AX")]] },
      { name: "b", produces: [], consumes: ["a.x.v1"], scenarios: consumers },
    ]);
    const flows = deriveFlows(services);
    expect(flows.truncated).toBe(true);
    expect(flows.journeys).toHaveLength(MAX_JOURNEYS);
  });

  test("a lone service with nobody listening has no journeys and no graph", () => {
    const services = synth([
      { name: "greeter", produces: ["greeter.greeted.v1"], consumes: [], scenarios: [["greets", pub("greeter.greeted.v1", "GreeterGreeted")]] },
    ]);
    backLinks(services);
    expect(deriveFlows(services)).toEqual({ journeys: [], truncated: false, graph_mermaid: null });
    expect((services[0].channels[0] as any).scenarios).toEqual([
      { service: "greeter", feature: "f", title: "greets", message: "GreeterGreeted", direction: "publishes", negated: false },
    ]);
  });
});
