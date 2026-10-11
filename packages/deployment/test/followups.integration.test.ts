import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ArtifactRepository, AuthorityPolicyRepository, DeploymentRepository } from '@expunge/mongo';
import { actor, describeLive } from '../../mongo/test/support.js';
import { answerApproval, promoteWithHooks, renderDescriptor } from './api.js';
import { insertLabeledAdmitReport } from './admitted-report.js';
import { childBundle, openRig, scope, type Rig } from './support.js';

let rig: Rig;
let n = 0;
const OPTS = { allowTestFixtures: true };
const key = { ...scope, target: 'worker' } as const;

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
const count = (collection: string, filter: object = {}) =>
  rig.env.service.control.collection(collection).countDocuments(filter);

describeLive(
  'deployment follow-ups (DA-16): descriptor body, idempotent grants, declines, commit-time taint',
  () => {
    beforeAll(async () => {
      rig = await openRig('depfollow');
    }, 60_000);
    beforeEach(async () => {
      await rig.env.reset();
      rig.parentHash = (await new ArtifactRepository(rig.builder).insert(rig.parent))._id;
      await new DeploymentRepository(rig.env.service).initialize(actor, 'worker', rig.parentHash, 1);
      await new AuthorityPolicyRepository(rig.env.service).install(key, false);
    }, 30_000);
    afterAll(async () => {
      if (rig) await rig.env.dispose();
    }, 30_000);

    it('DP-6: the digest-bound body carries every changed unit with before and after, and the gate summary', async () => {
      const { request } = await stage();
      const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
      const change = descriptor.changes.find((c) => c.unit === 'contextPolicy.maxContextTokens')!;
      expect(change).toMatchObject({ kind: 'behavioral', reason: 'execution behavior changed' });
      expect(change.before).toBe(rig.parent.contextPolicy.maxContextTokens);
      expect(change.after).not.toBe(change.before);
      expect(descriptor.gateSummary).toMatchObject({ triggerGain: 2, triggerRequiredGain: 2 });
      // A change in any shown part changes the digest the human approves.
      const again = await renderDescriptor(rig.issuer, request, OPTS);
      expect(again.descriptor.descriptorDigest).toBe(descriptor.descriptorDigest);
      await rig.env.service.control
        .collection('gate_reports')
        .updateOne(
          { _id: request.reportId as never },
          { $set: { 'causalControls.decisionSummary.triggerGain': 9 } },
        );
      const edited = await renderDescriptor(rig.issuer, request, OPTS);
      expect(edited.descriptor.gateSummary).toMatchObject({ triggerGain: 9 });
      expect(edited.descriptor.descriptorDigest).not.toBe(descriptor.descriptorDigest);
    });

    it('DP-7: approving the same descriptor twice issues one grant', async () => {
      const { request, stored } = await stage();
      const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
      const answer = { descriptorDigest: descriptor.descriptorDigest, decision: 'approve' as const };
      const first = await answerApproval(rig.issuer, { ...request, answer }, OPTS);
      const second = await answerApproval(rig.issuer, { ...request, answer }, OPTS);
      if (first.state !== 'approved' || second.state !== 'approved') throw new Error('not approved');
      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.grantId).toBe(first.grantId);
      expect(await count('approvals', { proposalId: stored.report.candidateId })).toBe(1);
    });

    it('DP-7: a decline leaves one audit row per approver and binding, however often it is repeated', async () => {
      const { request, stored } = await stage();
      const { descriptor } = await renderDescriptor(rig.issuer, request, OPTS);
      const answer = { descriptorDigest: descriptor.descriptorDigest, decision: 'decline' as const };
      const a = await answerApproval(rig.issuer, { ...request, answer }, OPTS);
      const b = await answerApproval(rig.issuer, { ...request, answer }, OPTS);
      if (a.state !== 'declined' || b.state !== 'declined') throw new Error('not declined');
      expect(a.auditId).toBe(b.auditId);
      const rows = await rig.env.service.control.collection('approval_declines').find({}).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        proposalId: stored.report.candidateId,
        gateReportDigest: stored.digest,
        descriptorDigest: descriptor.descriptorDigest,
        approverId: actor.actorId,
      });
      expect(await count('approvals')).toBe(0);
    });

    it('DP-10: a source revoked between loading the report and committing stops the promotion', async () => {
      const evidence = {
        provider: 'raindrop',
        externalSignalIds: [],
        localSourceIds: ['s'],
        origin: 'verifier_feedback' as const,
        redactionPolicy: 'p',
        retrievedAt: '2026-10-11T00:00:00.000Z',
        contentHash: '8'.repeat(64),
        permittedUse: 'training' as const,
      };
      const { request } = await stage({ evidence: [evidence] });
      const revoke = async () => {
        await rig.env.service.control.collection('artifact_eligibility').insertOne({
          ...scope,
          artifactHash: evidence.contentHash,
          state: 'revoked',
          policyHash: 'a'.repeat(64),
          reasonCode: 'source_retracted',
          sourceIds: [],
          updatedAt: new Date(),
        } as never);
      };
      // The report loaded fine (the source was eligible); the revocation lands before the transaction opens.
      await expect(
        promoteWithHooks(rig.promoter, { ...request, reason: 'r' }, { afterPrecheck: revoke }, OPTS),
      ).rejects.toThrow('ArtifactIneligible');
      expect((await new DeploymentRepository(rig.promoter).read(key))?.revision).toBe(0);
      expect(await count('promotions')).toBe(0);
    });
  },
);
