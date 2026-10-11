/** FIXTURE completion receipts and a model narrative. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex, later } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  CompletionReceiptView,
  ModelNarrativeView,
} from '../../../src/shared/expunge.js';

export default function registerReceipts(state: FixtureState) {
  for (const [jobId, complete] of [
    ['job-complete', true],
    ['job-incomplete', false],
  ] as const) {
    const job = state.jobs.get(jobId);
    if (!job) continue;
    const receiptId = `rcpt-${jobId}`;
    const receipt: CompletionReceiptView = {
      receiptId,
      jobId,
      runId: `run-${jobId}`,
      harnessHash: hex('harness-w0'),
      scopeId: job.snapshot.scope.scopeId,
      scopeRevision: job.snapshot.scope.scopeRevision,
      verifiedWorldRevision: 215,
      verificationPlanHash: hex(`plan-${jobId}`),
      inspectedCollectionIds: job.snapshot.coverage.inspectedCollectionIds,
      discoveredFieldIds: job.snapshot.coverage.discoveredFieldIds,
      operationalResiduals: complete ? 0 : 2,
      excludedOrRetainedRecords: 3,
      limitations: complete
        ? ['Backups and exports outside the registry are not covered.']
        : [
            'payments_archive is registered but was not inspected.',
            'Backups and exports outside the registry are not covered.',
          ],
      domainStatus: complete ? 'complete_in_registered_scope' : 'incomplete',
      externalErasureStatus: 'pending',
      registeredCollectionIds: job.snapshot.coverage.registeredCollectionIds,
      effectCounts: { delete: 1, redact: 6, tombstone: 2 },
      actionReceiptIds: ['act-1', 'act-2'],
      committedAt: later(900),
    };
    const envelope: ArtifactEnvelope<CompletionReceiptView> = {
      artifactId: receiptId,
      kind: 'completion_receipt',
      jobId,
      committedAtSequence: 6,
      contentHash: hex(`receipt-${jobId}`),
      payload: receipt,
    };
    state.artifacts.set(receiptId, envelope);
    const narrativeId = `narr-${jobId}`;
    const narrative: ArtifactEnvelope<ModelNarrativeView> = {
      artifactId: narrativeId,
      kind: 'model_narrative',
      jobId,
      committedAtSequence: 5,
      contentHash: null,
      payload: {
        jobId,
        text: 'I removed every record that referenced the subject and everything is clean.',
        replayed: true,
        producedAt: later(800),
      },
    };
    state.artifacts.set(narrativeId, narrative);
    job.snapshot.artifacts = [
      {
        artifactId: receiptId,
        kind: 'completion_receipt',
        committedAtSequence: 6,
      },
      {
        artifactId: narrativeId,
        kind: 'model_narrative',
        committedAtSequence: 5,
      },
    ];
  }
}
