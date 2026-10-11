import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuthorityPolicyRepository, AuthorityRepository, DeploymentRepository } from '@expunge/mongo';
import { actor, describeLive } from '../../mongo/test/support.js';
import {
  answerApproval,
  issueRollbackGrant,
  promoteAdmitted,
  promoteWithHooks,
  renderDescriptor,
  rollbackDeployment,
  rollbackWithHooks,
} from './api.js';
import { insertLabeledAdmitReport } from './admitted-report.js';
import { childBundle, openRig, scope, type Rig } from './support.js';

let rig: Rig;
let n = 0;
const OPTS = { allowTestFixtures: true };
const key = { ...scope, target: 'worker' } as const;
const expansion = () => ({
  toolPolicy: {
    ...rig.parent.toolPolicy,
    grants: [...rig.parent.toolPolicy.grants, 'verify_registered_scope'],
  },
});

async function fresh(behavioralRequiresApproval = false) {
  await rig.env.reset();
  const { ArtifactRepository } = await import('@expunge/mongo');
  rig.parentHash = (await new ArtifactRepository(rig.builder).insert(rig.parent))._id;
  await new DeploymentRepository(rig.env.service).initialize(actor, 'worker', rig.parentHash, 1);
  await new AuthorityPolicyRepository(rig.env.service).install(key, behavioralRequiresApproval);
}
async function stage(childOver: Parameters<typeof childBundle>[1] = {}) {
  const child = childBundle(rig.parentHash, childOver);
  const childHash = await rig.insert(child);
  const stored = await insertLabeledAdmitReport(rig.grader, {
    candidateId: `cand-${++n}`,
    parentHash: rig.parentHash,
    childHash,
    parent: rig.parent,
    child,
  });
  return {
    childHash,
    stored,
    request: {
      actor,
      target: 'worker' as const,
      reportId: stored.report.reportId,
      parentHash: rig.parentHash,
      childHash,
    },
  };
}
async function grantFor(request: Awaited<ReturnType<typeof stage>>['request'], lifetimeMs?: number) {
  const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
  const out = await answerApproval(
    rig.issuer,
    {
      ...request,
      ...(lifetimeMs ? { lifetimeMs } : {}),
      answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' },
    },
    OPTS,
  );
  if (out.state !== 'approved') throw new Error('not approved');
  return out.grantId;
}
const pointer = () => new DeploymentRepository(rig.promoter).read(key);
const count = (collection: string, filter: object = {}) =>
  rig.env.service.control.collection(collection).countDocuments(filter);

