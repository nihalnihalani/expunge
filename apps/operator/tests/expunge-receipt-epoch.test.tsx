import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ReceiptCell } from '../src/client/expunge/views/JobsHomeView';
import { ErrorState } from '../src/client/expunge/components/StateViews';
import { ExpungeApiError } from '../src/client/expunge/api';
import {
  readTelemetry,
  resetTelemetryCache,
} from '../src/client/expunge/TelemetryNotice';
import {
  jobListSchema,
  parseEventsPage,
  snapshotSchema,
} from '../src/server/expunge/schemas';
import type { ExpungeJobListItem } from '../src/shared/expunge';
import { baseSnapshot, event, startedPayload } from './fixtures/expunge-data';

const item = (patch: Partial<ExpungeJobListItem>): ExpungeJobListItem => ({
  jobId: 'job-1',
  kind: 'cleanup',
  status: 'succeeded',
  sequence: 6,
  updatedAt: '2026-10-11T10:00:00.000Z',
  ...patch,
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetTelemetryCache();
});

it('DA-7 S1a: a verdict without a committed receipt reference renders no "Complete"', () => {
  for (const patch of [
    { receiptDomainStatus: 'complete_in_registered_scope' as const },
    {
      receiptDomainStatus: 'complete_in_registered_scope' as const,
      receiptId: 'r1',
    },
    {
      receiptDomainStatus: 'complete_in_registered_scope' as const,
      receiptId: 'r1',
      receiptSequence: 6,
    },
  ]) {
    const html = renderToStaticMarkup(<ReceiptCell item={item(patch)} />);
    expect(html).not.toContain('Complete');
    expect(html).not.toContain('ex-seal');
    expect(html).toContain('Receipt reference missing');
  }
  const none = renderToStaticMarkup(<ReceiptCell item={item({})} />);
  expect(none).toContain('No receipt committed');
  expect(none).not.toContain('ex-seal');
});

it('DA-7 S1b: a succeeded job with a receipt renders exactly one receipt seal with the revision', () => {
  const html = renderToStaticMarkup(
    <ReceiptCell
      item={item({
        receiptDomainStatus: 'complete_in_registered_scope',
        receiptId: 'rcpt-job-1',
        receiptSequence: 6,
        verifiedWorldRevision: 215,
      })}
    />,
  );
  expect(html.match(/class="ex-seal"/g)).toHaveLength(1);
  expect(html).toContain('data-source-kind="receipt"');
  expect(html).toContain('event 6');
  expect(html).toContain('Complete in registered scope');
  expect(html).toContain('as of world revision 215');
});

it('keeps an incomplete verdict visibly incomplete, with its seal', () => {
  const html = renderToStaticMarkup(
    <ReceiptCell
      item={item({
        receiptDomainStatus: 'incomplete',
        receiptId: 'rcpt-job-2',
        receiptSequence: 6,
        verifiedWorldRevision: 9,
      })}
    />,
  );
  expect(html).not.toContain('Complete in registered scope');
  expect(html).toContain('ncomplete');
});

it('carries the stream epoch and receipt reference through the server schemas', () => {
  const list = jobListSchema.parse({
    items: [
      item({
        receiptDomainStatus: 'complete_in_registered_scope',
        receiptId: 'rcpt-job-1',
        receiptSequence: 6,
        verifiedWorldRevision: 215,
      }),
    ],
    nextCursor: null,
  });
  expect(list.items[0].receiptId).toBe('rcpt-job-1');
  expect(list.items[0].verifiedWorldRevision).toBe(215);
  const snapshot = snapshotSchema.parse({
    ...baseSnapshot('job-1', { sequence: 3 }),
    streamEpoch: 'epoch-7',
  });
  expect(snapshot.streamEpoch).toBe('epoch-7');
  const page = parseEventsPage(
    {
      events: [event('job-1', 1, 'job_started', startedPayload)],
      nextSequence: 1,
      streamEpoch: 'epoch-7',
    },
    'job-1',
    0,
  );
  expect(page.streamEpoch).toBe('epoch-7');
  expect(
    parseEventsPage(
      {
        events: [event('job-1', 1, 'job_started', startedPayload)],
        nextSequence: 1,
      },
      'job-1',
      0,
    ),
  ).not.toHaveProperty('streamEpoch');
});

it('DA-7 TN1: an unreadable telemetry answer is not cached, so a later read sees the server state', async () => {
  const answers = [
    new Response('{}', { status: 401 }),
    new Response(JSON.stringify({ telemetry: 'disabled' }), { status: 200 }),
  ];
  const fetchMock = vi.fn(async () => answers.shift()!);
  vi.stubGlobal('fetch', fetchMock);
  expect(await readTelemetry()).toBe('unknown');
  expect(await readTelemetry()).toBe('disabled');
  // A readable answer stays cached.
  expect(await readTelemetry()).toBe('disabled');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('DA-7 K1 UI: owner_auth_required is shown as blocked access with the variable name, not a generic failure', () => {
  const html = renderToStaticMarkup(
    <ErrorState
      what="jobs"
      error={
        new ExpungeApiError('http', 401, 'owner_auth_required', 'x', [
          'OWNER_TOKEN',
        ])
      }
    />,
  );
  expect(html).toContain('Jobs is unavailable');
  expect(html).toContain('owner access token');
  expect(html).toContain('OWNER_TOKEN');
  expect(html).not.toContain('Could not load');
});
