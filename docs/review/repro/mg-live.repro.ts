// DA-1 live MongoDB repros against the local replica set (packages/mongo/test/docker-compose.yml, port 27018).
// Uses throwaway databases with a random prefix and drops them afterwards. No credentials are used.
// Each check prints REPRODUCED / NOT REPRODUCED / ERROR. Exit 0 = every check reproduced, 1 = some did not, 2 = setup error.
// Run: DA1_MONGO_URI='mongodb://127.0.0.1:27018/?directConnection=true' npx tsx docs/review/repro/mg-live.repro.ts
import { randomUUID } from 'node:crypto';
import type { ActorContext, ActionIntent, ApprovalGrant, GateReport, ScopeRegistry } from '@expunge/contracts';
import { contentHash } from '@expunge/contracts';
import {
  ApprovalRepository,
  ArtifactRepository,
  AuthorityPolicyRepository,
  DeploymentRepository,
  EffectRepository,
  JobRepository,
  ScopeRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '@expunge/mongo';
import { validBundle } from '../../../packages/contracts/test/valid-bundle.js';
import * as mongo from '@expunge/mongo';

const uri = process.env.DA1_MONGO_URI ?? 'mongodb://127.0.0.1:27018/?directConnection=true';
const prefix = `da1_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const names = { worldDatabase: `${prefix}_world`, controlDatabase: `${prefix}_control`, privateDatabase: `${prefix}_private` };
const config = (p: Principal) => ({ uris: { [p]: uri }, ...names });
const H = 'a'.repeat(64);
const actor: ActorContext = { actorId: 'owner', tenantId: 'tenant-a', env: 'evaluation', scopeId: 'scope-a', authorizationRevision: 1 };
const svc = {} as Record<'setup' | 'domain_executor' | 'promoter' | 'grader' | 'approval_issuer' | 'proposer', MongoService>;
const results: Array<[string, string]> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(id: string, fn: () => Promise<boolean>) {
  try {
    results.push([id, (await fn()) ? 'REPRODUCED' : 'NOT REPRODUCED']);
  } catch (error) {
    // A deliberate repository refusal (ProtocolError) means the defect no longer reproduces on this path.
    const refused = (error as { name?: string }).name === 'ProtocolError';
    results.push([id, refused ? `NOT REPRODUCED (refused: ${(error as Error).message})` : `ERROR ${(error as Error).message}`]);
  }
}
async function newJob(jobs: JobRepository, worldRevision = 0) {
  const id = randomUUID();
  await jobs.create(actor, { jobId: id, kind: 'cleanup', binding: { runId: `run-${id}`, worldId: `world-${id}`, harnessHash: H, scopeRevision: 1, workerProfileHash: H } });
  await svc.setup.world.collection<{ _id: string }>('world_revisions').insertOne({ _id: `world-${id}`, worldId: `world-${id}`, ...scope(), revision: worldRevision, scopeRevision: 1, maintenanceMode: false, updatedAt: new Date() } as never);
  return id;
}
const scope = () => ({ tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId });
function intent(jobId: string, effectKey: string, targets: ActionIntent['targetAddresses'], worldRevision: number): ActionIntent {
  const base = intentRaw(jobId, effectKey, targets, worldRevision);
  const m = mongo as Record<string, unknown>;
  if (process.env.DA1_DERIVE !== '0' && typeof m.deriveEffectKey === 'function') {
    const derived = { ...base, stepId: effectKey.includes('toolcall') ? 'apply' : base.stepId };
    derived.targetHash = (m.deriveTargetHash as (t: unknown) => string)(targets);
    derived.effectKey = (m.deriveEffectKey as (i: unknown) => string)(derived);
    derived.argsDigest = (m.deriveArgsDigest as (i: unknown) => string)(derived);
    return derived;
  }
  return base;
}
function intentRaw(jobId: string, effectKey: string, targets: ActionIntent['targetAddresses'], worldRevision: number): ActionIntent {
  return { intentId: `intent-${effectKey}`, jobId, runId: `run-${jobId}`, harnessHash: H, stepId: 'apply', approvedPlanHash: H, batchOrdinal: 0, targetAddresses: targets, targetHash: contentHash(targets, 'targets'), effectKind: 'delete', expectedDocumentVersions: [], worldRevision, policyDecision: { result: 'allow', ruleIds: [], authorizationRevision: 1 }, effectKey, argsDigest: contentHash({ jobId, targets }, 'effect-args') };
}
async function gate(parentHash: string, childHash: string, candidateId: string, computedClass: 'tightening' | 'behavioral' | 'authority_expansion' = 'behavioral') {
  const report: GateReport = { computedClass, reportId: `g-${candidateId}`, candidateId, parentHash, childHash, evaluatorHash: H, fixtureGeneratorHash: H, runtimeHash: H, workerProfileHash: H, splitManifestCommitment: H, pairedTrials: [], trialRowsDigest: contentHash([], 'trial-rows'), causalControls: {}, knownAuthorityFlips: [], cost: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costMicrousd: 0, unpricedCalls: 0, mongoOperations: 0, wallTimeMs: 0 }, verdict: 'admit', reasonCodes: [] };
  await svc.setup.control.collection<{ _id: string }>('gate_reports').insertOne({ _id: report.reportId, ...report } as never);
  return contentHash(report, 'gate-report');
}
function candidateRow(owner: ActorContext, candidateId: string, parentHash: string, childHash: string, computedClass: 'tightening' | 'behavioral' | 'authority_expansion') {
  // Snapshot schema had computedClass on this proposer-writable row; current validator forbids it, so it is only sent when accepted.
  const row: Record<string, unknown> = { _id: candidateId, candidateId, actor: { tenantId: owner.tenantId, env: owner.env, scopeId: owner.scopeId }, target: 'worker', parentHash, childHash, patches: [], hypothesis: 'h', sourceEvidence: [], claimedClass: computedClass, artifactHashes: [childHash], state: 'eligible' };
  if (process.env.DA1_LEGACY_CANDIDATE_CLASS === '1') row.computedClass = computedClass;
  return row as never;
}
function registry(fields: ScopeRegistry['fields']): ScopeRegistry {
  return { ...scope(), revision: 1, collectionIds: ['customers'], fields, referenceEdges: [], allowedEffectKinds: ['delete', 'redact', 'restrict', 'tombstone'], eligibilityPolicyId: 'p', eligibilityPolicyHash: H, documentLimits: { maxScanned: 100, maxChanged: 100 }, discoveryCompleteness: { kind: 'declared', limitations: [] } };
}

async function main() {
  for (const p of ['setup', 'domain_executor', 'promoter', 'grader', 'approval_issuer', 'proposer'] as const) {
    svc[p] = createPrincipalService(config(p), p);
    await svc[p].client.connect();
  }
  await setupMongo(svc.setup);
  const jobs = new JobRepository(svc.domain_executor);
  const effects = new EffectRepository(svc.domain_executor);

  await check('L1a finish(succeeded) with no completion receipt (domain_executor)', async () => {
    const id = await newJob(jobs);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    await jobs.finish(actor, { jobId: id, ownerId: 'worker', fence: job.lease.fence }, 'succeeded', ['fabricated']);
    const after = await jobs.readAuthorized(actor, id);
    const receipts = await svc.setup.control.collection('completion_receipts').countDocuments({ jobId: id });
    return after.status === 'succeeded' && receipts === 0;
  });
  await check('L1b grader principal claims and succeeds a cleanup job', async () => {
    const id = await newJob(jobs);
    const graderJobs = new JobRepository(svc.grader);
    const job = (await graderJobs.claim(actor, id, 'grader-proc', 10000))!;
    await graderJobs.finish(actor, { jobId: id, ownerId: 'grader-proc', fence: job.lease.fence }, 'succeeded', []);
    return (await jobs.readAuthorized(actor, id)).status === 'succeeded';
  });
  await check('L2 complete() accepts receipt with zero inspected collections/fields', async () => {
    const id = await newJob(jobs);
    try { await new ScopeRepository(svc.setup).insert(registry([{ fieldId: 'customers.handle', collectionId: 'customers', path: ['data', 'handle'], bsonTypes: ['string'], isArray: false, sanitized: true }])); } catch {}
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    await effects.complete(actor, { jobId: id, ownerId: 'worker', fence: job.lease.fence }, { receiptId: `r-${id}`, jobId: id, runId: `run-${id}`, harnessHash: H, scopeId: actor.scopeId, scopeRevision: 1, verifiedWorldRevision: 0, verificationPlanHash: H, inspectedCollectionIds: [], discoveredFieldIds: [], operationalResiduals: 0, excludedOrRetainedRecords: 0, limitations: [], domainStatus: 'complete_in_registered_scope', externalErasureStatus: 'not_required' });
    return (await jobs.readAuthorized(actor, id)).status === 'succeeded';
  });
  await check('L3 cancelled queued / lease-expired jobs can never reach cancelled', async () => {
    const queued = await newJob(jobs);
    await jobs.cancel(actor, queued);
    const reclaimed = await jobs.claim(actor, queued, 'other', 10000);
    const running = await newJob(jobs);
    const lease = (await jobs.claim(actor, running, 'worker', 150))!.lease;
    await sleep(400);
    await jobs.cancel(actor, running);
    const takeover = await jobs.claim(actor, running, 'other', 10000);
    let finished = true;
    try {
      await jobs.finish(actor, { jobId: running, ownerId: 'worker', fence: lease.fence }, 'cancelled', []);
    } catch {
      finished = false;
    }
    const a = await jobs.readAuthorized(actor, queued);
    const b = await jobs.readAuthorized(actor, running);
    return reclaimed === null && takeover === null && !finished && a.status === 'queued' && b.status === 'running';
  });
  const artifacts = new ArtifactRepository(svc.promoter);
  const deployments = new DeploymentRepository(svc.promoter);
  await check('L4 rollback activates a never-gated, never-promoted artifact', async () => {
    const parent = (await artifacts.insert(validBundle()))._id;
    await deployments.initialize(actor, 'worker', parent, 1);
    const stranger = (await artifacts.insert({ ...validBundle(), contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 7 } }))._id;
    await svc.setup.control.collection('artifact_eligibility').insertOne({ ...scope(), artifactHash: stranger, state: 'permitted', policyHash: H, reasonCode: 'retrieval', sourceIds: [], updatedAt: new Date() });
    await deployments.rollback(actor, { ...scope(), target: 'worker' }, parent, 0, stranger, 'rollback', async () => {});
    const pointer = await deployments.read({ ...scope(), target: 'worker' });
    const gates = await svc.setup.control.collection('gate_reports').countDocuments({ childHash: stranger });
    return pointer?.activeHash === stranger && gates === 0;
  });
  await check('L5 promote() activates a child whose eligibility is revoked', async () => {
    const other: ActorContext = { ...actor, scopeId: 'scope-b' };
    const parent = (await artifacts.insert({ ...validBundle(), contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 2 } }))._id;
    await deployments.initialize(other, 'worker', parent, 1);
    const child = (await artifacts.insert({ ...validBundle(), parentHash: parent, contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 3 } }))._id;
    await svc.setup.control.collection('artifact_eligibility').insertOne({ tenantId: other.tenantId, env: other.env, scopeId: other.scopeId, artifactHash: child, state: 'revoked', policyHash: H, reasonCode: 'source_retracted', sourceIds: ['s'], updatedAt: new Date() });
    const digest = await gate(parent, child, 'c-revoked');
    await new AuthorityPolicyRepository(svc.setup).install({ ...other, target: 'worker' }, true);
    await svc.setup.control.collection('candidates').insertOne(candidateRow(other, 'c-revoked', parent, child, 'behavioral'));
    const grant: ApprovalGrant = { tenantId: other.tenantId, env: other.env, scopeId: other.scopeId, target: 'worker', grantId: 'grant-revoked', proposalId: 'c-revoked', parentHash: parent, childHash: child, parentRevision: 0, approvedDescriptor: {}, authorizationRevision: 1, scopeRevision: 1, flipSetDigest: H, gateReportId: 'g-c-revoked', gateReportDigest: digest, approverId: other.actorId, expiresAt: new Date(Date.now() + 60000), nonce: 'n-revoked', createdAt: new Date() };
    await new ApprovalRepository(svc.approval_issuer).issue(other, grant);
    await deployments.promote({ actor: other, target: 'worker', candidateId: 'c-revoked', parentHash: parent, childHash: child, parentRevision: 0, gateReportId: 'g-c-revoked', gateReportDigest: digest, runtimeHash: H, evaluatorHash: H, scopeRevision: 1, flipSetDigest: H, approvedDescriptor: {}, grantId: 'grant-revoked', reason: 'x', validateAuthority: async () => {} } as never);
    return (await deployments.read({ ...other, target: 'worker' }))?.activeHash === child;
  });
  await check('L11 proposer-inserted candidate row self-classifies an authority widening as tightening; promoted with no grant', async () => {
    const other: ActorContext = { ...actor, scopeId: 'scope-c' };
    const parent = (await artifacts.insert({ ...validBundle(), contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 4 } }))._id;
    await deployments.initialize(other, 'worker', parent, 1);
    const widened = { ...validBundle(), parentHash: parent, contextPolicy: { ...validBundle().contextPolicy, referenceDepth: 4 }, toolPolicy: { grants: ['inspect_schema', 'apply_cleanup_batch', 'complete_cleanup'], prerequisites: [] } };
    const child = (await artifacts.insert(widened))._id;
    const digest = await gate(parent, child, 'c-self', 'authority_expansion');
    await new AuthorityPolicyRepository(svc.setup).install({ ...other, target: 'worker' }, true);
    // Raw insert with the proposer's own principal: the role manifest grants proposer INSERT on candidates.
    await svc.proposer.control.collection('candidates').insertOne(candidateRow(other, 'c-self', parent, child, 'tightening'));
    await deployments.promote({ actor: other, target: 'worker', candidateId: 'c-self', parentHash: parent, childHash: child, parentRevision: 0, gateReportId: 'g-c-self', gateReportDigest: digest, runtimeHash: H, evaluatorHash: H, scopeRevision: 1, flipSetDigest: H, approvedDescriptor: {}, reason: 'x', validateAuthority: async () => {} } as never);
    const consumed = await svc.setup.control.collection('approvals').countDocuments({ proposalId: 'c-self' });
    return (await deployments.read({ ...other, target: 'worker' }))?.activeHash === child && consumed === 0;
  });
  await check('L6 commitEffect receipts an effect on a record outside intent.targetAddresses', async () => {
    const id = await newJob(jobs);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const customers = svc.setup.world.collection<{ _id: string }>('customers');
    await customers.insertMany([{ _id: `A-${id}`, ...scope(), worldId: `world-${id}`, _rev: 1 }, { _id: `B-${id}`, ...scope(), worldId: `world-${id}`, _rev: 1 }] as never);
    const A = { collectionId: 'customers', recordId: `A-${id}`, recordIdBsonType: 'string' as const };
    const B = { collectionId: 'customers', recordId: `B-${id}`, recordIdBsonType: 'string' as const };
    const receipt = await effects.commitEffect({ actor, lease: { jobId: id, ownerId: 'worker', fence: job.lease.fence }, intent: intent(id, `k-${id}`, [A], 0), apply: async (session) => {
      await svc.domain_executor.world.collection<{ _id: string }>('customers').deleteOne({ _id: B.recordId }, { session });
      return [{ address: B, kind: 'delete', preHash: H, postHash: null, preVersion: 1, postVersion: null }];
    } });
    const aLeft = await customers.countDocuments({ _id: A.recordId });
    const bLeft = await customers.countDocuments({ _id: B.recordId });
    return receipt.appliedEffects[0]!.address.recordId === B.recordId && aLeft === 1 && bLeft === 0;
  });
  await check('L7 same logical batch under two effectKeys commits twice', async () => {
    const id = await newJob(jobs);
    const job = (await jobs.claim(actor, id, 'worker', 10000))!;
    const lease = { jobId: id, ownerId: 'worker', fence: job.lease.fence };
    const customers = svc.setup.world.collection<{ _id: string }>('customers');
    await customers.insertOne({ _id: `C-${id}`, ...scope(), worldId: `world-${id}`, _rev: 1, applied: 0 } as never);
    const C = { collectionId: 'customers', recordId: `C-${id}`, recordIdBsonType: 'string' as const };
    const apply = async (session: import('mongodb').ClientSession) => {
      await svc.domain_executor.world.collection<{ _id: string }>('customers').updateOne({ _id: C.recordId }, { $inc: { applied: 1 } }, { session });
      return [];
    };
    const one = await effects.commitEffect({ actor, lease, intent: intent(id, `logical-${id}:toolcall-1`, [C], 0), apply });
    const two = await effects.commitEffect({ actor, lease, intent: intent(id, `logical-${id}:toolcall-2`, [C], 1), apply });
    const doc = await customers.findOne({ _id: C.recordId });
    return one.receiptId !== two.receiptId && (doc as unknown as { applied: number }).applied === 2;
  });
  const scopes = new ScopeRepository(svc.domain_executor);
  await check('L8 findByField throws on an int32 _id (BSON identity not handled)', async () => {
    const worldId = `world-int-${randomUUID()}`;
    const reg = registry([{ fieldId: 'customers.handle', collectionId: 'customers', path: ['data', 'handle'], bsonTypes: ['string'], isArray: false, sanitized: true }]);
    await svc.setup.world.collection('customers').insertOne({ _id: 424242, ...scope(), worldId, _rev: 1, data: { handle: 'h1' } } as never);
    try {
      await scopes.findByField(actor, worldId, reg, 'customers.handle', 'h1');
      return false;
    } catch (error) {
      console.log(`    L8 error: ${(error as Error).message}`);
      return /UnsupportedAddressType/.test((error as Error).message);
    }
  });
  await check('L9 writeField on non-wildcard path over an array overwrites unrelated elements', async () => {
    const worldId = `world-arr-${randomUUID()}`;
    const reg = registry([{ fieldId: 'customers.aliases_flat', collectionId: 'customers', path: ['data', 'aliases'], bsonTypes: ['string'], isArray: true, sanitized: true }]);
    await svc.setup.world.collection('customers').insertOne({ _id: `arr-${worldId}`, ...scope(), worldId, _rev: 1, data: { aliases: ['subject-alias', 'unrelated-alias'] } } as never);
    await scopes.writeField(actor, worldId, reg, { collectionId: 'customers', recordId: `arr-${worldId}`, recordIdBsonType: 'string' }, 'customers.aliases_flat', { match: 'subject-alias', mutation: { kind: 'replace', replacement: '[redacted]' } });
    const after = (await svc.setup.world.collection('customers').findOne({ _id: `arr-${worldId}` } as never)) as unknown as { data: { aliases: unknown } };
    console.log(`    L9 aliases after write: ${JSON.stringify(after.data.aliases)}`);
    return !Array.isArray(after.data.aliases);
  });
  await check('L10 registry admits path [tenantId]; writeField moves a record to another tenant', async () => {
    const worldId = `world-ten-${randomUUID()}`;
    const reg = { ...registry([{ fieldId: 'customers.owner_tenant', collectionId: 'customers', path: ['tenantId'], bsonTypes: ['string'], isArray: false, sanitized: true }]), revision: 7 };
    // Inserted by the trusted setup principal: tests the path grammar itself, not the executor's insert right.
    await new ScopeRepository(svc.setup).insert(reg);
    await svc.setup.world.collection('customers').insertOne({ _id: `ten-${worldId}`, ...scope(), worldId, _rev: 1, data: {} } as never);
    await scopes.writeField(actor, worldId, reg, { collectionId: 'customers', recordId: `ten-${worldId}`, recordIdBsonType: 'string' }, 'customers.owner_tenant', { match: actor.tenantId, mutation: { kind: 'replace', replacement: 'tenant-victim' } });
    const moved = (await svc.setup.world.collection('customers').findOne({ _id: `ten-${worldId}` } as never)) as unknown as { tenantId: string };
    return moved.tenantId === 'tenant-victim';
  });
}

main()
  .catch((error) => {
    console.error('SETUP ERROR', error);
    process.exitCode = 2;
  })
  .finally(async () => {
    try {
      if (svc.setup) {
        await svc.setup.world.dropDatabase();
        await svc.setup.control.dropDatabase();
        await svc.setup.privateDb?.dropDatabase();
      }
      for (const s of Object.values(svc)) await s.close();
    } catch {}
    for (const [id, status] of results) console.log(`${status.padEnd(15)} ${id}`);
    if (process.exitCode !== 2) process.exitCode = results.length && results.every(([, s]) => s === 'REPRODUCED') ? 0 : 1;
  });
