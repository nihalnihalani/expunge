import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { CommittedSeal } from '../components/CommittedSeal';
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
import { jobStatusChip } from '../projection/selectors';
import { TableWrap } from '../components/TableWrap';
import { UnclaimedNotice } from '../components/UnclaimedNotice';
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

export type Filter = 'all' | 'approval' | 'evidence' | 'running' | 'finished';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['approval', 'Needs your decision'],
  ['evidence', 'Waiting for evidence'],
  ['running', 'Queued or running'],
  ['finished', 'Finished'],
];
/**
 * "Finished" is every terminal job: succeeded, cancelled, failed, and the failed jobs that finished with a committed
 * incomplete receipt (status `failed`, shown as "Finished: cleanup incomplete").
 */
export const matchesFilter = (filter: Filter, status: JobStatus) =>
  filter === 'all' ||
  (filter === 'approval' && status === 'waiting_approval') ||
  (filter === 'evidence' && status === 'waiting_evidence') ||
  (filter === 'running' && (status === 'queued' || status === 'running')) ||
  (filter === 'finished' &&
    ['succeeded', 'failed', 'cancelled'].includes(status));

/** The receipt is committed (id, sequence and verified revision all present): DA-7 S1. */
const receiptCommitted = (item: ExpungeJobListItem) =>
  item.receiptId !== undefined &&
  item.receiptSequence !== undefined &&
  item.verifiedWorldRevision !== undefined;

/** Status chip for a list row; see `jobStatusChip`. */
export function JobStatusCell({ item }: { item: ExpungeJobListItem }) {
  const chip = jobStatusChip({
    status: item.status,
    receiptIncomplete:
      receiptCommitted(item) && item.receiptDomainStatus === 'incomplete',
    terminalReason: receiptCommitted(item) ? undefined : item.terminalReason,
  });
  return <StatusChip state={chip.state} label={chip.label} />;
}

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
        matchesFilter(filter, item.status),
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
              <table className="ex-table ex-table--stack" role="table">
                <caption>
                  {rows.length} of {jobs.data.items.length} jobs. Jobs that need
                  your decision come first.
                  {jobs.updatedAt !== null
                    ? ` Updated ${ageText(jobs.updatedAt, now)}.`
                    : ''}
                </caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      Job
                    </th>
                    <th scope="col" role="columnheader">
                      Kind
                    </th>
                    <th scope="col" role="columnheader">
                      Subject
                    </th>
                    <th scope="col" role="columnheader">
                      World
                    </th>
                    <th scope="col" role="columnheader">
                      Status
                    </th>
                    <th scope="col" role="columnheader">
                      Completion verdict
                    </th>
                    <th scope="col" role="columnheader">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {rows.map((item) => (
                    <tr key={item.jobId} role="row">
                      <th scope="row" role="rowheader" data-label="Job">
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
                      <td role="cell" data-label="Kind">
                        {item.kind.replaceAll('_', ' ')}
                      </td>
                      <td role="cell" data-label="Subject">
                        {item.subjectDisplay ?? '—'}
                      </td>
                      <td role="cell" data-label="World" className="ex-data">
                        {item.worldId ?? '—'}
                      </td>
                      <td role="cell" data-label="Status">
                        <JobStatusCell item={item} />
                        <UnclaimedNotice job={item} now={now} />
                      </td>
                      <td role="cell" data-label="Completion verdict">
                        <ReceiptCell item={item} />
                      </td>
                      <td role="cell" data-label="Updated" className="ex-num">
                        {formatTime(item.updatedAt)}
                      </td>
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

/**
 * The receipt verdict is shown only when the list item names the committed receipt that carries
 * it. A verdict without a receipt id, sequence or verified world revision is not rendered as
 * "Complete" (DA-7 S1): the seal is the only authority badge.
 */
export function ReceiptCell({ item }: { item: ExpungeJobListItem }) {
  const committed = receiptCommitted(item);
  if (!item.receiptDomainStatus || !committed)
    return (
      <span className="ex-muted">
        {item.receiptDomainStatus
          ? 'Receipt reference missing'
          : 'No receipt committed'}
      </span>
    );
  return (
    <span className="ex-receipt-cell">
      <CommittedSeal
        source={{
          kind: 'receipt',
          id: item.receiptId!,
          sequence: item.receiptSequence!,
        }}
      />
      <StatusChip
        state={
          item.receiptDomainStatus === 'complete_in_registered_scope'
            ? 'complete_in_scope'
            : 'incomplete'
        }
        label={
          item.receiptDomainStatus === 'complete_in_registered_scope'
            ? 'Complete in registered scope'
            : undefined
        }
      />
      <span className="ex-muted ex-num">
        as of world revision {item.verifiedWorldRevision}
      </span>
    </span>
  );
}
