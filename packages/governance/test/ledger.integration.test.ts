import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildExpertStaticBundle } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import type { ActionIntent, HarnessBundle } from '@expunge/contracts';
import {
  ArtifactRepository,
  AuthorityRepository,
  DecisionRepository,
  EffectRepository,
  JobRepository,
  deriveArgsDigest,
  deriveDecisionId,
  deriveEffectKey,
  deriveTargetHash,
  type MongoService,
} from '@expunge/mongo';
import {
  HASH,
  actor,
  createJob,
  describeLive,
  openEnvironment,
  recordDecisionFor,
  type LiveEnvironment,
} from '../../mongo/test/support.js';
import {
  DEFAULT_AUTHORITY_FLOOR,
  DecisionLedger,
  PolicyEvaluator,
  liveFloorValidator,
  toolArgsDigest,
  type JobSnapshot,
} from '../src/index.js';

const bundleFor = (authorityFloorHash: string): HarnessBundle =>
  buildExpertStaticBundle({
    runtimeAdapterHash: HASH,
    compilerHash: COMPILER_HASH,
    vocabularyHash: VOCABULARY_HASH,
    authorityFloorHash,
    eligibilityPolicyHash: HASH,
    sourceEligibilityPolicyHash: HASH,
  });
const bundle = () => bundleFor(DEFAULT_AUTHORITY_FLOOR.hash);
const snapshot: JobSnapshot = {
  toolId: 'inspect_scope',
  worldRevision: 0,
  plan: null,
  batch: null,
  discovery: null,
  arrayFieldsRegistered: null,
  arrayFieldsInspected: null,
  verification: null,
  completionReceiptCommitted: false,
  priorEffects: {},
  priorCalls: 1,
};

