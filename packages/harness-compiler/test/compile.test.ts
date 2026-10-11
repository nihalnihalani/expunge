import { describe, expect, it } from 'vitest';
import { contentHash, type GuardrailAst, type HarnessBundle, type WorkflowGraph } from '@expunge/contracts';
import { WORKER_TOOL_IDS } from '@expunge/baselines';
import {
  COMPILER_HASH,
  VOCABULARY_HASH,
  compileHarness,
  type CompileResult,
  type RejectionCode,
} from '../src/index.js';
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

function rejected(result: CompileResult, code: RejectionCode, phase?: string): void {
  expect(result.ok, `expected rejection ${code}`).toBe(false);
  if (result.ok) return;
  expect(result.rejection.codes, JSON.stringify(result.rejection.issues)).toContain(code);
  if (phase) expect(result.rejection.phase).toBe(phase);
}
function accepted(result: CompileResult) {
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.rejection.issues)}`);
  return result.artifact;
}

const CORPUS = [
  ledgerRow('complete_unverified', 'complete_cleanup', {
    verification_status: null,
    world_revision_fresh: true,
  }),
  ledgerRow('complete_invalid', 'complete_cleanup', {
    verification_status: 'invalid',
    world_revision_fresh: true,
  }),
  ledgerRow('complete_valid', 'complete_cleanup', {
    verification_status: 'valid',
    world_revision_fresh: true,
  }),
  ledgerRow('inspect', 'inspect_scope', { retry_count: 0 }),
  ledgerRow('apply_stale', 'apply_cleanup_batch', {
    world_revision_fresh: false,
    batch_document_count: 3,
    retry_count: 0,
  }),
  ledgerRow('apply_fresh', 'apply_cleanup_batch', {
    world_revision_fresh: true,
    batch_document_count: 3,
    retry_count: 0,
  }),
];
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
const withCorpus = () => context({ replayCorpus: CORPUS });
/** Apply and inspect decisions with the plan absent, invalid and valid: flips for every rewritten expert rule. */
const PLAN_CORPUS = [
  ledgerRow(
    'apply_no_plan',
    'apply_cleanup_batch',
    { retry_count: 0 },
    { inputs: { facts: { retry_count: 0 }, bindings: { preview_plan: null }, prior: {} } },
  ),
  ledgerRow(
    'apply_bad_plan',
    'apply_cleanup_batch',
    { retry_count: 0 },
    { inputs: { facts: { retry_count: 0 }, bindings: { preview_plan: 'invalid' }, prior: {} } },
  ),
  ledgerRow('apply_good_plan', 'apply_cleanup_batch', { retry_count: 0 }),
  ledgerRow(
    'inspect_no_plan',
    'inspect_scope',
    { retry_count: 0 },
    { inputs: { facts: { retry_count: 0 }, bindings: { preview_plan: null }, prior: {} } },
  ),
];

/** W0's workflow plus a verification step, as the expert has it. */
function verifyingWorkflow(): WorkflowGraph {
  const graph = structuredClone(w0().workflow);
  graph.nodes = graph.nodes.map((node) =>
    node.id === 'complete' ? { ...node, inputBindings: { receipt: 'verify.output' } } : node,
  );
  graph.nodes.splice(5, 0, {
    id: 'verify',
    toolId: 'verify_registered_scope',
    inputBindings: { plan: 'preview.output' },
    maxVisits: 2,
  });
  graph.edges = graph.edges.filter((edge) => !(edge.from === 'apply' && edge.to === 'complete'));
  graph.edges.push(
    { from: 'apply', to: 'verify', when: 'success' },
    { from: 'verify', to: 'complete', when: 'success' },
    { from: 'verify', to: 'discover', when: 'verification_failed' },
  );
  return graph;
}

describe('baseline bundles compile as root bundles', () => {
  it.each([
    ['W0', w0],
    ['expert-static', expert],
  ])('%s compiles with a workflow plan, compiled predicates and no class', (_name, build) => {
    const artifact = accepted(compileHarness({ candidate: build(), parent: null }, context()));
    expect(artifact.mutationClass).toBeNull();
    expect(artifact.bundleHash).toBe(contentHash(build()));
    expect(artifact.compilerHash).toBe(COMPILER_HASH);
    expect(artifact.vocabularyHash).toBe(VOCABULARY_HASH);
    expect(artifact.workflowPlan.worstCaseToolCalls).toBeLessThanOrEqual(12);
    expect(artifact.workflowPlan.entry).toBe('inspect');
    expect(artifact.toolGrants).toEqual(build().toolPolicy.grants);
  });
  it('the expert plan has the bounded verification loop and its guardrail compiles', () => {
    const artifact = accepted(compileHarness({ candidate: expert(), parent: null }, context()));
    expect(artifact.workflowPlan.loopNodes).toEqual(['apply', 'discover', 'preview', 'verify']);
    expect(artifact.workflowPlan.transitions.verify).toEqual({
      verification_failed: 'discover',
      success: 'complete',
    });
    expect(artifact.compiledPredicates.map((rule) => rule.ruleId)).toEqual(['deny_apply_without_valid_plan']);
    expect(artifact.compiledPredicates[0]!.appliesTo).toEqual(['apply_cleanup_batch']);
  });
  it('a root bundle with patches or a wrong parentHash is refused', () => {
    rejected(
      compileHarness(
        { candidate: w0(), parent: null, patches: [patch('workflow', 'workflow', 1, 2)] },
        context(),
      ),
      'patch_path_invalid',
    );
    rejected(
      compileHarness({ candidate: { ...w0(), parentHash: 'f'.repeat(64) }, parent: null }, context()),
      'parent_hash_mismatch',
      'infrastructure',
    );
  });
});

describe('one generated candidate per surface compiles with its computed class', () => {
  it('context: wider discovery is behavioral', () => {
    const parent = w0();
    const patches = [
      patch('contextPolicy.includeNestedArrays', 'context', false, true),
      patch('contextPolicy.referenceDepth', 'context', 1, 5),
      patch('limits.traversalDepth', 'tool_policy', 1, 5),
    ];
    const artifact = accepted(compileChild(parent, patches));
    expect(artifact.mutationClass).toBe('behavioral');
    expect(artifact.editedUnits.sort()).toEqual([
      'contextPolicy.includeNestedArrays',
      'contextPolicy.referenceDepth',
      'limits.traversalDepth',
    ]);
    expect(artifact.requiresGrant).toBe(false);
    expect(artifact.parentHash).toBe(contentHash(parent));
  });
  it('workflow: a bounded discovery loop is behavioral', () => {
    const parent = w0();
    const graph = structuredClone(parent.workflow);
    graph.nodes = graph.nodes.map((node) =>
      node.id === 'discover'
        ? { ...node, maxVisits: 3, inputBindings: { subject: 'resolve.output', frontier: 'discover.output' } }
        : node,
    );
    graph.edges.push({ from: 'discover', to: 'discover', when: 'more_references' });
    const artifact = accepted(compileChild(parent, [patch('workflow', 'workflow', parent.workflow, graph)]));
    expect(artifact.mutationClass).toBe('behavioral');
    expect(artifact.workflowPlan.loopNodes).toContain('discover');
    expect(artifact.workflowPlan.worstCaseToolCalls).toBe(10);
  });
  it('guardrails: a scoped deny rule that flips recorded decisions is a tightening', () => {
    const parent = w0();
    const artifact = accepted(
      compileChild(
        parent,
        [patch('guardrails.deny_complete_without_verification', 'guardrails', null, VERIFY_RULE)],
        withCorpus(),
      ),
    );
    expect(artifact.mutationClass).toBe('tightening');
    expect(artifact.compiledPredicates.map((rule) => rule.ruleId)).toEqual([
      'deny_complete_without_verification',
    ]);
    expect(artifact.decisionExpression.result).toBeDefined();
  });
  it('tool policy: requiring an approval grant before apply is a tightening', () => {
    const parent = w0();
    const prerequisites = [
      ...parent.toolPolicy.prerequisites,
      {
        toolId: 'apply_cleanup_batch',
        requiredArtifact: 'approval_grant',
        binding: 'same_job_same_plan_current_revision',
      },
    ];
    const artifact = accepted(
      compileChild(parent, [
        patch('toolPolicy.prerequisites', 'tool_policy', parent.toolPolicy.prerequisites, prerequisites),
      ]),
    );
    expect(artifact.mutationClass).toBe('tightening');
  });
  it('plugin: a verified, paired binding is behavioral', () => {
    const parent = w0();
    const binding = {
      slot: 'discovery',
      sourceHash: 'a'.repeat(64),
      compiledHash: 'b'.repeat(64),
      abiHash: 'c'.repeat(64),
      sandboxProfileHash: 'd'.repeat(64),
      exportName: 'discover_extra',
      inputSchemaHash: 'e'.repeat(64),
      outputSchemaHash: 'f'.repeat(64),
    } as const;
    const ctx = context({
      plugins: {
        abiHash: binding.abiHash,
        sandboxProfileHash: binding.sandboxProfileHash,
        attest: () => ({ sourceVerified: true, compiledVerified: true, compiledFromSource: true }),
      },
    });
    expect(
      accepted(compileChild(parent, [patch('pluginArtifacts', 'plugin', [], [binding])], ctx)).mutationClass,
    ).toBe('behavioral');
  });
});

describe('authority expansion needs a flag', () => {
  it('adding a tool grant (with its workflow step) is classified authority_expansion and refused unflagged', () => {
    const parent = w0();
    const patches = [
      patch('toolPolicy.grants', 'tool_policy', parent.toolPolicy.grants, [
        ...parent.toolPolicy.grants,
        'verify_registered_scope',
      ]),
      patch('workflow', 'workflow', parent.workflow, verifyingWorkflow()),
    ];
    rejected(compileChild(parent, patches), 'authority_expansion_unflagged', 'classification');
    const artifact = accepted(compileChild(parent, patches, context({ allowAuthorityExpansion: true })));
    expect(artifact.mutationClass).toBe('authority_expansion');
    expect(artifact.requiresGrant).toBe(true);
    expect(artifact.classComponents.map((part) => part.kind)).toContain('authority_expansion');
  });
  it('the computed class is authoritative: a false claim is recorded as a diagnostic, not trusted', () => {
    const parent = w0();
    const patches = [patch('limits.modelCalls', 'tool_policy', 12, 8)];
    const result = compileHarness(
      { candidate: childOf(parent, patches), parent, patches, claimedClass: 'authority_expansion' },
      context(),
    );
    const artifact = accepted(result);
    expect(artifact.mutationClass).toBe('tightening');
    expect(artifact.claimedClass).toBe('authority_expansion');
    expect(artifact.diagnostics).toEqual([
      { code: 'claimed_class_mismatch', message: 'claimed authority_expansion, computed tightening' },
    ]);
  });
  it.each([
    [
      'removing a prerequisite',
      () => {
        const p = expert();
        return [
          p,
          patch(
            'toolPolicy.prerequisites',
            'tool_policy',
            p.toolPolicy.prerequisites,
            p.toolPolicy.prerequisites.slice(1),
          ),
        ] as const;
      },
    ],
    [
      'removing a restrictive rule',
      () => {
        const p = expert();
        return [
          p,
          patch('guardrails.deny_apply_without_valid_plan', 'guardrails', p.guardrails[0], null),
        ] as const;
      },
    ],
    [
      'weakening the completion policy',
      () => {
        const p = expert();
        return [p, patch('completionPolicy', 'workflow', 'verified_receipt', 'model_narrative')] as const;
      },
    ],
    [
      'raising changedDocuments',
      () => {
        const p = w0();
        return [
          { ...p, limits: { ...p.limits, changedDocuments: 100 } } as HarnessBundle,
          patch('limits.changedDocuments', 'tool_policy', 100, 500),
        ] as const;
      },
    ],
    [
      'narrowing a rule scope',
      () => {
        const p = expert();
        const narrowed = { ...p.guardrails[0]!, appliesTo: ['inspect_scope'], sourceEvidenceIds: ['evt_01'] };
        return [
          p,
          patch('guardrails.deny_apply_without_valid_plan', 'guardrails', p.guardrails[0], narrowed),
        ] as const;
      },
    ],
    [
      'changing a rule predicate without a provable superset',
      () => {
        const p = expert();
        const changed = {
          ...p.guardrails[0]!,
          predicate: { op: 'receipt_valid', bindingId: 'preview_plan' } as const,
          sourceEvidenceIds: ['evt_01'],
        };
        return [
          p,
          patch('guardrails.deny_apply_without_valid_plan', 'guardrails', p.guardrails[0], changed),
        ] as const;
      },
    ],
  ])('%s is an authority expansion', (_name, build) => {
    const [parent, edit] = build();
    const result = compileChild(
      parent,
      [edit],
      context({ allowAuthorityExpansion: true, replayCorpus: PLAN_CORPUS }),
    );
    expect(accepted(result).mutationClass).toBe('authority_expansion');
  });
  it.each([
    [
      'adding a prerequisite',
      () => {
        const p = w0();
        return [
          p,
          patch('toolPolicy.prerequisites', 'tool_policy', p.toolPolicy.prerequisites, [
            ...p.toolPolicy.prerequisites,
            {
              toolId: 'apply_cleanup_batch',
              requiredArtifact: 'approval_grant',
              binding: 'same_job_same_plan_current_revision',
            },
          ]),
        ] as const;
      },
    ],
    [
      'removing a grant',
      () => {
        const p = w0();
        return [
          p,
          patch(
            'toolPolicy.grants',
            'tool_policy',
            p.toolPolicy.grants,
            p.toolPolicy.grants.filter((t) => t !== 'report_diagnostic'),
          ),
        ] as const;
      },
    ],
    [
      'lowering a limit',
      () => {
        const p = w0();
        return [p, patch('limits.wallTimeMs', 'tool_policy', 120000, 60000)] as const;
      },
    ],
    [
      'requiring a committed receipt',
      () => {
        const p = w0();
        return [p, patch('completionPolicy', 'workflow', 'model_narrative', 'verified_receipt')] as const;
      },
    ],
    [
      'widening a restrictive rule to every tool',
      () => {
        const p = expert();
        const wider = { ...p.guardrails[0]!, appliesTo: undefined, sourceEvidenceIds: ['evt_01'] };
        delete (wider as { appliesTo?: unknown }).appliesTo;
        return [
          p,
          patch('guardrails.deny_apply_without_valid_plan', 'guardrails', p.guardrails[0], wider),
        ] as const;
      },
    ],
  ])('%s is a tightening', (_name, build) => {
    const [parent, edit] = build();
    const result = compileChild(parent, [edit], context({ replayCorpus: PLAN_CORPUS }));
    // The unscoped-widening case trips the unscoped-artifact rule: tightening in class, but not admissible.
    if (_name.startsWith('widening')) rejected(result, 'unscoped_artifact_rule');
    else expect(accepted(result).mutationClass).toBe('tightening');
  });
});

describe('rejections: schema, identity and infrastructure', () => {
  it('unknown keys, unknown guardrail ops and bad enums are schema_invalid', () => {
    rejected(
      compileHarness({ candidate: { ...w0(), extra: 1 } as never, parent: null }, context()),
      'schema_invalid',
      'schema',
    );
    const unknownOp = {
      ...w0(),
      guardrails: [
        { ruleId: 'x_rule', predicate: { op: 'eval', code: '1' }, result: 'deny', sourceEvidenceIds: [] },
      ],
    };
    rejected(
      compileHarness({ candidate: unknownOp as never, parent: null }, context()),
      'schema_invalid',
      'schema',
    );
    const badEdge = structuredClone(w0());
    (badEdge.workflow.edges[0] as { when: string }).when = 'whenever';
    rejected(compileHarness({ candidate: badEdge, parent: null }, context()), 'schema_invalid', 'schema');
  });
  it('an edge to an unknown node is a malformed graph', () => {
    const bundle = structuredClone(w0());
    bundle.workflow.edges.push({ from: 'apply', to: 'ghost', when: 'needs_approval' });
    rejected(
      compileHarness({ candidate: bundle, parent: null }, context()),
      'workflow_reference_invalid',
      'schema',
    );
  });
  it('a bundle bound to another compiler, vocabulary, floor, runtime or eligibility policy is refused', () => {
    for (const field of [
      'compilerHash',
      'vocabularyHash',
      'authorityFloorHash',
      'runtimeAdapterHash',
      'eligibilityPolicyHash',
    ] as const) {
      rejected(
        compileHarness({ candidate: { ...w0(), [field]: 'e'.repeat(64) }, parent: null }, context()),
        'infrastructure_hash_mismatch',
        'infrastructure',
      );
    }
    const candidate = w0();
    candidate.contextPolicy.sourceEligibilityPolicyHash = 'e'.repeat(64);
    rejected(compileHarness({ candidate, parent: null }, context()), 'infrastructure_hash_mismatch');
  });
  it('the child must name its parent by hash, and may not change identity or infrastructure fields', () => {
    const parent = w0();
    const patches = [patch('limits.modelCalls', 'tool_policy', 12, 8)];
    rejected(
      compileHarness(
        { candidate: childOf(parent, patches, { parentHash: 'f'.repeat(64) }), parent, patches },
        context(),
      ),
      'parent_hash_mismatch',
    );
    rejected(
      compileHarness(
        { candidate: childOf(parent, patches, { target: 'improver' }), parent, patches },
        context(),
      ),
      'immutable_field_changed',
      'edits',
    );
    const rewritten = childOf(parent, patches);
    rewritten.evidence = [];
    const withEvidence = { ...parent, evidence: [EVIDENCE_REFERENCE] };
    rejected(
      compileHarness(
        { candidate: { ...rewritten, parentHash: contentHash(withEvidence) }, parent: withEvidence, patches },
        context(),
      ),
      'immutable_field_changed',
    );
  });
});

describe('rejections: edits and evidence', () => {
  const parent = w0();
  it('more than three independently justified edits is refused', () => {
    const patches = [
      patch('limits.modelCalls', 'tool_policy', 12, 11),
      patch('limits.toolCalls', 'tool_policy', 12, 11),
      patch('limits.wallTimeMs', 'tool_policy', 120000, 100000),
      patch('limits.totalTokens', 'tool_policy', 24000, 20000),
    ];
    rejected(compileChild(parent, patches), 'edit_budget_exceeded', 'edits');
  });
  it('a change without a patch is refused (a helpful batch cannot launder an unrelated restriction)', () => {
    const patches = [patch('limits.modelCalls', 'tool_policy', 12, 8)];
    const candidate = childOf(parent, patches);
    candidate.limits.wallTimeMs = 60000;
    rejected(compileHarness({ candidate, parent, patches }, context()), 'unexplained_change', 'edits');
    const smuggled = childOf(parent, patches);
    smuggled.guardrails = [SCOPED_RULE];
    rejected(compileHarness({ candidate: smuggled, parent, patches }, context()), 'unexplained_change');
  });
  it('patch paths, surfaces, before and after must be exact', () => {
    const invalid = [patch('workflow.nodes', 'workflow', 1, 2)];
    rejected(
      compileHarness(
        {
          candidate: childOf(parent, [patch('limits.modelCalls', 'tool_policy', 12, 8)]),
          parent,
          patches: invalid,
        },
        context(),
      ),
      'patch_path_invalid',
    );
    rejected(
      compileChild(parent, [
        patch('limits.modelCalls', 'tool_policy', 12, 8),
        patch('limits.modelCalls', 'tool_policy', 12, 8),
      ]),
      'patch_path_duplicate',
    );
    const wrongSurface = [patch('limits.modelCalls', 'context', 12, 8)];
    rejected(
      compileHarness({ candidate: childOf(parent, wrongSurface), parent, patches: wrongSurface }, context()),
      'patch_surface_mismatch',
    );
    const wrongBefore = [patch('limits.modelCalls', 'tool_policy', 99, 8)];
    rejected(
      compileHarness({ candidate: childOf(parent, wrongBefore), parent, patches: wrongBefore }, context()),
      'patch_before_mismatch',
    );
    const real = [patch('limits.modelCalls', 'tool_policy', 12, 8)];
    const lying = [patch('limits.modelCalls', 'tool_policy', 12, 4)];
    rejected(
      compileHarness({ candidate: childOf(parent, real), parent, patches: lying }, context()),
      'patch_after_mismatch',
    );
  });
  it('a no-op patch or an unchanged child is refused', () => {
    rejected(compileChild(parent, [patch('limits.modelCalls', 'tool_policy', 12, 12)]), 'no_op_patch');
    rejected(compileHarness({ candidate: childOf(parent, []), parent, patches: [] }, context()), 'no_change');
  });
  it('every edit needs a hypothesis and permitted training evidence that exists and is recorded in the bundle', () => {
    const edit = patch('limits.modelCalls', 'tool_policy', 12, 8);
    rejected(compileChild(parent, [{ ...edit, hypothesis: 'short' }]), 'hypothesis_missing');
    rejected(compileChild(parent, [{ ...edit, sourceEvidenceIds: [] }]), 'evidence_missing');
    rejected(
      compileChild(parent, [{ ...edit, sourceEvidenceIds: ['evt_does_not_exist'] }]),
      'evidence_not_found',
    );
    const gateOnly = context({
      evidence: new Map([
        [
          'evt_01',
          {
            permittedUse: 'gate_only' as const,
            origin: 'verifier_feedback' as const,
            split: 'train' as const,
          },
        ],
      ]),
    });
    rejected(compileChild(parent, [edit], gateOnly), 'evidence_not_permitted');
    const validation = context({
      evidence: new Map([
        [
          'evt_01',
          {
            permittedUse: 'training' as const,
            origin: 'verifier_feedback' as const,
            split: 'validation' as const,
          },
        ],
      ]),
    });
    rejected(compileChild(parent, [edit], validation), 'evidence_not_permitted');
    const unrecorded = childOf(parent, [edit]);
    unrecorded.evidence = [];
    rejected(
      compileHarness({ candidate: unrecorded, parent, patches: [edit] }, context()),
      'evidence_not_in_bundle',
    );
    rejected(compileChild(parent, [edit], { ...context(), evidence: undefined }), 'evidence_not_found');
  });
});

describe('rejections: literals and hidden-test shortcuts', () => {
  const parent = w0();
  const rule = (ruleId: string): GuardrailAst => ({ ...VERIFY_RULE, ruleId });
  const withRule = (ruleId: string, hypothesis?: string) => {
    const added = rule(ruleId);
    const edit = patch(`guardrails.${ruleId}`, 'guardrails', null, added, hypothesis);
    return compileChild(parent, [edit], withCorpus());
  };
  it('a subject identifier anywhere in the bundle or in a hypothesis is refused', () => {
    rejected(withRule('deny_for_syn_subject_0123456789abcdef0123'), 'subject_literal', 'shortcuts');
    rejected(
      withRule(
        'deny_complete_without_verification',
        'Fix for syn_subject_0123456789abcdef0123 who was missed.',
      ),
      'subject_literal',
    );
  });
  it('literals from the evidence the proposer saw are refused even when they do not look synthetic', () => {
    const forbidden = { subject: ['Quartz Harbor'], task: ['order_77'] };
    const edit = patch(
      'guardrails.deny_complete_without_verification',
      'guardrails',
      null,
      VERIFY_RULE,
      'Records of Quartz Harbor were missed in the nested copy.',
    );
    rejected(compileChild(parent, [edit], context({ forbidden, replayCorpus: CORPUS })), 'subject_literal');
    const task = patch(
      'guardrails.deny_complete_without_verification',
      'guardrails',
      null,
      VERIFY_RULE,
      'The order_77 incident needs this rule.',
    );
    rejected(compileChild(parent, [task], context({ forbidden, replayCorpus: CORPUS })), 'task_literal');
  });
  it('held-out markers, record IDs and unregistered field IDs are hidden-test shortcuts', () => {
    const marker = patch(
      'guardrails.deny_complete_without_verification',
      'guardrails',
      null,
      VERIFY_RULE,
      'Held-out layout s4f9a1c2d3e needs this check.',
    );
    rejected(
      compileChild(
        parent,
        [marker],
        context({ forbidden: { subject: [], task: [], hidden: ['s4f9a1c2d3e'] }, replayCorpus: CORPUS }),
      ),
      'hidden_test_shortcut',
    );
    const recordId = patch(
      'guardrails.deny_complete_without_verification',
      'guardrails',
      null,
      VERIFY_RULE,
      'Target syn_0123456789abcdef01234567 was missed.',
    );
    rejected(compileChild(parent, [recordId], withCorpus()), 'hidden_test_shortcut');
    const unknownField = patch(
      'guardrails.deny_complete_without_verification',
      'guardrails',
      null,
      VERIFY_RULE,
      'Check messages.expected_target before completing.',
    );
    rejected(compileChild(parent, [unknownField], withCorpus()), 'hidden_test_shortcut');
    const registered = patch(
      'guardrails.deny_complete_without_verification',
      'guardrails',
      null,
      VERIFY_RULE,
      'The messages.identity_binding array was never inspected.',
    );
    expect(compileChild(parent, [registered], withCorpus()).ok).toBe(true);
    // Lesson module IDs are free strings too.
    const lessons = patch('contextPolicy.lessonRecall', 'context', parent.contextPolicy.lessonRecall, {
      mode: 'exact',
      topK: 3,
      moduleIds: ['syn_0123456789abcdef01234567'],
    });
    rejected(compileChild(parent, [lessons]), 'hidden_test_shortcut');
  });
});

describe('rejections: guardrails', () => {
  const parent = w0();
  const add = (rule: GuardrailAst, ctx = withCorpus()) =>
    compileChild(parent, [patch(`guardrails.${rule.ruleId}`, 'guardrails', null, rule)], ctx);
  const rule = (over: Partial<GuardrailAst>): GuardrailAst => ({ ...VERIFY_RULE, ...over });
  it('unknown facts, bindings and tools are refused', () => {
    const unknownFact = rule({
      predicate: {
        op: 'compare',
        comparator: 'eq',
        left: { kind: 'fact', factId: 'tool_is_anything' },
        right: { kind: 'constant', value: true },
      },
    });
    rejected(add(unknownFact), 'unknown_fact', 'structure');
    rejected(
      add(rule({ predicate: { op: 'receipt_valid', bindingId: 'grader_verdict' } })),
      'unknown_binding',
    );
    rejected(
      add(
        rule({
          predicate: {
            op: 'compare',
            comparator: 'eq',
            left: { kind: 'binding', bindingId: 'oracle' },
            right: { kind: 'constant', value: 'valid' },
          },
        }),
      ),
      'unknown_binding',
    );
    rejected(
      add(
        rule({
          predicate: { op: 'prior_effect_count', toolId: 'drop_database', comparator: 'gt', count: 0 },
        }),
      ),
      'unknown_tool',
    );
  });
  it('operand types, comparators and constant domains are checked', () => {
    const cmp = (comparator: 'eq' | 'lt', left: never, right: never) =>
      rule({ predicate: { op: 'compare', comparator, left, right } });
    const residuals = { kind: 'fact', factId: 'verification_residuals' } as never;
    const status = { kind: 'fact', factId: 'verification_status' } as never;
    rejected(add(cmp('eq', residuals, { kind: 'constant', value: true } as never)), 'operand_type_mismatch');
    rejected(add(cmp('eq', status, residuals)), 'operand_type_mismatch');
    rejected(add(cmp('lt', status, { kind: 'constant', value: 'valid' } as never)), 'comparator_not_allowed');
    rejected(
      add(cmp('eq', status, { kind: 'constant', value: 'tombstone' } as never)),
      'constant_out_of_domain',
    );
    rejected(
      add(
        cmp(
          'eq',
          { kind: 'fact', factId: 'world_revision_fresh' } as never,
          { kind: 'constant', value: 3 } as never,
        ),
      ),
      'operand_type_mismatch',
    );
  });
  it('degenerate rules are refused: constant predicates, inert allow rules, duplicate ids, bad identifiers', () => {
    const constant = rule({
      predicate: {
        op: 'compare',
        comparator: 'eq',
        left: { kind: 'constant', value: 1 },
        right: { kind: 'constant', value: 1 },
      },
    });
    rejected(add(constant), 'constant_predicate');
    rejected(add(rule({ result: 'allow' })), 'inert_allow_rule');
    rejected(add(rule({ ruleId: 'Bad Rule!' })), 'identifier_format');
    const twice = structuredClone(parent);
    twice.guardrails = [VERIFY_RULE, VERIFY_RULE];
    rejected(compileHarness({ candidate: twice, parent: null }, context()), 'rule_id_duplicate');
  });
  it('predicates nested deeper than the contract bound are refused', () => {
    let predicate: GuardrailAst['predicate'] = { op: 'receipt_valid', bindingId: 'preview_plan' };
    for (let level = 0; level < 10; level++) predicate = { op: 'not', predicate };
    rejected(add(rule({ predicate })), 'guardrail_depth');
  });
  it('more predicate nodes than the contract bound is refused', () => {
    const wide: GuardrailAst['predicate'] = {
      op: 'all',
      predicates: Array.from({ length: 32 }, () => ({
        op: 'receipt_valid' as const,
        bindingId: 'preview_plan',
      })),
    };
    const many = structuredClone(parent);
    many.guardrails = Array.from({ length: 70 }, (_, index) => ({
      ruleId: `deny_rule_${index}`,
      predicate: wide,
      result: 'deny' as const,
      sourceEvidenceIds: [],
      appliesTo: ['apply_cleanup_batch'],
    }));
    rejected(compileHarness({ candidate: many, parent: null }, context()), 'guardrail_nodes', 'schema');
  });
  it('a restrictive rule over receipts, prior effects or nullable facts must name the tools it governs', () => {
    const unscoped = (predicate: GuardrailAst['predicate']) => rule({ appliesTo: undefined, predicate });
    const receipt = unscoped({ op: 'not', predicate: { op: 'receipt_valid', bindingId: 'preview_plan' } });
    delete (receipt as { appliesTo?: unknown }).appliesTo;
    rejected(add(receipt), 'unscoped_artifact_rule');
    const prior = unscoped({
      op: 'prior_effect_count',
      toolId: 'apply_cleanup_batch',
      comparator: 'gte',
      count: 3,
    });
    delete (prior as { appliesTo?: unknown }).appliesTo;
    rejected(add(prior), 'unscoped_artifact_rule');
    const nullable = unscoped({
      op: 'compare',
      comparator: 'gt',
      left: { kind: 'fact', factId: 'verification_residuals' },
      right: { kind: 'constant', value: 0 },
    });
    delete (nullable as { appliesTo?: unknown }).appliesTo;
    rejected(add(nullable), 'unscoped_artifact_rule');
    rejected(add({ ...receipt, appliesTo: [] }), 'unscoped_artifact_rule');
    // A rule over a fact that always exists may apply to every call.
    const always = rule({
      predicate: {
        op: 'compare',
        comparator: 'gt',
        left: { kind: 'fact', factId: 'retry_count' },
        right: { kind: 'constant', value: 3 },
      },
    });
    delete (always as { appliesTo?: unknown }).appliesTo;
    const corpus = context({
      replayCorpus: [
        ledgerRow('retried', 'apply_cleanup_batch', { retry_count: 5 }),
        ledgerRow('fresh', 'apply_cleanup_batch', { retry_count: 0 }),
      ],
    });
    expect(add(always, corpus).ok).toBe(true);
  });
  it('appliesTo entries outside the tool vocabulary or repeated are refused', () => {
    rejected(add(rule({ appliesTo: ['apply_cleanup_batch', 'drop_database'] })), 'applies_to_unknown_tool');
    rejected(add(rule({ appliesTo: ['complete_cleanup', 'complete_cleanup'] })), 'applies_to_duplicate');
  });
});

describe('rejections: no-op rules (a rule whose removal changes no replayed decision)', () => {
  const parent = w0();
  const add = (rule: GuardrailAst, ctx = withCorpus()) =>
    compileChild(parent, [patch(`guardrails.${rule.ruleId}`, 'guardrails', null, rule)], ctx);
  it('a rule that never fires on the corpus is a no-op', () => {
    const never: GuardrailAst = {
      ...SCOPED_RULE,
      ruleId: 'deny_when_retry_huge',
      predicate: {
        op: 'compare',
        comparator: 'gt',
        left: { kind: 'fact', factId: 'retry_count' },
        right: { kind: 'constant', value: 100 },
      },
    };
    rejected(add(never), 'no_op_rule', 'standing');
  });
  it('a rule shadowed by a stronger one already in the candidate changes nothing', () => {
    const both = structuredClone(parent);
    both.guardrails = [{ ...VERIFY_RULE, ruleId: 'deny_complete_first' }];
    const second: GuardrailAst = { ...VERIFY_RULE, ruleId: 'deny_complete_second' };
    const added = {
      ...both,
      guardrails: [...both.guardrails, second],
      parentHash: contentHash(both),
      evidence: [EVIDENCE_REFERENCE],
    };
    const edit = patch('guardrails.deny_complete_second', 'guardrails', null, second);
    rejected(
      compileHarness({ candidate: added, parent: both, patches: [edit] }, { ...withCorpus() }),
      'no_op_rule',
    );
  });
  it('changed rules need a replay corpus and cited evidence', () => {
    rejected(add(VERIFY_RULE, context()), 'replay_corpus_missing', 'standing');
    rejected(add({ ...VERIFY_RULE, sourceEvidenceIds: [] }), 'evidence_missing');
    rejected(add({ ...VERIFY_RULE, sourceEvidenceIds: ['evt_unknown'] }), 'evidence_not_found');
  });
  it('a rule that flips a recorded decision has standing', () => {
    expect(add(VERIFY_RULE).ok).toBe(true);
  });
});

describe('rejections: workflow', () => {
  const parent = w0();
  const edit = (mutate: (graph: WorkflowGraph) => void, extra: Partial<HarnessBundle> = {}) => {
    const graph = structuredClone(parent.workflow);
    mutate(graph);
    return compileChild(parent, [patch('workflow', 'workflow', parent.workflow, graph)], context(), extra);
  };
  it('unknown, ungranted and forbidden tools or routes', () => {
    rejected(
      edit((g) => void (g.nodes[0]!.toolId = 'drop_database')),
      'unknown_tool',
      'structure',
    );
    rejected(
      edit(
        (g) =>
          void (g.nodes.splice(5, 0, {
            id: 'verify',
            toolId: 'verify_registered_scope',
            inputBindings: {},
            maxVisits: 1,
          }),
          g.edges.push({ from: 'apply', to: 'verify', when: 'needs_approval' }),
          g.edges.push({ from: 'verify', to: 'complete', when: 'success' })),
      ),
      'workflow_tool_not_granted',
    );
    rejected(
      edit(
        (g) =>
          void ((g.nodes[1]!.id = 'grader_probe'),
          (g.edges[0]!.to = 'grader_probe'),
          (g.edges[1]!.from = 'grader_probe'),
          (g.entryNodeId = 'inspect')),
      ),
      'workflow_forbidden_route',
    );
    rejected(
      edit((g) => void (g.nodes[2]!.inputBindings = { verdict: 'promoter.output' })),
      'workflow_forbidden_route',
    );
    rejected(
      edit((g) => void (g.nodes[2]!.inputBindings = { subject: 'ghost.output' })),
      'workflow_input_binding_invalid',
    );
    rejected(
      edit((g) => void (g.nodes[2]!.inputBindings = { subject: 'resolve' })),
      'workflow_input_binding_invalid',
    );
  });
  it('malformed graphs: unreachable node, unreachable terminal, dead end, ambiguous transition', () => {
    rejected(
      edit(
        (g) =>
          void g.nodes.push({ id: 'orphan', toolId: 'report_diagnostic', inputBindings: {}, maxVisits: 1 }),
      ),
      'workflow_unreachable_node',
    );
    rejected(
      edit((g) => void (g.edges = g.edges.filter((e) => !(e.from === 'apply' && e.to === 'complete')))),
      'workflow_terminal_unreachable',
    );
    rejected(
      edit((g) => void (g.edges = g.edges.filter((e) => e.from !== 'preview'))),
      'workflow_dead_end',
    );
    rejected(
      edit(
        (g) =>
          void g.edges.push(
            { from: 'apply', to: 'complete', when: 'retryable_error' },
            { from: 'apply', to: 'discover', when: 'retryable_error' },
          ),
      ),
      'workflow_duplicate_transition',
    );
  });
  it('a cycle whose node declares too many visits is an unbounded loop', () => {
    rejected(
      edit((g) => void (g.nodes.find((n) => n.id === 'apply')!.maxVisits = 20)),
      'workflow_unbounded_loop',
    );
    rejected(
      edit(
        (g) =>
          void (g.edges.push({ from: 'complete', to: 'inspect', when: 'verification_failed' }),
          g.nodes.forEach((n) => (n.maxVisits = 9))),
      ),
      'workflow_unbounded_loop',
    );
  });
  it('summed maxVisits above limits.toolCalls and graphs above the declared size limits are refused', () => {
    rejected(
      edit((g) => void (g.nodes.find((n) => n.id === 'apply')!.maxVisits = 8)),
      'workflow_visit_budget',
    );
    const small = patch('limits.graphNodes', 'tool_policy', 16, 4);
    rejected(compileChild(parent, [small]), 'workflow_graph_limit');
  });
});

describe('rejections: tool policy and limits', () => {
  const parent = w0();
  it('grants outside the owner floor, duplicate grants and unknown tools', () => {
    const narrow = context({
      floor: { ...TEST_FLOOR, allowedTools: WORKER_TOOL_IDS.filter((tool) => tool !== 'report_diagnostic') },
    });
    rejected(compileHarness({ candidate: w0(), parent: null }, narrow), 'floor_violation', 'structure');
    const grants = { ...parent.toolPolicy, grants: [...parent.toolPolicy.grants, 'inspect_scope'] };
    rejected(
      compileChild(parent, [
        patch('toolPolicy.grants', 'tool_policy', parent.toolPolicy.grants, grants.grants),
      ]),
      'duplicate_grant',
    );
    rejected(
      compileChild(parent, [
        patch('toolPolicy.grants', 'tool_policy', parent.toolPolicy.grants, [
          ...parent.toolPolicy.grants,
          'exfiltrate',
        ]),
      ]),
      'unknown_tool',
    );
  });
  it('prerequisites that deadlock, cannot be satisfied by the workflow, or repeat', () => {
    const base = parent.toolPolicy.prerequisites;
    const prerequisite = (
      toolId: string,
      requiredArtifact: 'preview_plan' | 'action_receipt' | 'completion_receipt' | 'approval_grant',
    ) => ({ toolId, requiredArtifact, binding: 'same_job_same_plan_current_revision' as const });
    const change = (extra: ReturnType<typeof prerequisite>[]) =>
      compileChild(parent, [patch('toolPolicy.prerequisites', 'tool_policy', base, [...base, ...extra])]);
    rejected(change([prerequisite('preview_cleanup', 'preview_plan')]), 'prerequisite_deadlock');
    rejected(change([prerequisite('complete_cleanup', 'completion_receipt')]), 'prerequisite_unsatisfiable');
    rejected(change([prerequisite('apply_cleanup_batch', 'preview_plan')]), 'duplicate_prerequisite');
  });
  it('limits above the owner maxima, degenerate limits and a context larger than its limits', () => {
    rejected(
      compileChild(parent, [patch('limits.modelCalls', 'tool_policy', 12, 13)]),
      'limits_exceed_owner',
    );
    rejected(
      compileChild(parent, [patch('limits.maxCostMicrousd', 'tool_policy', 100000, 100001)]),
      'limits_exceed_owner',
    );
    rejected(compileChild(parent, [patch('limits.modelCalls', 'tool_policy', 12, 0)]), 'limits_degenerate');
    rejected(
      compileChild(parent, [patch('contextPolicy.referenceDepth', 'context', 1, 4)]),
      'context_exceeds_limits',
    );
  });
});

describe('rejections: plugins', () => {
  const parent = w0();
  const binding = {
    slot: 'context',
    sourceHash: 'a'.repeat(64),
    compiledHash: 'b'.repeat(64),
    abiHash: 'c'.repeat(64),
    sandboxProfileHash: 'd'.repeat(64),
    exportName: 'select_fields',
    inputSchemaHash: 'e'.repeat(64),
    outputSchemaHash: 'f'.repeat(64),
  } as const;
  const edit = patch('pluginArtifacts', 'plugin', [], [binding]);
  const policy = (
    attest: { sourceVerified: boolean; compiledVerified: boolean; compiledFromSource: boolean },
    abiHash = binding.abiHash,
  ) =>
    context({ plugins: { abiHash, sandboxProfileHash: binding.sandboxProfileHash, attest: () => attest } });
  it('source and compiled hashes must both verify and pair', () => {
    rejected(
      compileChild(
        parent,
        [edit],
        policy({ sourceVerified: true, compiledVerified: true, compiledFromSource: false }),
      ),
      'plugin_source_compiled_mismatch',
    );
    rejected(
      compileChild(
        parent,
        [edit],
        policy({ sourceVerified: false, compiledVerified: true, compiledFromSource: true }),
      ),
      'plugin_unverifiable',
    );
    rejected(
      compileChild(
        parent,
        [edit],
        policy({ sourceVerified: true, compiledVerified: false, compiledFromSource: true }),
      ),
      'plugin_unverifiable',
    );
    rejected(
      compileChild(
        parent,
        [edit],
        policy({ sourceVerified: true, compiledVerified: true, compiledFromSource: true }, '0'.repeat(64)),
      ),
      'plugin_abi_mismatch',
    );
    rejected(compileChild(parent, [edit]), 'plugin_unverifiable');
  });
});

describe('the compiler hashes', () => {
  it('compilerHash and vocabularyHash are commitments to actual source bytes, not version labels', async () => {
    const { readFileSync } = await import('node:fs');
    const files = [
      'classify.ts',
      'compile.ts',
      'decisions.ts',
      'guardrails.ts',
      'hashes.ts',
      'issues.ts',
      'literals.ts',
      'mongo-eval.ts',
      'mongo.ts',
      'noop.ts',
      'patches.ts',
      'plugins.ts',
      'policy.ts',
      'semantics.ts',
      'source.ts',
      'vocabulary.ts',
      'workflow.ts',
      '../../contracts/src/index.ts',
    ].sort();
    const sources = files.map((moduleId) => ({
      moduleId,
      source: readFileSync(new URL(`../src/${moduleId}`, import.meta.url), 'utf8'),
    }));
    expect(COMPILER_HASH).toBe(
      contentHash(
        { sources: contentHash({ sources }, 'harness-compiler-source'), vocabularyHash: VOCABULARY_HASH },
        'harness-compiler',
      ),
    );
    const changed = sources.map((entry, index) =>
      index === 0 ? { ...entry, source: `${entry.source}\n// edit` } : entry,
    );
    expect(contentHash({ sources: changed }, 'harness-compiler-source')).not.toBe(
      contentHash({ sources }, 'harness-compiler-source'),
    );
  });
});
