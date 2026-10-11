import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  ERASURE_STATUS_COPY,
  ErasureLifecycle,
  PrivacyDocument,
  completionClaim,
  type ErasureData,
  type PrivacyData2,
} from '../src/client/expunge/views/PrivacyView';

const h = (c: string) => c.repeat(64);
const erasure = (patch: Partial<ErasureData> = {}): ErasureData => ({
  requestKey: 'req-1',
  providerStatus: 'pending',
  regulation: 'gdpr',
  subjectCount: 1,
  receivedAt: '2026-10-11T08:00:00.000Z',
  dueBy: '2026-11-10T08:00:00.000Z',
  completedAt: null,
  localExportSuppression: 'active',
  history: [
    { at: '2026-10-11T08:00:05.000Z', status: 'pending', snapshotHash: h('a') },
  ],
  revokedPendingEntries: 2,
  ...patch,
});
const data = (patch: Partial<PrivacyData2> = {}): PrivacyData2 => ({
  retractionId: 'r1',
  sourceId: 's1',
  progress: {
    retractionId: 'r1',
    sourceId: 's1',
    frontierSize: 3,
    visited: 9,
    closureComplete: false,
    revoked: 4,
    regenerated: 1,
    runsCancelled: 0,
    failClosed: false,
  },
  edges: [{ edgeKey: 'e1', fromId: 'a', toId: 's1', kind: 'derived_from' }],
  eligibility: [
    {
      artifactHash: h('b'),
      state: 'revoked',
      reasonCode: 'source_deleted',
      sourceIds: ['s1'],
    },
  ],
  erasure: erasure(),
  retainedBytesCheck: { state: 'not_checked', violations: 0 },
  ...patch,
});
const render = (e: ErasureData | null) =>
  renderToStaticMarkup(<ErasureLifecycle erasure={e} />);

it('words every lifecycle state, with submission_ambiguous exactly as ruled', () => {
  expect(Object.keys(ERASURE_STATUS_COPY).sort()).toEqual(
    [
      'unsubmitted',
      'submitting',
      'submission_ambiguous',
      'pending',
      'in_progress',
      'completed',
      'rejected',
      'cancelled',
    ].sort(),
  );
  expect(ERASURE_STATUS_COPY.submission_ambiguous).toBe(
    'The provider may or may not have received this request; it will not be resent automatically; a person must reconcile it.',
  );
  const html = render(erasure({ providerStatus: 'submission_ambiguous' }));
  expect(html).toContain('may or may not have received');
  expect(html).toContain('Needs a person');
  expect(html).toContain('Nothing will resend this request on its own');
  expect(html).not.toContain('Provider completion time');
});

it('never shows completed without the provider completion time', () => {
  const noTime = render(
    erasure({ providerStatus: 'completed', completedAt: null }),
  );
  expect(noTime).toContain('Not shown as complete');
  expect(noTime).toContain('completed, no completion time');
  expect(noTime).not.toContain('Provider completion time');
  expect(completionClaim(erasure({ providerStatus: 'completed' }))).toEqual({
    ok: false,
  });
  const withTime = render(
    erasure({
      providerStatus: 'completed',
      completedAt: '2026-10-11T09:15:00.000Z',
    }),
  );
  expect(withTime).toContain('Provider completion time');
  expect(withTime).not.toContain('Not shown as complete');
  expect(completionClaim(erasure({ providerStatus: 'pending' }))).toBeNull();
  // A pending request with a stray completion time is still pending, never complete.
  const stray = render(
    erasure({
      providerStatus: 'pending',
      completedAt: '2026-10-11T09:15:00.000Z',
    }),
  );
  expect(stray).not.toContain('Provider completion time');
  expect(stray).toContain('has not completed it');
});

it('does not interpret a status it does not know', () => {
  const html = render(erasure({ providerStatus: 'teleported' }));
  expect(html).toContain('status not recognized');
  expect(html).toContain('not interpreted');
});

it('falls back to "not recorded" when no erasure request is reported', () => {
  const html = render(null);
  expect(html).toContain('No provider erasure request is recorded');
  expect(html).toContain('not a statement that none is owed');
});

it('shows retraction progress with the fail-closed state and an incomplete closure', () => {
  const html = renderToStaticMarkup(
    <PrivacyDocument
      data={data({
        progress: { ...data().progress, failClosed: true },
      })}
    />,
  );
  expect(html).toContain('Failed closed');
  expect(html).toContain('derivation closure not complete');
  expect(html).toContain('known so far, not a complete list');
  expect(html).toContain(
    'Not checked, so no claim is made about retained bytes',
  );
  expect(html).toContain('Frontier');
  expect(html).toContain('derived from');
});

it('says a complete closure is complete and reports the retained-bytes check when it ran', () => {
  const html = renderToStaticMarkup(
    <PrivacyDocument
      data={data({
        progress: {
          ...data().progress,
          closureComplete: true,
          frontierSize: 0,
        },
        retainedBytesCheck: { state: 'checked', violations: 2 },
      })}
    />,
  );
  expect(html).toContain('derivation closure complete');
  expect(html).not.toContain('known so far');
  expect(html).toContain('Checked: 2 violations');
  expect(html).not.toContain('Failed closed');
});

it('lists artifact eligibility by state with its reason and sources', () => {
  const html = renderToStaticMarkup(<PrivacyDocument data={data()} />);
  expect(html).toContain('Learning eligibility of derived artifacts');
  expect(html).toContain('source_deleted');
  expect(html).toContain('revoked');
  expect(html).not.toContain('ex-seal');
});

it('the closure chip state and its label both follow progress.closureComplete, so forcing either fails', () => {
  const chip = (closureComplete: boolean) => {
    const html = renderToStaticMarkup(
      <PrivacyDocument
        data={data({ progress: { ...data().progress, closureComplete } })}
      />,
    );
    const match = html.match(
      /data-state="([a-z_]+)"[^>]*>(?:(?!<\/span>)[\s\S])*?(derivation closure (?:not )?complete)/,
    );
    return { state: match?.[1], label: match?.[2] };
  };
  expect(chip(true)).toEqual({
    state: 'ok',
    label: 'derivation closure complete',
  });
  expect(chip(false)).toEqual({
    state: 'incomplete',
    label: 'derivation closure not complete',
  });
});
