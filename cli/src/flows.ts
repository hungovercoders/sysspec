/** Scenarios as flows: what each acceptance criterion does to the system.
 *
 * A feature file already names the contract it exercises, in the
 * spellings the gates enforce: a quoted "PascalCase" message
 * (lint:manifest resolves it to an owned or consumed channel), a quoted
 * dotted channel address, a bare operationId (check:intent requires a
 * new endpoint to be named this way) and `the response status is 201`.
 * This module reads those spellings back out of every scenario as
 * contract references, decides direction from the contract graph rather
 * than from verbs (a message on a channel the service produces is
 * outbound, on one it consumes inbound), and draws the result: a
 * sequence diagram per scenario, a flow map per feature, and the
 * cross-service journeys that fall out of chaining a publishing scenario
 * to the scenario in another service that consumes the same message.
 *
 * Everything here is a pure function of the spec tree: no filesystem,
 * no clock, stable ordering throughout (first mention in document order
 * within a scenario, manifest and document order across them), so the
 * emitted specs.json stays byte-identical for the same inputs and every
 * chart is gated by `sysspec docs diagrams`.
 */

import { Dict, mermaidLabel, nodeId } from "./docs-gen.js";
import { CHANNEL_RE, MESSAGE_RE, slug } from "./util.js";

/** `the response status is 201` - and not `the order status is "placed"`. */
export const STATUS_RE = /\bstatus\s+is\s+(\d{3})\b/g;

/** Journeys are bounded so a large suite cannot explode the catalog:
 * at most this many hops per journey, this many journeys, and this many
 * search steps before `truncated` is set. */
export const MAX_DEPTH = 6;
export const MAX_JOURNEYS = 50;
export const MAX_SEARCH_STEPS = 5000;

export interface FlowOp {
  op_id: string;
  method: string;
  path: string;
  /** Response codes the contract declares, for the status → op inference. */
  statuses: string[];
  /** Stem of the OpenAPI artifact, the page the op is rendered on. */
  stem: string;
}

export interface ChannelPage {
  service: string;
  stem: string;
}

/** What one service's scenarios are read against. */
export interface FlowContext {
  service: string;
  title: string;
  actor: string;
  ops: FlowOp[];
  produces: string[];
  consumes: string[];
  /** message name → channel address, across the whole suite. */
  messageChannel: Map<string, string>;
  /** channel address → producing service name. */
  channelProducer: Map<string, string>;
  /** channel address → where its producer renders it. */
  channelPage: Map<string, ChannelPage>;
}

export interface OperationRef {
  op_id: string;
  /** "name" when the scenario names the op; "status" when it was the
   * only op in the contract that can answer the status the scenario
   * asserts. */
  via: "name" | "status";
}

export interface InboundRef {
  channel: string;
  message: string | null;
  producer: string | null;
}

export interface OutboundRef {
  channel: string;
  message: string | null;
  negated: boolean;
}

export interface ScenarioRefs {
  operations: OperationRef[];
  inbound: InboundRef[];
  outbound: OutboundRef[];
  statuses: string[];
}

/** One contract event in a scenario, in first-mention order. */
type FlowEvent =
  | { kind: "op"; phase: string; op: OperationRef }
  | { kind: "status"; phase: string; status: string }
  | { kind: "in"; phase: string; ref: InboundRef }
  | { kind: "out"; phase: string; ref: OutboundRef };

