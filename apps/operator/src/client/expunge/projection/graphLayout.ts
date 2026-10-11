import type { GraphEdge, GraphNode } from '../../../shared/expunge';
import type { GraphIndex } from './graphModel';

/** Beyond this many nodes the drawing aggregates by collection and state; the table stays complete. */
export const MAX_DRAWN_NODES = 300;

export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  lane: number;
  row: number;
  /** For aggregated groups: how many records the mark stands for. */
  count: number;
}

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  fieldId: string;
  /** SVG path data. */
  d: string;
  /** Both ends carry a committed effect. */
  committed: boolean;
  /** The reference points back to an earlier or same lane (a cycle). */
  back: boolean;
}

export interface Layout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  byId: Map<string, PlacedNode>;
  lanes: number;
  aggregated: boolean;
  /** Keyboard navigation graph over drawn nodes. */
  children: Map<string, string[]>;
  parent: Map<string, string>;
  laneOrder: Map<number, string[]>;
  /** One heading per lane: the hop distance it stands for and where it starts. */
  laneLabels: Array<{ hop: number; x: number }>;
  /** Pixels available for a record's label beside its mark. */
  textWidth: number;
}

export interface LayoutOptions {
  laneWidth: number;
  rowHeight: number;
  pad: number;
  nodeSize: number;
  /** Room above the first row for lane headings and the lines that loop back. */
  header: number;
  /** Clear space at the end of each lane where connectors run, so a line never crosses a label. */
  gutter: number;
}
export const DEFAULT_LAYOUT: LayoutOptions = {
  laneWidth: 200,
  rowHeight: 34,
  pad: 24,
  nodeSize: 14,
  header: 22,
  gutter: 34,
};

const compare = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true });

/** Collapse a large graph to one mark per collection, hop and state, with summed counts. */
export function aggregate(index: GraphIndex): {
  nodes: Array<GraphNode & { count: number }>;
  edges: GraphEdge[];
  groupOf: Map<string, string>;
} {
  const groups = new Map<string, GraphNode & { count: number }>();
  const groupOf = new Map<string, string>();
  for (const node of index.nodes) {
    const id = `group:${node.collectionId}:${node.hop}:${node.state}`;
    groupOf.set(node.id, id);
    const existing = groups.get(id);
    if (existing) existing.count += 1;
    else
      groups.set(id, {
        ...node,
        id,
        recordId: node.collectionId,
        label: node.collectionId,
        effect: node.effect,
        count: 1,
        fieldIds: [],
        noExactIdentity: false,
      });
  }
  const edges = new Map<string, GraphEdge>();
  for (const edge of index.edges) {
    const from = groupOf.get(edge.from);
    const to = groupOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const id = `${from}->${to}:${edge.fieldId}`;
    if (!edges.has(id)) edges.set(id, { ...edge, id, from, to });
  }
  for (const group of groups.values())
    group.label = `${group.collectionId}: ${group.count} ${group.state.replaceAll('_', ' ')}`;
  return { nodes: [...groups.values()], edges: [...edges.values()], groupOf };
}

/**
 * Deterministic layered layout: lanes by hop distance from the subject, rows ordered by
 * collection then record. No force simulation, so it is stable between reads and cheap.
 */
