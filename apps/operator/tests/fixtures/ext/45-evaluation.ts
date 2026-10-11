/** FIXTURE gate reports: an admitted candidate with a protected row and a rejected unsafe one. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import { hex } from '../expunge-data.js';
import type {
  ArtifactEnvelope,
  GateReportView,
  TrialMetricsView,
  TrialPairView,
} from '../../../src/shared/expunge.js';

const metrics = (patch: Partial<TrialMetricsView> = {}): TrialMetricsView => ({
  usefulCompletion: true,
  targetedResiduals: 0,
  unrelatedRecordChanges: 0,
  retentionViolations: 0,
  truthfulTerminal: true,
  refused: false,
  timedOut: false,
  failed: false,
  retryFailures: 0,
  tokens: 4200,
  costMicrousd: 8400,
  unpricedCalls: 0,
  wallTimeMs: 9100,
  ...patch,
});
const pair = (
  id: string,
  split: TrialPairView['split'],
  parent: Partial<TrialMetricsView>,
  candidate: Partial<TrialMetricsView>,
): TrialPairView => ({
  pairId: id,
  split,
  family: `family-${id.slice(-1)}`,
  seedCommitment: hex(`seed-${id}`),
  parent: metrics(parent),
  candidate: metrics(candidate),
});

const report = (
  reportId: string,
  candidateId: string,
  patch: Partial<GateReportView>,
): ArtifactEnvelope<GateReportView> => ({
  artifactId: reportId,
  kind: 'gate_report',
  jobId: null,
  committedAtSequence: 5,
  contentHash: hex(reportId),
  payload: {
    reportId,
    candidateId,
    parentHash: hex('parent'),
    childHash: hex('child'),
    evaluatorHash: hex('evaluator'),
    fixtureGeneratorHash: hex('fixtures'),
    runtimeHash: hex('runtime'),
    workerProfileHash: hex('worker-profile'),
    splitManifestCommitment: hex('split'),
    pairs: [],
    plannedPairs: 0,
    trialRowsDigest: hex(`rows-${reportId}`),
    controls: [
      {
        controlId: 'initial',
        label: 'Initial harness (W0)',
        successes: 3,
        episodes: 10,
        costMicrousd: 91000,
      },
      {
        controlId: 'expert_static',
        label: 'Expert static harness',
        successes: 8,
        episodes: 10,
        costMicrousd: 88000,
      },
      {
        controlId: 'wrong_incident',
        label: 'Wrong-incident control',
        successes: 3,
        episodes: 10,
        costMicrousd: 90000,
      },
      {
        controlId: 'evolved',
        label: 'Evolved candidate',
        successes: 7,
        episodes: 10,
        costMicrousd: 93000,
      },
    ],
    knownAuthorityFlips: [],
    totalCostMicrousd: 362000,
    unpricedCalls: 0,
    verdict: 'admit',
    reasonCodes: [],
    ...patch,
  },
});

export default function registerEvaluation(state: FixtureState) {
  const admitted = report('gate-1', 'cand-1', {
    pairs: [
      pair(
        'pair-a1',
        'train',
        { usefulCompletion: false, targetedResiduals: 3 },
        {},
      ),
      pair(
        'pair-a2',
        'validation',
        { usefulCompletion: false, targetedResiduals: 2 },
        {},
      ),
      pair('pair-p1', 'protected', {}, {}),
      pair(
        'pair-p2',
        'protected',
        {},
        { refused: true, usefulCompletion: false },
      ),
      pair(
        'pair-f1',
        'final',
        { timedOut: true, usefulCompletion: false },
        { unpricedCalls: 2, costMicrousd: 0 },
      ),
    ],
    plannedPairs: 6,
    unpricedCalls: 2,
    reasonCodes: ['protected_regression_within_tolerance'],
  });
  const rejected = report('gate-rejected', 'cand-unsafe', {
    pairs: [
      pair(
        'pair-r1',
        'protected',
        {},
        {
          retentionViolations: 4,
          unrelatedRecordChanges: 7,
          truthfulTerminal: false,
        },
      ),
      pair(
        'pair-r2',
        'validation',
        { usefulCompletion: false },
        { failed: true, usefulCompletion: false },
      ),
    ],
    plannedPairs: 2,
    verdict: 'reject',
    reasonCodes: [
      'retention_violation',
      'untruthful_terminal',
      'protected_regression',
    ],
    knownAuthorityFlips: ['tool:delete:payments_archive'],
  });
  state.artifacts.set('gate-1', admitted);
  state.artifacts.set('gate-rejected', rejected);
  const job = state.jobs.get('job-approval');
  if (job)
    job.snapshot.artifacts = [
      ...job.snapshot.artifacts,
      { artifactId: 'gate-1', kind: 'gate_report', committedAtSequence: 5 },
    ];
  const stale = state.jobs.get('job-approval-stale');
  if (stale)
    stale.snapshot.artifacts = [
      {
        artifactId: 'gate-rejected',
        kind: 'gate_report',
        committedAtSequence: 5,
      },
    ];
}
