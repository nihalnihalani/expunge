import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type {
  ExpungeJobList,
  ExpungeJobListItem,
  JobStatus,
} from '../../../shared/expunge';
import { ConnectionBanner } from '../components/ConnectionBanner';
import { PageHeading } from '../components/PageHeading';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { TableWrap } from '../components/TableWrap';
import { ageText, formatTime } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { useResource } from '../hooks/useResource';
import { formatRoute } from '../routes';
import type { ViewMeta, ViewProps } from '../registry';

export const meta: ViewMeta = {
  id: 'jobs',
  label: 'Jobs',
  routes: ['home'],
  scope: 'global',
  order: 10,
  navRoute: { name: 'home' },
  home: 10,
};

type Filter = 'all' | 'approval' | 'evidence' | 'running' | 'finished';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['approval', 'Needs your decision'],
  ['evidence', 'Waiting for evidence'],
  ['running', 'Queued or running'],
  ['finished', 'Finished'],
];
const match = (filter: Filter, status: JobStatus) =>
  filter === 'all' ||
  (filter === 'approval' && status === 'waiting_approval') ||
  (filter === 'evidence' && status === 'waiting_evidence') ||
  (filter === 'running' && (status === 'queued' || status === 'running')) ||
  (filter === 'finished' &&
    ['succeeded', 'failed', 'cancelled'].includes(status));

/** Jobs that need a human come first, then the most recently updated. */
export function sortJobs(items: ExpungeJobListItem[]) {
  return [...items].sort((a, b) => {
    const rank = (item: ExpungeJobListItem) =>
      item.status === 'waiting_approval' ? 0 : 1;
    return (
      rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );
  });
}

export const STALE_AFTER_MS = 60_000;

export default function JobsHomeView(_props: ViewProps) {
  useDocumentTitle('Jobs');
  const jobs = useResource<ExpungeJobList>('/jobs?limit=100', { pollMs: 5000 });
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(
    () =>
      sortJobs(jobs.data?.items ?? []).filter((item) =>
        match(filter, item.status),
      ),
    [jobs.data, filter],
  );
  const stale =
    jobs.updatedAt !== null &&
    jobs.status === 'ok' &&
    now - jobs.updatedAt > STALE_AFTER_MS;
  return (
    <div className="ex-page">
      <PageHeading eyebrow="Expunge" title="Cleanup jobs">
        Durable cleanup jobs run on the server. This list reads their committed
        state; closing the tab or finishing a chat turn never completes or
        cancels one.
      </PageHeading>
      <div className="ex-actions">
        <a
          className="ex-btn ex-btn--primary"
          href={formatRoute({ name: 'new' })}
        >
          <Plus size={14} aria-hidden /> New cleanup
        </a>
        <a className="ex-link" href={formatRoute({ name: 'setup' })}>
          Setup and readiness
        </a>
      </div>
      {(jobs.status === 'retrying' || jobs.status === 'disconnected') && (
        <ConnectionBanner
          connection={jobs.status}
          attempt={jobs.attempt}
          nextRetryMs={jobs.nextRetryMs}
          updatedAt={jobs.updatedAt}
          now={now}
          onRetry={jobs.refresh}
        />
      )}
      {stale && (
        <div className="ex-banner ex-banner--warn" role="status">
          <strong>The list is older than 60 seconds.</strong>
          <button type="button" className="ex-btn" onClick={jobs.refresh}>
            Refresh
          </button>
        </div>
      )}
      {jobs.status === 'loading' && !jobs.data && <Skeleton label="jobs" />}
      {jobs.status === 'unavailable' && !jobs.data && (
        <UnavailableState
          what="The jobs list"
          reason={jobs.error?.message ?? 'The domain service is not available.'}
          missing={jobs.error?.missing}
          onRecheck={jobs.refresh}
        />
      )}
      {(jobs.status === 'error' || jobs.status === 'not_found') && (
        <ErrorState
          what="jobs"
          error={jobs.error}
          stale={!!jobs.data}
          onRetry={jobs.refresh}
        />
      )}
      {jobs.data && (
        <section aria-labelledby="ex-jobs-h" className="ex-section">
          <h2 className="ex-h2" id="ex-jobs-h">
            Jobs
          </h2>
          <div
            className="ex-filters"
            role="group"
            aria-label="Filter jobs by status"
          >
            {FILTERS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="ex-btn ex-filter"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {jobs.data.items.length === 0 ? (
            <EmptyState
              title="No cleanup jobs yet."
              action={
                <a className="ex-btn" href={formatRoute({ name: 'new' })}>
                  Choose a world and a subject
                </a>
              }
            >
              Choose an authorized world and an exact subject to start. Nothing
              is running.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title="No job matches this filter.">
              {jobs.data.items.length} jobs exist; choose another filter to see
              them.
            </EmptyState>
          ) : (
            <TableWrap label="Cleanup jobs">
              <table className="ex-table">
                <caption>
                  {rows.length} of {jobs.data.items.length} jobs. Jobs that need
                  your decision come first.
                  {jobs.updatedAt !== null
                    ? ` Updated ${ageText(jobs.updatedAt, now)}.`
                    : ''}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Subject</th>
                    <th scope="col">World</th>
                    <th scope="col">Status</th>
                    <th scope="col">Completion verdict</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={item.jobId}>
                      <th scope="row">
                        <a
                          className="ex-link ex-data"
                          href={formatRoute({
                            name: 'job',
                            jobId: item.jobId,
                            tab: 'workbench',
                          })}
                        >
                          {item.jobId}
                        </a>
                      </th>
                      <td>{item.kind.replaceAll('_', ' ')}</td>
                      <td>{item.subjectDisplay ?? '—'}</td>
                      <td className="ex-data">{item.worldId ?? '—'}</td>
                      <td>
                        <StatusChip state={item.status} />
                      </td>
                      <td>
                        {item.receiptDomainStatus ===
                        'complete_in_registered_scope' ? (
                          <StatusChip
                            state="complete_in_scope"
                            label="Complete in registered scope"
                          />
                        ) : item.receiptDomainStatus === 'incomplete' ? (
                          <StatusChip state="incomplete" />
                        ) : (
                          <span className="ex-muted">No receipt committed</span>
                        )}
                      </td>
                      <td className="ex-num">{formatTime(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </section>
      )}
    </div>
  );
}
