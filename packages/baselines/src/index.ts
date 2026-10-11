// Baseline harness bundles for the Expunge worker.
//
// W0 is the documented, deliberately incomplete initial harness: it inspects only selected fields,
// ignores nested arrays, expands references one hop, never verifies, and lets the model narrate
// completion. The expert-static bundle is the competent known procedure written by a human:
// all registered fields, nested arrays, five hops, a verification step, and completion that is
// only rendered from a committed receipt. Both are explicit, human-authored artifacts. The
// learner's contribution is measured as the delta between W0 and what evolution produces,
// compared against expert-static on structurally held-out worlds.
//
// The five infrastructure hashes are not decided here. They are inputs, so that the bundle hash
// binds to the actual runtime adapter, compiler, vocabulary, authority floor and eligibility policy
// that will execute it. Freezing happens in PREREGISTRATION.md.
import {
  BINDING_IDS,
  COMPARATORS_BY_TYPE,
  ENUM_DOMAINS,
  FACT_CATALOG,
  PATCH_PATHS,
  WORKER_TOOL_IDS,
  WORKFLOW_INPUT_SOURCES,
} from './primitives.js';
import {
  validateHarnessBundle,
  type ContextPolicy,
  type GuardrailAst,
  type HarnessBundle,
  type ResourceLimits,
  type ToolPolicy,
  type WorkflowGraph,
} from '@expunge/contracts';

export type InfrastructureHashes = {
  runtimeAdapterHash: string;
  compilerHash: string;
  vocabularyHash: string;
  authorityFloorHash: string;
  eligibilityPolicyHash: string;
  sourceEligibilityPolicyHash: string;
};

export * from './primitives.js';

/**
 * Limits from docs/expunge/ACCEPTANCE.md ("Worker execution" and "Controlled world" rows): 120 seconds per episode,
 * a 24,000 total token cap, 500 documents and five reference hops. The phase ceiling is 16 model calls and 16 tool
 * calls under amendment A-1 (PREREGISTRATION.md, recorded before any result). ACCEPTANCE.md stated 12. A cleanup plan
 * applies one batch per effect kind, and the ten fixture families need 2 to 4 apply calls per plan. At 12 calls the
 * expert procedure could not reach verification on four-batch plans or run its verification-failure round at all.
 * The amendment applies identically to every arm (W0, expert-static, evolved, score-only, wrong-incident).
 */
export const ACCEPTANCE_LIMITS = {
  modelCalls: 16,
  toolCalls: 16,
  scannedDocuments: 500,
  changedDocuments: 500,
  traversalDepth: 5,
  wallTimeMs: 120_000,
  totalTokens: 24_000,
} as const;

/**
 * Owner maxima set by the lead, NOT stated in docs/expunge/ACCEPTANCE.md (which fixes only 12 phases, 120 s,
 * 24,000 tokens and 500 documents): the workflow graph caps and the provisional dollar ceiling below. They are
 * frozen in PREREGISTRATION.md before evolution. The compiler enforces `workflow.nodes.length <= limits.graphNodes`
 * and `workflow.edges.length <= limits.graphEdges`; reference traversal in the domain is bounded by
 * `traversalDepth` and `scannedDocuments`.
 */
export const WORKFLOW_GRAPH_CAPS = { graphNodes: 16, graphEdges: 32 } as const;

/**
 * PROVISIONAL lead-set dollar ceiling (US$0.10 per episode). ACCEPTANCE.md requires the real ceiling to come from
 * measured baseline probes before final evaluation; until then unknown pricing cannot satisfy a dollar gate.
 */
export const PROVISIONAL_COST_CEILING_MICROUSD = 100_000;

/** Owner maxima the trusted executor enforces; the model never self-reports against them. */
export const OWNER_EPISODE_LIMITS: ResourceLimits = {
  ...ACCEPTANCE_LIMITS,
  ...WORKFLOW_GRAPH_CAPS,
  maxCostMicrousd: PROVISIONAL_COST_CEILING_MICROUSD,
};

function node(
  id: string,
  toolId: (typeof WORKER_TOOL_IDS)[number],
  maxVisits = 1,
  inputBindings: Record<string, string> = {},
) {
  return { id, toolId, inputBindings, maxVisits };
}

