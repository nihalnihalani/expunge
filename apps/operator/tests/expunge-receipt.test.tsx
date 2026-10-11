import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  ERASURE_COPY,
  ReceiptDocument,
  ReceiptPanel,
  absenceText,
  receiptMatches,
} from '../src/client/expunge/views/ReceiptView';
import type {
  CompletionReceiptView,
  ExternalErasureStatus,
} from '../src/shared/expunge';
import { baseSnapshot } from './fixtures/expunge-data';

const receipt = (
  patch: Partial<CompletionReceiptView> = {},
): CompletionReceiptView => ({
  receiptId: 'rcpt-1',
  jobId: 'job-1',
  runId: 'run-1',
  harnessHash: 'a'.repeat(64),
  scopeId: 'scope-1',
  scopeRevision: 4,
  verifiedWorldRevision: 215,
  verificationPlanHash: 'b'.repeat(64),
  inspectedCollectionIds: ['customers'],
  discoveredFieldIds: ['customers.email'],
  operationalResiduals: 0,
  excludedOrRetainedRecords: 3,
  limitations: ['Backups are not covered.'],
  domainStatus: 'complete_in_registered_scope',
  externalErasureStatus: 'pending',
  registeredCollectionIds: ['customers', 'payments_archive'],
  effectCounts: { delete: 1, redact: 6 },
  actionReceiptIds: ['a1', 'a2'],
  committedAt: '2026-10-11T10:00:00.000Z',
  ...patch,
});
const render = (r: CompletionReceiptView, narrative = null as never) =>
  renderToStaticMarkup(
    <ReceiptDocument receipt={r} sequence={6} narrative={narrative} />,
  );

it('renders a receipt from committed fields only, behind one receipt seal', () => {
  const html = render(receipt());
  expect(html.match(/class="ex-seal"/g)).toHaveLength(1);
  expect(html).toContain('data-source-kind="receipt"');
  expect(html).toContain('Complete in registered scope');
  expect(html).toContain('world revision 215');
  expect(html).toContain('event 6');
  expect(html).toContain('delete');
  expect(html).toContain('Backups are not covered.');
  expect(html).toContain('payments_archive');
  expect(html).toContain('1 of');
});

it('says incomplete and lists what was not inspected', () => {
  const html = render(receipt({ domainStatus: 'incomplete' }));
  expect(html).not.toContain('Complete in registered scope');
  expect(html).toContain('Incomplete');
  expect(html).toContain('Not inspected');
});

it('states the backend external erasure status exactly, never upgrading it', () => {
  for (const status of [
    'not_required',
    'pending',
    'confirmed',
    'failed',
  ] as ExternalErasureStatus[]) {
    const html = render(receipt({ externalErasureStatus: status }));
    expect(html).toContain(ERASURE_COPY[status].replaceAll("'", '&#x27;'));
  }
  expect(ERASURE_COPY.pending).toContain('has not yet confirmed');
  expect(render(receipt({ externalErasureStatus: 'pending' }))).not.toContain(
    'Confirmed by the provider',
  );
});

it('keeps model narrative labeled untrusted, outside the verdict', () => {
  const html = render(receipt(), {
    jobId: 'job-1',
    text: 'Everything is clean.',
    replayed: false,
    producedAt: '2026-10-11T10:00:00.000Z',
  } as never);
  expect(html).toContain('Model narrative, not verified');
  expect(html).toContain('untrusted');
  expect(html.indexOf('Everything is clean.')).toBeGreaterThan(
    html.indexOf('Verdict'),
  );
  expect(html.match(/class="ex-seal"/g)).toHaveLength(1);
  expect(render(receipt())).not.toContain('Model narrative');
});

it('explains an absent receipt from the committed status, never as complete', () => {
  for (const status of [
    'running',
    'queued',
    'failed',
    'cancelled',
    'succeeded',
    'waiting_approval',
  ] as const) {
    const text = absenceText(baseSnapshot('job-1', { status, receipt: null }));
    expect(text).not.toMatch(/is complete|completed successfully/i);
  }
  expect(absenceText(baseSnapshot('job-1', { status: 'failed' }))).toContain(
    'failed',
  );
  expect(absenceText(baseSnapshot('job-1', { status: 'succeeded' }))).toContain(
    'no completion receipt',
  );
});

const snapshotWith = (
  receiptRef: { receiptId: string; sequence: number } | null,
) => baseSnapshot('job-1', { status: 'succeeded', receipt: receiptRef });

it('G1: a receipt for another job renders no seal, no verdict and the mismatch message', () => {
  const html = renderToStaticMarkup(
    <ReceiptPanel
      snapshot={snapshotWith({ receiptId: 'rcpt-1', sequence: 6 })}
      receipt={receipt({ jobId: 'job-OTHER' })}
    />,
  );
  expect(html).toContain('The receipt does not match this job.');
  expect(html).not.toContain('ex-seal');
  expect(html).not.toContain('Complete in registered scope');
  expect(html).not.toContain('Verdict');
});

it('G1: a receipt whose id differs from the snapshot reference renders no seal or verdict', () => {
  const html = renderToStaticMarkup(
    <ReceiptPanel
      snapshot={snapshotWith({ receiptId: 'rcpt-1', sequence: 6 })}
      receipt={receipt({ receiptId: 'rcpt-DIFFERENT' })}
    />,
  );
  expect(html).toContain('The receipt does not match this job.');
  expect(html).not.toContain('ex-seal');
  expect(html).not.toContain('Complete in registered scope');
  expect(html).not.toContain('Verdict');
});

it('G1: a snapshot with no receipt reference never renders a receipt', () => {
  const html = renderToStaticMarkup(
    <ReceiptPanel snapshot={snapshotWith(null)} receipt={receipt()} />,
  );
  expect(html).toContain('does not match');
  expect(html).not.toContain('ex-seal');
  expect(receiptMatches(snapshotWith(null), receipt())).toBe(false);
});

it('G1: the matching receipt renders, so the guard is not simply always on', () => {
  const html = renderToStaticMarkup(
    <ReceiptPanel
      snapshot={snapshotWith({ receiptId: 'rcpt-1', sequence: 6 })}
      receipt={receipt()}
    />,
  );
  expect(html).not.toContain('does not match');
  expect(html.match(/class="ex-seal"/g)).toHaveLength(1);
  expect(html).toContain('event 6');
});
