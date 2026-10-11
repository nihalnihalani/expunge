import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { scopeIdentity } from '@expunge/contracts';
import {
  AuthorityRepository,
  DecisionRepository,
  EffectRepository,
  JobRepository,
  WorldRepository,
  deriveDecisionId,
  seedOptionsFromEnv,
  setupMongo,
  type MongoService,
} from '../src/index.js';
import {
  HASH,
  actor,
  completionReceipt,
  createJob,
  describeLive,
  insertRegistry,
  intent,
  openEnvironment,
  recordDecisionFor,
  type LiveEnvironment,
} from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

describeLive('D8 live authorization, D13 world split, K6 world binding (real replica set)', () => {
  let env: LiveEnvironment;
  let executor: MongoService;
  let effects: EffectRepository;
  let jobs: JobRepository;
  let authority: AuthorityRepository;
  let worlds: WorldRepository;

  beforeAll(async () => {
    env = await openEnvironment('authority');
    executor = await env.as('domain_executor');
    effects = new EffectRepository(executor);
    jobs = new JobRepository(executor);
    authority = new AuthorityRepository(env.service);
    worlds = new WorldRepository(env.service);
  }, 30000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30000);

  const claim = async (id: string) => {
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    return { jobId: id, ownerId: 'worker', fence: job.lease.fence };
  };
  const control = (name: string) => env.service.control.collection<Document>(name);

  describe('D8: the stored authorization revision is checked inside every authority-bearing transaction', () => {
    it('denies the next effect of a pinned run after the stored revision is bumped mid-run', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      const first = intent(id, { batchOrdinal: 0 });
      const second = intent(id, { batchOrdinal: 1, worldRevision: 1 });
      await recordDecisionFor(env.service, first);
      await recordDecisionFor(env.service, second); // decided honestly before the owner revoked
      expect(
        (await effects.commitEffect({ actor, lease, intent: first, apply: async () => [] })).status,
      ).toBe('committed');

      await new AuthorityRepository(await env.as('approval_issuer')).bump(scope);
      await expect(
        effects.commitEffect({ actor, lease, intent: second, apply: async () => [] }),
      ).rejects.toThrow('AuthorityRevisionStale');
      expect(await control('effects').countDocuments()).toBe(1);
      expect(
        await env.service.world.collection('world_revisions').findOne({ _id: `world-${id}` as never }),
      ).toHaveProperty('revision', 1);
    });

    it('lets a gateway on a stale run neither record a decision nor complete', async () => {
      const id = await createJob(env.service);
      await insertRegistry(env.service);
      const lease = await claim(id);
      await authority.bump(scope);
      await expect(recordDecisionFor(executor, intent(id))).rejects.toThrow('AuthorityRevisionStale');
      await expect(effects.complete(actor, lease, completionReceipt(id))).rejects.toThrow(
        'AuthorityRevisionStale',
      );
      expect((await jobs.readAuthorized(actor, id)).status).toBe('running');
    });

    it('fails closed when the scope has no stored authority', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      const action = intent(id);
      await recordDecisionFor(env.service, action);
      await control('authority_revisions').deleteMany({});
      await expect(
        effects.commitEffect({ actor, lease, intent: action, apply: async () => [] }),
      ).rejects.toThrow('AuthorityMissing');
    });

    it('aborts a transaction whose authority read went stale before it committed (snapshot cannot commit)', async () => {
      const session = executor.client.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        // Fix the snapshot, then let the owner revoke, then try to use the old revision.
        await executor.control.collection('artifacts').findOne({}, { session });
        await authority.bump(scope);
        await expect(new AuthorityRepository(executor).fence(scope, 1, session)).rejects.toMatchObject({
          code: 112,
        });
      } finally {
        await session.endSession();
      }
      expect((await authority.read(scope)).authorizationRevision).toBe(2);
    });

    it('keeps the authoritative row writable only through install and bump by the owner principals', async () => {
      await expect(new AuthorityRepository(executor).bump(scope)).rejects.toThrow('PrincipalBoundary');
      await expect(new AuthorityRepository(await env.as('promoter')).bump(scope)).rejects.toThrow(
        'PrincipalBoundary',
      );
      await expect(new AuthorityRepository(executor).install(scope, HASH)).rejects.toThrow(
        'PrincipalBoundary',
      );
      expect(await authority.install(scope, HASH)).toMatchObject({
        authorizationRevision: 1,
        floorHash: HASH,
      });
      await expect(authority.install(scope, 'b'.repeat(64))).rejects.toThrow('AuthorityConflict');
      const bumped = await authority.bump(scope, 'b'.repeat(64));
      expect(bumped).toMatchObject({ authorizationRevision: 2, floorHash: 'b'.repeat(64) });
      expect(
        await control('authority_touches').findOne({ _id: scopeIdentity(scope) as never }),
      ).toMatchObject({
        authorizationRevision: 2,
        touches: 1,
      });
    });
  });

  describe('D8: an intent cannot assert an allow decision that the ledger does not hold', () => {
    async function setup() {
      const id = await createJob(env.service);
      const lease = await claim(id);
      return { id, lease };
    }
    const commit = (lease: Awaited<ReturnType<typeof claim>>, action: ReturnType<typeof intent>) =>
      effects.commitEffect({ actor, lease, intent: action, apply: async () => [] });

    it('refuses an intent with no ledger row', async () => {
      const { id, lease } = await setup();
      await expect(commit(lease, intent(id))).rejects.toThrow('DecisionNotFound');
      expect(await control('effects').countDocuments()).toBe(0);
    });

    it('refuses a decision id that is not the digest of the intent it travels with', async () => {
      const { id, lease } = await setup();
      const action = intent(id);
      await recordDecisionFor(env.service, action);
      await expect(commit(lease, { ...action, decisionId: HASH })).rejects.toThrow('DecisionMismatch');
      // A real row for a different batch cannot be borrowed.
      const other = intent(id, { batchOrdinal: 1 });
      await recordDecisionFor(env.service, other);
      await expect(commit(lease, { ...action, decisionId: other.decisionId })).rejects.toThrow(
        'DecisionMismatch',
      );
    });

    it('refuses an intent whose claimed decision differs from the recorded one', async () => {
      const { id, lease } = await setup();
      const action = intent(id);
      // The ledger holds a deny under the id an allow would use (as a tampering raw-driver write might).
      await control('decisions').insertOne({
        _id: action.decisionId as never,
        ...scope,
        decisionId: action.decisionId,
        jobId: id,
        runId: action.runId,
        harnessHash: action.harnessHash,
        stepId: action.stepId,
        batchOrdinal: action.batchOrdinal,
        argsDigest: action.argsDigest,
        decision: { result: 'deny', ruleIds: ['r'], authorizationRevision: 1 },
        decidedAt: new Date(),
      });
      await expect(commit(lease, action)).rejects.toThrow('DecisionMismatch');
    });

    it('refuses a ledger row from another scope', async () => {
      const { id, lease } = await setup();
      const action = intent(id);
      await control('decisions').insertOne({
        _id: action.decisionId as never,
        ...scope,
        tenantId: 'other-tenant',
        decisionId: action.decisionId,
        jobId: id,
        runId: action.runId,
        harnessHash: action.harnessHash,
        stepId: action.stepId,
        batchOrdinal: action.batchOrdinal,
        argsDigest: action.argsDigest,
        decision: action.policyDecision,
        decidedAt: new Date(),
      });
      await expect(commit(lease, action)).rejects.toThrow('DecisionMismatch');
    });

    it('records a decision once per action and only for a worker principal of the job kind', async () => {
      const { id } = await setup();
      const action = intent(id);
      const record = () =>
        new DecisionRepository(executor).record(
          actor,
          {
            jobId: id,
            runId: action.runId,
            harnessHash: action.harnessHash,
            stepId: action.stepId,
            batchOrdinal: action.batchOrdinal,
            argsDigest: action.argsDigest,
          },
          action.policyDecision,
        );
      const first = await record();
      expect(first.decisionId).toBe(deriveDecisionId(action));
      await record();
      expect(await control('decisions').countDocuments()).toBe(1);
      await expect(
        new DecisionRepository(await env.as('grader')).record(
          actor,
          {
            jobId: id,
            runId: action.runId,
            harnessHash: action.harnessHash,
            stepId: 's',
            batchOrdinal: 0,
            argsDigest: HASH,
          },
          action.policyDecision,
        ),
      ).rejects.toThrow('PrincipalBoundary');
    });
  });

  describe('decision ledger rows carry the tool and the inputs the gateway used', () => {
    it('records toolId and bounded inputs with a digest, lists them in time order, and stays idempotent', async () => {
      const id = await createJob(env.service);
      const repository = new DecisionRepository(executor);
      const identity = (stepId: string, ordinal = 0) => ({
        jobId: id,
        runId: `run-${id}`,
        harnessHash: HASH,
        stepId,
        batchOrdinal: ordinal,
        argsDigest: HASH,
      });
      const decision = { result: 'allow' as const, ruleIds: [], authorizationRevision: 1 };
      const inputs = { facts: { plan_target_count: 3 }, bindings: { preview_plan: 'valid' }, prior: {} };
      const first = await repository.record(actor, identity('step-a'), decision, {
        toolId: 'apply_cleanup_batch',
        inputs,
      });
      expect(first).toMatchObject({ toolId: 'apply_cleanup_batch', inputs });
      expect(first.inputsDigest).toMatch(/^[a-f0-9]{64}$/);
      await repository.record(actor, identity('step-a'), decision, { toolId: 'apply_cleanup_batch', inputs });
      await repository.record(actor, identity('step-b'), { ...decision, result: 'deny', ruleIds: ['r1'] });
      const listed = await repository.list(actor, id);
      expect(listed.map((row) => row.stepId)).toEqual(['step-a', 'step-b']);
      expect(listed[1]).not.toHaveProperty('inputs');
      await expect(repository.list(actor, id, 0)).rejects.toThrow('InvalidDecisionWindow');
    });

    it('G6: a repeated record returns the stored row, so different inputs under the same identity cannot masquerade', async () => {
      const id = await createJob(env.service);
      const repository = new DecisionRepository(executor);
      const identity = {
        jobId: id,
        runId: `run-${id}`,
        harnessHash: HASH,
        stepId: 'step-a',
        batchOrdinal: 0,
        argsDigest: HASH,
      };
      const decision = { result: 'allow' as const, ruleIds: [], authorizationRevision: 1 };
      const firstInputs = { facts: { plan_target_count: 3 }, bindings: {}, prior: {} };
      const secondInputs = { facts: { plan_target_count: 99 }, bindings: {}, prior: {} };
      const first = await repository.record(actor, identity, decision, { toolId: 't', inputs: firstInputs });
      const again = await repository.record(actor, identity, decision, { toolId: 't', inputs: secondInputs });
      // What the caller gets back is what is stored: the first inputs and their digest, not the second.
      expect(again).toEqual(first);
      expect(again.inputsDigest).toBe(first.inputsDigest);
      expect(again.inputs?.facts.plan_target_count).toBe(3);
      expect(await control('decisions').countDocuments()).toBe(1);
    });

    it('refuses oversized inputs, non-canonical inputs and a bad tool id', async () => {
      const id = await createJob(env.service);
      const repository = new DecisionRepository(executor);
      const base = {
        jobId: id,
        runId: `run-${id}`,
        harnessHash: HASH,
        stepId: 's',
        batchOrdinal: 0,
        argsDigest: HASH,
      };
      const decision = { result: 'allow' as const, ruleIds: [], authorizationRevision: 1 };
      const huge = { facts: { blob: 'x'.repeat(40_000) }, bindings: {}, prior: {} };
      await expect(repository.record(actor, base, decision, { inputs: huge })).rejects.toThrow(
        'DecisionInputsTooLarge',
      );
      await expect(
        repository.record(actor, base, decision, {
          inputs: { facts: { when: new Date() as never }, bindings: {}, prior: {} },
        }),
      ).rejects.toThrow();
      await expect(repository.record(actor, base, decision, { toolId: '' })).rejects.toThrow('InvalidToolId');
      expect(await control('decisions').countDocuments()).toBe(0);
    });
  });

  describe('D13: the world counter and its trusted binding are separate rows with separate writers', () => {
    it('creates a world as two rows and reads them as one logical revision', async () => {
      await worlds.create(scope, 'w1', 3);
      expect(await worlds.read(scope, 'w1')).toMatchObject({
        worldId: 'w1',
        revision: 0,
        scopeRevision: 3,
        maintenanceMode: false,
      });
      expect(
        await env.service.world.collection('world_revisions').findOne({ _id: 'w1' as never }),
      ).not.toHaveProperty('scopeRevision');
      expect(
        await env.service.world.collection('world_scope_bindings').findOne({ _id: 'w1' as never }),
      ).not.toHaveProperty('revision');
    });

    it('keeps rebinding and maintenance with the setup and fixture-builder principals', async () => {
      await worlds.create(scope, 'w1', 1);
      await expect(
        new WorldRepository(executor).rebind(scope, 'w1', { maintenanceMode: true }),
      ).rejects.toThrow('PrincipalBoundary');
      await expect(new WorldRepository(executor).create(scope, 'w2', 1)).rejects.toThrow('PrincipalBoundary');
      const rebound = await new WorldRepository(await env.as('fixture_builder')).rebind(scope, 'w1', {
        scopeRevision: 2,
      });
      expect(rebound).toMatchObject({ scopeRevision: 2, revision: 1 });
    });

    it('denies an effect once the world is in maintenance, and invalidates the plan that was in flight', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      const action = intent(id);
      await recordDecisionFor(env.service, action);
      await worlds.rebind(scope, `world-${id}`, { maintenanceMode: true });
      await expect(
        effects.commitEffect({ actor, lease, intent: action, apply: async () => [] }),
      ).rejects.toThrow('WorldInMaintenance');
      await worlds.rebind(scope, `world-${id}`, { maintenanceMode: false });
      // Leaving maintenance advanced the counter, so the plan made at revision 0 is stale.
      await expect(
        effects.commitEffect({ actor, lease, intent: action, apply: async () => [] }),
      ).rejects.toThrow('StaleWorldRevision');
    });

    it('denies an effect for a run pinned to a scope revision the world is no longer bound to', async () => {
      const id = await createJob(env.service);
      const lease = await claim(id);
      await worlds.rebind(scope, `world-${id}`, { scopeRevision: 2 });
      const action = intent(id, { worldRevision: 1 });
      await recordDecisionFor(env.service, action);
      await expect(
        effects.commitEffect({ actor, lease, intent: action, apply: async () => [] }),
      ).rejects.toThrow('StaleWorldBinding');
    });

    it('conflicts a rebind with an effect that read the old binding (no write skew)', async () => {
      await worlds.create(scope, 'wc', 1);
      const session = executor.client.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        await executor.control.collection('artifacts').findOne({}, { session }); // fix the snapshot
        await worlds.rebind(scope, 'wc', { maintenanceMode: true });
        await expect(new WorldRepository(executor).advance(scope, 'wc', 0, session)).rejects.toThrow();
      } finally {
        await session.endSession();
      }
      expect((await worlds.read(scope, 'wc')).maintenanceMode).toBe(true);
    });

    it('rejects, at the database, a job recorded as succeeded with nothing to point at', async () => {
      const id = await createJob(env.service);
      const jobsCollection = control('jobs');
      await expect(
        jobsCollection.updateOne({ _id: id as never }, { $set: { status: 'succeeded' } }),
      ).rejects.toMatchObject({ code: 121 });
      await expect(
        jobsCollection.updateOne({ _id: id as never }, { $set: { status: 'succeeded', outputRefs: [] } }),
      ).rejects.toMatchObject({ code: 121 });
      await jobsCollection.updateOne({ _id: id as never }, { $set: { status: 'failed' } });
      await jobsCollection.updateOne(
        { _id: id as never },
        { $set: { status: 'succeeded', outputRefs: ['r'] } },
      );
    });
  });

  describe('K6: a job binds to a world that exists, under this scope, outside maintenance', () => {
    const create = (worldId: string, scopeRevision = 1, creator: MongoService = env.service) =>
      new JobRepository(creator).create(actor, {
        kind: 'cleanup',
        binding: { runId: 'r', worldId, harnessHash: HASH, scopeRevision, workerProfileHash: HASH },
      });

    it('refuses an unknown world and a world that exists only under another scope', async () => {
      await expect(create('nowhere')).rejects.toThrow('UnknownWorld');
      await worlds.create({ ...scope, scopeId: 'other-scope' }, 'foreign', 1);
      await expect(create('foreign')).rejects.toThrow('UnknownWorld');
      await worlds.create({ ...scope, tenantId: 'other-tenant' }, 'foreign-tenant', 1);
      await expect(create('foreign-tenant')).rejects.toThrow('UnknownWorld');
      expect(await control('jobs').countDocuments()).toBe(0);
    });

    it('refuses a half-created world and a mismatched scope revision', async () => {
      await env.service.world.collection<Document>('world_revisions').insertOne({
        _id: 'half' as never,
        ...scope,
        worldId: 'half',
        revision: 0,
        updatedAt: new Date(),
      });
      await expect(create('half')).rejects.toThrow('UnknownWorld');
      await worlds.create(scope, 'bound', 2);
      await expect(create('bound', 1)).rejects.toThrow('StaleWorldBinding');
      expect((await create('bound', 2))._id).toBeTruthy();
    });

    it('refuses a world in maintenance', async () => {
      await worlds.create(scope, 'busy', 1, { maintenanceMode: true });
      await expect(create('busy')).rejects.toThrow('WorldInMaintenance');
    });

    it('lets the principals that create jobs read the binding rows they need', async () => {
      await worlds.create(scope, 'shared', 1);
      for (const principal of [
        'domain_executor',
        'observer',
        'promoter',
        'privacy_controller',
        'grader',
        'fixture_builder',
      ] as const)
        expect((await create('shared', 1, await env.as(principal)))._id, principal).toBeTruthy();
    });
  });
  describe('setup seeding', () => {
    it('installs the scope authority and policies idempotently from the environment seed', async () => {
      const seed = seedOptionsFromEnv({
        EXPUNGE_TENANT_ID: scope.tenantId,
        EXPUNGE_ENV: scope.env,
        EXPUNGE_SCOPE_ID: scope.scopeId,
        EXPUNGE_AUTHORITY_FLOOR_HASH: HASH,
      });
      await control('authority_revisions').deleteMany({});
      await control('authority_touches').deleteMany({});
      expect(await setupMongo(env.service, seed)).toMatchObject({ authorities: 1, authorityPolicies: 3 });
      expect(await setupMongo(env.service, seed)).toMatchObject({ authorities: 1, authorityPolicies: 3 });
      expect(await control('authority_revisions').countDocuments()).toBe(1);
      expect(await control('authority_policies').countDocuments()).toBe(3);
      const changed = seedOptionsFromEnv({
        EXPUNGE_TENANT_ID: scope.tenantId,
        EXPUNGE_ENV: scope.env,
        EXPUNGE_SCOPE_ID: scope.scopeId,
        EXPUNGE_AUTHORITY_FLOOR_HASH: 'b'.repeat(64),
      });
      await expect(setupMongo(env.service, changed)).rejects.toThrow('AuthorityConflict');
    });
  });
});
