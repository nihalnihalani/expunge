import type { ResourceLimits, ToolPolicy, WorkflowGraph } from '@expunge/contracts';
import { FORBIDDEN_ROUTE_TOKENS } from '@expunge/baselines';
import { issue, type Issue } from './issues.js';
import { IDENTIFIER_FORMAT, LOOP_NODE_MAX_VISITS, TOOL_ID_SET } from './vocabulary.js';

type Edge = WorkflowGraph['edges'][number];
const INPUT_BINDING = /^([a-z][a-z0-9_]{0,63})\.output$/;

export interface WorkflowPlan {
  entry: string;
  nodes: Array<{ id: string; toolId: string; maxVisits: number; inputs: Record<string, string> }>;
  /** Deterministic transition table: node -> condition -> next node. */
  transitions: Record<string, Partial<Record<Edge['when'], string>>>;
  terminals: string[];
  /** Nodes that sit on a cycle (every one has a bounded visit count). */
  loopNodes: string[];
  /** Upper bound on tool calls this graph can make: the sum of its visit bounds. */
  worstCaseToolCalls: number;
}

/** Strongly connected components with Tarjan's algorithm; returns the nodes that lie on a cycle. */
function cyclicNodes(ids: readonly string[], edges: readonly Edge[]): Set<string> {
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) next.get(edge.from)?.push(edge.to);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    onStack.add(node);
    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      const selfLoop = component.length === 1 && (next.get(node) ?? []).includes(node);
      if (component.length > 1 || selfLoop) component.forEach((id) => cyclic.add(id));
    }
  };
  ids.forEach((id) => {
    if (!index.has(id)) visit(id);
  });
  return cyclic;
}

function reachable(start: string, edges: readonly Edge[]): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of edges) {
      if (edge.from === node && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
}

/** Static analysis of one workflow graph. Collects every issue; `plan` is set only when there are none. */
export function analyzeWorkflow(
  workflow: WorkflowGraph,
  toolPolicy: Pick<ToolPolicy, 'grants'>,
  limits: Pick<ResourceLimits, 'toolCalls' | 'graphNodes' | 'graphEdges'>,
): { issues: Issue[]; plan: WorkflowPlan | null } {
  const issues: Issue[] = [];
  const ids = workflow.nodes.map((node) => node.id);
  const grants = new Set(toolPolicy.grants);

  workflow.nodes.forEach((node, index) => {
    const where = `workflow.nodes[${index}]`;
    if (!IDENTIFIER_FORMAT.test(node.id))
      issues.push(issue('identifier_format', `${where}.id`, 'node id is not a lowercase identifier'));
    if (FORBIDDEN_ROUTE_TOKENS.some((token) => node.id.includes(token))) {
      issues.push(
        issue('workflow_forbidden_route', `${where}.id`, 'node id names a grader, issuer or promoter route'),
      );
    }
    if (!TOOL_ID_SET.has(node.toolId))
      issues.push(issue('unknown_tool', `${where}.toolId`, 'tool is not in the vocabulary'));
    else if (!grants.has(node.toolId))
      issues.push(
        issue('workflow_tool_not_granted', `${where}.toolId`, 'tool is not granted by the tool policy'),
      );
    for (const [name, source] of Object.entries(node.inputBindings)) {
      if (
        !IDENTIFIER_FORMAT.test(name) ||
        FORBIDDEN_ROUTE_TOKENS.some((token) => name.includes(token) || source.includes(token))
      ) {
        issues.push(
          issue(
            'workflow_forbidden_route',
            `${where}.inputBindings`,
            'binding names a grader, issuer or promoter route',
          ),
        );
        continue;
      }
      const match = INPUT_BINDING.exec(source);
      if (source !== 'job.input' && !(match && ids.includes(match[1]!))) {
        issues.push(
          issue(
            'workflow_input_binding_invalid',
            `${where}.inputBindings`,
            'binding must be job.input or an existing node output',
          ),
        );
      }
    }
  });

  const transitions: WorkflowPlan['transitions'] = {};
  workflow.edges.forEach((edge, index) => {
    const slot = (transitions[edge.from] ??= {});
    if (slot[edge.when] !== undefined) {
      issues.push(
        issue(
          'workflow_duplicate_transition',
          `workflow.edges[${index}]`,
          'two edges leave one node on one condition',
        ),
      );
    }
    slot[edge.when] = edge.to;
  });

  if (workflow.nodes.length > limits.graphNodes || workflow.edges.length > limits.graphEdges) {
    issues.push(issue('workflow_graph_limit', 'workflow', 'workflow exceeds the declared graph size limits'));
  }

  const fromEntry = reachable(workflow.entryNodeId, workflow.edges);
  ids.forEach((id, index) => {
    if (!fromEntry.has(id))
      issues.push(
        issue(
          'workflow_unreachable_node',
          `workflow.nodes[${index}]`,
          'node is not reachable from the entry',
        ),
      );
  });
  workflow.terminalNodeIds.forEach((id, index) => {
    if (!fromEntry.has(id))
      issues.push(
        issue(
          'workflow_terminal_unreachable',
          `workflow.terminalNodeIds[${index}]`,
          'terminal is not reachable from the entry',
        ),
      );
  });
  // Every reachable node must be able to reach some terminal, or a run could wander forever or stall.
  const terminals = new Set(workflow.terminalNodeIds);
  ids.forEach((id, index) => {
    if (!fromEntry.has(id) || terminals.has(id)) return;
    const downstream = reachable(id, workflow.edges);
    if (![...downstream].some((node) => terminals.has(node))) {
      issues.push(issue('workflow_dead_end', `workflow.nodes[${index}]`, 'node cannot reach a terminal'));
    }
  });

  const loopNodes = [...cyclicNodes(ids, workflow.edges)];
  workflow.nodes.forEach((node, index) => {
    if (loopNodes.includes(node.id) && node.maxVisits > LOOP_NODE_MAX_VISITS) {
      issues.push(
        issue(
          'workflow_unbounded_loop',
          `workflow.nodes[${index}].maxVisits`,
          'a node on a cycle declares too many visits',
        ),
      );
    }
  });

  const worstCaseToolCalls = workflow.nodes
    .filter((node) => fromEntry.has(node.id))
    .reduce((sum, node) => sum + node.maxVisits, 0);
  if (worstCaseToolCalls > limits.toolCalls) {
    issues.push(
      issue('workflow_visit_budget', 'workflow.nodes', 'summed maxVisits exceeds limits.toolCalls'),
    );
  }

  const plan: WorkflowPlan | null = issues.length
    ? null
    : {
        entry: workflow.entryNodeId,
        nodes: workflow.nodes.map((node) => ({
          id: node.id,
          toolId: node.toolId,
          maxVisits: node.maxVisits,
          inputs: { ...node.inputBindings },
        })),
        transitions,
        terminals: [...workflow.terminalNodeIds],
        loopNodes: loopNodes.sort(),
        worstCaseToolCalls,
      };
  return { issues, plan };
}

/** Can a node running `producer` execute before a node running `consumer`? (the producer must precede the consumer) */
export function canPrecede(workflow: WorkflowGraph, producerTool: string, consumerTool: string): boolean {
  const producers = workflow.nodes.filter((node) => node.toolId === producerTool);
  const consumers = new Set(
    workflow.nodes.filter((node) => node.toolId === consumerTool).map((node) => node.id),
  );
  return producers.some((producer) =>
    [...reachable(producer.id, workflow.edges)].some((id) => id !== producer.id && consumers.has(id)),
  );
}
