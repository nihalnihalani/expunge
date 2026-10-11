import './fixtures/browser-globals';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NO_VERDICT_TEXT } from '../src/client/expunge/components/MetaVerdict';
import {
  CampaignDocument,
  FIXED_GAIN_SENTENCES,
  RESULT_COPY,
  summarizeCampaign,
  type CampaignDoc,
  type CampaignRow,
} from '../src/client/expunge/views/CampaignView';

const h = (c: string) => c.repeat(64);
const row = (
  rowId: string,
  result: string,
  patch: Partial<CampaignRow> = {},
): CampaignRow => ({
  campaignId: 'c1',
  manifestHash: h('a'),
  kind: 'hider',
  rowId,
  admitted: true,
  w0ResetProof: 'proof',
  budgetHash: h('b'),
  result,
  ...patch,
});
const view = (patch: Partial<CampaignDoc> = {}): CampaignDoc => ({
  campaignId: 'c1',
  kind: 'hider',
  manifestHash: h('a'),
  plannedRows: 3,
  w0ResetProof: 'proof',
  budgetHash: h('b'),
  rows: [
    row('r1', 'measured'),
    row('r2', 'null'),
    row('r3', 'invalid', { admitted: false }),
  ],
  quarantined: [],
  noiseControl: { present: true, rowId: 'r1' },
  noDataControl: { present: true, rowId: 'r2' },
  ...patch,
});
const render = (v: CampaignDoc) =>
  renderToStaticMarkup(<CampaignDocument view={v} />);

it('counts results by their recorded word, including tie and unrecognized, and computes no gain', () => {
  const summary = summarizeCampaign(
    view({
      rows: [
        row('a', 'measured'),
        row('b', 'null'),
        row('c', 'tie'),
        row('d', 'invalid'),
        row('e', 'weird'),
      ],
      plannedRows: 7,
    }),
  );
  expect(summary.counts).toEqual({
    measured: 1,
    null: 1,
    tie: 1,
    invalid: 1,
    unrecognized: 1,
  });
  expect(summary.missing).toBe(2);
  expect(Object.keys(summary)).not.toContain('gain');
});

it('finds rows whose budget or W0 reset proof differs from the campaign, and none when equal', () => {
  const ok = summarizeCampaign(view());
  expect(ok.budgetMismatched).toEqual([]);
  expect(ok.resetMismatched).toEqual([]);
  const bad = summarizeCampaign(
    view({
      rows: [
        row('r1', 'measured', { budgetHash: h('c') }),
        row('r2', 'null', { w0ResetProof: undefined }),
        row('r3', 'measured', { budgetHash: undefined }),
      ],
    }),
  );
  expect(bad.budgetMismatched).toEqual(['r1', 'r3']);
  expect(bad.resetMismatched).toEqual(['r2']);
  // No campaign-level hash: nothing can be called mismatched, and the view says it cannot show equality.
  const none = summarizeCampaign(
    view({ budgetHash: null, w0ResetProof: null }),
  );
  expect(none.budgetMismatched).toEqual([]);
  expect(none.resetMismatched).toEqual([]);
  const html = render(view({ budgetHash: null, w0ResetProof: null }));
  expect(html).toContain('Equal budgets: not shown');
  expect(html).toContain('W0 reset: not shown');
  expect(html).not.toContain('Equal budgets: all');
});

it('states equal budgets only when every row carries the campaign budget hash', () => {
  expect(render(view())).toContain(
    'Equal budgets: all 3 rows carry the campaign&#x27;s budget hash',
  );
  const mismatch = render(
    view({
      rows: [row('r1', 'measured', { budgetHash: h('c') })],
      plannedRows: 1,
    }),
  );
  expect(mismatch).toContain('Budget mismatch: 1 row');
  expect(mismatch).toContain('differs from campaign');
  expect(mismatch).not.toContain('Equal budgets: all');
});

it('words a null result as a result and never states a gain', () => {
  const html = render(view());
  expect(html).toContain(RESULT_COPY.null);
  expect(html).toContain('A null result is a result');
  expect(html).toContain('It states no gain and no conclusion');
  expect(html).not.toMatch(/improv|\bgain of\b|\+\d+%/i);
});

it('flags missing rows, missing controls and quarantine reasons', () => {
  const html = render(
    view({
      plannedRows: 5,
      noiseControl: { present: false, rowId: null },
      noDataControl: { present: false, rowId: null },
      quarantined: [
        { rowId: 'r3', reasonCodes: ['unequal_budget', 'duplicate_novelty'] },
      ],
    }),
  );
  expect(html).toContain('3 of 5 planned rows recorded');
  expect(html).toContain('2 not recorded');
  expect(html).toContain('cannot be separated from noise');
  expect(html).toContain('cannot be separated from the harness doing nothing');
  expect(html).toContain('unequal_budget');
  expect(html).toContain('duplicate_novelty');
});

