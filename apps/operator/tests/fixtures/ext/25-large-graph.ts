/**
 * FIXTURE: POST /__fixture/advance/job-complete swaps that job's graph for a large one (more
 * than the drawing's 300-node limit), so the grouped drawing and the complete table can be
 * checked. Synthetic test data only; a fixture restart restores the small graph.
 */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { GRAPH_NODE_STATES } from '../../../src/shared/expunge.js';
import type {
  GraphEdge,
  GraphNode,
  GraphNodeState,
} from '../../../src/shared/expunge.js';

export const LARGE_ORDERS = 420;

export function largeGraph() {
  const subject: GraphNode = {
    id: 'n-customers-7f3a',
    collectionId: 'customers',
    recordId: '7f3a',
    recordIdBsonType: 'objectId',
    hop: 0,
    state: 'applied',
    effect: 'delete',
    label: 'customers / 7f3a (objectId)',
    fieldIds: ['customers.id'],
    noExactIdentity: false,
  };
  const nodes: GraphNode[] = [subject];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < LARGE_ORDERS; i += 1) {
    const state: GraphNodeState =
      i % 9 === 0 ? 'retained' : i % 13 === 0 ? 'residual' : 'applied';
    const record = `ord-${String(i).padStart(4, '0')}`;
    const node: GraphNode = {
      id: `n-orders-${record}`,
      collectionId: 'orders',
      recordId: record,
      recordIdBsonType: 'string',
      hop: 1,
      state,
      effect: state === 'applied' ? (i % 2 ? 'tombstone' : 'redact') : null,
      label: `orders / ${record} (string)`,
      fieldIds: ['orders.customerId'],
      noExactIdentity: false,
    };
    nodes.push(node);
    edges.push({
      id: `e-${subject.id}-${node.id}`,
      from: subject.id,
      to: node.id,
      edgeId: 'edge-orders.customerId',
      fieldId: 'orders.customerId',
    });
  }
  return { nodes, edges };
}

export default function registerLargeGraph(state: FixtureState) {
  state.advance.set('job-complete', (current) => {
    const job = current.jobs.get('job-complete');
    if (!job) return;
    const { nodes, edges } = largeGraph();
    const artifactId = 'graph-job-complete';
    current.artifacts.set(artifactId, {
      artifactId,
      kind: 'graph_page',
      jobId: 'job-complete',
      committedAtSequence: job.snapshot.sequence,
      contentHash: null,
      payload: { nodes, edges, nextCursor: null },
    });
    const byState = Object.fromEntries(
      GRAPH_NODE_STATES.map((name) => [name, 0]),
    ) as Record<GraphNodeState, number>;
    for (const node of nodes) byState[node.state] += 1;
    job.snapshot = {
      ...job.snapshot,
      graph: {
        artifactId,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        truncated: false,
        byState,
      },
    };
  });
}
