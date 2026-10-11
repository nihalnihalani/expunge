// TEST-ONLY. One minimal unsafe candidate per rejection code. The type is a complete Record over REJECTION_CODES, so
// adding a code without adding its provoking case is a compile error; the catalog test and the evidence script both
// read it, which is why it stands alone and does not depend on the order of any other test.
import type { GuardrailAst, HarnessBundle, WorkflowGraph } from '@expunge/contracts';
import { contentHash } from '@expunge/contracts';
import { ACCEPTANCE_LIMITS, WORKER_TOOL_IDS } from '@expunge/baselines';
import { compileHarness, type CompileContext, type CompileResult, type RejectionCode } from '../src/index.js';
import {
  EVIDENCE_REFERENCE,
  SCOPED_RULE,
  TEST_FLOOR,
  childOf,
  compileChild,
  context,
  expert,
  ledgerRow,
  patch,
  w0,
} from './helpers.js';

/** The call ceiling of the baselines under test: derived, never hard-coded. */
const LIMIT_CALLS = ACCEPTANCE_LIMITS.modelCalls;
const CORPUS = [
  ledgerRow('complete_unverified', 'complete_cleanup', { verification_status: null, retry_count: 0 }),
  ledgerRow('complete_valid', 'complete_cleanup', { verification_status: 'valid', retry_count: 0 }),
  ledgerRow('apply_fresh', 'apply_cleanup_batch', { world_revision_fresh: true, retry_count: 0 }),
];
const withCorpus = (): CompileContext => context({ replayCorpus: CORPUS });
const VERIFY_RULE: GuardrailAst = {
  ruleId: 'deny_complete_without_verification',
  predicate: {
    op: 'not',
    predicate: {
      op: 'compare',
      comparator: 'eq',
      left: { kind: 'fact', factId: 'verification_status' },
      right: { kind: 'constant', value: 'valid' },
    },
  },
  result: 'deny',
  sourceEvidenceIds: ['evt_01'],
  appliesTo: ['complete_cleanup'],
};
const LIMIT = patch('limits.modelCalls', 'tool_policy', LIMIT_CALLS, 8);
const addRule = (rule: GuardrailAst, ctx: CompileContext = withCorpus()): CompileResult =>
  compileChild(w0(), [patch(`guardrails.${rule.ruleId}`, 'guardrails', null, rule)], ctx);
const editWorkflow = (
  mutate: (graph: WorkflowGraph) => void,
  extra: Partial<HarnessBundle> = {},
): CompileResult => {
  const parent = w0();
  const graph = structuredClone(parent.workflow);
  mutate(graph);
  return compileChild(parent, [patch('workflow', 'workflow', parent.workflow, graph)], context(), extra);
};
const rule = (over: Partial<GuardrailAst>): GuardrailAst => ({ ...VERIFY_RULE, ...over });
const unscoped = (over: Partial<GuardrailAst>): GuardrailAst => {
  const built = rule(over);
  delete (built as { appliesTo?: unknown }).appliesTo;
  return built;
};
const root = (candidate: unknown, ctx: CompileContext = context()): CompileResult =>
  compileHarness({ candidate: candidate as HarnessBundle, parent: null }, ctx);
const prerequisite = (
  toolId: string,
  requiredArtifact: 'preview_plan' | 'action_receipt' | 'completion_receipt' | 'approval_grant',
) => ({ toolId, requiredArtifact, binding: 'same_job_same_plan_current_revision' as const });
const addPrerequisite = (extra: ReturnType<typeof prerequisite>) => {
  const parent = w0();
  return compileChild(parent, [
    patch('toolPolicy.prerequisites', 'tool_policy', parent.toolPolicy.prerequisites, [
      ...parent.toolPolicy.prerequisites,
      extra,
    ]),
  ]);
};
const pluginBinding = {
  slot: 'context',
  sourceHash: 'a'.repeat(64),
  compiledHash: 'b'.repeat(64),
  abiHash: 'c'.repeat(64),
  sandboxProfileHash: 'd'.repeat(64),
  exportName: 'select_fields',
  inputSchemaHash: 'e'.repeat(64),
  outputSchemaHash: 'f'.repeat(64),
} as const;
const plugin = (
  attest: { sourceVerified: boolean; compiledVerified: boolean; compiledFromSource: boolean } | null,
  abiHash: string = pluginBinding.abiHash,
): CompileResult =>
  compileChild(
    w0(),
    [patch('pluginArtifacts', 'plugin', [], [pluginBinding])],
    attest
      ? context({
          plugins: { abiHash, sandboxProfileHash: pluginBinding.sandboxProfileHash, attest: () => attest },
        })
      : context(),
  );
