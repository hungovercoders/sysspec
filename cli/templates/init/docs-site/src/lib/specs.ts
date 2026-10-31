import data from '../data/specs.json';

export interface SchemaRow {
  field: string;
  type: string;
  required: boolean;
  constraints: string;
}

export interface Operation {
  op_id: string;
  kind: 'command' | 'query';
  method: string;
  path: string;
  summary: string;
  description: string;
  artifact_path: string;
  artifact_version: string | null;
  parameters: { name: string; in: string; type: string; required: boolean }[];
  request_rows: SchemaRow[];
  responses: { status: string; description: string }[];
  response_body: { status: string; rows: SchemaRow[] } | null;
  examples: { case: string; request: string | null; status: string | null; response: string | null }[];
  /** Scenarios that name this operation, or assert a status only it answers. */
  scenarios: { feature: string; title: string }[];
}

export interface ChannelMessage {
  name: string;
  title: string;
  event_type: string | null;
  data_rows: SchemaRow[];
  envelope_rows: SchemaRow[];
}

export interface Channel {
  address: string;
  producer: string;
  producer_title: string;
  artifact_path: string;
  artifact_version: string | null;
  description: string;
  consumers: string[];
  sequence_mermaid: string;
  messages: ChannelMessage[];
  examples: { case: string; payload: string }[];
  /** Scenarios that publish to or consume from this channel, anywhere in the suite. */
  scenarios: ChannelScenario[];
}

export interface ChannelScenario {
  service: string;
  feature: string;
  title: string;
  message: string | null;
  direction: 'publishes' | 'consumes';
  negated: boolean;
}

export interface Release {
  version: string;
  date: string | null;
  unreleased: boolean;
  tag?: string;
  sha?: string;
  commits: string[];
}

export interface ArtifactRelease {
  version: string;
  date: string | null;
  service_version: string;
}

export interface Artifact {
  kind: 'openapi' | 'asyncapi' | 'data-contract' | 'feature' | 'doc';
  path: string;
  stem: string;
  version: string | null;
  gated: boolean;
  summary: string;
  history: ArtifactRelease[];
  odcs?: Record<string, any>;
  er_mermaid?: string;
  text?: string;
  feature?: Feature;
  label?: string;
}

export interface GherkinStep {
  keyword?: string;
  phase?: 'given' | 'when' | 'then';
  text?: string;
  table?: string[][];
  heading?: string;
  comment?: string;
  prose?: string;
}

/** What a scenario does to the contract, read from the names it uses:
 * the operations it calls, the events it consumes and publishes (a
 * negated one is asserted *not* to be published), and the statuses it
 * expects. Direction comes from the service's produces/consumes. */
export interface ScenarioRefs {
  operations: { op_id: string; via: 'name' | 'status' }[];
  inbound: { channel: string; message: string | null; producer: string | null }[];
  outbound: { channel: string; message: string | null; negated: boolean }[];
  statuses: string[];
}

export interface Scenario {
  title: string;
  steps: GherkinStep[];
  refs: ScenarioRefs;
  /** The scenario as a sequence diagram; null when it names no contract. */
  sequence_mermaid: string | null;
}