export interface Extraction {
  refs: ScenarioRefs;
  events: FlowEvent[];
  /** The first When step, for a scenario that has refs but no trigger. */
  cause: string | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A mention is negated when `no` sits at most one word before it:
 * `no second "OrderPlaced"`, `no "PaymentSettled" event`. The double
 * negative `no order ever exists without its "OrderPlaced" event` is
 * five words away and stays positive, as it should. */
function negatedIn(text: string, message: string): boolean {
  return new RegExp(`\\bno(?:\\s+\\w+)?\\s+"${escapeRe(message)}"`).test(text);
}

/** The actor named by the feature's `As a <role>` line, else Client. */
export function featureActor(description: string[]): string {
  for (const line of description) {
    const m = line.trim().match(/^As an?\s+(.+?)[,.]?$/i);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
  }
  return "Client";
}

/** Contract references of one scenario (background steps included, in
 * front), plus the ordered events the sequence diagram draws. */
export function extractRefs(steps: Dict[], ctx: FlowContext): Extraction {
  const events: FlowEvent[] = [];
  const ops = new Map<string, OperationRef>();
  const inbound = new Map<string, InboundRef>();
  const outbound = new Map<string, OutboundRef>();
  const statuses: string[] = [];
  const produces = new Set(ctx.produces);
  const consumes = new Set(ctx.consumes);
  let cause: string | null = null;

  const addOp = (op: OperationRef, phase: string) => {
    const seen = ops.get(op.op_id);
    if (seen) {
      // Naming the op beats inferring it, wherever each happened.
      if (seen.via === "status" && op.via === "name") seen.via = "name";
      return;
    }
    ops.set(op.op_id, op);
    events.push({ kind: "op", phase, op });
  };

  const addMessage = (channel: string, message: string | null, text: string, phase: string) => {
    const key = `${channel}\u0000${message ?? ""}`;
    if (produces.has(channel)) {
      const negated = message !== null && negatedIn(text, message);
      const seen = outbound.get(key);
      if (seen) {
        // Positive wins: a scenario that both publishes and withholds
        // the same message is asserting that it publishes.
        if (!negated) seen.negated = false;
        return;
      }
      const ref: OutboundRef = { channel, message, negated };
      outbound.set(key, ref);
      events.push({ kind: "out", phase, ref });
    } else if (consumes.has(channel)) {
      if (inbound.has(key)) return;
      const ref: InboundRef = {
        channel,
        message,
        producer: ctx.channelProducer.get(channel) ?? null,
      };
      inbound.set(key, ref);
      events.push({ kind: "in", phase, ref });
    }
    // A channel this service neither produces nor consumes is lint's
    // finding, not the catalog's: the mention is dropped.
  };

  for (const step of steps) {
    const text: string | undefined = step.text;
    if (typeof text !== "string") continue;
    const phase: string = step.phase ?? "given";
    if (cause === null && phase === "when") cause = `${step.keyword} ${text}`;

    for (const op of ctx.ops) {
      if (new RegExp(`\\b${escapeRe(op.op_id)}\\b`).test(text)) {
        addOp({ op_id: op.op_id, via: "name" }, phase);
      }
    }

    const quotedChannels = [...text.matchAll(CHANNEL_RE)].map((m) => m[1]);
    const claimed = new Set<string>();
    for (const m of text.matchAll(MESSAGE_RE)) {
      const message = m[1];
      const channel = ctx.messageChannel.get(message);
      if (!channel) continue;
      claimed.add(channel);
      addMessage(channel, message, text, phase);
    }
    for (const channel of quotedChannels) {
      // The message decides its channel; an address quoted on its own
      // (or a different one) is a channel-level reference.
      if (claimed.has(channel)) continue;
      addMessage(channel, null, text, phase);
    }

    for (const m of text.matchAll(STATUS_RE)) {
      const status = m[1];
      if (!statuses.includes(status)) {
        statuses.push(status);
        events.push({ kind: "status", phase, status });
      }
      const answering = ctx.ops.filter((op) => op.statuses.includes(status));
      if (answering.length === 1) addOp({ op_id: answering[0].op_id, via: "status" }, phase);
    }
  }

  // An inferred op is the request the scenario never spells out: draw it
  // where the request happens, ahead of the first non-Given event.
  const inferred = events.filter((e) => e.kind === "op" && e.op.via === "status");
  if (inferred.length) {
    const rest = events.filter((e) => !inferred.includes(e));
    let at = rest.findIndex((e) => e.phase !== "given");
    if (at === -1) at = rest.length;
    events.splice(0, events.length, ...rest.slice(0, at), ...inferred, ...rest.slice(at));
  }

  const refs: ScenarioRefs = {
    operations: events.filter((e) => e.kind === "op").map((e) => (e as any).op),
    inbound: events.filter((e) => e.kind === "in").map((e) => (e as any).ref),
    outbound: events.filter((e) => e.kind === "out").map((e) => (e as any).ref),
    statuses,
  };
  const hasTrigger = refs.operations.length > 0 || refs.inbound.length > 0;
  const hasRefs = hasTrigger || refs.outbound.length > 0 || statuses.length > 0;
  return { refs, events, cause: hasRefs && !hasTrigger ? cause : null };
}

/** A note's worth of a step, clipped so the diagram stays readable. */
function noteText(text: string, max = 80): string {
  const label = mermaidLabel(text);
  return label.length > max ? label.slice(0, max - 1).trimEnd() + "…" : label;
}

const opLabel = (op: FlowOp) => mermaidLabel(`${op.method} ${op.path} · ${op.op_id}`);
const chanId = (address: string) => `c_${nodeId(address)}`;

/** One scenario as a fenced sequence diagram: the actor's request and
 * the service's answer, the events it consumes and the events it
 * publishes (a crossed arrow for one it must not), in the order the
 * scenario states them. [] when the scenario names no contract. */
export function scenarioSequence(extraction: Extraction, ctx: FlowContext): string[] {
  const { refs, events, cause } = extraction;
  const hasRefs =
    refs.operations.length + refs.inbound.length + refs.outbound.length + refs.statuses.length > 0;
  if (!hasRefs) return [];
  const opsById = new Map(ctx.ops.map((op) => [op.op_id, op]));
  const client = refs.operations.length > 0 || refs.statuses.length > 0;

  const lines = ["```mermaid", "sequenceDiagram", "    autonumber"];
  if (client) lines.push(`    participant client as ${mermaidLabel(ctx.actor)}`);
  for (const ref of refs.inbound) {
    lines.push(`    participant ${chanId(ref.channel)} as ${mermaidLabel(ref.channel)}`);
  }
  lines.push(`    participant svc as ${mermaidLabel(ctx.title)}`);
  for (const ref of refs.outbound) {
    lines.push(`    participant ${chanId(ref.channel)} as ${mermaidLabel(ref.channel)}`);
  }
  if (cause) lines.push(`    Note over svc: ${noteText(cause)}`);
  for (const e of events) {
    if (e.kind === "op") {
      const op = opsById.get(e.op.op_id);
      lines.push(`    client->>svc: ${op ? opLabel(op) : mermaidLabel(e.op.op_id)}`);
    } else if (e.kind === "status") {
      lines.push(`    svc-->>client: ${e.status}`);
    } else if (e.kind === "in") {
      lines.push(`    ${chanId(e.ref.channel)}--)svc: ${mermaidLabel(e.ref.message ?? "event")}`);
    } else if (e.ref.negated) {
      lines.push(`    svc-x${chanId(e.ref.channel)}: no ${mermaidLabel(e.ref.message ?? "event")}`);
    } else {
      lines.push(`    svc-)${chanId(e.ref.channel)}: ${mermaidLabel(e.ref.message ?? "event")}`);
    }
  }
  lines.push("```");
  return lines;
}

export interface FlowScenario {
  title: string;
  refs: ScenarioRefs;
}

/** Relative link from a service's features page to a channel's section
 * on its producer's AsyncAPI page. */
function channelHref(address: string, ctx: FlowContext): string | null {
  const page = ctx.channelPage.get(address);
  if (!page) return null;
  const hash = `#${address.replaceAll(".", "-")}`;
  return page.service === ctx.service
    ? `../${page.stem}/${hash}`
    : `../../${page.service}/${page.stem}/${hash}`;
}

/** A feature as a fenced flowchart: what triggers its scenarios (the
 * operations and inbound channels they name), the scenarios, and what
 * each one leads to (response statuses, published events). A scenario
 * that names no contract still gets a node, so the gap shows. Nodes
 * link to the contract sections and scenario headings. */
export function featureFlow(scenarios: FlowScenario[], ctx: FlowContext): string[] {
  if (scenarios.length === 0) return [];
  const usedOps = new Set(scenarios.flatMap((s) => s.refs.operations.map((o) => o.op_id)));
  const usedIn = new Set(scenarios.flatMap((s) => s.refs.inbound.map((r) => r.channel)));
  const usedOut = new Set(scenarios.flatMap((s) => s.refs.outbound.map((r) => r.channel)));
  const statuses = [...new Set(scenarios.flatMap((s) => s.refs.statuses))].sort();
  const ops = ctx.ops.filter((op) => usedOps.has(op.op_id));
  const inbound = ctx.consumes.filter((c) => usedIn.has(c));
  const outbound = ctx.produces.filter((c) => usedOut.has(c));

  const lines = ["```mermaid", "flowchart LR"];
  const clicks: string[] = [];
  if (ops.length || inbound.length) {
    lines.push('    subgraph sg_triggers["Triggers"]');
    for (const op of ops) {
      lines.push(`        http_${nodeId(op.op_id)}["${opLabel(op)}"]`);
      clicks.push(`    click http_${nodeId(op.op_id)} "../${op.stem}/#${nodeId(op.op_id)}"`);
    }
    for (const address of inbound) {
      lines.push(`        ch_in_${nodeId(address)}>"${mermaidLabel(address)}"]`);
      const href = channelHref(address, ctx);
      if (href) clicks.push(`    click ch_in_${nodeId(address)} "${href}"`);
    }
    lines.push("    end");
  }
  lines.push('    subgraph sg_scenarios["Scenarios"]');
  scenarios.forEach((s, i) => {
    lines.push(`        sc_${i + 1}("${mermaidLabel(s.title)}")`);
    clicks.push(`    click sc_${i + 1} "#${slug(s.title)}"`);
  });
  lines.push("    end");
  if (statuses.length || outbound.length) {
    lines.push('    subgraph sg_outcomes["Outcomes"]');
    for (const status of statuses) lines.push(`        st_${status}(["${status}"])`);
    for (const address of outbound) {
      lines.push(`        ch_out_${nodeId(address)}[["${mermaidLabel(address)}"]]`);
      const href = channelHref(address, ctx);
      if (href) clicks.push(`    click ch_out_${nodeId(address)} "${href}"`);
    }
    lines.push("    end");
  }
  scenarios.forEach((s, i) => {
    const sc = `sc_${i + 1}`;
    for (const op of s.refs.operations) lines.push(`    http_${nodeId(op.op_id)} --> ${sc}`);
    for (const ref of s.refs.inbound) {
      const label = ref.message ? `|"${mermaidLabel(ref.message)}"|` : "";
      lines.push(`    ch_in_${nodeId(ref.channel)} -->${label} ${sc}`);
    }
    for (const status of s.refs.statuses) lines.push(`    ${sc} --> st_${status}`);
    for (const ref of s.refs.outbound) {
      const name = mermaidLabel(ref.message ?? "event");
      lines.push(
        ref.negated
          ? `    ${sc} -.->|"no ${name}"| ch_out_${nodeId(ref.channel)}`
          : `    ${sc} -->|"${name}"| ch_out_${nodeId(ref.channel)}`,
      );
    }
  });
  lines.push(...clicks, "```");
  return lines;
}

/* ------------------------------------------------------------------ */
/* Journeys: scenarios chained across services by the messages they   */
/* publish and consume.                                               */
/* ------------------------------------------------------------------ */

interface Node {
  order: number;
  service: string;
  serviceTitle: string;
  actor: string;
  feature: string;
  index: number;
  title: string;
  refs: ScenarioRefs;
  consumes: Set<string>;
  ops: Map<string, Dict>;
  /** Stem of the OpenAPI artifact the service's ops render on. */
  openapiStem: string | null;
}

interface Edge {
  from: Node;
  to: Node;
  channel: string;
  message: string;
}

export interface JourneyStep {
  service: string;
  feature: string;
  index: number;
  scenario: string;
  trigger: { op_id: string } | null;
  inbound: { channel: string; message: string } | null;
  outbound: { channel: string; message: string | null }[];
}

export interface Journey {
  id: string;
  title: string;
  services: string[];
  steps: JourneyStep[];
  sequence_mermaid: string;
}

export interface Flows {
  journeys: Journey[];
  truncated: boolean;
  graph_mermaid: string | null;
}

const stemOf = (p: string) => String(p).split("/").pop()!.replace(/\.[^.]*$/, "");

/** Every scenario of every service as a graph node, in catalog order. */
function scenarioNodes(services: Dict[]): Node[] {
  const nodes: Node[] = [];
  for (const s of services) {
    const openapi = (s.artifacts ?? []).find((a: Dict) => a.kind === "openapi");
    const ops = new Map<string, Dict>((s.operations ?? []).map((o: Dict) => [o.op_id, o]));
    for (const a of s.artifacts ?? []) {
      if (a.kind !== "feature" || !a.feature) continue;
      (a.feature.scenarios ?? []).forEach((sc: Dict, i: number) => {
        if (!sc.refs) return;
        nodes.push({
          order: nodes.length,
          service: s.name,
          serviceTitle: s.title,
          actor: a.feature.actor ?? "Client",
          feature: a.stem,
          index: i + 1,
          title: sc.title,
          refs: sc.refs,
          consumes: new Set(s.consumes ?? []),
          ops,
          openapiStem: openapi ? stemOf(openapi.path) : null,
        });
      });
    }
  }
  return nodes;
}

/** A publishing scenario feeds every scenario in another service that
 * consumes the channel and names the message (or the bare channel). */
function scenarioEdges(nodes: Node[]): Edge[] {
  const edges: Edge[] = [];
  for (const from of nodes) {
    for (const out of from.refs.outbound) {
      if (out.negated || !out.message) continue;
      for (const to of nodes) {
        if (to.service === from.service || !to.consumes.has(out.channel)) continue;
        const listens = to.refs.inbound.some(
          (r) => r.channel === out.channel && (r.message === out.message || r.message === null),
        );
        if (listens) edges.push({ from, to, channel: out.channel, message: out.message });
      }
    }
  }
  return edges;
}

const nodeKey = (n: Node) => `${n.service}:${n.feature}:${n.index}`;

/** One journey as a fenced sequence diagram: each hop's scenario as a
 * note over its service, then its request, answer and published
 * events, and the delivery that hands over to the next service. */
function journeySequence(path: Node[], via: Edge[]): string[] {
  const body: string[] = [];
  const participants: [string, string][] = [];
  const declare = (id: string, label: string) => {
    if (!participants.some(([p]) => p === id)) participants.push([id, mermaidLabel(label)]);
  };
  const entryOp = path[0].refs.operations[0];
  if (entryOp) declare("client", path[0].actor);

  path.forEach((node, i) => {
    const svc = `s_${nodeId(node.service)}`;
    declare(svc, node.serviceTitle);
    body.push(`    Note over ${svc}: ${noteText(node.title)}`);
    if (i === 0 && entryOp) {
      const op = node.ops.get(entryOp.op_id);
      const label = op ? `${op.method} ${op.path} · ${op.op_id}` : entryOp.op_id;
      body.push(`    client->>${svc}: ${mermaidLabel(label)}`);
      for (const status of node.refs.statuses) body.push(`    ${svc}-->>client: ${status}`);
    }
    for (const out of node.refs.outbound) {
      if (out.negated) continue;
      declare(chanId(out.channel), out.channel);
      body.push(`    ${svc}-)${chanId(out.channel)}: ${mermaidLabel(out.message ?? "event")}`);
    }
    const edge = via[i];
    if (edge) {
      const next = `s_${nodeId(edge.to.service)}`;
      declare(next, edge.to.serviceTitle);
      body.push(`    ${chanId(edge.channel)}--)${next}: ${mermaidLabel(edge.message)}`);
    }
  });
  return [
    "```mermaid",
    "sequenceDiagram",
    "    autonumber",
    ...participants.map(([id, label]) => `    participant ${id} as ${label}`),
    ...body,
    "```",
  ];
}

/** The cross-service scenario graph as a fenced flowchart: scenarios on
 * at least one message edge, grouped by service, with the operations
 * that start them. [] when no scenario hands over to another service. */
function scenarioGraph(nodes: Node[], edges: Edge[], services: Dict[]): string[] {
  if (edges.length === 0) return [];
  const onGraph = new Set<Node>();
  for (const e of edges) onGraph.add(e.from).add(e.to);
  const shown = nodes.filter((n) => onGraph.has(n));
  const scId = (n: Node) => `sc_${nodeId(n.service)}_${nodeId(n.feature)}_${n.index}`;
  const lines = ["```mermaid", "flowchart LR"];
  const clicks: string[] = [];
  const opEdges: string[] = [];
  for (const n of shown) {
    for (const op of n.refs.operations) {
      const id = `http_${nodeId(n.service)}_${nodeId(op.op_id)}`;
      const spec = n.ops.get(op.op_id);
      const label = spec ? `${spec.method} ${spec.path} · ${op.op_id}` : op.op_id;
      if (!lines.some((l) => l.startsWith(`    ${id}[`))) {
        lines.push(`    ${id}["${mermaidLabel(label)}"]`);
        if (n.openapiStem) {
          clicks.push(`    click ${id} "../services/${n.service}/${n.openapiStem}/#${nodeId(op.op_id)}"`);
        }
      }
      opEdges.push(`    ${id} --> ${scId(n)}`);
    }
  }
  for (const s of services) {
    const own = shown.filter((n) => n.service === s.name);
    if (own.length === 0) continue;
    lines.push(`    subgraph sg_${nodeId(s.name)}["${mermaidLabel(s.title)}"]`);
    for (const n of own) {
      lines.push(`        ${scId(n)}("${mermaidLabel(n.title)}")`);
      clicks.push(`    click ${scId(n)} "../services/${n.service}/features/#${slug(n.title)}"`);
    }
    lines.push("    end");
  }
  lines.push(...opEdges);
  for (const e of edges) {
    lines.push(`    ${scId(e.from)} -->|"${mermaidLabel(e.message)}"| ${scId(e.to)}`);
  }
  lines.push(...clicks, "```");
  return lines;
}

function unfence(lines: string[]): string {
  return lines.slice(1, -1).join("\n");
}

/** Every maximal chain of scenarios across services, bounded.
 *
 * An entry is a scenario a caller or the outside world starts (it names
 * an operation, or consumes nothing) that publishes at least one
 * message. From each, follow the message edges depth-first in catalog
 * order; a chain ends where no scenario consumes what was published,
 * at MAX_DEPTH hops, or where it would revisit a scenario. Only chains
 * of two or more scenarios are journeys - a lone scenario is its own
 * feature page.
 */
export function deriveFlows(services: Dict[]): Flows {
  const nodes = scenarioNodes(services);
  const edges = scenarioEdges(nodes);
  const outgoing = new Map<Node, Edge[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }
  for (const list of outgoing.values()) {
    list.sort((a, b) => a.to.order - b.to.order || (a.message < b.message ? -1 : 1));
  }

  const entries = nodes.filter(
    (n) =>
      (n.refs.operations.length > 0 || n.refs.inbound.length === 0) &&
      n.refs.outbound.some((o) => !o.negated && o.message),
  );

  const found = new Map<string, { path: Node[]; via: Edge[] }>();
  let steps = 0;
  let truncated = false;
  const walk = (path: Node[], via: Edge[]) => {
    if (steps++ > MAX_SEARCH_STEPS) {
      truncated = true;
      return;
    }
    const last = path[path.length - 1];
    const next = (outgoing.get(last) ?? []).filter(
      (e) => !path.includes(e.to) && path.length - 1 < MAX_DEPTH,
    );
    if (next.length === 0) {
      if (path.length >= 2) {
        const id = path.map(nodeKey).join(">");
        if (!found.has(id)) found.set(id, { path, via });
      }
      return;
    }
    for (const e of next) walk([...path, e.to], [...via, e]);
  };
  for (const entry of entries) walk([entry], []);

  const ordered = [...found.values()].sort((a, b) => {
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
      if (a.path[i].order !== b.path[i].order) return a.path[i].order - b.path[i].order;
    }
    return a.path.length - b.path.length;
  });
  if (ordered.length > MAX_JOURNEYS) truncated = true;

