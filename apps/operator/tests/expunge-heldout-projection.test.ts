import { expect, it } from 'vitest';
import { describeEvent } from '../src/client/expunge/projection/selectors.js';
import {
  parseArtifact,
  parseEventsPage,
  ProjectionRejected,
} from '../src/server/expunge/schemas.js';
import type {
  CampaignRowPayload,
  CampaignView,
  TrialCompletedPayload,
} from '../src/shared/expunge.js';

// Schema/selector grammar metadata only, not a campaign, admission, event delivery or service response.
// No fixture module, business record, provider or HTTP transport is used.
const trial: TrialCompletedPayload = {
  reportId: null,
  candidateId: 'metadata-candidate',
  pairId: 'metadata-pair',
  family: 'metadata-family',
  verdict: null,
};
const row: CampaignRowPayload = {
  campaignId: 'metadata-campaign',
  manifestHash: 'a'.repeat(64),
  kind: 'meta',
  rowId: 'metadata-row',
  result: 'null',
};
const page = (
  kind: 'trial_completed' | 'campaign_row_committed',
  payload: unknown,
) => ({
  events: [
    {
      eventId: 'metadata-event',
      jobId: 'metadata-job',
      sequence: 1,
      kind,
      artifactIds: [],
      payload,
    },
  ],
  nextSequence: 1,
});
const parse = (
  kind: 'trial_completed' | 'campaign_row_committed',
  payload: unknown,
) => parseEventsPage(page(kind, payload), 'metadata-job', 0).events[0];

it('accepts minimized contract-valid trial and campaign DTOs without hidden fields', async () => {
  const core = (await import(
    new URL('../../../packages/contracts/src/projection.ts', import.meta.url)
      .href
  )) as {
    validateProjectionPayload: (
      kind: 'trial_completed' | 'campaign_row_committed',
      payload: unknown,
    ) => unknown;
  };
  for (const [kind, payload] of [
    ['trial_completed', trial],
    ['campaign_row_committed', row],
  ] as const) {
    expect(core.validateProjectionPayload(kind, payload)).toEqual(payload);
    expect(parse(kind, payload).payload).toEqual(payload);
  }
});

it.each([
  'split',
  'fixtureId',
  'parentUseful',
  'candidateUseful',
  'useful',
  'outcome',
  'outcomes',
  'admitted',
])(
  'refuses forbidden direct key %s for both worker-readable event kinds',
  (key) => {
    for (const [kind, payload] of [
      ['trial_completed', trial],
      ['campaign_row_committed', row],
    ] as const)
      expect(() =>
        parse(kind, { ...payload, [key]: 'private-grammar-marker' }),
      ).toThrow(ProjectionRejected);
  },
);

it('describes an unlinked trial without inventing split, arm outcomes or report availability', () => {
  const description = describeEvent(parse('trial_completed', trial));
  expect(description).toContain('Trial metadata-pair completed.');
  expect(description).toContain('withheld from this event');
  expect(description).toContain('No report is linked yet.');
  expect(description).not.toContain('undefined');
  expect(description).not.toContain('not useful');
  expect(description).not.toContain('Gate verdict:');
});

it('renders only the reported gate verdict and authorized-detail pointer for linked trials', () => {
  for (const verdict of ['admit', 'reject', 'hold'] as const) {
    const description = describeEvent(
      parse('trial_completed', {
        ...trial,
        reportId: 'metadata-report',
        verdict,
      }),
    );
    expect(description).toContain(`Gate verdict: ${verdict}.`);
    expect(description).toContain('linked report with authorized access');
    expect(description).not.toContain('parent useful');
    expect(description).not.toContain('candidate useful');
  }
});

it('retains admission only in separately parsed authorized campaign artifact detail', () => {
  const detail = {
    campaignId: row.campaignId,
    kind: row.kind,
    manifestHash: row.manifestHash,
    plannedRows: 1,
    w0ResetProof: null,
    budgetHash: null,
    rows: [{ ...row, admitted: false }],
    quarantined: [],
    noiseControl: { present: false, rowId: null },
    noDataControl: { present: false, rowId: null },
  };
  const parsed = parseArtifact({
    artifactId: 'metadata-artifact',
    kind: 'campaign',
    jobId: null,
    committedAtSequence: 1,
    contentHash: null,
    payload: detail,
  }).payload as CampaignView;
  expect(parsed.rows[0].admitted).toBe(false);
  const missing = parseArtifact({
    artifactId: 'metadata-artifact',
    kind: 'campaign',
    jobId: null,
    committedAtSequence: 1,
    contentHash: null,
    payload: { ...detail, rows: [row] },
  }).payload as CampaignView;
  expect(missing.rows[0]).not.toHaveProperty('admitted');
  expect(() => parse('campaign_row_committed', detail.rows[0])).toThrow(
    ProjectionRejected,
  );
});

it('describes coarse campaign metadata without inferring row admission', () => {
  const description = describeEvent(parse('campaign_row_committed', row));
  expect(description).toBe(
    'Campaign metadata-campaign row metadata-row: null.',
  );
  expect(description).not.toContain('admitted');
});
