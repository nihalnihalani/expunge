import type { ContextPolicy, ResourceLimits, ToolPolicy, WorkflowGraph } from '@expunge/contracts';
import { issue, type Issue } from './issues.js';
import { canPrecede } from './workflow.js';
import { ARTIFACT_PRODUCER, TOOL_ID_SET } from './vocabulary.js';

/** The immutable owner ceiling. A learned bundle may tighten within it, never exceed it. */
export interface OwnerFloor {
  /** Hash a bundle's `authorityFloorHash` must equal. */
  hash: string;
  allowedTools: readonly string[];
  maxLimits: ResourceLimits;
}

const LIMIT_KEYS: ReadonlyArray<keyof ResourceLimits> = [
  'modelCalls',
  'toolCalls',
  'scannedDocuments',
  'changedDocuments',
  'traversalDepth',
  'graphNodes',
  'graphEdges',
  'wallTimeMs',
  'totalTokens',
  'maxCostMicrousd',
];
const MUST_BE_POSITIVE: ReadonlyArray<keyof ResourceLimits> = [
  'modelCalls',
  'toolCalls',
  'wallTimeMs',
  'totalTokens',
  'graphNodes',
];

export function validateLimits(limits: ResourceLimits, floor: OwnerFloor): Issue[] {
  const issues: Issue[] = [];
  for (const key of LIMIT_KEYS) {
    if (limits[key] > floor.maxLimits[key])
      issues.push(issue('limits_exceed_owner', `limits.${key}`, 'limit is above the owner maximum'));
    if (MUST_BE_POSITIVE.includes(key) && limits[key] < 1)
      issues.push(issue('limits_degenerate', `limits.${key}`, 'limit must be at least 1'));
  }
  return issues;
}

/** The context may not ask for more than the limits the executor will enforce. */
export function validateContext(context: ContextPolicy, limits: ResourceLimits): Issue[] {
  const issues: Issue[] = [];
  if (context.referenceDepth > limits.traversalDepth) {
    issues.push(
      issue(
        'context_exceeds_limits',
        'contextPolicy.referenceDepth',
        'reference depth exceeds limits.traversalDepth',
      ),
    );
  }
  if (context.maxContextTokens > limits.totalTokens) {
    issues.push(
      issue(
        'context_exceeds_limits',
        'contextPolicy.maxContextTokens',
        'context size exceeds limits.totalTokens',
      ),
    );
  }
  return issues;
}

export function validateToolPolicy(policy: ToolPolicy, workflow: WorkflowGraph, floor: OwnerFloor): Issue[] {
  const issues: Issue[] = [];
  const floorTools = new Set(floor.allowedTools);
  const seenGrants = new Set<string>();
  policy.grants.forEach((toolId, index) => {
    const where = `toolPolicy.grants[${index}]`;
    if (!TOOL_ID_SET.has(toolId)) issues.push(issue('unknown_tool', where, 'tool is not in the vocabulary'));
    else if (!floorTools.has(toolId))
      issues.push(issue('floor_violation', where, 'grant is outside the owner floor'));
    if (seenGrants.has(toolId)) issues.push(issue('duplicate_grant', where, 'tool granted twice'));
    seenGrants.add(toolId);
  });
  const seenPrerequisites = new Set<string>();
  policy.prerequisites.forEach((prerequisite, index) => {
    const where = `toolPolicy.prerequisites[${index}]`;
    if (!TOOL_ID_SET.has(prerequisite.toolId))
      issues.push(issue('unknown_tool', where, 'tool is not in the vocabulary'));
    const key = `${prerequisite.toolId}:${prerequisite.requiredArtifact}`;
    if (seenPrerequisites.has(key))
      issues.push(issue('duplicate_prerequisite', where, 'prerequisite repeated'));
    seenPrerequisites.add(key);
    const producer = ARTIFACT_PRODUCER[prerequisite.requiredArtifact] ?? null;
    if (producer === prerequisite.toolId) {
      issues.push(
        issue('prerequisite_deadlock', where, 'a tool cannot require an artifact only it can produce'),
      );
    } else if (
      producer &&
      policy.grants.includes(prerequisite.toolId) &&
      workflow.nodes.some((node) => node.toolId === prerequisite.toolId) &&
      !canPrecede(workflow, producer, prerequisite.toolId)
    ) {
      issues.push(
        issue(
          'prerequisite_unsatisfiable',
          where,
          'no workflow path produces the required artifact before the tool runs',
        ),
      );
    }
  });
  return issues;
}
