import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  RelatedRecords,
  relatedLinks,
} from '../src/client/expunge/components/RelatedRecords';
import {
  ReceiptDocument,
  ReceiptPanel,
} from '../src/client/expunge/views/ReceiptView';
import type { CompletionReceiptView } from '../src/shared/expunge';
import { baseSnapshot } from './fixtures/expunge-data';

const art = (kind: 'retraction' | 'campaign' | 'candidate') => ({ kind });

it('links only to records the job has, from the committed artifact index', () => {
  expect(relatedLinks('job-1', [])).toEqual([]);
  expect(relatedLinks('job-1', [art('candidate')])).toEqual([]);
  expect(relatedLinks('job-1', [art('retraction')])).toEqual([
    { label: 'Privacy and retraction', href: '#/expunge/privacy/job-1' },
  ]);
  expect(
    relatedLinks('job-1', [art('campaign'), art('retraction')]).map(
      (l) => l.href,
    ),
  ).toEqual(['#/expunge/privacy/job-1', '#/expunge/campaigns/job-1']);
  expect(relatedLinks('a b', [art('campaign')])[0].href).toBe(
    '#/expunge/campaigns/a%20b',
  );
});

it('renders nothing for a job with no such record, and a named nav when it has one', () => {
  expect(
    renderToStaticMarkup(<RelatedRecords jobId="j" artifacts={[]} />),
  ).toBe('');
  const html = renderToStaticMarkup(
    <RelatedRecords
      jobId="j"
      artifacts={[art('retraction'), art('campaign')]}
    />,
  );
  expect(html).toContain('aria-label="Related records"');
  expect(html).toContain('href="#/expunge/privacy/j"');
  expect(html).toContain('href="#/expunge/campaigns/j"');
});

const receipt = (
  patch: Partial<CompletionReceiptView> = {},
): CompletionReceiptView => ({
  receiptId: 'rcpt-1',
  jobId: 'job-1',
  runId: 'run-1',
  harnessHash: 'a'.repeat(64),
  scopeId: 's',
  scopeRevision: 1,
  verifiedWorldRevision: 2,
  verificationPlanHash: 'b'.repeat(64),
  inspectedCollectionIds: [],
  discoveredFieldIds: [],
  operationalResiduals: 0,
  excludedOrRetainedRecords: 0,
  limitations: [],
  domainStatus: 'complete_in_registered_scope',
  externalErasureStatus: 'pending',
  registeredCollectionIds: [],
  effectCounts: {},
  actionReceiptIds: [],
  committedAt: '2026-10-11T10:00:00.000Z',
  ...patch,
});

it('the receipt links to the retraction record only when the job has one', () => {
  const withLink = renderToStaticMarkup(
    <ReceiptDocument
      receipt={receipt()}
      sequence={6}
      privacyHref="#/expunge/privacy/job-1"
    />,
  );
  expect(withLink).toContain('See the retraction and provider deletion record');
  expect(withLink).toContain('href="#/expunge/privacy/job-1"');
  const without = renderToStaticMarkup(
    <ReceiptDocument receipt={receipt()} sequence={6} />,
  );
  expect(without).not.toContain('retraction and provider deletion record');
  // Through the panel: the artifact index decides.
  const snap = (
    artifacts: Array<{
      artifactId: string;
      kind: 'retraction';
      committedAtSequence: number;
    }>,
  ) =>
    baseSnapshot('job-1', {
      status: 'succeeded',
      receipt: { receiptId: 'rcpt-1', sequence: 6 },
      artifacts,
    });
  expect(
    renderToStaticMarkup(
      <ReceiptPanel
        snapshot={snap([
          { artifactId: 'r1', kind: 'retraction', committedAtSequence: 3 },
        ])}
        receipt={receipt()}
      />,
    ),
  ).toContain('href="#/expunge/privacy/job-1"');
  expect(
    renderToStaticMarkup(
      <ReceiptPanel snapshot={snap([])} receipt={receipt()} />,
    ),
  ).not.toContain('retraction and provider deletion record');
});
