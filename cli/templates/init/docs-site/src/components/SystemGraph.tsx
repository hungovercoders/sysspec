import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';

interface GraphService {
  name: string;
  title: string;
  domain: string;
  version: string | null;
  operations: { op_id: string }[];
  data_products: { stem: string; title: string }[];
}

interface Props {
  services: GraphService[];
  edges: { from: string; channel: string; to: string }[];
  unconsumed: { channel: string; producer: string }[];
  base: string;
  focus?: string;
  height?: number;
}

const NODE = { width: 176, height: 56 };

// Theme tokens, not literals: the graph has to read in both themes, and
// the same six carry the artifact kinds elsewhere on the site.
const DOMAIN_COLORS = [
  'var(--ss-accent, #2456e6)',
  'var(--ss-kind-data, #0f766e)',
  'var(--ss-kind-asyncapi, #b45309)',
  'var(--ss-kind-feature, #6d28d9)',
  'var(--ss-kind-openapi, #2456e6)',
  'var(--ss-kind-doc, #6b768c)',
];

/** A node wide enough for its own label, within sane bounds. */
const widthFor = (label: string) =>
  Math.max(NODE.width, Math.min(260, Math.round(label.length * 7.6) + 40));

const nodeStyle = (kind: string, accent: string, focused = false): React.CSSProperties => {
  const common: React.CSSProperties = {
    fontSize: 13,
    fontFamily: 'var(--ss-font-sans, inherit)',
    borderRadius: 8,
    boxShadow: 'var(--ss-shadow-sm)',
    padding: '8px 10px',
    border: '1px solid var(--ss-hairline-strong, #888)',
    background: 'var(--ss-surface, #fff)',
    color: 'var(--ss-text, #222)',
    textAlign: 'left',
  };
  if (kind === 'service')
    return {
      ...common,
      borderColor: accent,
      borderWidth: focused ? 2 : 1,
      // The domain's colour as a spine, so services group by eye even
      // when the layout cannot put them side by side.
      borderLeft: `5px solid ${accent}`,
    };
  if (kind === 'data')
    return {
      ...common,
      borderRadius: 18,
      borderColor: 'var(--ss-kind-data, #0f766e)',
      borderStyle: 'dashed',
    };
  if (kind === 'channel')
    return {
      ...common,
      borderRadius: 999,
      borderColor: accent,
      background: 'var(--ss-surface-2, #f1f3f7)',
      fontFamily: 'var(--ss-font-mono, monospace)',
      fontSize: 11.5,
      padding: '7px 12px',
      textAlign: 'center',
    };
  if (kind === 'clients')
    return { ...common, borderRadius: 24, textAlign: 'center', background: 'var(--ss-surface-2, #f1f3f7)' };
  return { ...common, borderStyle: 'dashed', opacity: 0.75, textAlign: 'center' };
};

// Edge labels are addresses and operation ids - monospace, on a chip, so
// they stay readable where they cross a node or another label.
const LABEL_STYLE = {
  fill: 'var(--ss-text-2, #46516a)',
  fontSize: 11,
  fontFamily: 'var(--ss-font-mono, monospace)',
};
const LABEL_BG_STYLE = { fill: 'var(--ss-surface, #fff)', fillOpacity: 0.92 };

const labelled = (label: string) => ({
  label,
  labelStyle: LABEL_STYLE,
  labelBgStyle: LABEL_BG_STYLE,
  labelBgPadding: [5, 3] as [number, number],
  labelBgBorderRadius: 4,
});

const arrow = (color: string) => ({
  type: MarkerType.ArrowClosed,
  width: 16,
  height: 16,
  color,
});

