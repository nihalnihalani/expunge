import { afterAll, beforeAll, expect, it } from 'vitest';
import { deriveGrantBinding, DeploymentRepository } from '@expunge/mongo';
import type { GateReport } from '@expunge/contracts';
import { actor, describeLive } from '../../mongo/test/support.js';
import { answerApproval, renderDescriptor } from './api.js';
import { insertLabeledAdmitReport } from './admitted-report.js';
import { childBundle, openRig, type Rig } from './support.js';

let rig: Rig;
let n = 0;
const OPTS = { allowTestFixtures: true };

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
    child,
    request: {
      reportId: stored.report.reportId,
      parentHash: rig.parentHash,
      childHash,
      target: 'worker' as const,
      actor,
    },
    stored,
  };
}
const approvalsOf = (proposalId: string) =>
  rig.env.service.control.collection('approvals').find({ proposalId }).toArray();

describeLive('approval descriptor and grant issue (real replica set)', () => {
  beforeAll(async () => {
    rig = await openRig('depgrant');
    await new DeploymentRepository(rig.env.service).initialize(actor, 'worker', rig.parentHash, 1);
  }, 60_000);
  afterAll(async () => {
    if (rig) await rig.env.dispose();
  }, 30_000);

  it('renders the descriptor from stored rows, the same digest every time', async () => {
    const { request, stored } = await stage();
    const a = await renderDescriptor(rig.issuer, request, OPTS);
    const b = await renderDescriptor(rig.issuer, request, OPTS);
    expect(a.descriptor).toEqual(b.descriptor);
    expect(a.descriptor).toMatchObject({
      proposalId: stored.report.candidateId,
      parentHash: rig.parentHash,
      computedClass: 'behavioral',
      gateReportId: stored.report.reportId,
      gateReportDigest: stored.digest,
      expectedParentRevision: 0,
      scope: { scopeId: actor.scopeId, scopeRevision: 1, authorizationRevision: 1 },
    });
    expect(a.descriptor.descriptorDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('lists an authority expansion as a flip and says so in plain words', async () => {
    const { request } = await stage({
      toolPolicy: {
        ...rig.parent.toolPolicy,
        grants: [...rig.parent.toolPolicy.grants, 'verify_registered_scope'],
      },
    });
    const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
    expect(descriptor.computedClass).toBe('authority_expansion');
    expect(descriptor.flipSet).toEqual([{ capability: 'toolPolicy.grants', change: 'added' }]);
    expect(descriptor.consequences.join(' ')).toContain('Expands authority: toolPolicy.grants');
  });

  it('approve issues a grant whose every field comes from the stored report and pointer', async () => {
    const { request, stored } = await stage();
    const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
    // The client may add fields; none of them reaches the grant.
    const answer = {
      descriptorDigest: descriptor.descriptorDigest,
      decision: 'approve',
      childHash: 'f'.repeat(64),
      parentRevision: 9,
    };
    const out = await answerApproval(rig.issuer, { ...request, answer: answer as never }, OPTS);
    expect(out.state).toBe('approved');
    if (out.state !== 'approved') return;
    const binding = deriveGrantBinding(stored.report as GateReport, stored.digest);
    const row = (await approvalsOf(stored.report.candidateId))[0]!;
    expect(row).toMatchObject({
      grantId: out.grantId,
      proposalId: binding.proposalId,
      parentHash: binding.parentHash,
      childHash: request.childHash,
      parentRevision: 0,
      scopeRevision: 1,
      authorizationRevision: 1,
      flipSetDigest: binding.flipSetDigest,
      gateReportId: binding.gateReportId,
      gateReportDigest: binding.gateReportDigest,
      approverId: actor.actorId,
    });
    expect(row.consumedAt).toBeUndefined();
    expect(out.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('decline records nothing', async () => {
    const { request, stored } = await stage();
    const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
    const out = await answerApproval(
      rig.issuer,
      { ...request, answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'decline' } },
      OPTS,
    );
    expect(out).toEqual({ accepted: true, state: 'declined', auditId: expect.any(String) });
    expect(await approvalsOf(stored.report.candidateId)).toHaveLength(0);
  });

  it('refuses a digest that is not the stored descriptor, an unknown decision and an over-long expiry', async () => {
    const { request, stored } = await stage();
    const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
    await expect(
      answerApproval(
        rig.issuer,
        { ...request, answer: { descriptorDigest: 'f'.repeat(64), decision: 'approve' } },
        OPTS,
      ),
    ).rejects.toThrow('DescriptorStale');
    await expect(
      answerApproval(
        rig.issuer,
        { ...request, answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'maybe' as never } },
        OPTS,
      ),
    ).rejects.toThrow('InvalidDecision');
    await expect(
      answerApproval(
        rig.issuer,
        {
          ...request,
          lifetimeMs: 30 * 24 * 3600 * 1000,
          answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' },
        },
        OPTS,
      ),
    ).rejects.toThrow('InvalidApprovalExpiry');
    expect(await approvalsOf(stored.report.candidateId)).toHaveLength(0);
  });

  it('a descriptor goes stale when the pointer or the authority revision moves under it', async () => {
    const { request } = await stage();
    const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
    await rig.env.service.control.collection('deployments').updateOne({}, { $inc: { revision: 1 } });
    await expect(
      answerApproval(
        rig.issuer,
        { ...request, answer: { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' } },
        OPTS,
      ),
    ).rejects.toThrow('DescriptorStale');
    await rig.env.service.control.collection('deployments').updateOne({}, { $inc: { revision: -1 } });
    const fresh = await renderDescriptor(rig.issuer, request, OPTS);
    expect(fresh.descriptor.descriptorDigest).toBe(descriptor.descriptorDigest);
    await rig.env.service.control
      .collection('deployments')
      .updateOne({}, { $set: { activeHash: 'e'.repeat(64) } });
    await expect(renderDescriptor(rig.issuer, request, OPTS)).rejects.toThrow('StaleParent');
    await rig.env.service.control
      .collection('deployments')
      .updateOne({}, { $set: { activeHash: rig.parentHash } });
  });

  it('no grant for a report that is not an admitted, fresh gate decision', async () => {
    const child = childBundle(rig.parentHash);
    const childHash = await rig.insert(child);
    const rejected = await insertLabeledAdmitReport(rig.grader, {
      candidateId: `cand-${++n}`,
      parentHash: rig.parentHash,
      childHash,
      parent: rig.parent,
      child,
      verdict: 'reject',
    });
    const request = {
      reportId: rejected.report.reportId,
      parentHash: rig.parentHash,
      childHash,
      target: 'worker' as const,
      actor,
    };
    await expect(
      answerApproval(
        rig.issuer,
        { ...request, answer: { descriptorDigest: 'a'.repeat(64), decision: 'approve' } },
        OPTS,
      ),
    ).rejects.toThrow('GateReportNotAdmitted');
    // A fixture-labeled admit is refused without the test opt-in.
    const staged = await stage();
    await expect(
      answerApproval(rig.issuer, {
        ...staged.request,
        answer: { descriptorDigest: 'a'.repeat(64), decision: 'approve' },
      }),
    ).rejects.toThrow('GateReportFixture');
  });
});