describeLive('governance against a real replica set: ledger rows and the live floor fence', () => {
  let env: LiveEnvironment;
  let executor: MongoService;
  let jobs: JobRepository;
  let effects: EffectRepository;

  beforeAll(async () => {
    env = await openEnvironment('governance');
    executor = await env.as('domain_executor');
    jobs = new JobRepository(executor);
    effects = new EffectRepository(executor);
  }, 30000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  it('records a decision before the action with the inputs the guardrails saw, and lists it back', async () => {
    const id = await createJob(env.service);
    const verdict = new PolicyEvaluator(bundle(), DEFAULT_AUTHORITY_FLOOR).decide(
      snapshot,
      actor.authorizationRevision,
      DEFAULT_AUTHORITY_FLOOR.hash,
    );
    const ledger = new DecisionLedger(
      new DecisionRepository(executor),
      () => new Date('2026-10-11T10:00:00.000Z'),
    );
    const call = {
      jobId: id,
      runId: `run-${id}`,
      harnessHash: HASH,
      toolId: 'inspect_scope',
      stepId: 'inspect_scope',
      batchOrdinal: 1,
      argsDigest: toolArgsDigest('inspect_scope', {}),
    };
    const row = await ledger.record(actor, call, verdict);
    expect(row).toMatchObject({ toolId: 'inspect_scope', decision: { result: 'allow' } });
    expect(row.inputs?.facts.plan_target_count).toBeNull();
    expect(row.inputs?.observedAt?.['facts.plan_target_count']).toBe('2026-10-11T10:00:00.000Z');
    expect((await ledger.record(actor, call, verdict)).decisionId).toBe(row.decisionId);
    const listed = await ledger.list(actor, id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.inputsDigest).toBe(row.inputsDigest);
  });

  /** An effect intent for a job pinned to `harnessHash`, with every identity field derived as the repository derives it. */
  function intentPinnedTo(jobId: string, harnessHash: string, batchOrdinal: number): ActionIntent {
    const base = {
      jobId,
      runId: `run-${jobId}`,
      harnessHash,
      stepId: 'delete',
      approvedPlanHash: HASH,
      batchOrdinal,
      targetAddresses: [],
      effectKind: 'delete' as const,
    };
    const argsDigest = deriveArgsDigest(base);
    const policyDecision = { result: 'allow' as const, ruleIds: [], authorizationRevision: 1 };
    return {
      intentId: `intent-${jobId}-${batchOrdinal}`,
      ...base,
      targetHash: deriveTargetHash(base.targetAddresses),
      expectedDocumentVersions: [],
      worldRevision: batchOrdinal,
      policyDecision,
      effectKey: deriveEffectKey(base),
      argsDigest,
      decisionId: deriveDecisionId({ ...base, argsDigest, policyDecision }),
    };
  }
  /** Stores a pinned bundle as a permitted artifact and returns the hash a job can be pinned to. */
  async function pinnedBundle(authorityFloorHash: string): Promise<string> {
    const envelope = await new ArtifactRepository(env.service).insert(bundleFor(authorityFloorHash));
    await env.service.control.collection('artifact_eligibility').insertOne({
      tenantId: actor.tenantId,
      env: actor.env,
      scopeId: actor.scopeId,
      artifactHash: envelope._id,
      state: 'permitted',
      policyHash: HASH,
      reasonCode: 'source_retracted',
      sourceIds: [],
      updatedAt: new Date(),
    } as never);
    return envelope._id;
  }
  const validatorFor = (jobId: string) =>
    liveFloorValidator(
      {
        authority: new AuthorityRepository(executor),
        jobs: new JobRepository(executor),
        artifacts: new ArtifactRepository(executor),
      },
      actor,
      jobId,
    );

  it('G4: denies the next effect of a run pinned to a floor the store no longer holds, judged by the stored bundle', async () => {
    const pinned = await pinnedBundle(HASH); // the installed floor is HASH
    const id = await createJob(env.service, { harnessHash: pinned });
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    const validate = validatorFor(id);
    const first = intentPinnedTo(id, pinned, 0);
    await recordDecisionFor(env.service, first);
    await effects.commitEffect({ actor, lease, intent: first, apply: async () => [], validate });

    // The stored floor changes without an authorization bump (defense in depth: the fence checks identity too).
    await env.service.control
      .collection('authority_revisions')
      .updateOne({ tenantId: actor.tenantId }, { $set: { floorHash: 'b'.repeat(64) } });
    const second = intentPinnedTo(id, pinned, 1);
    await recordDecisionFor(env.service, second);
    await expect(
      effects.commitEffect({ actor, lease, intent: second, apply: async () => [], validate }),
    ).rejects.toThrow('AuthorityFloorMismatch');
    expect(await env.service.control.collection('effects').countDocuments()).toBe(1);
  });

  it('G4: the caller cannot choose the bundle: a run pinned to another floor is judged by its own pinned bundle', async () => {
    // Stored floor is HASH. A job pinned to a bundle that names 'b...' fails even though a caller who passed the
    // stored floor's bundle (the old API) would have made the same commit succeed.
    const other = await pinnedBundle('b'.repeat(64));
    const id = await createJob(env.service, { harnessHash: other });
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    const attempt = intentPinnedTo(id, other, 0);
    await recordDecisionFor(env.service, attempt);
    await expect(
      effects.commitEffect({
        actor,
        lease,
        intent: attempt,
        apply: async () => [],
        validate: validatorFor(id),
      }),
    ).rejects.toThrow('AuthorityFloorMismatch');
    expect(await env.service.control.collection('effects').countDocuments()).toBe(0);
  });

  it('G4: a run pinned to an artifact that is not permitted cannot commit an effect', async () => {
    const envelope = await new ArtifactRepository(env.service).insert(bundleFor(HASH));
    const id = await createJob(env.service, { harnessHash: envelope._id });
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    const attempt = intentPinnedTo(id, envelope._id, 0);
    await recordDecisionFor(env.service, attempt);
    await expect(
      effects.commitEffect({
        actor,
        lease,
        intent: attempt,
        apply: async () => [],
        validate: validatorFor(id),
      }),
    ).rejects.toThrow('ArtifactIneligible');
  });
});
