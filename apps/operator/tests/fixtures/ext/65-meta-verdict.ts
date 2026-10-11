/** FIXTURE stored preregistered meta verdicts (a TIE and a GAIN). Synthetic test data only; no result here is real. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  CampaignView,
} from '../../../src/shared/expunge.js';

export default function registerMetaVerdicts(state: FixtureState) {
  const existing = state.artifacts.get('campaign-meta-1') as
    ArtifactEnvelope<CampaignView> | undefined;
  if (existing)
    existing.payload.metaVerdict = {
      verdict: 'tie',
      incidents: 8,
      wins: 3,
      losses: 2,
      ties: 3,
      p: 1,
      net: 1,
      noiseNet: 2,
      noDataNet: 1,
    };
  const job = state.jobs.get('job-incomplete');
  if (!job) return;
  const view: CampaignView = {
    campaignId: 'campaign-meta-2',
    kind: 'meta',
    manifestHash: hex('manifest-campaign-meta-2'),
    plannedRows: 1,
    w0ResetProof: 'w0-reset-proof-3',
    budgetHash: hex('budget-equal'),
    rows: [
      {
        campaignId: 'campaign-meta-2',
        manifestHash: hex('manifest-campaign-meta-2'),
        kind: 'meta',
        rowId: 'g-1',
        admitted: true,
        w0ResetProof: 'w0-reset-proof-3',
        budgetHash: hex('budget-equal'),
        result: 'measured',
      },
    ],
    quarantined: [],
    noiseControl: { present: true, rowId: 'g-noise' },
    noDataControl: { present: true, rowId: 'g-nodata' },
    metaVerdict: {
      verdict: 'gain',
      incidents: 8,
      wins: 7,
      losses: 1,
      ties: 0,
      p: 0.0703125,
      net: 6,
      noiseNet: 1,
      noDataNet: 0,
    },
  };
  state.artifacts.set('campaign-meta-2', {
    artifactId: 'campaign-meta-2',
    kind: 'campaign',
    jobId: 'job-incomplete',
    committedAtSequence: 4,
    contentHash: hex('campaign-meta-2'),
    payload: view,
  });
  job.snapshot.artifacts = [
    ...job.snapshot.artifacts,
    { artifactId: 'campaign-meta-2', kind: 'campaign', committedAtSequence: 4 },
  ];
}