describeLive('promotion and rollback over the stored gate report (real replica set)', () => {
  beforeAll(async () => {
    rig = await openRig('deppromote');
  }, 60_000);
  beforeEach(async () => {
    await fresh();
  }, 30_000);
  afterAll(async () => {
    if (rig) await rig.env.dispose();
  }, 30_000);

  it('promotes a behavioural child without a grant; the receipt, outbox and pointer agree; a second attempt is a StaleParent', async () => {
    const { request, stored, childHash } = await stage();
    const receipt = await promoteAdmitted(
      rig.promoter,
      { ...request, reason: 'test', expectedDigest: stored.digest },
      OPTS,
    );
    expect(receipt).toMatchObject({
      fromHash: rig.parentHash,
      toHash: childHash,
      fromRevision: 0,
      toRevision: 1,
      gateReportDigest: stored.digest,
    });
    expect(receipt.consumedGrantId).toBeUndefined();
    expect((await pointer())?.activeHash).toBe(childHash);
    expect(await count('deployment_outbox', { promotionId: receipt.promotionId })).toBe(1);
    // A second attempt on the moved pointer is refused; there is still exactly one promotion.
    await expect(promoteAdmitted(rig.promoter, { ...request, reason: 'test' }, OPTS)).rejects.toThrow(
      'StaleParent',
    );
    expect(await count('promotions')).toBe(1);
  });

  it('an authority expansion needs a grant; the grant is consumed once and recorded on the receipt', async () => {
    const { request } = await stage(expansion());
    await expect(promoteAdmitted(rig.promoter, { ...request, reason: 'r' }, OPTS)).rejects.toThrow(
      'ApprovalRequired',
    );
    expect((await pointer())?.revision).toBe(0);
    const grantId = await grantFor(request);
    const receipt = await promoteAdmitted(rig.promoter, { ...request, grantId, reason: 'r' }, OPTS);
    expect(receipt.consumedGrantId).toBe(grantId);
    expect(await count('grant_consumptions', { grantId })).toBe(1);
  });

  it("another candidate's grant is not accepted", async () => {
    const a = await stage(expansion());
    const b = await stage(expansion());
    const grantA = await grantFor(a.request);
    await expect(
      promoteAdmitted(rig.promoter, { ...b.request, grantId: grantA, reason: 'r' }, OPTS),
    ).rejects.toThrow('ApprovalInvalidOrConsumed');
    expect(await count('grant_consumptions')).toBe(0);
    expect(
      (await promoteAdmitted(rig.promoter, { ...a.request, grantId: grantA, reason: 'r' }, OPTS))
        .consumedGrantId,
    ).toBe(grantA);
  });

  it('an expired grant is refused and stays unconsumed', async () => {
    const { request } = await stage(expansion());
    const grantId = await grantFor(request, 1000);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await expect(promoteAdmitted(rig.promoter, { ...request, grantId, reason: 'r' }, OPTS)).rejects.toThrow(
      'ApprovalInvalidOrConsumed',
    );
    expect(await count('grant_consumptions')).toBe(0);
    expect((await pointer())?.revision).toBe(0);
  });

  it('a grant is bound to the authorization revision it was issued under', async () => {
    const { request } = await stage(expansion());
    const grantId = await grantFor(request);
    await new AuthorityRepository(rig.issuer).bump(scope);
    // The caller still holds revision 1: the live fence refuses before anything moves.
    await expect(promoteAdmitted(rig.promoter, { ...request, grantId, reason: 'r' }, OPTS)).rejects.toThrow(
      'AuthorityRevisionStale',
    );
    // Under revision 2 the old grant (revision 1) no longer matches.
    await expect(
      promoteAdmitted(
        rig.promoter,
        { ...request, actor: { ...actor, authorizationRevision: 2 }, grantId, reason: 'r' },
        OPTS,
      ),
    ).rejects.toThrow('ApprovalInvalidOrConsumed');
    expect((await pointer())?.revision).toBe(0);
  });

  it('a digest the caller expected that is not the stored report is refused; so is a moved parent', async () => {
    const first = await stage();
    await expect(
      promoteAdmitted(rig.promoter, { ...first.request, reason: 'r', expectedDigest: 'f'.repeat(64) }, OPTS),
    ).rejects.toThrow('GateReportDigestMismatch');
    const second = await stage();
    await promoteAdmitted(rig.promoter, { ...first.request, reason: 'r' }, OPTS);
    await expect(promoteAdmitted(rig.promoter, { ...second.request, reason: 'r' }, OPTS)).rejects.toThrow(
      'StaleParent',
    );
  });

  it('two candidates on one parent race through the transaction: exactly one commits, the loser fails in the compare-and-set and keeps its grant', async () => {
    const a = await stage(expansion());
    const b = await stage({
      ...expansion(),
      contextPolicy: { ...rig.parent.contextPolicy, maxContextTokens: 777 },
    });
    const grantA = await grantFor(a.request);
    const grantB = await grantFor(b.request);
    let passed = 0;
    let entered = 0;
    let releasePre!: () => void;
    let releaseTx!: () => void;
    const pre = new Promise<void>((resolve) => (releasePre = resolve));
    const tx = new Promise<void>((resolve) => (releaseTx = resolve));
    const hooks = {
      afterPrecheck: async () => {
        if (++passed === 2) releasePre();
        await pre;
      },
      inTransaction: async () => {
        if (++entered >= 2) releaseTx();
        await Promise.race([tx, new Promise((resolve) => setTimeout(resolve, 3000))]);
      },
    };
    const results = await Promise.allSettled([
      promoteWithHooks(rig.promoter, { ...a.request, grantId: grantA, reason: 'a' }, hooks, OPTS),
      promoteWithHooks(rig.promoter, { ...b.request, grantId: grantB, reason: 'b' }, hooks, OPTS),
    ]);
    expect(passed).toBe(2); // both read the same pointer state before either committed
    expect(entered).toBeGreaterThanOrEqual(2); // both were inside the transaction together
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser's failure can only come from the in-transaction compare-and-set (both passed the pre-check).
    expect(String(lost[0]!.reason)).toContain('StaleParent');
    expect(await count('promotions')).toBe(1);
    expect(await count('grant_consumptions')).toBe(1);
    expect((await pointer())?.revision).toBe(1);
  });

  it('rolls back to a previously deployed hash as a new audited move; a never-deployed target is refused', async () => {
    const { request, childHash } = await stage();
    await promoteAdmitted(rig.promoter, { ...request, reason: 'up' }, OPTS);
    const back = await rollbackDeployment(rig.promoter, {
      actor,
      target: 'worker',
      toHash: rig.parentHash,
      reason: 'oops',
    });
    expect(back).toMatchObject({
      fromHash: childHash,
      toHash: rig.parentHash,
      fromRevision: 1,
      toRevision: 2,
      gateReportId: 'rollback',
    });
    expect((await pointer())?.activeHash).toBe(rig.parentHash);
    const stranger = await rig.insert(childBundle(rig.parentHash));
    await expect(
      rollbackDeployment(rig.promoter, { actor, target: 'worker', toHash: stranger, reason: 'x' }),
    ).rejects.toThrow('RollbackTargetNeverDeployed');
  });

  it('a rollback that re-expands authority needs its own grant and records its refusal', async () => {
    const { request, childHash } = await stage(expansion());
    await promoteAdmitted(rig.promoter, { ...request, grantId: await grantFor(request), reason: 'up' }, OPTS);
    // Roll back to the narrower parent: tightening, no grant. Then roll forward to the expansion: needs a grant.
    await rollbackDeployment(rig.promoter, {
      actor,
      target: 'worker',
      toHash: rig.parentHash,
      reason: 'down',
    });
    await expect(
      rollbackDeployment(rig.promoter, { actor, target: 'worker', toHash: childHash, reason: 'again' }),
    ).rejects.toThrow('RollbackNeedsGrant');
    expect(await count('rollback_refusals', { code: 'RollbackNeedsGrant' })).toBe(1);
    const grant = await issueRollbackGrant(rig.issuer, { actor, target: 'worker', toHash: childHash });
    const receipt = await rollbackDeployment(rig.promoter, {
      actor,
      target: 'worker',
      toHash: childHash,
      reason: 'again',
      grantId: grant.grantId,
    });
    expect(receipt.consumedGrantId).toBe(grant.grantId);
    expect(await count('grant_consumptions', { grantId: grant.grantId })).toBe(1);
  });

  it('two rollbacks race through the transaction: one commits, the other fails in the compare-and-set', async () => {
    const { request } = await stage();
    await promoteAdmitted(rig.promoter, { ...request, reason: 'up' }, OPTS);
    let passed = 0;
    let entered = 0;
    let releasePre!: () => void;
    let releaseTx!: () => void;
    const pre = new Promise<void>((resolve) => (releasePre = resolve));
    const tx = new Promise<void>((resolve) => (releaseTx = resolve));
    const hooks = {
      afterPrecheck: async () => {
        if (++passed === 2) releasePre();
        await pre;
      },
      inTransaction: async () => {
        if (++entered >= 2) releaseTx();
        await Promise.race([tx, new Promise((resolve) => setTimeout(resolve, 3000))]);
      },
    };
    const results = await Promise.allSettled([
      rollbackWithHooks(
        rig.promoter,
        { actor, target: 'worker', toHash: rig.parentHash, reason: 'a' },
        hooks,
      ),
      rollbackWithHooks(
        rig.promoter,
        { actor, target: 'worker', toHash: rig.parentHash, reason: 'b' },
        hooks,
      ),
    ]);
    expect(passed).toBe(2);
    expect(entered).toBeGreaterThanOrEqual(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(String(lost[0]!.reason)).toContain('StaleParent');
    expect((await pointer())?.revision).toBe(2);
  });
});
