/** FIXTURE evidence bundles: partial and truncated, complete, and dead-lettered. Synthetic test data only; ids are not real Raindrop ids. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  EvidenceBundleView,
} from '../../../src/shared/expunge.js';

const source = (
  n: number,
  patch: Partial<EvidenceBundleView['sources'][number]> = {},
): EvidenceBundleView['sources'][number] => ({
  provider: 'raindrop',
  externalEventId: `evt_fixture_${n}`,
  externalTraceId: `trace_fixture_${n}`,
  externalSignalIds: [`sig_fixture_${n}`],
  localSourceIds: [`local-${n}`],
  origin: 'raindrop_classifier',
  redactionPolicy: 'sanitize-v1',
  retrievedAt: '2026-10-11T09:20:00.000Z',
  contentHash: hex(`evidence-source-${n}`),
  permittedUse: 'training',
  ...patch,
});

export default function registerEvidence(state: FixtureState) {
  const attach = (jobId: string, bundle: EvidenceBundleView) => {
    const job = state.jobs.get(jobId);
    if (!job) return;
    const envelope: ArtifactEnvelope<EvidenceBundleView> = {
      artifactId: bundle.evidenceId,
      kind: 'evidence_bundle',
      jobId,
      committedAtSequence: 3,
      contentHash: hex(bundle.evidenceId),
      payload: bundle,
    };
    state.artifacts.set(bundle.evidenceId, envelope);
    job.snapshot.artifacts = [
      ...job.snapshot.artifacts,
      {
        artifactId: bundle.evidenceId,
        kind: 'evidence_bundle',
        committedAtSequence: 3,
      },
    ];
  };
  attach('job-evidence', {
    evidenceId: 'ev-partial',
    split: 'train',
    sources: [
      source(1),
      source(2, {
        origin: 'verifier_feedback',
        permittedUse: 'gate_only',
        externalSignalIds: [],
      }),
      source(3, {
        origin: 'agent_self_report',
        permittedUse: 'display_only',
        externalTraceId: undefined,
      }),
    ],
    tools: [
      {
        toolId: 'inspect_scope',
        decision: 'allow',
        summary: 'Inspected the registered scope.',
      },
      {
        toolId: 'apply_cleanup_batch',
        decision: 'ask',
        summary: 'Batch needs approval.',
      },
    ],
    diagnostics: [
      'The worker did not inspect payments_archive before completing.',
    ],
    confidence: 0.6,
    outbox: [
      { state: 'pending', at: '2026-10-11T09:00:00.000Z' },
      { state: 'sdk_enqueued', at: '2026-10-11T09:00:05.000Z' },
      { state: 'ingest_accepted', at: '2026-10-11T09:00:10.000Z' },
      { state: 'query_visible', at: '2026-10-11T09:01:00.000Z' },
    ],
    truncated: true,
    missing: ['required span', 'classifier signal'],
    retryAttempts: 1,
  });
  attach('job-approval', {
    evidenceId: 'ev-ready',
    split: 'validation',
    sources: [source(4)],
    tools: [
      {
        toolId: 'verify_registered_scope',
        decision: 'allow',
        summary: 'Verified the scope.',
      },
    ],
    diagnostics: [],
    confidence: 0.9,
    outbox: [
      { state: 'pending', at: '2026-10-11T09:00:00.000Z' },
      { state: 'evidence_ready', at: '2026-10-11T09:05:00.000Z' },
    ],
    truncated: false,
    missing: [],
    retryAttempts: 0,
  });
  attach('job-failed', {
    evidenceId: 'ev-dead',
    split: 'train',
    sources: [],
    tools: [],
    diagnostics: ['Raindrop ingest was unreachable for every attempt.'],
    confidence: 0,
    outbox: [
      { state: 'pending', at: '2026-10-11T09:00:00.000Z' },
      { state: 'retrying', at: '2026-10-11T09:10:00.000Z' },
      { state: 'dead_letter', at: '2026-10-11T09:40:00.000Z' },
    ],
    truncated: false,
    missing: ['terminal event'],
    retryAttempts: 5,
  });
}