/** Linear workflow with no verification: the structural reason W0 reports success after a miss. */
const w0Workflow: WorkflowGraph = {
  entryNodeId: 'inspect',
  nodes: [
    node('inspect', 'inspect_scope'),
    node('resolve', 'resolve_subject', 1, { scope: 'inspect.output' }),
    node('discover', 'discover_references', 1, { subject: 'resolve.output' }),
    node('preview', 'preview_cleanup', 1, { targets: 'discover.output' }),
    node('apply', 'apply_cleanup_batch', 5, { plan: 'preview.output' }),
    node('complete', 'complete_cleanup', 1, { plan: 'preview.output' }),
  ],
  edges: [
    { from: 'inspect', to: 'resolve', when: 'success' },
    { from: 'resolve', to: 'discover', when: 'success' },
    { from: 'discover', to: 'preview', when: 'success' },
    { from: 'preview', to: 'apply', when: 'success' },
    { from: 'apply', to: 'apply', when: 'batches_remaining' },
    { from: 'apply', to: 'apply', when: 'retryable_error' },
    { from: 'apply', to: 'complete', when: 'success' },
  ],
  terminalNodeIds: ['complete'],
};

/**
 * Expert procedure: bounded discovery loop, verification before completion, verification failure re-enters discovery.
 * A plan is applied one batch per call (`batches_remaining` until the last batch, then `success`). The re-entry is a
 * second round discover -> preview -> apply -> verify, so preview and verify allow two visits and apply allows six
 * (a four-batch first round plus a smaller second round). Summed maxVisits stays within ACCEPTANCE_LIMITS.toolCalls
 * (16): 1+1+3+2+6+2+1 = 16. With preview at one visit (the pre-enforcement value), the gateway's runtime workflow
 * enforcement denied every second round at preview, so the verification-failure branch could never complete.
 */
const expertWorkflow: WorkflowGraph = {
  entryNodeId: 'inspect',
  nodes: [
    node('inspect', 'inspect_scope'),
    node('resolve', 'resolve_subject', 1, { scope: 'inspect.output' }),
    node('discover', 'discover_references', 3, { subject: 'resolve.output', frontier: 'discover.output' }),
    node('preview', 'preview_cleanup', 2, { targets: 'discover.output' }),
    node('apply', 'apply_cleanup_batch', 6, { plan: 'preview.output' }),
    node('verify', 'verify_registered_scope', 2, { plan: 'preview.output' }),
    node('complete', 'complete_cleanup', 1, { receipt: 'verify.output' }),
  ],
  edges: [
    { from: 'inspect', to: 'resolve', when: 'success' },
    { from: 'resolve', to: 'discover', when: 'success' },
    { from: 'discover', to: 'discover', when: 'more_references' },
    { from: 'discover', to: 'preview', when: 'success' },
    { from: 'preview', to: 'apply', when: 'success' },
    { from: 'apply', to: 'apply', when: 'batches_remaining' },
    { from: 'apply', to: 'apply', when: 'retryable_error' },
    { from: 'apply', to: 'verify', when: 'success' },
    { from: 'verify', to: 'discover', when: 'verification_failed' },
    { from: 'verify', to: 'complete', when: 'success' },
  ],
  terminalNodeIds: ['complete'],
};

const w0Context = (sourceEligibilityPolicyHash: string): ContextPolicy => ({
  schemaMode: 'selected_fields',
  includeNestedArrays: false,
  referenceDepth: 1,
  lessonRecall: { mode: 'exact', topK: 0, moduleIds: [] },
  sourceEligibilityPolicyHash,
  maxContextTokens: 6_000,
  evidenceFormat: 'score_only',
});

const expertContext = (sourceEligibilityPolicyHash: string): ContextPolicy => ({
  schemaMode: 'all_registered_fields',
  includeNestedArrays: true,
  referenceDepth: 5,
  lessonRecall: { mode: 'exact', topK: 0, moduleIds: [] },
  sourceEligibilityPolicyHash,
  maxContextTokens: 12_000,
  evidenceFormat: 'score_only',
});

const w0ToolPolicy: ToolPolicy = {
  grants: [
    'inspect_scope',
    'resolve_subject',
    'discover_references',
    'preview_cleanup',
    'apply_cleanup_batch',
    'complete_cleanup',
    'report_diagnostic',
  ],
  prerequisites: [
    {
      toolId: 'apply_cleanup_batch',
      requiredArtifact: 'preview_plan',
      binding: 'same_job_same_plan_current_revision',
    },
  ],
};

