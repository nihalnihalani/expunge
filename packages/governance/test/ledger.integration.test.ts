import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildExpertStaticBundle } from '@expunge/baselines';
import { COMPILER_HASH, VOCABULARY_HASH } from '@expunge/harness-compiler';
import {
  AuthorityRepository,
  DecisionRepository,
  EffectRepository,
  JobRepository,
  type MongoService,
} from '@expunge/mongo';
import {
  HASH,
  actor,
  createJob,
  describeLive,
  intent,
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

const bundle = () =>
  buildExpertStaticBundle({
    runtimeAdapterHash: HASH,
    compilerHash: COMPILER_HASH,
    vocabularyHash: VOCABULARY_HASH,
    authorityFloorHash: HASH,
    eligibilityPolicyHash: HASH,
    sourceEligibilityPolicyHash: HASH,
  });
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

  it('denies the next effect of a pinned run once the stored owner floor differs from the one it is pinned to', async () => {
    const id = await createJob(env.service);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    const validate = liveFloorValidator(new AuthorityRepository(executor), actor, {
      authorityFloorHash: HASH,
    });
    const first = intent(id, { batchOrdinal: 0 });
    await recordDecisionFor(env.service, first);
    await effects.commitEffect({ actor, lease, intent: first, apply: async () => [], validate });

    // The stored floor changes without an authorization bump (defense in depth: the fence checks identity too).
    await env.service.control
      .collection('authority_revisions')
      .updateOne({ tenantId: actor.tenantId }, { $set: { floorHash: 'b'.repeat(64) } });
    const second = intent(id, { batchOrdinal: 1, worldRevision: 1 });
    await recordDecisionFor(env.service, second);
    await expect(
      effects.commitEffect({ actor, lease, intent: second, apply: async () => [], validate }),
    ).rejects.toThrow('AuthorityFloorMismatch');
    expect(await env.service.control.collection('effects').countDocuments()).toBe(1);

    // A run pinned to the new floor passes the same fence.
    await expect(
      effects.commitEffect({
        actor,
        lease,
        intent: second,
        apply: async () => [],
        validate: liveFloorValidator(new AuthorityRepository(executor), actor, {
          authorityFloorHash: 'b'.repeat(64),
        }),
      }),
    ).resolves.toMatchObject({ status: 'committed' });
  });
});
