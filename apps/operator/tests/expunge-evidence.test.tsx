import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  EvidenceDocument,
  EvidenceSummary,
  LADDER,
  OUTBOX_COPY,
  OutboxLadder,
  ORIGIN_COPY,
  ladderIndex,
} from '../src/client/expunge/views/EvidenceView';
import { OUTBOX_STATES, SOURCE_ORIGINS } from '../src/shared/expunge';
import type { EvidenceBundleView, OutboxState } from '../src/shared/expunge';

const bundle = (
  patch: Partial<EvidenceBundleView> = {},
): EvidenceBundleView => ({
  evidenceId: 'ev-1',
  split: 'train',
  sources: [
    {
      provider: 'raindrop',
      externalEventId: 'evt_1',
      externalTraceId: 'trace_1',
      externalSignalIds: ['sig_1'],
      localSourceIds: ['l1'],
      origin: 'raindrop_classifier',
      redactionPolicy: 'sanitize-v1',
      retrievedAt: '2026-10-11T09:20:00.000Z',
      contentHash: 'a'.repeat(64),
      permittedUse: 'training',
    },
  ],
  tools: [
    { toolId: 'inspect_scope', decision: 'allow', summary: 'Inspected.' },
  ],
  diagnostics: [],
  confidence: 0.5,
  outbox: [{ state: 'pending', at: '2026-10-11T09:00:00.000Z' }],
  truncated: false,
  missing: [],
  retryAttempts: 0,
  ...patch,
});
const render = (b: EvidenceBundleView) =>
  renderToStaticMarkup(<EvidenceDocument bundle={b} />);

it('words every outbox state and every origin, so none is silently dropped', () => {
  expect(Object.keys(OUTBOX_COPY).sort()).toEqual([...OUTBOX_STATES].sort());
  expect(Object.keys(ORIGIN_COPY).sort()).toEqual([...SOURCE_ORIGINS].sort());
  expect(LADDER).toEqual([
    'pending',
    'leased',
    'sdk_enqueued',
    'ingest_accepted',
    'query_visible',
    'evidence_ready',
  ]);
});

it('marks how far the ladder was reached, and says enqueueing is not proof of delivery', () => {
  const html = renderToStaticMarkup(<OutboxLadder state="ingest_accepted" />);
  expect(html.match(/data-reached="yes"/g)).toHaveLength(4);
  expect(html.match(/data-reached="no"/g)).toHaveLength(2);
  expect(html).toContain('aria-current="step"');
  expect(html).toContain('(not reached)');
  expect(renderToStaticMarkup(<OutboxLadder state="sdk_enqueued" />)).toContain(
    'Enqueueing is not proof of delivery',
  );
  expect(ladderIndex('evidence_ready')).toBe(5);
  expect(ladderIndex('retrying')).toBe(-1);
  expect(ladderIndex(null)).toBe(-1);
});

it('only evidence_ready is shown as ready; dead_letter is a failure, retrying is not progress', () => {
  const chip = (state: OutboxState) => {
    const html = renderToStaticMarkup(<OutboxLadder state={state} />);
    return html.match(/class="ex-chip[^"]*" data-state="([a-z_]+)"/)?.[1];
  };
  expect(chip('evidence_ready')).toBe('ok');
  expect(chip('dead_letter')).toBe('fail');
  expect(chip('retrying')).toBe('retrying');
  for (const state of [
    'pending',
    'leased',
    'sdk_enqueued',
    'ingest_accepted',
    'query_visible',
  ] as const)
    expect(chip(state)).toBe('waiting_evidence');
  const dead = renderToStaticMarkup(<OutboxLadder state="dead_letter" />);
  expect(dead).toContain('NOT available');
  expect(dead).toContain('not a clean result');
  expect(dead.match(/data-reached="yes"/g)).toBeNull();
  expect(renderToStaticMarkup(<OutboxLadder state={null} />)).toContain(
    'none is claimed',
  );
});

it('shows Raindrop event and trace ids, signals, origins and permitted use, with no invented URL', () => {
  const html = render(bundle());
  expect(html).toContain('evt_1');
  expect(html).toContain('trace_1');
  expect(html).toContain('sig_1');
  expect(html).toContain('A Raindrop classifier');
  expect(html).toContain('may be used to propose and train');
  expect(html).not.toContain('href=');
  expect(html).toContain('Origin says who produced a piece of evidence');
});

