/** FIXTURE harness proposal, candidate and approval decisions. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { event, hex, later } from '../expunge-data.js';
import type {
  ApprovalDescriptorView,
  ArtifactEnvelope,
  CandidateView,
} from '../../../src/shared/expunge.js';

const descriptor = (
  proposalId: string,
  patch: Partial<ApprovalDescriptorView> = {},
): ApprovalDescriptorView => ({
  proposalId,
  grantId: `grant-${proposalId}`,
  state: 'pending',
  target: 'worker',
  parentHash: hex('parent'),
  childHash: hex('child'),
  expectedParentRevision: 3,
  computedClass: 'authority_expansion',
  flipSet: [
    { capability: 'tool:delete:payments_archive', change: 'added' },
    { capability: 'tool:redact:tickets', change: 'widened' },
  ],
  flipSetDigest: hex('flip-1'),
  scope: {
    scopeId: 'synthetic_company',
    scopeRevision: 4,
    authorizationRevision: 2,
  },
  gateReportId: 'gate-1',
  gateReportDigest: hex('gate-1'),
  approver: { actorId: 'opendots-owner', display: 'Workspace owner' },
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  consequences: [
    'This lets the worker delete from payments_archive.',
    'It does not take effect until the database commits the promotion.',
  ],
  descriptorDigest: hex(`descriptor-${proposalId}`),
  ...patch,
});

export default function registerApproval(state: FixtureState) {
  const candidate: ArtifactEnvelope<CandidateView> = {
    artifactId: 'cand-1',
    kind: 'candidate',
    jobId: 'job-approval',
    committedAtSequence: 5,
    contentHash: hex('cand-1'),
    payload: {
      candidateId: 'cand-1',
      target: 'worker',
      parentHash: hex('parent'),
      childHash: hex('child'),
      state: 'waiting_approval',
      hypothesis:
        'Registered archive collections hold references the worker never inspects; adding the archive to the inspection step should close the residuals.',
      claimedClass: 'behavioral',
      computedClass: 'authority_expansion',
      flipSet: [
        { capability: 'tool:delete:payments_archive', change: 'added' },
        { capability: 'tool:redact:tickets', change: 'widened' },
      ],
      patches: [
        {
          surface: 'workflow',
          path: 'steps.inspect.collections',
          before: 'customers, accounts, orders',
          after: 'customers, accounts, orders, payments_archive',
          sourceEvidenceIds: ['ev-1'],
          hypothesis: 'Inspect every registered collection.',
        },
        {
          surface: 'tool_policy',
          path: 'tools.delete.allow',
          before: 'customers, accounts',
          after: 'customers, accounts, payments_archive',
          sourceEvidenceIds: ['ev-1'],
          hypothesis: 'Allow deletes where the archive holds the reference.',
        },
      ],
      sourceEvidence: [],
      reasonCodes: ['class_mismatch_claimed_behavioral'],
      compiler: {
        ok: true,
        messages: ['2 patches compiled against the typed schema.'],
      },
      replay: {
        ran: true,
        label: 'decision_replay_diagnostic',
        summary:
          'The candidate would have inspected payments_archive in 3 of 3 recorded decisions.',
      },
      activeParentHash: hex('parent'),
    },
  };
  state.artifacts.set('cand-1', candidate);
  state.proposals.set('proposal-1', descriptor('proposal-1'));
  const job = state.jobs.get('job-approval');
  if (job) {
    job.snapshot.approval = {
      state: 'pending',
      proposalId: 'proposal-1',
      expiresAt: state.proposals.get('proposal-1')!.expiresAt,
    };
    job.snapshot.artifacts = [
      { artifactId: 'cand-1', kind: 'candidate', committedAtSequence: 5 },
    ];
  }
  // A second job whose proposal expired and a third whose proposal went stale, so those
  // states are exercised against stored descriptors, not scripted in the browser.
  for (const [jobId, proposalId, patch, approvalState] of [
    [
      'job-approval-expired',
      'proposal-expired',
      { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      'pending',
    ],
    [
      'job-approval-stale',
      'proposal-stale',
      { state: 'stale' as const },
      'stale',
    ],
  ] as const) {
    if (!job) continue;
    state.proposals.set(proposalId, descriptor(proposalId, patch));
    state.jobs.set(jobId, {
      snapshot: {
        ...job.snapshot,
        jobId,
        status: 'cancelled',
        approval: {
          state: approvalState,
          proposalId,
          expiresAt: state.proposals.get(proposalId)!.expiresAt,
        },
        artifacts: [],
      },
      events: job.events.map((item) => ({ ...item, jobId })),
    });
  }
  state.onDecision.push((current, proposalId, decision) => {
    const stored = current.proposals.get(proposalId);
    if (!stored || stored.state !== 'pending') return;
    stored.state = decision === 'approve' ? 'approved' : 'declined';
    for (const entry of current.jobs.values()) {
      if (entry.snapshot.approval.proposalId !== proposalId) continue;
      const next = entry.snapshot.sequence + 1;
      entry.events.push(
        event(entry.snapshot.jobId, next, 'approval_resolved', {
          proposalId,
          decision: decision === 'approve' ? 'approved' : 'declined',
          grantId: decision === 'approve' ? stored.grantId : null,
        }),
      );
      entry.snapshot = {
        ...entry.snapshot,
        sequence: next,
        approval: { ...entry.snapshot.approval, state: stored.state },
        updatedAt: later(0),
      };
    }
  });
}