  const journeys: Journey[] = ordered.slice(0, MAX_JOURNEYS).map(({ path, via }) => {
    const entryOp = path[0].refs.operations[0];
    const messages = via.map((e) => e.message);
    return {
      id: path.map(nodeKey).join(">"),
      title: [...(entryOp ? [entryOp.op_id] : []), ...messages].join(" → "),
      services: [...new Set(path.map((n) => n.service))],
      steps: path.map((n, i) => ({
        service: n.service,
        feature: n.feature,
        index: n.index,
        scenario: n.title,
        trigger: i === 0 && entryOp ? { op_id: entryOp.op_id } : null,
        inbound: i > 0 ? { channel: via[i - 1].channel, message: via[i - 1].message } : null,
        outbound: n.refs.outbound
          .filter((o) => !o.negated)
          .map((o) => ({ channel: o.channel, message: o.message })),
      })),
      sequence_mermaid: unfence(journeySequence(path, via)),
    };
  });

  const graph = scenarioGraph(nodes, edges, services);
  return { journeys, truncated, graph_mermaid: graph.length ? unfence(graph) : null };
}

/** Write each scenario back onto the contract it exercises: the
 * operations it names and the channels it publishes to or consumes
 * from (on the producer's channel entry, which is where a channel
 * renders). Publishing scenarios list first, then by service, feature
 * and document order. */
