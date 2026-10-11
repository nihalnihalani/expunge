import { useState } from 'react';
import type {
  ArtifactEnvelope,
  ControlRowView,
  ExpungeJobSnapshotV2,
  GateReportView,
  TrialMetricsView,
  TrialPairView,
} from '../../../shared/expunge';
import { HashChip } from '../components/HashChip';
import { JobFrame } from '../components/JobFrame';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { TableWrap } from '../components/TableWrap';
import { formatMicrousd, plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResource } from '../hooks/useResource';
import type { ViewMeta, ViewProps } from '../registry';

export const meta: ViewMeta = {
  id: 'evaluation',
  label: 'Evaluation',
  routes: ['job'],
  tab: 'evaluation',
  scope: 'job',
  order: 40,
};

const MAX_REPORTS = 5;
export const PAIR_PAGE = 50;

/**
 * The gate's own stored decision summary, when the projection carries it. These are the
 * authoritative figures: the trigger gain counts training pairs only, so it can differ from any
 * recount over all recorded pairs. Declared here until the shared type carries it.
 */
export interface GateDecisionSummary {
  triggerGain: number;
  triggerRequiredGain: number;
  splits: Partial<
    Record<
      TrialPairView['split'],
      { trials: number; parentSuccesses: number; candidateSuccesses: number }
    >
  >;
  protectedRegressedWorlds: number;
}
export type GateData = GateReportView & {
  decisionSummary?: GateDecisionSummary;
};
const SPLIT_ORDER = ['protected', 'final', 'validation', 'train'] as const;

export interface PairSummary {
  recorded: number;
  planned: number;
  /** Planned pairs with no recorded row: shown, never silently dropped. */
  missing: number;
  improved: number;
  regressed: number;
  protectedTotal: number;
  protectedRegressed: number;
  retentionViolations: { parent: number; candidate: number };
  unrelatedChanges: { parent: number; candidate: number };
  refused: { parent: number; candidate: number };
  timedOut: { parent: number; candidate: number };
  failed: { parent: number; candidate: number };
  untruthful: { parent: number; candidate: number };
}

const count = (
  pairs: TrialPairView[],
  pick: (m: TrialMetricsView) => boolean,
) => ({
  parent: pairs.filter((pair) => pick(pair.parent)).length,
  candidate: pairs.filter((pair) => pick(pair.candidate)).length,
});
const sum = (
  pairs: TrialPairView[],
  pick: (m: TrialMetricsView) => number,
) => ({
  parent: pairs.reduce((total, pair) => total + pick(pair.parent), 0),
  candidate: pairs.reduce((total, pair) => total + pick(pair.candidate), 0),
});

