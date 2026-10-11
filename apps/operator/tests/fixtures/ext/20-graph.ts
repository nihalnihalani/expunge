/** FIXTURE reference graphs and record details. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  EffectKind,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  RecordDetail,
} from '../../../src/shared/expunge.js';
import { GRAPH_NODE_STATES } from '../../../src/shared/expunge.js';

type Bson = 'objectId' | 'string' | 'int' | 'long';
const node = (
  collection: string,
  recordId: string,
  hop: number,
  state: GraphNodeState,
  effect: EffectKind | null = null,
  extra: Partial<GraphNode> = {},
  bson: Bson = 'objectId',
): GraphNode => ({
  id: `n-${collection}-${recordId}`,
  collectionId: collection,
  recordId,
  recordIdBsonType: bson,
  hop,
  state,
  effect,
  label: `${collection} / ${recordId} (${bson})`,
  fieldIds: [`${collection}.id`],
  noExactIdentity: false,
  ...extra,
});
const edge = (from: GraphNode, to: GraphNode, fieldId: string): GraphEdge => ({
  id: `e-${from.id}-${to.id}`,
  from: from.id,
  to: to.id,
  edgeId: `edge-${fieldId}`,
  fieldId,
});

export function fullGraph(variant: 'complete' | 'incomplete' | 'live') {
  const subject = node(
    'customers',
    '7f3a',
    0,
    variant === 'live' ? 'inspected' : 'applied',
    variant === 'live' ? null : 'delete',
  );
  const acc1 = node(
    'accounts',
    'acc-01',
    1,
    variant === 'live' ? 'discovered' : 'applied',
    variant === 'live' ? null : 'redact',
  );
  const acc2 = node(
    'accounts',
    'acc-02',
    1,
    variant === 'live' ? 'discovered' : 'applied',
    variant === 'live' ? null : 'redact',
  );
  const acc3 = node('accounts', 'acc-03', 1, 'retained', null, {
    noExactIdentity: true,
  });
  const nodes = [subject, acc1, acc2, acc3];
  const edges = [
    edge(subject, acc1, 'accounts.ownerId'),
    edge(subject, acc2, 'accounts.ownerId'),
    edge(subject, acc3, 'accounts.ownerName'),
  ];
  if (variant !== 'live') {
    const orders = [
      node('orders', 'ord-101', 2, 'applied', 'tombstone'),
      node('orders', 'ord-102', 2, 'applied', 'tombstone'),
      node('orders', 'ord-103', 2, 'applied', 'restrict'),
      node('orders', 'ord-104', 2, 'applied', 'restrict'),
      node('orders', 'ord-105', 2, 'retained'),
    ];
    const tickets = [
      node('tickets', 'tkt-9', 2, 'applied', 'redact'),
      node('tickets', 'tkt-10', 2, 'retained'),
      ...(variant === 'incomplete'
        ? [node('tickets', 'tkt-11', 2, 'residual')]
        : []),
    ];
    const audit = [
      node('audit_events', 'ae-1', 3, 'applied', 'tombstone'),
      node('audit_events', 'ae-2', 3, 'retained'),
    ];
    nodes.push(...orders, ...tickets, ...audit);
    orders.forEach((order, index) =>
      edges.push(edge(index % 2 ? acc2 : acc1, order, 'orders.accountId')),
    );
    edges.push(edge(orders[4], acc1, 'orders.refundAccountId')); // a cycle back to an earlier record
    tickets.forEach((ticket, index) =>
      edges.push(edge(orders[index], ticket, 'tickets.orderId')),
    );
    audit.forEach((entry, index) =>
      edges.push(edge(tickets[index], entry, 'audit_events.ticketId')),
    );
    if (variant === 'incomplete') {
      const archive = node(
        'payments_archive',
        'pa-1',
        3,
        'not_inspected',
        null,
        {},
        'string',
      );
      nodes.push(archive);
      edges.push(edge(orders[2], archive, 'payments_archive.orderRef'));
    }
  } else {
    const o = node('orders', 'ord-101', 2, 'discovered');
    nodes.push(o);
    edges.push(edge(acc1, o, 'orders.accountId'));
  }
  return { nodes, edges };
}

function summarize(nodes: GraphNode[]) {
  const byState = Object.fromEntries(
    GRAPH_NODE_STATES.map((state) => [state, 0]),
  ) as Record<GraphNodeState, number>;
  for (const item of nodes) byState[item.state] += 1;
  return byState;
}

function register(
  state: FixtureState,
  jobId: string,
  variant: 'complete' | 'incomplete' | 'live',
) {
  const job = state.jobs.get(jobId);
  if (!job) return;
  const { nodes, edges } = fullGraph(variant);
  const artifactId = `graph-${jobId}`;
  const envelope = (payload: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  }): ArtifactEnvelope => ({
    artifactId,
    kind: 'graph_page',
    jobId,
    committedAtSequence: job.snapshot.sequence,
    contentHash: null,
    payload: { ...payload, nextCursor: null },
  });
  state.artifacts.set(artifactId, envelope({ nodes, edges }));
  job.snapshot = {
    ...job.snapshot,
    graph: {
      artifactId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncated: false,
      byState: summarize(nodes),
    },
  };
  if (variant === 'live') {
    const previous = state.advance.get(jobId);
    let step = 0;
    state.advance.set(jobId, (current) => {
      previous?.(current);
      step += 1;
      if (step === 1) {
        const more = [
          node('orders', 'ord-102', 2, 'discovered'),
          node('tickets', 'tkt-9', 2, 'discovered'),
        ];
        const all = [...nodes, ...more];
        const moreEdges = [
          ...edges,
          edge(nodes[2], more[0], 'orders.accountId'),
          edge(more[0], more[1], 'tickets.orderId'),
        ];
        current.artifacts.set(
          artifactId,
          envelope({ nodes: all, edges: moreEdges }),
        );
        const live = current.jobs.get(jobId)!;
        live.snapshot = {
          ...live.snapshot,
          graph: {
            artifactId,
            nodeCount: all.length,
            edgeCount: moreEdges.length,
            truncated: false,
            byState: summarize(all),
          },
        };
      }
    });
  }
  // Before and after detail for the records an effect touched.
  const detail = (item: GraphNode, fields: RecordDetail['fields']) =>
    state.artifacts.set(`record-detail-${item.id}`, {
      artifactId: `record-detail-${item.id}`,
      kind: 'record_detail',
      jobId,
      committedAtSequence: job.snapshot.sequence,
      contentHash: null,
      payload: {
        nodeId: item.id,
        address: {
          collectionId: item.collectionId,
          recordId: item.recordId,
          recordIdBsonType: item.recordIdBsonType,
        },
        preHash: hex(`pre-${item.id}`),
        postHash: item.effect === 'delete' ? null : hex(`post-${item.id}`),
        effect: item.effect,
        fields,
      } satisfies RecordDetail,
    });
  if (variant !== 'live') {
    const acc1 = nodes.find((n) => n.recordId === 'acc-01')!;
    detail(acc1, [
      {
        path: 'contacts[*]',
        kind: 'array',
        changed: true,
        elements: [
          {
            index: 0,
            outcome: 'preserved',
            display: 'billing contact (retained: different person)',
          },
          { index: 1, outcome: 'removed', display: null },
          {
            index: 2,
            outcome: 'preserved',
            display: 'support alias (retained)',
          },
          {
            index: 3,
            outcome: 'preserved',
            display: 'security contact (retained)',
          },
        ],
      },
      { path: 'ownerEmail', kind: 'scalar', changed: true, display: null },
      { path: 'plan', kind: 'scalar', changed: false, display: 'enterprise' },
      { path: 'record', kind: 'unchanged_group', changed: false, count: 9 },
    ]);
    const subject = nodes[0];
    detail(subject, [
      { path: 'record', kind: 'unchanged_group', changed: false, count: 0 },
    ]);
    const tombstoned = nodes.find((n) => n.recordId === 'ord-101')!;
    detail(tombstoned, [
      {
        path: 'lines[*]',
        kind: 'array',
        changed: true,
        elements: [
          { index: 0, outcome: 'tombstoned', display: null },
          { index: 1, outcome: 'preserved', display: 'shared invoice line' },
        ],
      },
      { path: 'record', kind: 'unchanged_group', changed: false, count: 4 },
    ]);
  }
}

export default function registerGraphs(state: FixtureState) {
  register(state, 'job-complete', 'complete');
  register(state, 'job-incomplete', 'incomplete');
  register(state, 'job-live', 'live');
}
