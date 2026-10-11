/** FIXTURE stored gate decision summary on the admitted report. Synthetic test data only. */
import type { FixtureState } from '../expunge-domain-fixture.js';
import type {
  ArtifactEnvelope,
  GateReportView,
} from '../../../src/shared/expunge.js';

export default function registerGateSummary(state: FixtureState) {
  const report = state.artifacts.get('gate-1') as
    ArtifactEnvelope<GateReportView> | undefined;
  if (!report) return;
  // The gate's trigger gain counts training pairs only (1), while a recount over every recorded
  // pair finds 3 improved: the two figures are deliberately different.
  report.payload.decisionSummary = {
    triggerGain: 1,
    triggerRequiredGain: 1,
    splits: {
      train: { trials: 1, parentSuccesses: 0, candidateSuccesses: 1 },
      protected: { trials: 2, parentSuccesses: 2, candidateSuccesses: 1 },
      validation: { trials: 1, parentSuccesses: 0, candidateSuccesses: 1 },
      final: { trials: 1, parentSuccesses: 0, candidateSuccesses: 1 },
    },
    protectedRegressedWorlds: 1,
  };
}