const hypothesisCase = (text: string, ctx: CompileContext = withCorpus()): CompileResult =>
  compileChild(
    w0(),
    [patch('guardrails.deny_complete_without_verification', 'guardrails', null, VERIFY_RULE, text)],
    ctx,
  );

export const REJECTION_CATALOG: Record<RejectionCode, () => CompileResult> = {
  schema_invalid: () => root({ ...w0(), extra: 1 }),
  infrastructure_hash_mismatch: () => root({ ...w0(), compilerHash: 'e'.repeat(64) }),
  parent_hash_mismatch: () =>
    compileHarness(
      { candidate: childOf(w0(), [LIMIT], { parentHash: 'f'.repeat(64) }), parent: w0(), patches: [LIMIT] },
      context(),
    ),
  immutable_field_changed: () =>
    compileHarness(
      { candidate: childOf(w0(), [LIMIT], { target: 'improver' }), parent: w0(), patches: [LIMIT] },
      context(),
    ),
  identifier_format: () => addRule(rule({ ruleId: 'Bad Rule!' })),

  rule_id_duplicate: () => root({ ...w0(), guardrails: [VERIFY_RULE, VERIFY_RULE] }),
  inert_allow_rule: () => addRule(rule({ result: 'allow' })),
  applies_to_unknown_tool: () => addRule(rule({ appliesTo: ['apply_cleanup_batch', 'drop_database'] })),
  applies_to_duplicate: () => addRule(rule({ appliesTo: ['complete_cleanup', 'complete_cleanup'] })),
  guardrail_depth: () => {
    let predicate: GuardrailAst['predicate'] = { op: 'receipt_valid', bindingId: 'preview_plan' };
    for (let level = 0; level < 10; level++) predicate = { op: 'not', predicate };
    return addRule(rule({ predicate }));
  },
  guardrail_nodes: () => {
    const wide: GuardrailAst['predicate'] = {
      op: 'all',
      predicates: Array.from({ length: 32 }, () => ({
        op: 'receipt_valid' as const,
        bindingId: 'preview_plan',
      })),
    };
    const many = w0();
    many.guardrails = Array.from({ length: 70 }, (_, index) => ({
      ruleId: `deny_rule_${index}`,
      predicate: wide,
      result: 'deny' as const,
      sourceEvidenceIds: [],
      appliesTo: ['apply_cleanup_batch'],
    }));
    return root(many);
  },
  unknown_fact: () =>
    addRule(
      rule({
        predicate: {
          op: 'compare',
          comparator: 'eq',
          left: { kind: 'fact', factId: 'tool_is_anything' },
          right: { kind: 'constant', value: true },
        },
      }),
    ),
  unknown_binding: () => addRule(rule({ predicate: { op: 'receipt_valid', bindingId: 'grader_verdict' } })),
  unknown_tool: () =>
    addRule(
      rule({ predicate: { op: 'prior_effect_count', toolId: 'drop_database', comparator: 'gt', count: 0 } }),
    ),
  operand_type_mismatch: () =>
    addRule(
      rule({
        predicate: {
          op: 'compare',
          comparator: 'eq',
          left: { kind: 'fact', factId: 'verification_residuals' },
          right: { kind: 'constant', value: true },
        },
      }),
    ),
  comparator_not_allowed: () =>
    addRule(
      rule({
        predicate: {
          op: 'compare',
          comparator: 'lt',
          left: { kind: 'fact', factId: 'verification_status' },
          right: { kind: 'constant', value: 'valid' },
        },
      }),
    ),
  constant_out_of_domain: () =>
    addRule(
      rule({
        predicate: {
          op: 'compare',
          comparator: 'eq',
          left: { kind: 'fact', factId: 'verification_status' },
          right: { kind: 'constant', value: 'tombstone' },
        },
      }),
    ),
  constant_predicate: () =>
    addRule(
      rule({
        predicate: {
          op: 'compare',
          comparator: 'eq',
          left: { kind: 'constant', value: 1 },
          right: { kind: 'constant', value: 1 },
        },
      }),
    ),
  unscoped_artifact_rule: () =>
    addRule(
      unscoped({ predicate: { op: 'not', predicate: { op: 'receipt_valid', bindingId: 'preview_plan' } } }),
    ),

  workflow_reference_invalid: () => {
    const bundle = w0();
    bundle.workflow.edges.push({ from: 'apply', to: 'ghost', when: 'needs_approval' });
    return root(bundle);
  },
  workflow_tool_not_granted: () =>
    editWorkflow((g) => {
      g.nodes.splice(5, 0, {
        id: 'verify',
        toolId: 'verify_registered_scope',
        inputBindings: {},
        maxVisits: 1,
      });
      g.edges.push(
        { from: 'apply', to: 'verify', when: 'needs_approval' },
        { from: 'verify', to: 'complete', when: 'success' },
      );
    }),
  workflow_duplicate_transition: () =>
    editWorkflow(
      (g) =>
        void g.edges.push(
          { from: 'apply', to: 'complete', when: 'retryable_error' },
          { from: 'apply', to: 'discover', when: 'retryable_error' },
        ),
    ),
  workflow_unreachable_node: () =>
    editWorkflow(
      (g) =>
        void g.nodes.push({ id: 'orphan', toolId: 'report_diagnostic', inputBindings: {}, maxVisits: 1 }),
    ),
  workflow_terminal_unreachable: () =>
    editWorkflow((g) => void (g.edges = g.edges.filter((e) => !(e.from === 'apply' && e.to === 'complete')))),
  workflow_dead_end: () => editWorkflow((g) => void (g.edges = g.edges.filter((e) => e.from !== 'preview'))),
  workflow_unbounded_loop: () =>
    editWorkflow((g) => void (g.nodes.find((n) => n.id === 'apply')!.maxVisits = 20)),
  workflow_graph_limit: () => compileChild(w0(), [patch('limits.graphNodes', 'tool_policy', 16, 4)]),
  workflow_visit_budget: () =>
    editWorkflow(
      (g) => void (g.nodes.find((n) => n.id === 'apply')!.maxVisits = ACCEPTANCE_LIMITS.toolCalls),
    ),
  workflow_forbidden_route: () =>
    editWorkflow((g) => void (g.nodes[2]!.inputBindings = { verdict: 'promoter.output' })),
  workflow_input_binding_invalid: () =>
    editWorkflow((g) => void (g.nodes[2]!.inputBindings = { subject: 'ghost.output' })),

  duplicate_grant: () => {
    const parent = w0();
    return compileChild(parent, [
      patch('toolPolicy.grants', 'tool_policy', parent.toolPolicy.grants, [
        ...parent.toolPolicy.grants,
        'inspect_scope',
      ]),
    ]);
  },
  floor_violation: () =>
    root(
      w0(),
      context({
        floor: {
          ...TEST_FLOOR,
          allowedTools: WORKER_TOOL_IDS.filter((tool) => tool !== 'report_diagnostic'),
        },
      }),
    ),
  duplicate_prerequisite: () => addPrerequisite(prerequisite('apply_cleanup_batch', 'preview_plan')),
  prerequisite_deadlock: () => addPrerequisite(prerequisite('preview_cleanup', 'preview_plan')),
  prerequisite_unsatisfiable: () => addPrerequisite(prerequisite('complete_cleanup', 'completion_receipt')),
  limits_exceed_owner: () =>
    compileChild(w0(), [patch('limits.modelCalls', 'tool_policy', LIMIT_CALLS, LIMIT_CALLS + 1)]),
  limits_degenerate: () => compileChild(w0(), [patch('limits.modelCalls', 'tool_policy', LIMIT_CALLS, 0)]),
  context_exceeds_limits: () => compileChild(w0(), [patch('contextPolicy.referenceDepth', 'context', 1, 4)]),

  no_change: () => compileHarness({ candidate: childOf(w0(), []), parent: w0(), patches: [] }, context()),
  patch_path_invalid: () =>
    compileHarness(
      {
        candidate: childOf(w0(), [LIMIT]),
        parent: w0(),
        patches: [patch('workflow.nodes', 'workflow', 1, 2)],
      },
      context(),
    ),
  patch_path_duplicate: () => compileChild(w0(), [LIMIT, LIMIT]),
  patch_surface_mismatch: () => {
    const wrong = [patch('limits.modelCalls', 'context', LIMIT_CALLS, 8)];
    return compileHarness({ candidate: childOf(w0(), wrong), parent: w0(), patches: wrong }, context());
  },
  patch_before_mismatch: () => {
    const wrong = [patch('limits.modelCalls', 'tool_policy', 99, 8)];
    return compileHarness({ candidate: childOf(w0(), wrong), parent: w0(), patches: wrong }, context());
  },
  patch_after_mismatch: () =>
    compileHarness(
      {
        candidate: childOf(w0(), [LIMIT]),
        parent: w0(),
        patches: [patch('limits.modelCalls', 'tool_policy', LIMIT_CALLS, 4)],
      },
      context(),
    ),
  no_op_patch: () =>
    compileChild(w0(), [patch('limits.modelCalls', 'tool_policy', LIMIT_CALLS, LIMIT_CALLS)]),
  unexplained_change: () => {
    const candidate = childOf(w0(), [LIMIT]);
    candidate.limits.wallTimeMs = 60000;
    return compileHarness({ candidate, parent: w0(), patches: [LIMIT] }, context());
  },
  edit_budget_exceeded: () =>
    compileChild(w0(), [
      patch('limits.modelCalls', 'tool_policy', LIMIT_CALLS, LIMIT_CALLS - 1),
      patch('limits.toolCalls', 'tool_policy', LIMIT_CALLS, LIMIT_CALLS - 1),
      patch('limits.wallTimeMs', 'tool_policy', 120000, 100000),
      patch('limits.totalTokens', 'tool_policy', 24000, 20000),
    ]),
  hypothesis_missing: () => compileChild(w0(), [{ ...LIMIT, hypothesis: 'short' }]),
  evidence_missing: () => compileChild(w0(), [{ ...LIMIT, sourceEvidenceIds: [] }]),
  evidence_not_found: () => compileChild(w0(), [{ ...LIMIT, sourceEvidenceIds: ['evt_does_not_exist'] }]),
  evidence_not_permitted: () =>
    compileChild(
      w0(),
      [LIMIT],
      context({
        evidence: new Map([
          [
            'evt_01',
            {
              permittedUse: 'gate_only' as const,
              origin: 'verifier_feedback' as const,
              split: 'train' as const,
              evidenceId: 'evb_fixture',
              jobId: 'job_fixture',
              runId: 'run_fixture',
            },
          ],
        ]),
      }),
    ),
  evidence_not_in_bundle: () => {
    const candidate = childOf(w0(), [LIMIT]);
    candidate.evidence = [];
    return compileHarness({ candidate, parent: w0(), patches: [LIMIT] }, context());
  },
  authority_expansion_unflagged: () => {
    const parent = expert();
    return compileChild(parent, [
      patch('completionPolicy', 'workflow', 'verified_receipt', 'model_narrative'),
    ]);
  },

  subject_literal: () => hypothesisCase('Fix for syn_subject_0123456789abcdef0123 who was missed.'),
  task_literal: () =>
    hypothesisCase(
      'The order_77 incident needs this rule.',
      context({ forbidden: { subject: [], task: ['order_77'] }, replayCorpus: CORPUS }),
    ),
  hidden_test_shortcut: () => hypothesisCase('Check messages.expected_target before completing.'),
  plugin_unverifiable: () =>
    plugin({ sourceVerified: false, compiledVerified: true, compiledFromSource: true }),
  plugin_source_compiled_mismatch: () =>
    plugin({ sourceVerified: true, compiledVerified: true, compiledFromSource: false }),
  plugin_abi_mismatch: () =>
    plugin({ sourceVerified: true, compiledVerified: true, compiledFromSource: true }, '0'.repeat(64)),
  replay_corpus_missing: () => addRule(VERIFY_RULE, context()),
  no_op_rule: () =>
    addRule({
      ...SCOPED_RULE,
      ruleId: 'deny_when_retry_huge',
      predicate: {
        op: 'compare',
        comparator: 'gt',
        left: { kind: 'fact', factId: 'retry_count' },
        right: { kind: 'constant', value: 100 },
      },
    }),
};
export { EVIDENCE_REFERENCE, contentHash };