/** Pure aggregation over the recorded rows; it adds nothing the rows do not contain. */
export function summarizePairs(
  pairs: TrialPairView[],
  plannedPairs: number,
): PairSummary {
  const protectedPairs = pairs.filter((pair) => pair.split === 'protected');
  return {
    recorded: pairs.length,
    planned: plannedPairs,
    missing: Math.max(0, plannedPairs - pairs.length),
    improved: pairs.filter(
      (pair) =>
        !pair.parent.usefulCompletion && pair.candidate.usefulCompletion,
    ).length,
    regressed: pairs.filter(
      (pair) =>
        pair.parent.usefulCompletion && !pair.candidate.usefulCompletion,
    ).length,
    protectedTotal: protectedPairs.length,
    protectedRegressed: protectedPairs.filter(
      (pair) =>
        pair.parent.usefulCompletion && !pair.candidate.usefulCompletion,
    ).length,
    retentionViolations: sum(pairs, (m) => m.retentionViolations),
    unrelatedChanges: sum(pairs, (m) => m.unrelatedRecordChanges),
    refused: count(pairs, (m) => m.refused),
    timedOut: count(pairs, (m) => m.timedOut),
    failed: count(pairs, (m) => m.failed),
    untruthful: count(pairs, (m) => !m.truthfulTerminal),
  };
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');
const flags = (m: TrialMetricsView) =>
  [m.refused && 'refused', m.timedOut && 'timed out', m.failed && 'failed']
    .filter(Boolean)
    .join(', ') || 'none';

function Pair({ pair }: { pair: TrialPairView }) {
  const row = (parent: React.ReactNode, candidate: React.ReactNode) => (
    <td>
      <span className="ex-pair">
        <span className="ex-pair-side">
          <span className="ex-pair-label">Parent</span> {parent}
        </span>
        <span className="ex-pair-side">
          <span className="ex-pair-label">Candidate</span> {candidate}
        </span>
      </span>
    </td>
  );
  return (
    <tr>
      <th scope="row">
        <span className="ex-data">{pair.pairId}</span>
        <span className="ex-note"> {pair.family}</span>
      </th>
      <td>{pair.split === 'protected' ? 'protected case' : pair.split}</td>
      {row(
        yesNo(pair.parent.usefulCompletion),
        yesNo(pair.candidate.usefulCompletion),
      )}
      {row(pair.parent.targetedResiduals, pair.candidate.targetedResiduals)}
      {row(
        pair.parent.unrelatedRecordChanges,
        pair.candidate.unrelatedRecordChanges,
      )}
      {row(pair.parent.retentionViolations, pair.candidate.retentionViolations)}
      {row(
        yesNo(pair.parent.truthfulTerminal),
        yesNo(pair.candidate.truthfulTerminal),
      )}
      {row(flags(pair.parent), flags(pair.candidate))}
      {row(
        <>
          {formatMicrousd(pair.parent.costMicrousd)}
          {pair.parent.unpricedCalls > 0 &&
            ` + ${pair.parent.unpricedCalls} unpriced`}
        </>,
        <>
          {formatMicrousd(pair.candidate.costMicrousd)}
          {pair.candidate.unpricedCalls > 0 &&
            ` + ${pair.candidate.unpricedCalls} unpriced`}
        </>,
      )}
    </tr>
  );
}

function Controls({ controls }: { controls: ControlRowView[] }) {
  if (controls.length === 0)
    return (
      <p className="ex-note">
        The report names no control rows. A comparison without controls is not
        shown as a result.
      </p>
    );
  return (
    <TableWrap label="Control rows">
      <table className="ex-table">
        <caption className="ex-sr">Control rows</caption>
        <thead>
          <tr>
            <th scope="col">Control</th>
            <th scope="col" className="ex-right">
              Successes
            </th>
            <th scope="col" className="ex-right">
              Episodes
            </th>
            <th scope="col" className="ex-right">
              Rate
            </th>
            <th scope="col" className="ex-right">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {controls.map((control) => (
            <tr key={control.controlId}>
              <th scope="row">{control.label}</th>
              <td className="ex-num ex-right">{control.successes}</td>
              <td className="ex-num ex-right">{control.episodes}</td>
              <td className="ex-num ex-right">
                {control.episodes > 0
                  ? `${Math.round((control.successes / control.episodes) * 100)}%`
                  : 'no episodes'}
              </td>
              <td className="ex-num ex-right">
                {formatMicrousd(control.costMicrousd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** Pure rendering of one committed gate report. */
export function EvaluationDocument({ report }: { report: GateData }) {
  const [shown, setShown] = useState(PAIR_PAGE);
  const summary = summarizePairs(report.pairs, report.plannedPairs);
  const ordered = [...report.pairs].sort(
    (a, b) =>
      SPLIT_ORDER.indexOf(a.split) - SPLIT_ORDER.indexOf(b.split) ||
      a.pairId.localeCompare(b.pairId),
  );
  const visible = ordered.slice(0, shown);
  return (
    <article
      className="ex-candidate"
      aria-label={`Gate report ${report.reportId}`}
    >
      <h3 className="ex-h3">
        <span className="ex-data">{report.reportId}</span>{' '}
        <StatusChip
          state={
            report.verdict === 'admit'
              ? 'ok'
              : report.verdict === 'reject'
                ? 'rejected'
                : 'unknown'
          }
          label={`gate verdict: ${report.verdict}`}
        />
      </h3>
      <p className="ex-note">
        Candidate <span className="ex-data">{report.candidateId}</span>. The
        verdict is the gate&apos;s; a model&apos;s account of the trials is not
        part of this report.
      </p>
      {report.reasonCodes.length > 0 && (
        <>
          <h4 className="ex-h4">
            {report.verdict === 'admit' ? 'Notes' : 'Why it was not admitted'}
          </h4>
          <ul className="ex-list">
            {report.reasonCodes.map((code) => (
              <li key={code}>
                <code className="ex-code">{code}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="ex-h4">The gate&apos;s stored summary</h4>
      {report.decisionSummary ? (
        <>
          <p>
            Trigger gain (training pairs only):{' '}
            <strong className="ex-num">
              {report.decisionSummary.triggerGain}
            </strong>
            , required {report.decisionSummary.triggerRequiredGain}. Protected
            worlds regressed:{' '}
            <strong className="ex-num">
              {report.decisionSummary.protectedRegressedWorlds}
            </strong>
            .
          </p>
          <TableWrap label="Gate successes by split">
            <table className="ex-table">
              <caption className="ex-sr">Gate successes by split</caption>
              <thead>
                <tr>
                  <th scope="col">Split</th>
                  <th scope="col" className="ex-right">
                    Trials
                  </th>
                  <th scope="col" className="ex-right">
                    Parent successes
                  </th>
                  <th scope="col" className="ex-right">
                    Candidate successes
                  </th>
                </tr>
              </thead>
              <tbody>
                {SPLIT_ORDER.filter(
                  (name) => report.decisionSummary!.splits[name],
                ).map((name) => {
                  const row = report.decisionSummary!.splits[name]!;
                  return (
                    <tr key={name}>
                      <th scope="row">{name}</th>
                      <td className="ex-num ex-right">{row.trials}</td>
                      <td className="ex-num ex-right">{row.parentSuccesses}</td>
                      <td className="ex-num ex-right">
                        {row.candidateSuccesses}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
          <p className="ex-note">
            These are the gate&apos;s own figures. The counts below are made
            here from the recorded pairs and can differ from them.
          </p>
        </>
      ) : (
        <p className="ex-note">
          The gate&apos;s stored summary is not in this projection. The counts
          below are made here from the recorded pairs, not read from the gate.
        </p>
      )}

      <h4 className="ex-h4">Counted from the recorded pairs</h4>
      <p>
        {summary.recorded} of {summary.planned} planned pairs recorded.
        {summary.missing > 0 && (
          <>
            {' '}
            <StatusChip
              state="incomplete"
              label={`${summary.missing} not recorded`}
            />
          </>
        )}
      </p>
      <ul className="ex-list">
        <li>
          {plural(summary.improved, 'pair')} improved (parent not useful,
          candidate useful); {plural(summary.regressed, 'pair')} regressed.
        </li>
        <li>
          Protected cases: {summary.protectedRegressed} of{' '}
          {summary.protectedTotal} regressed.
          {summary.protectedTotal === 0 && ' No protected pair is recorded.'}
        </li>
        <li>
          Retention violations: parent {summary.retentionViolations.parent},
          candidate {summary.retentionViolations.candidate}. Unrelated record
          changes: parent {summary.unrelatedChanges.parent}, candidate{' '}
          {summary.unrelatedChanges.candidate}.
        </li>
        <li>
          Refusals: {summary.refused.parent} / {summary.refused.candidate};
          timeouts: {summary.timedOut.parent} / {summary.timedOut.candidate};
          failures: {summary.failed.parent} / {summary.failed.candidate};
          untruthful terminal reports: {summary.untruthful.parent} /{' '}
          {summary.untruthful.candidate} (parent / candidate).
        </li>
      </ul>

      <h4 className="ex-h4">Paired rows</h4>
      {ordered.length === 0 ? (
        <p className="ex-note">No paired rows are recorded.</p>
      ) : (
        <TableWrap label="Paired trial rows">
          <table className="ex-table">
            <caption>
              Showing {visible.length} of {ordered.length} recorded pairs,
              protected cases first. Seeds stay committed; only their commitment
              is on record.
            </caption>
            <thead>
              <tr>
                <th scope="col">Pair</th>
                <th scope="col">Split</th>
                <th scope="col">Useful completion</th>
                <th scope="col">Targeted residuals</th>
                <th scope="col">Unrelated changes</th>
                <th scope="col">Retention violations</th>
                <th scope="col">Truthful terminal</th>
                <th scope="col">Refused, timed out, failed</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((pair) => (
                <Pair key={pair.pairId} pair={pair} />
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {ordered.length > shown && (
        <div className="ex-actions">
          <button
            type="button"
            className="ex-btn"
            onClick={() => setShown((value) => value + PAIR_PAGE)}
          >
            Show {Math.min(PAIR_PAGE, ordered.length - shown)} more pairs
          </button>
        </div>
      )}

      <h4 className="ex-h4">Controls</h4>
      <Controls controls={report.controls} />

      <h4 className="ex-h4">Cost</h4>
      <p>
        Total {formatMicrousd(report.totalCostMicrousd)}.{' '}
        {report.unpricedCalls > 0
          ? `${plural(report.unpricedCalls, 'call')} had no provider price and are counted separately, not as zero cost.`
          : 'Every call was priced.'}
      </p>

      {report.knownAuthorityFlips.length > 0 && (
        <>
          <h4 className="ex-h4">Known authority flips</h4>
          <ul className="ex-list">
            {report.knownAuthorityFlips.map((flip) => (
              <li key={flip}>
                <code className="ex-code">{flip}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="ex-h4">What was frozen</h4>
      <dl className="ex-dl">
        <dt>Parent</dt>
        <dd>
          <HashChip value={report.parentHash} label="parent hash" />
        </dd>
        <dt>Child</dt>
        <dd>
          <HashChip value={report.childHash} label="child hash" />
        </dd>
        <dt>Evaluator</dt>
        <dd>
          <HashChip value={report.evaluatorHash} label="evaluator hash" />
        </dd>
        <dt>Fixture generator</dt>
        <dd>
          <HashChip
            value={report.fixtureGeneratorHash}
            label="fixture generator hash"
          />
        </dd>
        <dt>Runtime</dt>
        <dd>
          <HashChip value={report.runtimeHash} label="runtime hash" />
        </dd>
        <dt>Worker profile</dt>
        <dd>
          <HashChip
            value={report.workerProfileHash}
            label="worker profile hash"
          />
        </dd>
        <dt>Split manifest commitment</dt>
        <dd>
          <HashChip
            value={report.splitManifestCommitment}
            label="split manifest commitment"
          />
        </dd>
        <dt>Trial rows digest</dt>
        <dd>
          <HashChip value={report.trialRowsDigest} label="trial rows digest" />
        </dd>
      </dl>
    </article>
  );
}

function ReportLoader({ artifactId }: { artifactId: string }) {
  const read = useResource<ArtifactEnvelope<GateData>>(
    `/artifacts/${encodeURIComponent(artifactId)}`,
  );
  if (read.status === 'loading') return <Skeleton label="gate report" />;
  if (read.status === 'unavailable')
    return (
      <UnavailableState
        what="The gate report"
        reason={read.error?.message ?? 'The artifact service is not reachable.'}
        onRecheck={read.refresh}
      />
    );
  if (!read.data)
    return (
      <ErrorState
        what="the gate report"
        error={read.error}
        onRetry={read.refresh}
      />
    );
  return <EvaluationDocument report={read.data.payload} />;
}

export function reportRefs(snapshot: Pick<ExpungeJobSnapshotV2, 'artifacts'>) {
  return snapshot.artifacts
    .filter((item) => item.kind === 'gate_report')
    .slice(0, MAX_REPORTS);
}

export default function EvaluationPage({ route }: ViewProps) {
  useDocumentTitle(
    route.name === 'job' ? `Job ${route.jobId} · Evaluation` : 'Evaluation',
  );
  if (route.name !== 'job') return null;
  return (
    <JobFrame route={route} title={`Job ${route.jobId}`}>
      {({ state }) => {
        const refs = reportRefs(state.snapshot!);
        return (
          <section className="ex-section" aria-labelledby="ex-eval-h">
            <h2 className="ex-h2" id="ex-eval-h">
              Gate evaluation
            </h2>
            {refs.length === 0 ? (
              <EmptyState title="No gate report for this job.">
                Cleanup jobs are not gated. A report appears here when an
                improvement job evaluates a candidate; nothing is shown in its
                place.
              </EmptyState>
            ) : (
              refs.map((item) => (
                <ReportLoader
                  key={item.artifactId}
                  artifactId={item.artifactId}
                />
              ))
            )}
          </section>
        );
      }}
    </JobFrame>
  );
}
