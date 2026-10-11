// TEST-ONLY helpers: labelled test infrastructure hashes, a test owner floor and ready-made bundles.
import {
  OWNER_EPISODE_LIMITS,
  WORKER_TOOL_IDS,
  buildExpertStaticBundle,
  buildW0Bundle,
  type InfrastructureHashes,
} from '@expunge/baselines';
import {
  contentHash,
  type EvidenceBundle,
  type GuardrailAst,
  type HarnessBundle,
  type TypedPatch,
} from '@expunge/contracts';
import {
  COMPILER_HASH,
  VOCABULARY_HASH,
  applyPatches,
  buildEvidenceCatalog,
  compileHarness,
  type CompileContext,
  type DecisionLedgerRow,
  type OwnerFloor,
} from '../src/index.js';

export const TEST_FLOOR: OwnerFloor = {
  hash: contentHash({ test: 'owner-floor' }, 'test-fixture'),
  allowedTools: WORKER_TOOL_IDS,
  maxLimits: OWNER_EPISODE_LIMITS,
};
export const TEST_INFRA: InfrastructureHashes = {
  runtimeAdapterHash: contentHash({ test: 'runtime' }, 'test-fixture'),
  compilerHash: COMPILER_HASH,
  vocabularyHash: VOCABULARY_HASH,
  authorityFloorHash: TEST_FLOOR.hash,
  eligibilityPolicyHash: contentHash({ test: 'eligibility' }, 'test-fixture'),
  sourceEligibilityPolicyHash: contentHash({ test: 'source-eligibility' }, 'test-fixture'),
};
export const w0 = (): HarnessBundle => buildW0Bundle(TEST_INFRA);
export const expert = (): HarnessBundle => buildExpertStaticBundle(TEST_INFRA);

/** The public registry of a fixture world: six collections and the field IDs every world declares. */
export const TEST_REGISTRY = {
  collectionIds: ['customers', 'accounts', 'messages', 'events', 'notes', 'archives'],
  fieldIds: [
    ...['customers', 'accounts', 'messages', 'events', 'notes', 'archives'].flatMap((collection) => [
      `${collection}.record_id`,
      `${collection}.identity_binding`,
      `${collection}.record_reference`,
      `${collection}.private_payload`,
    ]),
    'customers.aliases',
    'customers.identity_email',
  ],
};

/** A labelled training-split evidence bundle. IDs are synthetic; the tool trace mentions a synthetic subject. */
export function evidenceBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    evidenceId: 'evb_train_001',
    actor: {
      tenantId: 'synthetic-evaluation-tenant',
      env: 'evaluation',
      scopeId: 'synthetic-evaluation-scope',
    },
    binding: {
      jobId: 'job_1',
      runId: 'run_1',
      worldId: 'world_1',
      harnessHash: 'a'.repeat(64),
      scopeRevision: 1,
      workerProfileHash: 'b'.repeat(64),
    },
    tools: [
      {
        toolId: 'discover_references',
        input: { subject: 'syn_subject_0123456789abcdef0123' },
        output: { frontier: 0 },
        decision: { result: 'allow', ruleIds: [], authorizationRevision: 1 },
      },
    ],
    failureWitnesses: [{ missed: 'nested array copy under messages' }],
    diagnostics: [],
    modelOutput: 'All records for syn_subject_0123456789abcdef0123 have been removed.',
    sources: [
      {
        provider: 'raindrop',
        externalEventId: 'evt_01',
        externalTraceId: 'trace_01',
        externalSignalIds: ['sig_miss_nested'],
        localSourceIds: ['src_local_01'],
        origin: 'verifier_feedback',
        redactionPolicy: 'structural',
        retrievedAt: '2026-10-11T10:00:00.000Z',
        contentHash: 'c'.repeat(64),
        permittedUse: 'training',
      },
    ],
    cost: {
      modelCalls: 3,
      toolCalls: 6,
      inputTokens: 1000,
      outputTokens: 300,
      costMicrousd: 400,
      unpricedCalls: 0,
      mongoOperations: 40,
      wallTimeMs: 4000,
    },
    confidence: 0.9,
    split: 'train',
    ...overrides,
  };
}

export function context(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    expected: {
      runtimeAdapterHash: TEST_INFRA.runtimeAdapterHash,
      eligibilityPolicyHash: TEST_INFRA.eligibilityPolicyHash,
      sourceEligibilityPolicyHash: TEST_INFRA.sourceEligibilityPolicyHash,
    },
    floor: TEST_FLOOR,
    registry: TEST_REGISTRY,
    forbidden: { subject: ['syn_subject_0123456789abcdef0123'], task: [] },
    evidence: buildEvidenceCatalog([evidenceBundle()]),
    ...overrides,
  };
}

/** An evidence reference whose identifiers match `evidenceBundle()`. */
export const EVIDENCE_REFERENCE = evidenceBundle().sources[0]!;

/** Build a candidate from a parent and patches the way the evolver does: apply, link, append evidence. */
export function childOf(
  parent: HarnessBundle,
  patches: TypedPatch[],
  extra: Partial<HarnessBundle> = {},
): HarnessBundle {
  const child = applyPatches(parent, patches);
  child.parentHash = contentHash(parent);
  child.evidence = [...parent.evidence, EVIDENCE_REFERENCE];
  return { ...child, ...extra };
}
export function patch(
  path: string,
  surface: TypedPatch['surface'],
  before: unknown,
  after: unknown,
  hypothesis = 'The nested array copy was missed because discovery stopped at one hop.',
): TypedPatch {
  return {
    surface,
    path,
    before: before as TypedPatch['before'],
    after: after as TypedPatch['after'],
    sourceEvidenceIds: ['evt_01'],
    hypothesis,
  };
}
export function compileChild(
  parent: HarnessBundle,
  patches: TypedPatch[],
  ctx: CompileContext = context(),
  extra: Partial<HarnessBundle> = {},
) {
  const candidate = childOf(parent, patches, extra);
  return compileHarness({ candidate, parent, patches }, ctx);
}

/** A rule that denies apply when the plan is not valid; scoped, with evidence. */
export const SCOPED_RULE: GuardrailAst = {
  ruleId: 'deny_apply_when_world_stale',
  predicate: {
    op: 'compare',
    comparator: 'eq',
    left: { kind: 'fact', factId: 'world_revision_fresh' },
    right: { kind: 'constant', value: false },
  },
  result: 'deny',
  sourceEvidenceIds: ['evt_01'],
  appliesTo: ['apply_cleanup_batch'],
};

/** Labelled fixture ledger rows (not B1 output): the pre-apply decisions of two recorded runs. */
export function ledgerRow(
  id: string,
  toolId: string,
  facts: Record<string, unknown>,
  extra: Partial<DecisionLedgerRow> = {},
): DecisionLedgerRow {
  return {
    decisionId: `dec_${id}`,
    jobId: 'job_1',
    runId: 'run_1',
    harnessHash: 'a'.repeat(64),
    stepId: `step_${id}`,
    batchOrdinal: 0,
    argsDigest: 'd'.repeat(64),
    decision: { result: 'allow', ruleIds: [], authorizationRevision: 1 },
    decidedAt: '2026-10-11T10:00:00.000Z',
    toolId,
    inputs: { facts, bindings: { preview_plan: 'valid' }, prior: {} },
    ...extra,
  };
}