it('keeps origins distinct and shows absent ids as none', () => {
  const html = render(
    bundle({
      sources: [
        {
          ...bundle().sources[0],
          origin: 'agent_self_report',
          externalTraceId: undefined,
          externalEventId: undefined,
          permittedUse: 'display_only',
          externalSignalIds: [],
        },
        {
          ...bundle().sources[0],
          origin: 'verifier_feedback',
          contentHash: 'b'.repeat(64),
          permittedUse: 'revoked',
        },
      ],
    }),
  );
  expect(html).toContain('The agent reported it about itself');
  expect(html).toContain('The verifier');
  expect(html).toContain('display only, never learned from');
  expect(html).toContain('revoked: not usable');
  expect(html).toContain('none');
});

it('shows truncated and missing components as pending, never as clean', () => {
  const html = render(
    bundle({
      truncated: true,
      missing: ['required span', 'classifier signal'],
      retryAttempts: 2,
    }),
  );
  expect(html).toContain('Truncated');
  expect(html).toContain('may be incomplete');
  expect(html).toContain('Missing components');
  expect(html).toContain('required span');
  expect(html).toContain('this evidence is pending, not clean');
  expect(html).toContain('2 retry attempts recorded');
  const clean = render(bundle());
  expect(clean).toContain('No component is recorded as missing');
  expect(clean).not.toContain('Truncated');
});

it('derives the delivery state from the last recorded outbox entry, not from the bundle being present', () => {
  const html = render(
    bundle({
      outbox: [
        { state: 'pending', at: null },
        { state: 'query_visible', at: '2026-10-11T09:00:00.000Z' },
      ],
    }),
  );
  expect(html).toContain('Visible to a separate read-back query');
  expect(html).not.toContain('Read back from Raindrop: every component');
  expect(html).toContain('not recorded');
  const none = render(bundle({ outbox: [] }));
  expect(none).toContain('none is claimed');
});

it('treats a missing remote read-back as pending, not as no failures, in the job summary', () => {
  const waiting = renderToStaticMarkup(
    <EvidenceSummary
      snapshot={{
        status: 'waiting_evidence',
        evidence: {
          outboxState: 'query_visible',
          evidenceReady: false,
          truncated: true,
        },
      }}
    />,
  );
  expect(waiting).toContain('evidence pending, not');
  expect(waiting).toContain('evidence not ready');
  expect(waiting).toContain('truncated');
  const ready = renderToStaticMarkup(
    <EvidenceSummary
      snapshot={{
        status: 'running',
        evidence: {
          outboxState: 'evidence_ready',
          evidenceReady: true,
          truncated: false,
        },
      }}
    />,
  );
  expect(ready).toContain('evidence ready');
  expect(ready).not.toContain('Waiting for evidence');
  expect(
    renderToStaticMarkup(<EvidenceDocument bundle={bundle()} />),
  ).not.toContain('ex-seal');
});

it('a bundle that is evidence_ready but TRUNCATED is not shown as fully ready: the chip is downgraded and the copy is qualified', () => {
  const chip = (html: string) =>
    html.match(
      /class="ex-chip[^"]*" data-state="([a-z_]+)"[^>]*>(?:(?!<\/span>)[\s\S])*?(evidence ready(?:, truncated)?)/,
    );
  const ladderTruncated = renderToStaticMarkup(
    <OutboxLadder state="evidence_ready" truncated />,
  );
  expect(ladderTruncated).toContain('evidence ready, truncated');
  expect(ladderTruncated).toContain(
    'up to the cap; later components may be missing',
  );
  expect(ladderTruncated).not.toContain(
    'every component the proposal needs is proven',
  );
  expect(ladderTruncated).not.toMatch(/data-state="ok"/);
  expect(chip(ladderTruncated)?.[1]).toBe('incomplete');
  const ladderClean = renderToStaticMarkup(
    <OutboxLadder state="evidence_ready" />,
  );
  expect(ladderClean).toMatch(/data-state="ok"/);
  expect(ladderClean).toContain('every component the proposal needs is proven');
  // The whole bundle: banner and chip agree.
  const html = renderToStaticMarkup(
    <EvidenceDocument
      bundle={bundle({
        truncated: true,
        tools: [],
        outbox: [{ state: 'evidence_ready', at: '2026-10-11T09:05:00.000Z' }],
      })}
    />,
  );
  expect(html).toContain('Truncated.');
  expect(html).toContain('evidence ready, truncated');
  expect(html).not.toMatch(/data-state="ok"/);
  expect(html).not.toContain('every component the proposal needs is proven');
  // The job-level summary says the same.
  const summary = renderToStaticMarkup(
    <EvidenceSummary
      snapshot={{
        status: 'running',
        evidence: {
          outboxState: 'evidence_ready',
          evidenceReady: true,
          truncated: true,
        },
      }}
    />,
  );
  expect(summary).toContain('evidence ready, truncated');
  expect(summary).not.toMatch(/data-state="ok"/);
  expect(chip(summary)?.[1]).toBe('incomplete');
});