export function layoutGraph(
  index: GraphIndex,
  options: LayoutOptions = DEFAULT_LAYOUT,
): Layout {
  const large = index.nodes.length > MAX_DRAWN_NODES;
  const source = large
    ? aggregate(index)
    : {
        nodes: index.nodes.map((node) => ({ ...node, count: 1 })),
        edges: index.edges,
        groupOf: null,
      };
  const lanesMap = new Map<number, Array<GraphNode & { count: number }>>();
  for (const node of source.nodes) {
    const lane = lanesMap.get(node.hop) ?? [];
    lane.push(node);
    lanesMap.set(node.hop, lane);
  }
  const laneKeys = [...lanesMap.keys()].sort((a, b) => a - b);
  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  const laneOrder = new Map<number, string[]>();
  let rows = 0;
  laneKeys.forEach((hop, laneIndex) => {
    const nodes = lanesMap
      .get(hop)!
      .sort(
        (a, b) =>
          compare(a.collectionId, b.collectionId) ||
          compare(a.recordId, b.recordId) ||
          compare(a.id, b.id),
      );
    laneOrder.set(
      laneIndex,
      nodes.map((n) => n.id),
    );
    nodes.forEach((node, row) => {
      const p: PlacedNode = {
        node,
        count: node.count,
        lane: laneIndex,
        row,
        x: options.pad + laneIndex * options.laneWidth,
        y: options.pad + options.header + row * options.rowHeight,
      };
      placed.push(p);
      byId.set(node.id, p);
    });
    rows = Math.max(rows, nodes.length);
  });
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const edges: PlacedEdge[] = [];
  let backCount = 0;
  const half = options.nodeSize / 2;
  for (const edge of source.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    const back = b.lane <= a.lane;
    const x1 = a.x + options.laneWidth - options.gutter;
    const y1 = a.y + half;
    const x2 = b.x;
    const y2 = b.y + half;
    let d: string;
    if (back) {
      // Leave by the left edge, run in the gutters and across the top, so a cycle is visible,
      // cannot be mistaken for a forward step, and never crosses another record's mark.
      const top = options.pad + options.header - 8 - (backCount % 3) * 4;
      backCount += 1;
      const ax = a.x - 8;
      const bx = b.x - 8;
      d = `M ${a.x} ${y1} H ${ax} V ${top} H ${bx} V ${y2} H ${b.x}`;
    } else {
      const mid = x1 + (x2 - x1) / 2;
      d = `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
    }
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      fieldId: edge.fieldId,
      d,
      committed: a.node.state === 'applied' && b.node.state === 'applied',
      back,
    });
    if (!back) {
      const list = children.get(edge.from) ?? [];
      if (!list.includes(edge.to)) list.push(edge.to);
      children.set(edge.from, list);
      if (!parent.has(edge.to)) parent.set(edge.to, edge.from);
    }
  }
  for (const [id, list] of children)
    children.set(
      id,
      list.sort((x, y) => byId.get(x)!.row - byId.get(y)!.row),
    );
  return {
    laneLabels: laneKeys.map((hop, laneIndex) => ({
      hop,
      x: options.pad + laneIndex * options.laneWidth,
    })),
    textWidth: options.laneWidth - options.nodeSize - 6 - options.gutter,
    width: options.pad * 2 + Math.max(1, laneKeys.length) * options.laneWidth,
    height:
      options.pad * 2 + options.header + Math.max(1, rows) * options.rowHeight,
    nodes: placed,
    edges,
    byId,
    lanes: laneKeys.length,
    aggregated: large,
    children,
    parent,
    laneOrder,
  };
}

/** Every node on the path through `id`: its ancestors back to the subject and its descendants. */
export function pathThrough(layout: Layout, id: string): Set<string> {
  const keep = new Set<string>([id]);
  for (
    let at = layout.parent.get(id);
    at && !keep.has(at);
    at = layout.parent.get(at)
  )
    keep.add(at);
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const child of layout.children.get(current) ?? [])
      if (!keep.has(child)) {
        keep.add(child);
        stack.push(child);
      }
  }
  return keep;
}

export type Direction = 'right' | 'left' | 'up' | 'down' | 'home' | 'end';

/**
 * Keyboard movement over the drawing: Right goes forward along a reference, Left goes back to
 * the node that reached this one, Up and Down move between siblings in the same lane, Home goes
 * to the subject and End to the last record with an applied effect.
 */
export function nextNode(
  layout: Layout,
  from: string,
  direction: Direction,
): string {
  const here = layout.byId.get(from);
  if (!here) return from;
  switch (direction) {
    case 'right':
      return layout.children.get(from)?.[0] ?? from;
    case 'left':
      return layout.parent.get(from) ?? from;
    case 'up':
    case 'down': {
      const order = layout.laneOrder.get(here.lane) ?? [];
      const at = order.indexOf(from);
      const next = order[direction === 'up' ? at - 1 : at + 1];
      return next ?? from;
    }
    case 'home': {
      const first = layout.laneOrder.get(0)?.[0];
      return first ?? from;
    }
    case 'end': {
      const applied = layout.nodes
        .filter((p) => p.node.state === 'applied')
        .sort((a, b) => b.lane - a.lane || b.row - a.row);
      return applied[0]?.node.id ?? from;
    }
  }
}
