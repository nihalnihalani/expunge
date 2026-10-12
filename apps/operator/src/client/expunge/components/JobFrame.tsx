import { useEffect, useRef } from 'react';
import type { ExpungeJobSnapshotV2 } from '../../../shared/expunge';
import { ExpungeApiError } from '../api';
import { formatClock, formatTime } from '../format';
import { useNow } from '../hooks/useNow';
import { useJobProjection, type JobProjection } from '../projection/store';
import {
  isTerminal,
  jobStatusChip,
  snapshotReceiptIncomplete,
} from '../projection/selectors';
import { formatRoute, type ExpungeRoute, type JobTab } from '../routes';
import { registeredTabs } from '../viewModules';
import { ConnectionBanner, type Connection } from './ConnectionBanner';
import { HashChip } from './HashChip';
import { useAnnounce } from './LiveRegion';
import { PageHeading } from './PageHeading';
import { RelatedRecords } from './RelatedRecords';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from './StateViews';
import { StatusChip } from './StatusChip';

const TAB_LABEL: Record<JobTab, string> = {
  workbench: 'Workbench',
  evidence: 'Evidence',
  candidate: 'Candidate',
  evaluation: 'Evaluation',
  receipt: 'Receipt',
};

/** A tab exists only when its view module does; nothing links to a screen that is not built. */
export function availableTabs(): JobTab[] {
  return registeredTabs;
}

export const STALE_AFTER_MS = 20_000;

export function connectionOf(
  state: JobProjection['state'],
  now: number,
): Connection {
  if (state.connection === 'retrying') return 'retrying';
  if (state.connection === 'disconnected') return 'disconnected';
  if (state.connection === 'unavailable') return 'unavailable';
  if (
    state.snapshot &&
    state.connection !== 'bootstrapping' &&
    !isTerminal(state.snapshot.status) &&
    state.updatedAt !== null &&
    now - state.updatedAt > STALE_AFTER_MS
  )
    return 'stale';
  return 'live';
}

function Header({ snapshot }: { snapshot: ExpungeJobSnapshotV2 }) {
  return (
    <dl className="ex-dl ex-jobmeta">
      <dt>World</dt>
      <dd>
        {snapshot.world ? (
          <>
            <span className="ex-data">{snapshot.world.worldId}</span>{' '}
            <span className="ex-note">revision {snapshot.world.revision}</span>
            {snapshot.world.maintenanceMode && (
              <StatusChip state="unavailable" label="Maintenance mode" />
            )}
          </>
        ) : (
          'Not bound'
        )}
      </dd>
      <dt>Scope</dt>
      <dd>
        <span className="ex-data">{snapshot.scope.scopeId}</span>{' '}
        <span className="ex-note">
          revision {snapshot.scope.scopeRevision} · {snapshot.scope.env}
        </span>
      </dd>
      <dt>Harness</dt>
      <dd>
        {snapshot.harness ? (
          <>
            <HashChip value={snapshot.harness.hash} label="harness hash" />{' '}
            <span className="ex-note">
              active revision {snapshot.harness.activeRevision}
            </span>
          </>
        ) : (
          'Not pinned yet'
        )}
      </dd>
      <dt>Run</dt>
      <dd>
        {snapshot.runId ? (
          <span className="ex-data">{snapshot.runId}</span>
        ) : (
          'No run yet'
        )}
      </dd>
      <dt>Committed through</dt>
      <dd className="ex-num">
        event {snapshot.sequence}, {formatTime(snapshot.updatedAt)}
      </dd>
    </dl>
  );
}

/**
 * Shared frame for every job tab: title, status, committed-through marker, connection and
 * projection-reset notices, and the tab list. Projections are shared per job, so switching
 * tabs does not re-read anything.
 */