const expertToolPolicy: ToolPolicy = {
  grants: [...WORKER_TOOL_IDS],
  prerequisites: [
    {
      toolId: 'apply_cleanup_batch',
      requiredArtifact: 'preview_plan',
      binding: 'same_job_same_plan_current_revision',
    },
    {
      toolId: 'verify_registered_scope',
      requiredArtifact: 'action_receipt',
      binding: 'same_job_same_plan_current_revision',
    },
    {
      toolId: 'complete_cleanup',
      requiredArtifact: 'completion_receipt',
      binding: 'same_job_same_plan_current_revision',
    },
  ],
};

/**
 * Expert guardrail, scoped to the effect tool with `appliesTo`: deny apply_cleanup_batch unless the bound preview
 * plan is a valid receipt-backed artifact. Under the three-valued semantics an absent plan is unknown, which a deny
 * rule treats as fired, so apply without a plan is denied as well. Every other tool call is unaffected.
 */
const expertGuardrails: GuardrailAst[] = [
  {
    ruleId: 'deny_apply_without_valid_plan',
    predicate: { op: 'not', predicate: { op: 'receipt_valid', bindingId: 'preview_plan' } },
    result: 'deny',
    sourceEvidenceIds: [],
    appliesTo: ['apply_cleanup_batch'],
  },
];

export function buildW0Bundle(hashes: InfrastructureHashes): HarnessBundle {
  return validateHarnessBundle({
    contractVersion: 1,
    target: 'worker',
    parentHash: null,
    contextPolicy: w0Context(hashes.sourceEligibilityPolicyHash),
    workflow: w0Workflow,
    guardrails: [],
    toolPolicy: w0ToolPolicy,
    completionPolicy: 'model_narrative',
    pluginArtifacts: [],
    limits: { ...OWNER_EPISODE_LIMITS, traversalDepth: 1 },
    evidence: [],
    runtimeAdapterHash: hashes.runtimeAdapterHash,
    compilerHash: hashes.compilerHash,
    vocabularyHash: hashes.vocabularyHash,
    authorityFloorHash: hashes.authorityFloorHash,
    eligibilityPolicyHash: hashes.eligibilityPolicyHash,
  });
}

export function buildExpertStaticBundle(hashes: InfrastructureHashes): HarnessBundle {
  return validateHarnessBundle({
    contractVersion: 1,
    target: 'worker',
    parentHash: null,
    contextPolicy: expertContext(hashes.sourceEligibilityPolicyHash),
    workflow: expertWorkflow,
    guardrails: expertGuardrails,
    toolPolicy: expertToolPolicy,
    completionPolicy: 'verified_receipt',
    pluginArtifacts: [],
    limits: OWNER_EPISODE_LIMITS,
    evidence: [],
    runtimeAdapterHash: hashes.runtimeAdapterHash,
    compilerHash: hashes.compilerHash,
    vocabularyHash: hashes.vocabularyHash,
    authorityFloorHash: hashes.authorityFloorHash,
    eligibilityPolicyHash: hashes.eligibilityPolicyHash,
  });
}

/** Human-authored primitives disclosed for the evolver's search space (spec section 9). */
export const DISCLOSED_PRIMITIVES = {
  contextSchemaModes: ['selected_fields', 'all_registered_fields', 'inspect_then_select'],
  workflowEdgeConditions: [
    'success',
    'more_references',
    'batches_remaining',
    'needs_approval',
    'retryable_error',
    'verification_failed',
  ],
  workflowInputSources: WORKFLOW_INPUT_SOURCES,
  guardrailOps: ['all', 'any', 'not', 'compare', 'receipt_valid', 'prior_effect_count'],
  guardrailFacts: FACT_CATALOG,
  guardrailBindings: BINDING_IDS,
  guardrailComparators: COMPARATORS_BY_TYPE,
  guardrailEnumDomains: ENUM_DOMAINS,
  guardrailNullSemantics:
    'Kleene three-valued logic: a null or missing operand makes a comparison unknown; a deny or ask rule whose predicate is unknown fires (fail closed); an allow rule is inert; severity deny > ask > allow.',
  prerequisiteArtifacts: ['preview_plan', 'action_receipt', 'completion_receipt', 'approval_grant'],
  patchPaths: PATCH_PATHS,
  workerTools: WORKER_TOOL_IDS,
} as const;