export function backLinks(services: Dict[]): void {
  const channelOwner = new Map<string, Dict>();
  for (const s of services) {
    for (const c of s.channels ?? []) channelOwner.set(c.address, c);
    for (const o of s.operations ?? []) o.scenarios = [];
    for (const c of s.channels ?? []) c.scenarios = [];
  }
  const sorted = [...services].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const s of sorted) {
    const opsById = new Map<string, Dict>((s.operations ?? []).map((o: Dict) => [o.op_id, o]));
    const features = (s.artifacts ?? [])
      .filter((a: Dict) => a.kind === "feature" && a.feature)
      .sort((a: Dict, b: Dict) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
    for (const a of features) {
      for (const sc of a.feature.scenarios ?? []) {
        const refs: ScenarioRefs | undefined = sc.refs;
        if (!refs) continue;
        for (const op of refs.operations) {
          opsById.get(op.op_id)?.scenarios.push({ feature: a.stem, title: sc.title });
        }
        for (const out of refs.outbound) {
          channelOwner.get(out.channel)?.scenarios.push({
            service: s.name,
            feature: a.stem,
            title: sc.title,
            message: out.message,
            direction: "publishes",
            negated: out.negated,
          });
        }
        for (const inb of refs.inbound) {
          channelOwner.get(inb.channel)?.scenarios.push({
            service: s.name,
            feature: a.stem,
            title: sc.title,
            message: inb.message,
            direction: "consumes",
            negated: false,
          });
        }
      }
    }
  }
  for (const c of channelOwner.values()) {
    // Stable sort: publishers first, the insertion order (service,
    // feature, document) kept within each group.
    c.scenarios = [
      ...c.scenarios.filter((x: Dict) => x.direction === "publishes"),
      ...c.scenarios.filter((x: Dict) => x.direction !== "publishes"),
    ];
  }
}