export function JobFrame({
  route,
  title,
  children,
}: {
  route: Extract<ExpungeRoute, { name: 'job' }>;
  title: string;
  children: (projection: JobProjection) => React.ReactNode;
}) {
  const projection = useJobProjection(route.jobId);
  const { state } = projection;
  const now = useNow(5000);
  const announce = useAnnounce();
  const previous = useRef<string>('');
  const connection = connectionOf(state, now);
  useEffect(() => {
    const key = `${connection}`;
    if (previous.current && previous.current !== key)
      announce(
        connection === 'live'
          ? 'Reconnected. Showing current committed state.'
          : connection === 'disconnected'
            ? 'Disconnected from the operator. The job keeps running on the server.'
            : connection === 'stale'
              ? 'This view is out of date.'
              : connection === 'retrying'
                ? ''
                : 'The domain service is unavailable.',
      );
    previous.current = key;
  }, [connection, announce]);
  const tabs = availableTabs();
  const snapshot = state.snapshot;
  return (
    <div className="ex-page">
      <nav aria-label="Breadcrumb" className="ex-crumbs">
        <a className="ex-link" href={formatRoute({ name: 'home' })}>
          Jobs
        </a>
        <span aria-hidden> / </span>
        <span className="ex-data" aria-current="page">
          {route.jobId}
        </span>
      </nav>
      <PageHeading
        eyebrow={snapshot ? `${snapshot.kind.replaceAll('_', ' ')} job` : 'Job'}
        title={snapshot?.subject?.display ?? title}
      />
      {snapshot && (
        <div className="ex-actions">
          <StatusChip
            {...jobStatusChip({
              status: snapshot.status,
              receiptIncomplete: snapshotReceiptIncomplete(
                snapshot,
                state.events,
              ),
            })}
          />
          <span className="ex-note">
            Job status comes from the committed record; the completion verdict
            is separate{tabs.includes('receipt') ? ' (Receipt tab)' : ''}.
          </span>
        </div>
      )}
      {snapshot && <Header snapshot={snapshot} />}
      {snapshot && (
        <RelatedRecords jobId={snapshot.jobId} artifacts={snapshot.artifacts} />
      )}
      <ConnectionBanner
        connection={connection}
        attempt={state.attempt}
        nextRetryMs={state.nextRetryMs}
        updatedAt={state.updatedAt}
        now={now}
        onRetry={projection.refresh}
        detail={
          connection === 'disconnected' || connection === 'retrying'
            ? `The job keeps running on the server; this view is not connected.${state.updatedAt === null ? '' : ` Showing committed state from ${formatClock(state.updatedAt)}.`}`
            : undefined
        }
      />
      {state.notice && (
        <div className="ex-banner ex-banner--info" role="status">
          <strong>
            {state.notice === 'reset'
              ? 'The projection was reset by the backend.'
              : 'A gap was detected in the committed events.'}
          </strong>
          <span>
            {state.notice === 'reset'
              ? 'This is its current committed state; earlier events were re-read.'
              : state.failure?.code === 'projection_inconsistent'
                ? 'The event list is withheld because the stream is still not contiguous. Job status above is read from the database.'
                : 'The events were re-read from the start so none are skipped.'}
          </span>
        </div>
      )}
      {tabs.length > 1 && (
        <nav aria-label="Job sections">
          <ul className="ex-tabs">
            {tabs.map((tab) => (
              <li key={tab}>
                <a
                  href={formatRoute({ name: 'job', jobId: route.jobId, tab })}
                  aria-current={route.tab === tab ? 'page' : undefined}
                >
                  {TAB_LABEL[tab]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {state.connection === 'bootstrapping' && !snapshot && (
        <Skeleton label="job" />
      )}
      {state.connection === 'not_found' && (
        <EmptyState
          title="This job is not available from the projection."
          action={
            <a className="ex-link" href={formatRoute({ name: 'home' })}>
              Back to jobs
            </a>
          }
        >
          It may belong to another owner, or it does not exist.
        </EmptyState>
      )}
      {state.connection === 'unavailable' && !snapshot && (
        <UnavailableState
          what="The job projection"
          reason={
            state.failure?.message ?? 'The domain service is not reachable.'
          }
          onRecheck={projection.refresh}
        />
      )}
      {state.connection === 'error' && (
        <ErrorState
          what="this job"
          stale={!!snapshot}
          error={
            state.failure
              ? new ExpungeApiError(
                  'http',
                  state.failure.status,
                  state.failure.code,
                  state.failure.message,
                )
              : undefined
          }
          onRetry={projection.refresh}
        />
      )}
      {snapshot && children(projection)}
    </div>
  );
}