it('says what is missing when no W0 reset proof or budget is recorded, and that novelty is not reported', () => {
  const html = render(view({ w0ResetProof: null, budgetHash: null }));
  expect(html).toContain('Rows cannot be attributed to a clean baseline');
  expect(html).toContain('Equal budgets cannot be shown');
  expect(html).toContain('Novelty is not part of this projection');
  expect(render(view({ rows: [], plannedRows: 0 }))).toContain(
    'No rows are recorded',
  );
});

it('shows an unrecognized row result as not interpreted and the hider/meta heading from kind', () => {
  const html = render(
    view({ kind: 'meta', rows: [row('r1', 'weird')], plannedRows: 1 }),
  );
  expect(html).toContain('Meta campaign');
  expect(html).toContain('not recognized');
  expect(html).toContain('not interpreted');
  expect(render(view())).toContain('Hider campaign');
  expect(render(view())).not.toContain('ex-seal');
});

it('with no recorded rows it says so and makes no equal-budget or reset claim', () => {
  const html = render(view({ rows: [], plannedRows: 4 }));
  expect(html).toContain(
    'Equal budgets: no rows recorded yet, so nothing is compared.',
  );
  expect(html).toContain(
    'W0 reset: no rows recorded yet, so nothing is compared.',
  );
  expect(html).not.toContain('Equal budgets: all');
  expect(html).not.toContain('carry the campaign');
  expect(html).toContain('0 of 4 planned rows recorded');
  expect(html).toContain('No rows are recorded');
});

it('words a single row correctly', () => {
  const html = render(view({ rows: [row('r1', 'measured')], plannedRows: 1 }));
  expect(html).toContain(
    'Equal budgets: the 1 row carries the campaign&#x27;s budget hash.',
  );
  expect(html).toContain(
    'W0 reset: the 1 row carries the campaign&#x27;s reset proof.',
  );
});

/** Removes the fixed disclaimer sentences (as rendered), leaving only data and labels. */
const withoutDisclaimers = (html: string) => {
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return [...Object.values(FIXED_GAIN_SENTENCES), NO_VERDICT_TEXT].reduce(
    (rest, sentence) => rest.replace(sentence, ' '),
    text,
  );
};

it('renders no gain, improvement or percentage wording outside the fixed disclaimer sentences, whatever the rows are', () => {
  const variants: CampaignDoc[] = [
    view(),
    // measured far above null, then far below: no computed difference may appear either way
    view({
      rows: [
        row('a', 'measured'),
        row('b', 'measured'),
        row('c', 'measured'),
        row('d', 'null'),
      ],
      plannedRows: 4,
    }),
    view({
      rows: [
        row('a', 'null'),
        row('b', 'null'),
        row('c', 'null'),
        row('d', 'measured'),
      ],
      plannedRows: 4,
    }),
    view({
      rows: [
        row('a', 'tie', {
          incidentOutcome: 'tie',
          successes: { a: 3, b: 3, runs: 6 },
        }),
      ],
      plannedRows: 1,
    }),
    view({ kind: 'meta', rows: [], plannedRows: 8 }),
    view({
      noiseControl: { present: false, rowId: null },
      noDataControl: { present: false, rowId: null },
      w0ResetProof: null,
      budgetHash: null,
    }),
  ];
  for (const variant of variants) {
    const rest = withoutDisclaimers(render(variant));
    expect(rest).not.toMatch(/gain|improv|\+\d+%/i);
  }
  // The disclaimers themselves are present, so the strip is doing real work.
  expect(render(view())).toContain('It states no gain and no conclusion');
  expect(
    Object.values(FIXED_GAIN_SENTENCES).every((sentence) =>
      /gain/i.test(sentence),
    ),
  ).toBe(true);
  // Negative control: a computed difference would be caught by the same check.
  const mutant = render(view()).replace(
    '>Campaign rows<',
    '>Campaign rows gain +2<',
  );
  expect(withoutDisclaimers(mutant)).toMatch(/gain|\+\d+%/i);
});

it('shows the incident outcome as its own field, not as a validity result', () => {
  const html = render(
    view({
      rows: [
        row('a', 'measured', {
          incidentOutcome: 'win',
          successes: { a: 4, b: 2, runs: 6 },
        }),
        row('b', 'measured'),
      ],
      plannedRows: 2,
    }),
  );
  expect(html).toContain('Incident outcome');
  expect(html).toContain('win');
  expect(html).toContain('workers 4 and 2 of 6 runs');
  expect(html).toContain('not reported');
});

it('meta campaigns show the stored verdict section (or "none recorded"); hider campaigns show none', () => {
  const stored = render(
    view({
      kind: 'meta',
      metaVerdict: {
        verdict: 'tie',
        incidents: 8,
        wins: 3,
        losses: 2,
        ties: 3,
        p: 1,
        net: 1,
        noiseNet: -2,
        noDataNet: 1,
      },
    }),
  );
  expect(stored).toContain('Preregistered verdict');
  expect(stored).toContain('stored verdict: TIE');
  expect(render(view({ kind: 'meta' }))).toContain(
    'No preregistered verdict recorded',
  );
  expect(render(view({ kind: 'hider' }))).not.toContain(
    'Preregistered verdict',
  );
});
