import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  approvalAvailability,
  expiresIn,
} from '../src/client/expunge/review/approvalState';
import {
  ApprovalContent,
  submitDecision,
} from '../src/client/expunge/review/ApprovalDialog';
import {
  APPROVAL_COPY,
  CandidateDocument,
} from '../src/client/expunge/views/CandidateView';
import type {
  ApprovalDescriptorView,
  CandidateView,
} from '../src/shared/expunge';

const NOW = Date.parse('2026-10-11T10:00:00.000Z');
const descriptor = (
  patch: Partial<ApprovalDescriptorView> = {},
): ApprovalDescriptorView => ({
  proposalId: 'p1',
  grantId: 'g1',
  state: 'pending',
  target: 'worker',
  parentHash: 'a'.repeat(64),
  childHash: 'b'.repeat(64),
  expectedParentRevision: 3,
  computedClass: 'authority_expansion',
  flipSet: [{ capability: 'tool:delete:payments_archive', change: 'added' }],
  flipSetDigest: 'c'.repeat(64),
  scope: { scopeId: 's', scopeRevision: 4, authorizationRevision: 2 },
  gateReportId: 'gate-1',
  gateReportDigest: 'd'.repeat(64),
  approver: { actorId: 'o', display: 'Workspace owner' },
  expiresAt: '2026-10-11T10:05:00.000Z',
  consequences: ['It does not take effect until the database commits.'],
  descriptorDigest: 'e'.repeat(64),
  ...patch,
});

it('lets a pending, unexpired descriptor be decided', () => {
  expect(approvalAvailability(descriptor(), NOW)).toEqual({ canDecide: true });
});

it('removes Approve once the expiry passes or the stored state is not pending', () => {
  const expired = approvalAvailability(
    descriptor({ expiresAt: '2026-10-11T09:59:59.000Z' }),
    NOW,
  );
  expect(expired).toMatchObject({ canDecide: false, reason: 'expired' });
  expect(
    approvalAvailability(descriptor({ expiresAt: 'not a date' }), NOW),
  ).toMatchObject({ canDecide: false, reason: 'expired' });
  for (const state of [
    'approved',
    'declined',
    'consumed',
    'stale',
    'expired',
  ] as const) {
    const result = approvalAvailability(descriptor({ state }), NOW);
    expect(result.canDecide).toBe(false);
  }
});

it('never grants the action from the clock: a stored non-pending state wins over a future expiry', () => {
  expect(
    approvalAvailability(
      descriptor({ state: 'stale', expiresAt: '2030-01-01T00:00:00.000Z' }),
      NOW,
    ),
  ).toMatchObject({ canDecide: false, reason: 'stale' });
});

it('words the time left', () => {
  expect(expiresIn('2026-10-11T10:00:30.000Z', NOW)).toBe('in 30 s');
  expect(expiresIn('2026-10-11T10:05:00.000Z', NOW)).toBe('in 5 min');
  expect(expiresIn('2026-10-11T09:00:00.000Z', NOW)).toBe('expired');
});

it('shows the stored descriptor fields, with the class computed rather than claimed', () => {
  const html = renderToStaticMarkup(
    <ApprovalContent descriptor={descriptor()} now={NOW} />,
  );
  expect(html).toContain('authority expansion');
  expect(html).toContain('computed by the gate, not claimed');
  expect(html).toContain('tool:delete:payments_archive');
  expect(html).toContain('Added');
  expect(html).toContain('authorization revision 2');
  expect(html).toContain('gate-1');
  expect(html).toContain('Workspace owner');
  expect(html).toContain('in 5 min');
  expect(html).toContain('does not take effect until the database commits');
  expect(html).not.toContain('ex-seal');
});

it('describes committed approval states without claiming promotion from an approval', () => {
  expect(APPROVAL_COPY.approved).toContain('separate committed step');
  expect(APPROVAL_COPY.approved).not.toMatch(/promoted\b/);
  expect(APPROVAL_COPY.stale).toContain('cannot be approved');
  expect(APPROVAL_COPY.declined).toContain('not promoted');
});

const candidate = (patch: Partial<CandidateView> = {}): CandidateView => ({
  candidateId: 'cand-1',
  target: 'worker',
  parentHash: 'a'.repeat(64),
  childHash: 'b'.repeat(64),
  state: 'waiting_approval',
  hypothesis: 'Inspect the archive.',
  claimedClass: 'behavioral',
  computedClass: 'authority_expansion',
  flipSet: [{ capability: 'tool:delete:payments_archive', change: 'added' }],
  patches: [
    {
      surface: 'workflow',
      path: 'steps.inspect',
      before: 'customers',
      after: 'customers, payments_archive',
      sourceEvidenceIds: ['ev-1'],
      hypothesis: 'h',
    },
  ],
  sourceEvidence: [],
  reasonCodes: ['class_mismatch'],
  compiler: { ok: true, messages: [] },
  replay: { ran: true, label: 'decision_replay_diagnostic', summary: 'ok' },
  activeParentHash: 'f'.repeat(64),
  ...patch,
});

it('shows a before/after diff with text cues, the computed class and a claim mismatch', () => {
  const html = renderToStaticMarkup(
    <CandidateDocument candidate={candidate()} />,
  );
  expect(html).toContain('Before (removed)');
  expect(html).toContain('After (added)');
  expect(html).toContain('customers, payments_archive');
  expect(html).toContain('claimed behavioral');
  expect(html).toContain('differs from tested parent');
  expect(html).toContain('not evidence of improvement');
  expect(html).toContain('class_mismatch');
});

it('reports a compiler rejection and an absent replay plainly', () => {
  const html = renderToStaticMarkup(
    <CandidateDocument
      candidate={candidate({
        state: 'schema_rejected',
        compiler: { ok: false, messages: ['unknown surface'] },
        replay: null,
        claimedClass: 'authority_expansion',
      })}
    />,
  );
  expect(html).toContain('Compiler rejected');
  expect(html).toContain('unknown surface');
  expect(html).toContain('No decision replay was recorded');
  expect(html).not.toContain('claimed authority');
});

afterEach(() => vi.unstubAllGlobals());

for (const decision of ['approve', 'decline'] as const)
  it(`sends exactly {decision, descriptorDigest} for ${decision}, to the decision route only`, async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            accepted: true,
            state: decision === 'approve' ? 'approved' : 'declined',
            committedEventSequence: 7,
          }),
          { status: 200 },
        );
      }),
    );
    const answer = await submitDecision(
      'proposal-1',
      descriptor({ descriptorDigest: 'f'.repeat(64) }),
      decision,
    );
    expect(answer.state).toBe(decision === 'approve' ? 'approved' : 'declined');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/expunge/proposals/proposal-1/decision');
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(Object.keys(body).sort()).toEqual(['decision', 'descriptorDigest']);
    expect(body).toEqual({ decision, descriptorDigest: 'f'.repeat(64) });
  });
