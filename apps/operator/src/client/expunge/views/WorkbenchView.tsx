import { useEffect, useRef } from 'react';
import { Hand } from 'lucide-react';
import { CancelControl } from '../components/CancelControl';
import { CoverageStatement } from '../components/CoverageStatement';
import { DecisionLog } from '../components/DecisionLog';
import { GapBanner } from '../components/GapBanner';
import { JobFrame } from '../components/JobFrame';
import { LimitsStrip } from '../components/LimitsStrip';
import { useAnnounce } from '../components/LiveRegion';
import { PhaseStepper } from '../components/PhaseStepper';
import { ReferenceSection } from '../components/ReferenceSection';
import { formatTime, plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { isTerminal, snapshotReceiptIncomplete } from '../projection/selectors';
import type { ViewMeta, ViewProps } from '../registry';
import type { ExpungeJobSnapshotV2 } from '../../../shared/expunge';

export const meta: ViewMeta = {
  id: 'workbench',
  label: 'Workbench',
  routes: ['job'],
  tab: 'workbench',
  scope: 'job',
  order: 10,
};

function Announcer({
  snapshot,
  finishedIncomplete,
}: {
  snapshot: ExpungeJobSnapshotV2;
  finishedIncomplete: boolean;
}) {
  const announce = useAnnounce();
  const last = useRef<{
    phase: string | null;
    status: string;
    approval: string;
  } | null>(null);
  useEffect(() => {
    const now = {
      phase: snapshot.phase,
      status: snapshot.status,
      approval: snapshot.approval.state,
    };
    const before = last.current;
    last.current = now;
    if (!before) return;
    if (now.status !== before.status && isTerminal(snapshot.status))
      announce(
        finishedIncomplete
          ? 'Job finished: cleanup incomplete.'
          : `Job ${snapshot.status}.`,
      );
    else if (now.approval === 'pending' && before.approval !== 'pending')
      announce('A harness proposal needs your decision.');
    else if (now.phase !== before.phase && now.phase)
      announce(`Phase: ${now.phase}.`);
  }, [snapshot, finishedIncomplete, announce]);
  return null;
}

const STATE_LABEL: Record<string, string> = {
  discovered: 'discovered',
  inspected: 'inspected',
  previewed: 'previewed',
  applied: 'applied',
  retained: 'retained',
  excluded: 'excluded',
  residual: 'residual',
  not_inspected: 'not inspected',
};

export default function WorkbenchView({ route }: ViewProps) {
  useDocumentTitle(
    route.name === 'job' ? `Job ${route.jobId} · Workbench` : 'Workbench',
  );
  if (route.name !== 'job') return null;
  return (
    <JobFrame route={route} title={`Job ${route.jobId}`}>
      {({ state }) => {
        const snapshot = state.snapshot!;
        const finishedIncomplete =
          snapshot.status === 'failed' &&
          snapshotReceiptIncomplete(snapshot, state.events);
        return (
          <>
            <Announcer
              snapshot={snapshot}
              finishedIncomplete={finishedIncomplete}
            />
            <section className="ex-section" aria-labelledby="ex-phase-h">
              <h2 className="ex-h2" id="ex-phase-h">
                Phase
              </h2>
              <PhaseStepper
                states={snapshot.phaseStates}
                phase={snapshot.phase}
                finishedIncomplete={finishedIncomplete}
              />
              <GapBanner snapshot={snapshot} />
              {snapshot.status === 'waiting_approval' && (
                <div className="ex-banner ex-banner--warn" role="note">
                  <Hand size={16} aria-hidden />
                  <strong>This job needs your decision.</strong>
                  <span>
                    It released its lease and waits for the approval you owe.
                    Nothing proceeds until the database records a decision.
                  </span>
                </div>
              )}
              {snapshot.status === 'waiting_evidence' && (
                <div className="ex-banner ex-banner--info" role="note">
                  <strong>Waiting for evidence.</strong>
                  <span>
                    The job released its lease until remote evidence reaches the
                    required state. A missing response is not evidence of no
                    failure.
                  </span>
                </div>
              )}
              {snapshot.cancellation.requested &&
                snapshot.status !== 'cancelled' && (
                  <div className="ex-banner ex-banner--info" role="note">
                    <strong>Cancellation requested.</strong>
                    <span>
                      The database has not yet confirmed the job stopped
                      {snapshot.cancellation.requestedAt
                        ? ` (requested ${formatTime(snapshot.cancellation.requestedAt)})`
                        : ''}
                      .
                    </span>
                  </div>
                )}
              <CancelControl snapshot={snapshot} />
            </section>
            <section className="ex-section" aria-labelledby="ex-cov-h">
              <h2 className="ex-h2" id="ex-cov-h">
                Coverage
              </h2>
              <CoverageStatement snapshot={snapshot} />
            </section>
            <section className="ex-section" aria-labelledby="ex-graph-h">
              <h2 className="ex-h2" id="ex-graph-h">
                Reference graph
              </h2>
              <p className="ex-note">
                {plural(snapshot.graph.nodeCount, 'node')} and{' '}
                {plural(snapshot.graph.edgeCount, 'edge')}
                {snapshot.graph.truncated
                  ? ' (the graph is truncated at its limit)'
                  : ''}
                .
              </p>
              <ul className="ex-statelist" aria-label="Graph nodes by state">
                {Object.entries(snapshot.graph.byState).map(([name, count]) => (
                  <li key={name}>
                    <span className="ex-num">{count}</span>{' '}
                    {STATE_LABEL[name] ?? name}
                  </li>
                ))}
              </ul>
              <ReferenceSection snapshot={snapshot} />
            </section>
            <section className="ex-section" aria-labelledby="ex-limits-h">
              <h2 className="ex-h2" id="ex-limits-h">
                Limits
              </h2>
              <LimitsStrip limits={snapshot.limits} />
            </section>
            <section className="ex-section" aria-labelledby="ex-feed-h">
              <h2 className="ex-h2" id="ex-feed-h">
                Decision log
              </h2>
              <DecisionLog
                events={state.events}
                dropped={state.dropped}
                withheld={state.failure?.code === 'projection_inconsistent'}
              />
            </section>
          </>
        );
      }}
    </JobFrame>
  );
}
