/** FIXTURE campaigns: a clean hider campaign and a flawed meta campaign. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  CampaignView,
} from '../../../src/shared/expunge.js';

const row = (
  campaignId: string,
  rowId: string,
  result: 'measured' | 'null' | 'invalid',
  patch: Partial<CampaignView['rows'][number]> = {},
): CampaignView['rows'][number] => ({
  campaignId,
  manifestHash: hex(`manifest-${campaignId}`),
  kind: 'hider',
  rowId,
  admitted: result !== 'invalid',
  w0ResetProof: 'w0-reset-proof-1',
  budgetHash: hex('budget-equal'),
  result,
  ...patch,
});

export default function registerCampaigns(state: FixtureState) {
  const attach = (jobId: string, view: CampaignView) => {
    const job = state.jobs.get(jobId);
    if (!job) return;
    const envelope: ArtifactEnvelope<CampaignView> = {
      artifactId: view.campaignId,
      kind: 'campaign',
      jobId,
      committedAtSequence: 4,
      contentHash: hex(view.campaignId),
      payload: view,
    };
    state.artifacts.set(view.campaignId, envelope);
    job.snapshot.artifacts = [
      ...job.snapshot.artifacts,
      { artifactId: view.campaignId, kind: 'campaign', committedAtSequence: 4 },
    ];
  };
  // Valid hider campaign: equal budgets, reset proof on every row, both controls, mixed results incl. a null.
  attach('job-evidence', {
    campaignId: 'campaign-hider-1',
    kind: 'hider',
    manifestHash: hex('manifest-campaign-hider-1'),
    plannedRows: 4,
    w0ResetProof: 'w0-reset-proof-1',
    budgetHash: hex('budget-equal'),
    rows: [
      row('campaign-hider-1', 'row-1', 'measured'),
      row('campaign-hider-1', 'row-2', 'null'),
      row('campaign-hider-1', 'row-3', 'null'),
      row('campaign-hider-1', 'row-noise', 'measured'),
    ],
    quarantined: [],
    noiseControl: { present: true, rowId: 'row-noise' },
    noDataControl: { present: true, rowId: 'row-3' },
  });
  // Flawed meta campaign: a row with another budget, a row without reset proof, an invalid row,
  // a quarantined row, a missing planned row, no controls.
  attach('job-cancelled', {
    campaignId: 'campaign-meta-1',
    kind: 'meta',
    manifestHash: hex('manifest-campaign-meta-1'),
    plannedRows: 5,
    w0ResetProof: 'w0-reset-proof-2',
    budgetHash: hex('budget-equal'),
    rows: [
      row('campaign-meta-1', 'm-1', 'measured', {
        kind: 'meta',
        w0ResetProof: 'w0-reset-proof-2',
      }),
      row('campaign-meta-1', 'm-2', 'measured', {
        kind: 'meta',
        w0ResetProof: 'w0-reset-proof-2',
        budgetHash: hex('budget-bigger'),
      }),
      row('campaign-meta-1', 'm-3', 'null', {
        kind: 'meta',
        w0ResetProof: undefined,
      }),
      row('campaign-meta-1', 'm-4', 'invalid', {
        kind: 'meta',
        w0ResetProof: 'w0-reset-proof-2',
      }),
    ],
    quarantined: [
      { rowId: 'm-4', reasonCodes: ['unequal_budget', 'duplicate_novelty'] },
    ],
    noiseControl: { present: false, rowId: null },
    noDataControl: { present: false, rowId: null },
  });
}
