import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  JobStatusCell,
  ReceiptCell,
  matchesFilter,
} from '../src/client/expunge/views/JobsHomeView';
import { PhaseStepper } from '../src/client/expunge/components/PhaseStepper';
import {
  jobStatusChip,
  snapshotReceiptIncomplete,
} from '../src/client/expunge/projection/selectors';
import { jobListSchema } from '../src/server/expunge/schemas';
import type {
  ExpungeJobListItem,
  ForwardedProjectionEvent,
} from '../src/shared/expunge';
import { phaseStates } from './fixtures/expunge-data';

const item = (patch: Partial<ExpungeJobListItem>): ExpungeJobListItem => ({
  jobId: 'job-1',
  kind: 'cleanup',
  status: 'succeeded',
  sequence: 6,
  updatedAt: '2026-10-11T10:00:00.000Z',
  ...patch,
});

const committedIncomplete = {
  receiptDomainStatus: 'incomplete' as const,
  receiptId: 'rcpt-job-1',
  receiptSequence: 6,
  verifiedWorldRevision: 12,
};

const row = (patch: Partial<ExpungeJobListItem>) =>
  renderToStaticMarkup(
    <>
      <JobStatusCell item={item(patch)} />
      <ReceiptCell item={item(patch)} />
    </>,
  );

it('failed + committed incomplete receipt reads "Finished: cleanup incomplete" in the warning style, verdict kept', () => {
  const html = row({ status: 'failed', ...committedIncomplete });
  expect(html).toContain('Finished: cleanup incomplete');
  expect(html).toContain('data-state="finished_incomplete"');
  expect(html).toContain('ex-chip--warn');
  expect(html).not.toContain('ex-chip--fail');
  expect(html).not.toContain('>Failed');
  // The receipt verdict is still shown with its seal, and it is not "Complete".
  expect(html.match(/class="ex-seal"/g)).toHaveLength(1);
  expect(html).toContain('Incomplete in registered scope');
  expect(html).not.toContain('Complete in registered scope');
  expect(html).toContain('as of world revision 12');
});

it('failed + an incomplete verdict without a committed receipt reference keeps "Failed" (DA-7 S1)', () => {
  for (const patch of [
    { receiptDomainStatus: 'incomplete' as const },
    { receiptDomainStatus: 'incomplete' as const, receiptId: 'r1' },
    {
      receiptDomainStatus: 'incomplete' as const,
      receiptId: 'r1',
      receiptSequence: 6,
    },
  ]) {
    const html = row({ status: 'failed', ...patch });
    expect(html).toContain('data-state="failed"');
    expect(html).not.toContain('Finished: cleanup incomplete');
    expect(html).not.toContain('Complete');
    expect(html).not.toContain('ex-seal');
  }
});

it('failed with no receipt keeps "Failed" and names the terminal reason in plain words', () => {
  const plain = row({ status: 'failed' });
  expect(plain).toContain('data-state="failed"');
  expect(plain).toContain('>Failed<');
  expect(plain).toContain('No receipt committed');
  expect(plain).not.toContain('Complete');

  const attest = row({
    status: 'failed',
    terminalReason: 'ModelAttestationFailed',
  });
  expect(attest).toContain('ex-chip--fail');
  expect(attest).toContain(
    'Failed: Stopped before any model call: model stamp could not be written',
  );
  expect(
    row({ status: 'failed', terminalReason: 'NoCompletionReceipt' }),
  ).toContain('Failed: Ended without a completion receipt');
  expect(row({ status: 'failed', terminalReason: 'SomethingNew' })).toContain(
    'Failed: Stopped with code SomethingNew',
  );
  // A reason is never shown beside a committed receipt.
  expect(
    row({
      status: 'failed',
      terminalReason: 'NoCompletionReceipt',
      ...committedIncomplete,
    }),
  ).not.toContain('Ended without a completion receipt');
});

it('succeeded + complete committed receipt keeps the neutral "Job finished" chip and the complete verdict', () => {
  const html = row({
    status: 'succeeded',
    receiptDomainStatus: 'complete_in_registered_scope',
    receiptId: 'rcpt-job-1',
    receiptSequence: 6,
    verifiedWorldRevision: 215,
  });
  expect(html).toContain('Job finished');
  expect(html).toContain('Complete in registered scope');
  expect(html).not.toContain('Finished: cleanup incomplete');
  expect(html).not.toContain('Failed');
  // Status words alone never say "Complete"; only the sealed verdict does.
  expect(
    jobStatusChip({ status: 'succeeded', receiptIncomplete: false }),
  ).toEqual({
    state: 'succeeded',
  });
});

it('the "Finished" filter counts finished-incomplete jobs; the chip split never applies to non-failed jobs', () => {
  expect(matchesFilter('finished', 'failed')).toBe(true);
  expect(matchesFilter('finished', 'succeeded')).toBe(true);
  expect(matchesFilter('finished', 'cancelled')).toBe(true);
  expect(matchesFilter('finished', 'running')).toBe(false);
  expect(
    jobStatusChip({ status: 'cancelled', receiptIncomplete: true }).state,
  ).toBe('cancelled');
});

it('job detail: only a committed receipt_committed event for the named receipt makes it finished-incomplete', () => {
  const ev = (payload: Record<string, unknown>) =>
    ({
      jobId: 'job-1',
      sequence: 7,
      kind: 'receipt_committed',
      occurredAt: '2026-10-11T10:00:00.000Z',
      payload,
    }) as unknown as ForwardedProjectionEvent;
  const snapshot = { receipt: { receiptId: 'rcpt-job-1', sequence: 7 } };
  const incomplete = ev({
    receiptId: 'rcpt-job-1',
    domainStatus: 'incomplete',
    externalErasureStatus: 'not_requested',
    verifiedWorldRevision: 12,
  });
  expect(snapshotReceiptIncomplete(snapshot, [incomplete])).toBe(true);
  expect(snapshotReceiptIncomplete({ receipt: null }, [incomplete])).toBe(
    false,
  );
  expect(snapshotReceiptIncomplete(snapshot, [])).toBe(false);
  expect(
    snapshotReceiptIncomplete(snapshot, [
      ev({ ...incomplete.payload, receiptId: 'rcpt-other' }),
    ]),
  ).toBe(false);
  expect(
    snapshotReceiptIncomplete(snapshot, [
      ev({
        ...incomplete.payload,
        domainStatus: 'complete_in_registered_scope',
      }),
    ]),
  ).toBe(false);
});

it('PhaseStepper: a finished-incomplete job shows its failed node as "Incomplete", not "Failed"', () => {
  const states = { ...phaseStates('verify', 5), verify: 'failed' as const };
  const honest = renderToStaticMarkup(
    <PhaseStepper states={states} phase="verify" finishedIncomplete />,
  );
  expect(honest).toContain('ex-step--incomplete');
  expect(honest).toContain('Incomplete');
  expect(honest).not.toContain('>Failed<');
  const broken = renderToStaticMarkup(
    <PhaseStepper states={states} phase="verify" />,
  );
  expect(broken).toContain('ex-step--failed');
  expect(broken).toContain('>Failed<');
});

it('the server schema carries a code-shaped terminal reason and refuses free text', () => {
  const ok = jobListSchema.parse({
    items: [item({ status: 'failed', terminalReason: 'NoCompletionReceipt' })],
    nextCursor: null,
  });
  expect(ok.items[0].terminalReason).toBe('NoCompletionReceipt');
  expect(() =>
    jobListSchema.parse({
      items: [
        item({ status: 'failed', terminalReason: 'user ana@example.com' }),
      ],
      nextCursor: null,
    }),
  ).toThrow();
});