function buildGraph(props: Props): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const animate =
    typeof window === 'undefined' ||
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Domains keep a stable colour across every graph on the site: sorted,
  // then cycled - not hashed, so neighbours never collide by accident.
  const domains = [...new Set(props.services.map((s) => s.domain).filter(Boolean))].sort();
  const colorOf = (domain: string) =>
    DOMAIN_COLORS[Math.max(0, domains.indexOf(domain)) % DOMAIN_COLORS.length];

  // With a focus, only that service's edges appear; neighbours stay as
  // plain nodes and the surface (ops, data products) is the focus's own.
  const inFocus = (name: string) =>
    !props.focus ||
    name === props.focus ||
    props.edges.some(
      (e) =>
        (e.from === name && e.to === props.focus) ||
        (e.to === name && e.from === props.focus),
    );
  const services = props.services.filter((s) => inFocus(s.name));
  const channelEdges = props.edges.filter(
    (e) => !props.focus || e.from === props.focus || e.to === props.focus,
  );
  const unconsumed = props.unconsumed.filter(
    (u) => !props.focus || u.producer === props.focus,
  );
  const owns = (name: string) => !props.focus || name === props.focus;

  const anyOps = services.some((s) => owns(s.name) && s.operations.length > 0);
  if (anyOps) {
    nodes.push({
      id: 'clients',
      data: { label: 'Clients' },
      position: { x: 0, y: 0 },
      style: { ...nodeStyle('clients', ''), width: NODE.width },
      width: NODE.width,
    });
  }
  for (const s of services) {
    const accent = colorOf(s.domain);
    const width = widthFor(s.title);
    nodes.push({
      id: s.name,
      data: {
        label: (
          <div>
            <strong>{s.title}</strong>
            <div style={{ fontSize: 11, opacity: 0.75 }}>
              {s.domain} · v{s.version ?? '—'}
            </div>
          </div>
        ),
      },
      position: { x: 0, y: 0 },
      style: { ...nodeStyle('service', accent, s.name === props.focus), width },
      width,
    });
    if (!owns(s.name)) continue;
    // One synchronous edge per service, not one per operation: a dozen
    // parallel arrows from Clients said nothing a count does not.
    if (s.operations.length) {
      edges.push({
        id: `op-${s.name}`,
        source: 'clients',
        target: s.name,
        type: 'smoothstep',
        style: { strokeDasharray: '2 3', stroke: 'var(--ss-text-3, #5c677b)' },
        markerEnd: arrow('var(--ss-text-3, #5c677b)'),
        ...labelled(
          s.operations.length === 1
            ? s.operations[0].op_id
            : `${s.operations.length} operations`,
        ),
      });
    }
    for (const d of s.data_products) {
      const id = `dp-${s.name}-${d.stem}`;
      const width = widthFor(d.title);
      nodes.push({
        id,
        data: { label: d.title },
        position: { x: 0, y: 0 },
        style: { ...nodeStyle('data', accent), width },
        width,
      });
      edges.push({
        id: `e-${id}`,
        source: s.name,
        target: id,
        type: 'smoothstep',
        style: { stroke: 'var(--ss-kind-data, #0f766e)' },
        markerEnd: arrow('var(--ss-kind-data, #0f766e)'),
      });
    }
  }
  // Channels are nodes, not edge labels. They are things the specs name
  // and version, a fan-out can have several consumers, and two services
  // that both produce to each other would otherwise stack two labels on
  // one line. One pill per address, wired producer -> channel ->
  // consumer.
  const channelNode = (address: string, producer: string) => {
    const id = `chan-${address}`;
    if (nodes.some((n) => n.id === id)) return id;
    const color = colorOf(props.services.find((s) => s.name === producer)?.domain ?? '');
    const width = widthFor(address);
    nodes.push({
      id,
      data: { label: address },
      position: { x: 0, y: 0 },
      style: { ...nodeStyle('channel', color), width },
      width,
    });
    edges.push({
      id: `pub-${address}`,
      source: producer,
      target: id,
      type: 'smoothstep',
      animated: animate,
      style: { stroke: color, strokeWidth: 1.5 },
      markerEnd: arrow(color),
    });
    return id;
  };

  for (const e of channelEdges) {
    const color = colorOf(props.services.find((s) => s.name === e.from)?.domain ?? '');
    const chan = channelNode(e.channel, e.from);
    edges.push({
      id: `sub-${e.channel}-${e.to}`,
      source: chan,
      target: e.to,
      type: 'smoothstep',
      animated: animate,
      style: { stroke: color, strokeWidth: 1.5 },
      markerEnd: arrow(color),
    });
  }
  for (const u of unconsumed) {
    const chan = channelNode(u.channel, u.producer);
    const id = `sink-${u.channel}`;
    nodes.push({
      id,
      data: { label: 'no consumer yet' },
      position: { x: 0, y: 0 },
      style: { ...nodeStyle('sink', ''), width: NODE.width },
      width: NODE.width,
    });
    edges.push({
      id: `sub-${u.channel}`,
      source: chan,
      target: id,
      type: 'smoothstep',
      style: { strokeDasharray: '5 4', stroke: 'var(--ss-text-3, #5c677b)' },
      markerEnd: arrow('var(--ss-text-3, #5c677b)'),
    });
  }

  // multigraph: two services can share more than one channel, and each
  // of those edges needs its own lane rather than being merged away.
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 76, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  const sizes = new Map<string, number>();
  for (const n of nodes) {
    const width = (n.width as number) ?? NODE.width;
    sizes.set(n.id, width);
    g.setNode(n.id, { width, height: NODE.height });
  }
  for (const e of edges) {
    // Reserve room for the label so dagre routes around it instead of
    // under it.
    const label = typeof e.label === 'string' ? e.label : '';
    g.setEdge(e.source, e.target, { width: label.length * 6, height: 16, labelpos: 'c' }, e.id);
  }
  dagre.layout(g);
  for (const n of nodes) {
    const pos = g.node(n.id);
    n.position = { x: pos.x - (sizes.get(n.id) ?? NODE.width) / 2, y: pos.y - NODE.height / 2 };
  }
  return { nodes, edges };
}

