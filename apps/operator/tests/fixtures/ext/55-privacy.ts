/** FIXTURE retraction and provider erasure records. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  PrivacyView,
} from '../../../src/shared/expunge.js';

const base = (
  jobId: string,
  patch: Partial<PrivacyView>,
): ArtifactEnvelope<PrivacyView> => ({
  artifactId: `retraction-${jobId}`,
  kind: 'retraction',
  jobId,
  committedAtSequence: 6,
  contentHash: null,
  payload: {
    retractionId: `retraction-${jobId}`,
    sourceId: 'source-7f3a',
    progress: {
      retractionId: `retraction-${jobId}`,
      sourceId: 'source-7f3a',
      frontierSize: 0,
      visited: 12,
      closureComplete: true,
      revoked: 5,
      regenerated: 2,
      runsCancelled: 1,
      failClosed: false,
    },
    edges: [
      {
        edgeKey: 'e1',
        fromId: 'artifact-a',
        toId: 'source-7f3a',
        kind: 'derived_from',
      },
      {
        edgeKey: 'e2',
        fromId: 'artifact-b',
        toId: 'artifact-a',
        kind: 'derived_from',
      },
      {
        edgeKey: 'e3',
        fromId: 'source-7f3a',
        toId: 'source-7f3a',
        kind: 'source_deleted',
      },
    ],
    eligibility: [
      {
        artifactHash: hex('artifact-a'),
        state: 'revoked',
        reasonCode: 'source_deleted',
        sourceIds: ['source-7f3a'],
      },
      {
        artifactHash: hex('artifact-b'),
        state: 'source_deleted',
        reasonCode: 'derived_from_deleted_source',
        sourceIds: ['source-7f3a'],
      },
      {
        artifactHash: hex('artifact-c'),
        state: 'permitted',
        reasonCode: 'independent_source',
        sourceIds: ['source-9c'],
      },
    ],
    erasure: null,
    retainedBytesCheck: { state: 'checked', violations: 0 },
    ...patch,
  },
});

const erasure = (
  providerStatus: 'in_progress' | 'completed' | 'pending',
  completedAt: string | null,
) => ({
  requestKey: 'erasure-req-1',
  providerStatus,
  regulation: 'gdpr' as const,
  subjectCount: 1,
  receivedAt: '2026-10-11T08:00:00.000Z',
  dueBy: '2026-11-10T08:00:00.000Z',
  completedAt,
  localExportSuppression: completedAt
    ? ('released' as const)
    : ('active' as const),
  history: [
    {
      at: '2026-10-11T08:00:05.000Z',
      status: 'pending',
      snapshotHash: hex('h1'),
    },
    {
      at: '2026-10-11T08:30:00.000Z',
      status: providerStatus,
      snapshotHash: hex('h2'),
    },
  ],
  revokedPendingEntries: 3,
});

export default function registerPrivacy(state: FixtureState) {
  const attach = (jobId: string, envelope: ArtifactEnvelope<PrivacyView>) => {
    const job = state.jobs.get(jobId);
    if (!job) return;
    state.artifacts.set(envelope.artifactId, envelope);
    job.snapshot.artifacts = [
      ...job.snapshot.artifacts,
      {
        artifactId: envelope.artifactId,
        kind: 'retraction',
        committedAtSequence: 6,
      },
    ];
  };
  // Retraction still running and failed closed; the provider is working.
  attach(
    'job-complete',
    base('job-complete', {
      progress: {
        retractionId: 'retraction-job-complete',
        sourceId: 'source-7f3a',
        frontierSize: 4,
        visited: 8,
        closureComplete: false,
        revoked: 3,
        regenerated: 0,
        runsCancelled: 1,
        failClosed: true,
      },
      erasure: erasure('in_progress', null),
      retainedBytesCheck: { state: 'not_checked', violations: 0 },
    }),
  );
  // Closure complete and the provider reports completion with its completion time.
  attach(
    'job-incomplete',
    base('job-incomplete', {
      erasure: erasure('completed', '2026-10-11T09:15:00.000Z'),
    }),
  );
  // The provider status says completed but carries no completion time: not shown as complete.
  attach(
    'job-failed',
    base('job-failed', { erasure: erasure('completed', null) }),
  );
}
