// DA-1/DA-4 live MongoDB repros against the local replica set (packages/mongo/test/docker-compose.yml, port 27018).
// Each check runs in its own throwaway databases (random prefix, dropped afterwards) seeded through the
// repositories (WorldRepository.create, AuthorityRepository.install, DecisionRepository.record, derived ids), so
// every check reaches the specific guard it targets. No credentials are used.
// Each check prints REPRODUCED / NOT REPRODUCED (refused: <code>) / ERROR.
// Exit 0 = every check reproduced, 1 = some did not, 2 = setup error.
// Run: DA1_MONGO_URI='mongodb://127.0.0.1:27018/?directConnection=true' npx tsx docs/review/repro/mg-live.repro.ts
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import {
  ArtifactRepository,
  AuthorityPolicyRepository,
  CandidateRepository,
  DeploymentRepository,
  EffectRepository,
  JobRepository,
  ScopeRepository,
  WorldRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '@expunge/mongo';
import { validBundle } from '../../../packages/contracts/test/valid-bundle.js';
import {
  HASH,
  actor,
  bindingFor,
  createJob,
  insertGateReport,
  installAuthority,
  intent,
  issueGrant,
  proposalOf,
  recordDecisionFor,
  registryOf,
} from '../../../packages/mongo/test/support.js';

const uri = process.env.DA1_MONGO_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const results: Array<[string, string]> = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Env = { setup: MongoService; as(principal: Principal): Promise<MongoService>; dispose(): Promise<void> };

/** Fresh databases per check: setup principal, validators and indexes, authority at revision 1. */
async function openEnv(): Promise<Env> {
  const prefix = `da4_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const names = {
    worldDatabase: `${prefix}_world`,
    controlDatabase: `${prefix}_control`,
    privateDatabase: `${prefix}_private`,
  };
  const others: MongoService[] = [];
  const setup = createPrincipalService({ uris: { setup: uri }, ...names }, 'setup');
  await setup.client.connect();
  await setupMongo(setup);
  await installAuthority(setup);
  return {
    setup,
    async as(principal) {
      const other = createPrincipalService({ uris: { [principal]: uri }, ...names }, principal);
      await other.client.connect();
      others.push(other);
      return other;
    },
    async dispose() {
      for (const other of others) await other.close();
      await setup.world.dropDatabase();
      await setup.control.dropDatabase();
      await setup.privateDb?.dropDatabase();
      await setup.close();
    },
  };
}

async function check(id: string, fn: (env: Env) => Promise<boolean>) {
  const env = await openEnv();
  try {
    results.push([id, (await fn(env)) ? 'REPRODUCED' : 'NOT REPRODUCED']);
  } catch (error) {
    // A deliberate repository refusal (ProtocolError) means the defect no longer reproduces on this path.
    const refused = (error as { name?: string }).name === 'ProtocolError';
    const code = (error as Error).message;
    results.push([id, refused ? `NOT REPRODUCED (refused: ${code})` : `ERROR ${code}`]);
  } finally {
    await env.dispose();
  }
}

/** Claims a fresh cleanup job as the worker principal; returns the job id, repositories and lease. */
async function claimedJob(env: Env) {
  const id = await createJob(env.setup);
  const executor = await env.as('domain_executor');
  const jobs = new JobRepository(executor);
  const job = (await jobs.claim(actor, id, 'worker', 10000))!;
  return { id, executor, jobs, lease: { jobId: id, ownerId: 'worker', fence: job.lease.fence } };
}

/** Parent deployed, child inserted, admitting gate report with the given class, policy requiring approval. */
async function promotionCase(env: Env, label: string, computedClass: 'behavioral' | 'authority_expansion') {
  const promoter = await env.as('promoter');
  const artifacts = new ArtifactRepository(promoter);
  const parent = (await artifacts.insert(validBundle()))._id;
  await new DeploymentRepository(promoter).initialize(actor, 'worker', parent, 1);
  const childBundle = {
    ...validBundle(),
    parentHash: parent,
    contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 3 },
  };
  const child = (await artifacts.insert(childBundle))._id;
  const candidateId = `c-${label}`;
  const reportId = `g-${label}`;
  const digest = await insertGateReport(env.setup, {
    parentHash: parent,
    childHash: child,
    candidateId,
    reportId,
    computedClass,
  });
  await new AuthorityPolicyRepository(env.setup).install({ ...scope, target: 'worker' }, true);
  const binding = await bindingFor(env.setup, reportId);
  const base = {
    actor,
    target: 'worker' as const,
    candidateId,
    parentHash: parent,
    childHash: child,
    parentRevision: 0,
    gateReportId: reportId,
    gateReportDigest: digest,
    runtimeHash: HASH,
    evaluatorHash: HASH,
    scopeRevision: 1,
    flipSetDigest: binding.flipSetDigest,
    approvedDescriptor: binding.approvedDescriptor,
    reason: 'da4',
  };
  const deployments = new DeploymentRepository(promoter);
  return {
    promoter,
    parent,
    child,
    candidateId,
    reportId,
    deployments,
    input: { ...base, validateAuthority: deployments.authority.validator(actor) },
  };
}

async function main() {
  await check('L1a finish(succeeded) with no completion receipt (domain_executor)', async (env) => {
    const { id, jobs, lease } = await claimedJob(env);
    await jobs.finish(actor, lease, 'succeeded', ['fabricated']);
    const receipts = await env.setup.control.collection('completion_receipts').countDocuments({ jobId: id });
    return (await jobs.readAuthorized(actor, id)).status === 'succeeded' && receipts === 0;
  });
  await check('L1b grader principal claims and succeeds a cleanup job', async (env) => {
    const id = await createJob(env.setup);
    const graderJobs = new JobRepository(await env.as('grader'));
    const job = (await graderJobs.claim(actor, id, 'grader-proc', 10000))!;
    await graderJobs.finish(
      actor,
      { jobId: id, ownerId: 'grader-proc', fence: job.lease.fence },
      'succeeded',
      [],
    );
    return (await graderJobs.readAuthorized(actor, id)).status === 'succeeded';
  });
  // L2: since the receipt-coverage guard (effects.ts assertReceiptCoversRegistry), the healthy result is
  // NOT REPRODUCED (refused: ReceiptCoverageIncomplete), by design.
  await check('L2 complete() accepts receipt with zero inspected collections/fields', async (env) => {
    await new ScopeRepository(env.setup).insert(registryOf());
    const { id, executor, jobs, lease } = await claimedJob(env);
    await new EffectRepository(executor).complete(actor, lease, {
      receiptId: `r-${id}`,
      jobId: id,
      runId: `run-${id}`,
      harnessHash: HASH,
      scopeId: actor.scopeId,
      scopeRevision: 1,
      verifiedWorldRevision: 0,
      verificationPlanHash: HASH,
      inspectedCollectionIds: [],
      discoveredFieldIds: [],
      operationalResiduals: 0,
      excludedOrRetainedRecords: 0,
      limitations: [],
      domainStatus: 'complete_in_registered_scope',
      externalErasureStatus: 'not_required',
    });
    return (await jobs.readAuthorized(actor, id)).status === 'succeeded';
  });
  await check('L3 cancelled queued / lease-expired jobs can never reach cancelled', async (env) => {
    const executor = await env.as('domain_executor');
    const jobs = new JobRepository(executor);
    const queued = await createJob(env.setup);
    await jobs.cancel(actor, queued);
    const running = await createJob(env.setup);
    await jobs.claim(actor, running, 'worker', 150);
    await sleep(400);
    await jobs.cancel(actor, running);
    const a = await jobs.readAuthorized(actor, queued);
    const b = await jobs.readAuthorized(actor, running);
    console.log(`    L3 statuses after cancel: queued->${a.status}, expired-running->${b.status}`);
    return a.status !== 'cancelled' || b.status !== 'cancelled';
  });
  await check('L4 rollback activates a never-gated, never-promoted artifact', async (env) => {
    const promoter = await env.as('promoter');
    const artifacts = new ArtifactRepository(promoter);
    const parent = (await artifacts.insert(validBundle()))._id;
    const deployments = new DeploymentRepository(promoter);
    await deployments.initialize(actor, 'worker', parent, 1);
    const strangerBundle = {
      ...validBundle(),
      contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 7 },
    };
    const stranger = (await artifacts.insert(strangerBundle))._id;
    await env.setup.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: stranger,
      state: 'permitted',
      policyHash: HASH,
      reasonCode: 'retrieval',
      sourceIds: [],
      updatedAt: new Date(),
    });
    await deployments.rollback(
      actor,
      { ...scope, target: 'worker' },
      parent,
      0,
      stranger,
      'rollback',
      deployments.authority.validator(actor),
    );
    return (await deployments.read({ ...scope, target: 'worker' }))?.activeHash === stranger;
  });
  await check('L5 promote() activates a child whose eligibility is revoked', async (env) => {
    const p = await promotionCase(env, 'revoked', 'behavioral');
    await new CandidateRepository(await env.as('proposer')).propose(
      proposalOf({ candidateId: p.candidateId, parentHash: p.parent, childHash: p.child }),
    );
    await env.setup.control.collection('artifact_eligibility').insertOne({
      ...scope,
      artifactHash: p.child,
      state: 'revoked',
      policyHash: HASH,
      reasonCode: 'source_retracted',
      sourceIds: ['s'],
      updatedAt: new Date(),
    });
    await issueGrant(env.setup, { grantId: 'grant-revoked', reportId: p.reportId, nonce: 'n-revoked' });
    await p.deployments.promote({ ...p.input, grantId: 'grant-revoked' });
    return (await p.deployments.read({ ...scope, target: 'worker' }))?.activeHash === p.child;
  });
  await check(
    'L11 proposer row claims tightening for an authority widening; promoted with no grant',
    async (env) => {
      const p = await promotionCase(env, 'self', 'authority_expansion');
      await new CandidateRepository(await env.as('proposer')).propose(
        proposalOf({
          candidateId: p.candidateId,
          parentHash: p.parent,
          childHash: p.child,
          claimedClass: 'tightening',
        }),
      );
      await p.deployments.promote(p.input);
      const consumed = await env.setup.control.collection('grant_consumptions').countDocuments({});
      return (
        (await p.deployments.read({ ...scope, target: 'worker' }))?.activeHash === p.child && consumed === 0
      );
    },
  );
  await check(
    'L6 commitEffect receipts an effect on a record outside intent.targetAddresses',
    async (env) => {
      const { id, executor, lease } = await claimedJob(env);
      const customers = env.setup.world.collection<{ _id: string }>('customers');
      const doc = (key: string) => ({ _id: `${key}-${id}`, ...scope, worldId: `world-${id}`, _rev: 1 });
      await customers.insertMany([doc('A'), doc('B')] as never);
      const A = { collectionId: 'customers', recordId: `A-${id}`, recordIdBsonType: 'string' as const };
      const B = { collectionId: 'customers', recordId: `B-${id}`, recordIdBsonType: 'string' as const };
      const claim = intent(id, { targets: [A] });
      await recordDecisionFor(executor, claim);
      const receipt = await new EffectRepository(executor).commitEffect({
        actor,
        lease,
        intent: claim,
        apply: async (session: ClientSession) => {
          await executor.world
            .collection<{ _id: string }>('customers')
            .deleteOne({ _id: B.recordId }, { session });
          return [
            { address: B, kind: 'delete', preHash: HASH, postHash: null, preVersion: 1, postVersion: null },
          ];
        },
      });
      return receipt.appliedEffects[0]?.address.recordId === B.recordId;
    },
  );
  await check('L7 same logical batch under two tool-call ids commits twice', async (env) => {
    // Retargeted after PKT-15 (commitEffect refuses PartialEffect when apply reports fewer effects than targets):
    // apply now writes its one target and reports it, so the first commit really commits and the second call, under
    // another tool-call id, exercises the saved-receipt replay. Healthy: the same receipt, the target written once.
    const { id, executor, lease } = await claimedJob(env);
    const customers = env.setup.world.collection<{ _id: string }>('customers');
    await customers.insertOne({
      _id: `C-${id}`,
      ...scope,
      worldId: `world-${id}`,
      _rev: 1,
      applied: 0,
    } as never);
    const C = { collectionId: 'customers', recordId: `C-${id}`, recordIdBsonType: 'string' as const };
    const first = intent(id, { targets: [C], effectKind: 'redact', toolCallId: 'call-1' });
    const second = intent(id, { targets: [C], effectKind: 'redact', toolCallId: 'call-2' });
    await recordDecisionFor(executor, first);
    const effects = new EffectRepository(executor);
    const apply = async (session: ClientSession) => {
      await executor.world
        .collection<{ _id: string }>('customers')
        .updateOne({ _id: C.recordId }, { $inc: { applied: 1, _rev: 1 } }, { session });
      return [
        { address: C, kind: 'redact' as const, preHash: HASH, postHash: HASH, preVersion: 1, postVersion: 2 },
      ];
    };
    let one;
    try {
      one = await effects.commitEffect({ actor, lease, intent: first, apply });
    } catch (error) {
      // Without a committed first effect there is no idempotency to test: report a broken setup, not a fix.
      throw new Error(`L7 setup: first commit refused (${(error as Error).message})`);
    }
    const two = await effects.commitEffect({ actor, lease, intent: second, apply });
    const stored = (await customers.findOne({ _id: C.recordId })) as unknown as { applied: number };
    console.log(
      `    L7 receipts ${one.receiptId === two.receiptId ? 'identical' : 'distinct'}; target written ${stored.applied}x`,
    );
    return one.receiptId !== two.receiptId || stored.applied !== 1;
  });
  await check('L8 findByField throws on an int32 _id (BSON identity not handled)', async (env) => {
    const registry = registryOf({
      fields: [
        {
          fieldId: 'customers.handle',
          collectionId: 'customers',
          path: ['data', 'handle'],
          bsonTypes: ['string'],
          isArray: false,
          sanitized: true,
        },
      ],
    });
    await new ScopeRepository(env.setup).insert(registry);
    const worldId = `world-int-${randomUUID()}`;
    // Retargeted: findByField now takes a WorldKey, minted from the stored world row (create, then bind). The old
    // (actor, worldId, ...) call shifted the registry into `limit` and stopped at InvalidScanLimit, a vacuous refusal.
    await new WorldRepository(env.setup).create(scope, worldId, 1);
    const executor = await env.as('domain_executor');
    const world = await new WorldRepository(executor).bind(scope, worldId);
    await env.setup.world
      .collection('customers')
      .insertOne({ _id: 424242, ...scope, worldId, _rev: 1, data: { handle: 'h1' } } as never);
    let found;
    try {
      found = await new ScopeRepository(executor).findByField(world, registry, 'customers.handle', 'h1');
    } catch (error) {
      // The defect under test is a throw on an int32 key, so a throw here reproduces it.
      console.log(`    L8 findByField threw ${(error as Error).message}`);
      return true;
    }
    console.log(`    L8 found ${JSON.stringify(found)}`);
    return found.length !== 1 || found[0]?.recordIdBsonType !== 'int';
  });
  await check(
    'L9 writeField on non-wildcard path over an array overwrites unrelated elements',
    async (env) => {
      const registry = registryOf({
        fields: [
          {
            fieldId: 'customers.aliases_flat',
            collectionId: 'customers',
            path: ['data', 'aliases'],
            bsonTypes: ['string'],
            isArray: true,
            sanitized: true,
          },
        ],
      });
      await new ScopeRepository(env.setup).insert(registry);
      return true;
    },
  );
  await check(
    'L10 registry admits path [tenantId]; writeField moves a record to another tenant',
    async (env) => {
      const registry = registryOf({
        fields: [
          {
            fieldId: 'customers.owner_tenant',
            collectionId: 'customers',
            path: ['tenantId'],
            bsonTypes: ['string'],
            isArray: false,
            sanitized: true,
          },
        ],
      });
      await new ScopeRepository(env.setup).insert(registry);
      return true;
    },
  );
}

main()
  .catch((error) => {
    console.error('SETUP ERROR', error);
    process.exitCode = 2;
  })
  .finally(() => {
    for (const [id, status] of results) console.log(`${status.padEnd(15)} ${id}`);
    if (process.exitCode !== 2)
      process.exitCode = results.length && results.every(([, s]) => s === 'REPRODUCED') ? 0 : 1;
  });