export default function SystemGraph(props: Props) {
  const { nodes, edges } = useMemo(() => buildGraph(props), [props]);
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const connected = useMemo(() => {
    if (!selected) return null;
    const ids = new Set([selected]);
    for (const e of edges) {
      if (e.source === selected || e.target === selected) {
        ids.add(e.source);
        ids.add(e.target);
      }
    }
    return ids;
  }, [selected, edges]);

  const shownNodes = nodes.map((n) => {
    const dimmed = connected && !connected.has(n.id);
    const isSelected = n.id === selected;
    return {
      ...n,
      style: {
        ...n.style,
        opacity: dimmed ? 0.2 : (n.style?.opacity as number) ?? 1,
        // The selection reads as a ring rather than a thicker border, so
        // nothing shifts by a pixel when it is picked.
        boxShadow: isSelected
          ? '0 0 0 3px var(--ss-accent-soft, #e8eefc)'
          : (n.style?.boxShadow as string),
      },
    };
  });
  const shownEdges = edges.map((e) => {
    const active = !connected || e.source === selected || e.target === selected;
    return {
      ...e,
      animated: e.animated && active,
      style: { ...e.style, opacity: active ? 1 : 0.12 },
      labelStyle: { ...LABEL_STYLE, opacity: active ? 1 : 0.25 },
      labelBgStyle: { ...LABEL_BG_STYLE, fillOpacity: active ? 0.92 : 0.2 },
    };
  });

  const isService = useCallback(
    (id: string) => props.services.some((s) => s.name === id),
    [props.services],
  );

  return (
    <div
      style={{
        height: `min(${props.height ?? 560}px, 70vh)`,
        border: 'none',
        borderRadius: 0,
      }}
      role="group"
      aria-label="System graph: services, the channels between them, and their data products"
    >
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        colorMode={theme}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.2}
        nodesConnectable={false}
        nodesDraggable
        onNodeClick={(_evt, node) => setSelected(selected === node.id ? null : node.id)}
        onNodeDoubleClick={(_evt, node) => {
          if (isService(node.id) && node.id !== props.focus)
            window.location.assign(`${props.base}/services/${node.id}/`);
        }}
        onPaneClick={() => setSelected(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
