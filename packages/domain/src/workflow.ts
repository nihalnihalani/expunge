import type { WorkflowGraph } from '@expunge/contracts';

/** Gateway rule ids a workflow violation adds to a DENY verdict. */
export const WORKFLOW_TRANSITION_DENIED = 'gateway:workflow_transition_denied';
export const WORKFLOW_VISITS_EXCEEDED = 'gateway:workflow_visits_exceeded';

/**
 * Tools outside the workflow graph: they observe the run and change nothing, so they are admitted from any position,
 * never move it and never use a node's visits. Resource budgets still apply to them.
 */
export const WORKFLOW_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['inspect_harness', 'report_diagnostic']);

/**
 * Outcomes of a call that ran and moved the run along the graph. A call that was denied, stopped for approval or
 * failed without a retryable cause did not take an edge: the run stays where it was and the node keeps its visits.
 */
export const ADVANCING_OUTCOMES: ReadonlySet<string> = new Set([
  'success',
  'more_references',
  'batches_remaining',
  'retryable_error',
  'verification_failed',
]);

/** Outcomes that reached the caller as an answer. An error outcome (a retryable error) may hide a committed effect. */
export const ACKNOWLEDGED_OUTCOMES: ReadonlySet<string> = new Set([
  'success',
  'more_references',
  'batches_remaining',
  'verification_failed',
]);

/** Where a job stands in its graph: the node of the last call that moved it, how that call ended, and every node's visits. */
export type WorkflowPosition = {
  nodeId: string | null;
  outcome: string | null;
  visits: Readonly<Record<string, number>>;
};
export const WORKFLOW_START: WorkflowPosition = { nodeId: null, outcome: null, visits: {} };

export type TransitionVerdict = { nodeId: string | null; violation: string | null };

/**
 * Which node a call to `toolId` would visit from `position`, or the violation. From the start the call must be the
 * entry node's tool. After that the call must follow an edge out of the current node whose condition is how the last
 * call ended, to a node of that tool that still has visits left. Nothing the model sends takes part.
 */
export function admitTransition(
  graph: WorkflowGraph,
  position: WorkflowPosition,
  toolId: string,
): TransitionVerdict {
  if (WORKFLOW_EXEMPT_TOOLS.has(toolId)) return { nodeId: null, violation: null };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const reachable =
    position.nodeId === null
      ? [byId.get(graph.entryNodeId)]
      : graph.edges
          .filter((edge) => edge.from === position.nodeId && edge.when === position.outcome)
          .map((edge) => byId.get(edge.to));
  const candidates = [...new Set(reachable)].filter(
    (node): node is NonNullable<typeof node> => node !== undefined && node.toolId === toolId,
  );
  const first = candidates[0];
  if (!first) return { nodeId: null, violation: WORKFLOW_TRANSITION_DENIED };
  const open = candidates.find((node) => (position.visits[node.id] ?? 0) < node.maxVisits);
  return open
    ? { nodeId: open.id, violation: null }
    : { nodeId: first.id, violation: WORKFLOW_VISITS_EXCEEDED };
}

/** The position after a call visited `nodeId` and ended with `outcome`. */
export function advance(position: WorkflowPosition, nodeId: string, outcome: string): WorkflowPosition {
  return {
    nodeId,
    outcome,
    visits: { ...position.visits, [nodeId]: (position.visits[nodeId] ?? 0) + 1 },
  };
}