export interface Feature {
  title: string;
  description: string[];
  /** Who the feature speaks for (its `As a` line), else Client. */
  actor: string;
  background: GherkinStep[];
  scenarios: Scenario[];
  /** Triggers → scenarios → outcomes, as a flowchart; null without scenarios. */
  flow_mermaid: string | null;
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

/** Scenarios chained across services by the messages they publish and
 * consume: an end-to-end business flow the specs already state. */
export interface Journey {
  id: string;
  title: string;
  services: string[];
  steps: JourneyStep[];
  sequence_mermaid: string;
}

export interface Flows {
  journeys: Journey[];
  /** True when the suite has more journeys than the catalog draws. */
  truncated: boolean;
  /** Every scenario on a cross-service edge, as one graph; null without edges. */
  graph_mermaid: string | null;
}

export interface Service {
  name: string;
  title: string;
  version: string | null;
  domain: string;
  owner: string;
  summary: string;
  implementation_repo: string | null;
  artifacts: Artifact[];
  produces: string[];
  consumes: string[];
  operations: Operation[];
  data_products: { stem: string; title: string }[];
  channels: Channel[];
  changelog: Release[];
  latest_release: Release | null;
  ahead: boolean;
}

/** The suite's own annotation, from specs/system.yaml. Every field has
 * a neutral fallback, so a repo without that manifest still renders. */
export interface System {
  name: string | null;
  title: string;
  domain: string | null;
  org: string | null;
  summary: string;
  /** Hosted MCP endpoint these specs answer questions on, if any. */
  mcp: string | null;
  /** Distinct service domains, derived - what the catalog groups by. */
  domains: string[];
}

export const system = (data as { system?: System }).system ?? {
  name: null,
  title: 'System specs',
  domain: null,
  org: null,
  summary: '',
  mcp: null,
  domains: [],
};

export const services = data.services as Service[];
export const flows = ((data as { flows?: Flows }).flows ?? {
  journeys: [],
  truncated: false,
  graph_mermaid: null,
}) as Flows;
export const edges = data.edges as { from: string; channel: string; to: string }[];
export const unconsumed = data.unconsumed as { channel: string; producer: string }[];

/** Deterministic heading id for a channel address or stem (dots → dashes). */
export const anchor = (address: string) => address.replaceAll('.', '-');

/** Deterministic heading id from arbitrary text (titles, versions). */
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** address → producing service, across the whole spec suite. */
export const channelProducers: Record<string, Service> = Object.fromEntries(
  services.flatMap((s) => s.channels.map((c) => [c.address, s])),
);

export const serviceByName: Record<string, Service> = Object.fromEntries(
  services.map((s) => [s.name, s]),
);

/** Reading order for a service's artifacts: contract → events → data → criteria → context. */
export const KIND_ORDER: Artifact['kind'][] = [
  'openapi',
  'asyncapi',
  'data-contract',
  'feature',
  'doc',
];

export const KIND_LABELS: Record<Artifact['kind'], string> = {
  openapi: 'API Contract',
  asyncapi: 'Events',
  'data-contract': 'Data',
  feature: 'Acceptance criteria',
  doc: 'Context',
};

export const sortedArtifacts = (s: Service) =>
  [...s.artifacts].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );

/** Prefix a root-relative path with the configured base (GitHub Pages subpath). */
export const withBase = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;

/** URL of the raw artifact copied under public/ by `sysspec docs data`. */
export const artifactUrl = (service: string, artifact: Artifact | { path: string }) =>
  withBase(`/specs/${service}/${artifact.path}`);

/** Rendered page for an artifact (features share one page per service). */
export const artifactPage = (service: string, artifact: Artifact) =>
  artifact.kind === 'feature'
    ? withBase(`/services/${service}/features/`)
    : withBase(`/services/${service}/${artifact.stem}/`);

/** A scenario's heading on its service's acceptance-criteria page. */
export const scenarioHref = (service: string, title: string) =>
  withBase(`/services/${service}/features/#${slug(title)}`);

/** An operation's section on its service's rendered OpenAPI page, or
 * null when the service has no OpenAPI artifact to render it on. */
export const operationHref = (service: string, opId: string) => {
  const openapi = serviceByName[service]?.artifacts.find((a) => a.kind === 'openapi');
  return openapi ? `${artifactPage(service, openapi)}#${anchor(opId)}` : null;
};

/** A message's section under its channel on the producer's page. */
export const messageHref = (address: string, message: string) => {
  const producer = channelProducers[address];
  const channel = producer?.channels.find((c) => c.address === address);
  const stem = channel?.artifact_path.split('/').pop()?.replace(/\.[^.]+$/, '');
  if (!producer || !stem) return null;
  return withBase(`/services/${producer.name}/${stem}/#${anchor(`${address}-${message}`)}`);
};

/** Link target for a channel: its section on the producer's rendered
 * AsyncAPI page. */
export const channelHref = (address: string) => {
  const producer = channelProducers[address];
  if (!producer) return null;
  const channel = producer.channels.find((c) => c.address === address);
  const stem = channel?.artifact_path.split('/').pop()?.replace(/\.[^.]+$/, '');
  if (!stem) return withBase(`/services/${producer.name}/`);
  return withBase(`/services/${producer.name}/${stem}/#${anchor(address)}`);
};
