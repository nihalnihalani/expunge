import type {
  GraphEdge,
  GraphNode,
  GraphNodeState,
  EffectKind,
} from '../../../shared/expunge';

export interface ReachedVia {
  from: string;
  fieldId: string;
  edgeId: string;
}

export interface GraphIndex {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** First incoming reference per node: how the node was reached from the subject. */
  reachedVia: Map<string, ReachedVia>;
  collections: string[];
}

/** Lowest rank sorts first: problems and applied effects before untouched records. */
const STATE_RANK: Record<GraphNodeState, number> = {
  residual: 0,
  applied: 1,
  previewed: 2,
  inspected: 3,
  discovered: 4,
  retained: 5,
  excluded: 6,
  not_inspected: 7,
};
export const STATE_WORDS: Record<GraphNodeState, string> = {
  residual: 'Residual',
  applied: 'Effect applied',
  previewed: 'Previewed',
  inspected: 'Inspected',
  discovered: 'Discovered',
  retained: 'Retained',
  excluded: 'Excluded',
  not_inspected: 'Not inspected',
};
export const EFFECT_WORDS: Record<EffectKind, string> = {
  delete: 'Delete',
  redact: 'Redact',
  restrict: 'Restrict',
  tombstone: 'Tombstone',
};

export function buildIndex(nodes: GraphNode[], edges: GraphEdge[]): GraphIndex {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reachedVia = new Map<string, ReachedVia>();
  for (const edge of edges)
    if (!reachedVia.has(edge.to) && byId.has(edge.from))
      reachedVia.set(edge.to, {
        from: edge.from,
        fieldId: edge.fieldId,
        edgeId: edge.edgeId,
      });
  return {
    nodes,
    byId,
    edges,
    reachedVia,
    collections: [...new Set(nodes.map((node) => node.collectionId))].sort(),
  };
}

export type SortKey = 'hop' | 'collection' | 'record' | 'effect' | 'state';
export interface TableQuery {
  sort: SortKey;
  dir: 'asc' | 'desc';
  /** null means every state. */
  states: ReadonlySet<GraphNodeState> | null;
  collection: string | null;
  text: string;
  page: number;
  pageSize: number;
}

export const DEFAULT_QUERY: TableQuery = {
  sort: 'hop',
  dir: 'asc',
  states: null,
  collection: null,
  text: '',
  page: 1,
  pageSize: 50,
};

const compareText = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true });

export function queryNodes(index: GraphIndex, query: TableQuery) {
  const needle = query.text.trim().toLowerCase();
  const filtered = index.nodes.filter(
    (node) =>
      (query.states === null || query.states.has(node.state)) &&
      (query.collection === null || node.collectionId === query.collection) &&
      (needle === '' ||
        node.label.toLowerCase().includes(needle) ||
        node.recordId.toLowerCase().includes(needle)),
  );
  const direction = query.dir === 'asc' ? 1 : -1;
  const key = (node: GraphNode): number | string => {
    switch (query.sort) {
      case 'hop':
        return node.hop;
      case 'collection':
        return node.collectionId;
      case 'record':
        return node.recordId;
      case 'effect':
        return node.effect ?? '￿';
      case 'state':
        return STATE_RANK[node.state];
    }
  };
  const sorted = [...filtered].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    const primary =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : compareText(String(left), String(right));
    return direction * primary || compareText(a.id, b.id);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / query.pageSize));
  const page = Math.min(Math.max(1, query.page), pages);
  const start = (page - 1) * query.pageSize;
  return {
    rows: sorted.slice(start, start + query.pageSize),
    total: sorted.length,
    pages,
    page,
    start,
  };
}

/** Convention for where a node's before/after detail lives (proposed for CONTRACTS.md). */
export function recordDetailArtifactId(nodeId: string) {
  return `record-detail-${nodeId}`;
}
