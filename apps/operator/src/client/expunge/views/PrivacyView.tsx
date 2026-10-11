import type {
  ArtifactEnvelope,
  ExpungeJobSnapshotV2,
  ExternalErasureView,
  PrivacyView as PrivacyData,
  ProviderErasureStatus,
} from '../../../shared/expunge';
import { HashChip } from '../components/HashChip';
import { PageHeading } from '../components/PageHeading';
import {
  EmptyState,
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { TableWrap } from '../components/TableWrap';
import { formatTime, plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResource } from '../hooks/useResource';
import type { ViewMeta, ViewProps } from '../registry';
import { formatRoute } from '../routes';

export const meta: ViewMeta = {
  id: 'privacy',
  label: 'Privacy',
  routes: ['privacy'],
  scope: 'global',
  order: 40,
};

/**
 * The provider lifecycle as the backend states it: the contracts union plus the two additive
 * states (submitting, submission_ambiguous). A status this build does not know is shown as
 * unknown, never mapped to a known one.
 */
export type ErasureStatus =
  ProviderErasureStatus | 'submitting' | 'submission_ambiguous';

export const ERASURE_STATUS_COPY: Record<ErasureStatus, string> = {
  unsubmitted: 'Not yet sent to the provider.',
  submitting: 'Being sent to the provider now. Not confirmed.',
  submission_ambiguous:
    'The provider may or may not have received this request; it will not be resent automatically; a person must reconcile it.',
  pending: 'The provider has the request and has not completed it.',
  in_progress: 'The provider is processing the request.',
  completed: 'The provider reports completion.',
  rejected: 'The provider rejected the request.',
  cancelled: 'The request was cancelled before the provider completed it.',
};
const isKnown = (status: string): status is ErasureStatus =>
  Object.prototype.hasOwnProperty.call(ERASURE_STATUS_COPY, status);

export type ErasureData = Omit<ExternalErasureView, 'providerStatus'> & {
  providerStatus: string;
};
export type PrivacyData2 = Omit<PrivacyData, 'erasure'> & {
  erasure: ErasureData | null;
};

const chipFor = (status: string) =>
  status === 'completed'
    ? 'ok'
    : status === 'rejected'
      ? 'rejected'
      : status === 'cancelled'
        ? 'cancelled'
        : status === 'submission_ambiguous'
          ? 'fail'
          : status === 'unsubmitted'
            ? 'queued'
            : 'waiting_external';

/** Completion is claimed only with the provider's completion time. */
export function completionClaim(erasure: ErasureData) {
  if (erasure.providerStatus !== 'completed') return null;
  return erasure.completedAt
    ? { ok: true as const, at: erasure.completedAt }
    : { ok: false as const };
}

export function ErasureLifecycle({ erasure }: { erasure: ErasureData | null }) {
  if (!erasure)
    return (
      <p className="ex-note">
        No provider erasure request is recorded for this source. That is not a
        statement that none is owed.
      </p>
    );
  const known = isKnown(erasure.providerStatus);
  const claim = completionClaim(erasure);
  const label = erasure.providerStatus.replaceAll('_', ' ');
  return (
    <>
      <p>
        {claim && !claim.ok ? (
          <StatusChip state="unknown" label="completed, no completion time" />
        ) : (
          <StatusChip
            state={known ? chipFor(erasure.providerStatus) : 'unknown'}
            label={known ? label : 'status not recognized'}
          />
        )}{' '}
        {known
          ? ERASURE_STATUS_COPY[erasure.providerStatus as ErasureStatus]
          : 'This build does not recognize the status the backend reported, so it is not interpreted.'}
      </p>
      {claim?.ok && (
        <p className="ex-note">
          Provider completion time{' '}
          <time dateTime={claim.at}>{formatTime(claim.at)}</time>.
        </p>
      )}
      {claim && !claim.ok && (
        <div className="ex-banner ex-banner--warn" role="note">
          <strong>Not shown as complete.</strong>
          <span>
            The status says completed but no provider completion time is
            recorded, so completion is not claimed.
          </span>
        </div>
      )}
      {erasure.providerStatus === 'submission_ambiguous' && (
        <div className="ex-banner ex-banner--warn" role="note">
          <strong>Needs a person.</strong>
          <span>
            Nothing will resend this request on its own. Reconcile it with the
            provider before relying on the local state.
          </span>
        </div>
      )}
      <dl className="ex-dl">
        <dt>Regulation</dt>
        <dd>{erasure.regulation.toUpperCase()}</dd>
        <dt>Subjects</dt>
        <dd className="ex-num">{erasure.subjectCount}</dd>
        <dt>Received</dt>
        <dd className="ex-num">{formatTime(erasure.receivedAt)}</dd>
        <dt>Due by</dt>
        <dd className="ex-num">
          {erasure.dueBy ? formatTime(erasure.dueBy) : 'No due date recorded'}
        </dd>
        <dt>Local export suppression</dt>
        <dd>{erasure.localExportSuppression}</dd>
        <dt>Pending outbox entries revoked</dt>
        <dd className="ex-num">{erasure.revokedPendingEntries}</dd>
      </dl>
      <h3 className="ex-h3">History</h3>
      {erasure.history.length === 0 ? (
        <p className="ex-note">No status changes are recorded.</p>
      ) : (
        <TableWrap label="Provider status history">
          <table className="ex-table">
            <caption className="ex-sr">Provider status history</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Status</th>
                <th scope="col">Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {erasure.history.map((entry) => (
                <tr key={`${entry.at}:${entry.snapshotHash}`}>
                  <th scope="row" className="ex-num">
                    {formatTime(entry.at)}
                  </th>
                  <td>{entry.status.replaceAll('_', ' ')}</td>
                  <td>
                    <HashChip
                      value={entry.snapshotHash}
                      label="snapshot hash"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </>
  );
}

export function PrivacyDocument({ data }: { data: PrivacyData2 }) {
  const { progress } = data;
  return (
    <>
      <section className="ex-section" aria-labelledby="ex-pv-prog-h">
        <h2 className="ex-h2" id="ex-pv-prog-h">
          Retraction progress
        </h2>
        <p>
          Source <span className="ex-data">{data.sourceId}</span>, retraction{' '}
          <span className="ex-data">{data.retractionId}</span>.
        </p>
        {progress.failClosed && (
          <div className="ex-banner ex-banner--warn" role="note">
            <strong>Failed closed.</strong>
            <span>
              The retraction stopped without proving it reached everything
              derived from this source. Derived artifacts are treated as revoked
              until it completes.
            </span>
          </div>
        )}
        <p>
          <StatusChip
            state={progress.closureComplete ? 'ok' : 'incomplete'}
            label={
              progress.closureComplete
                ? 'derivation closure complete'
                : 'derivation closure not complete'
            }
          />
        </p>
        <dl className="ex-dl">
          <dt>Visited</dt>
          <dd className="ex-num">{progress.visited}</dd>
          <dt>Frontier</dt>
          <dd className="ex-num">{progress.frontierSize}</dd>
          <dt>Revoked</dt>
          <dd className="ex-num">{progress.revoked}</dd>
          <dt>Regenerated</dt>
          <dd className="ex-num">{progress.regenerated}</dd>
          <dt>Runs cancelled</dt>
          <dd className="ex-num">{progress.runsCancelled}</dd>
          <dt>Retained-bytes check</dt>
          <dd>
            {data.retainedBytesCheck.state === 'checked'
              ? `Checked: ${plural(data.retainedBytesCheck.violations, 'violation')}.`
              : 'Not checked, so no claim is made about retained bytes.'}
          </dd>
        </dl>
        {!progress.closureComplete && (
          <p className="ex-note">
            Until the closure is complete, the artifacts listed below are the
            ones known so far, not a complete list.
          </p>
        )}
      </section>

      <section className="ex-section" aria-labelledby="ex-pv-graph-h">
        <h2 className="ex-h2" id="ex-pv-graph-h">
          Source derivation
        </h2>
        {data.edges.length === 0 ? (
          <p className="ex-note">No derivation edges are recorded.</p>
        ) : (
          <TableWrap label="Derivation edges">
            <table className="ex-table">
              <caption>
                {plural(data.edges.length, 'edge')}. Each row reads: the first
                item relates to the second as stated.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Relation</th>
                  <th scope="col">Item</th>
                </tr>
              </thead>
              <tbody>
                {data.edges.map((edge) => (
                  <tr key={edge.edgeKey}>
                    <th scope="row" className="ex-data">
                      {edge.fromId}
                    </th>
                    <td>{edge.kind.replaceAll('_', ' ')}</td>
                    <td className="ex-data">{edge.toId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <h3 className="ex-h3">Learning eligibility of derived artifacts</h3>
        {data.eligibility.length === 0 ? (
          <p className="ex-note">No derived artifact is recorded.</p>
        ) : (
          <TableWrap label="Artifact eligibility">
            <table className="ex-table">
              <caption className="ex-sr">Artifact eligibility</caption>
              <thead>
                <tr>
                  <th scope="col">Artifact</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Sources</th>
                </tr>
              </thead>
              <tbody>
                {data.eligibility.map((item) => (
                  <tr key={item.artifactHash}>
                    <th scope="row">
                      <HashChip
                        value={item.artifactHash}
                        label="artifact hash"
                      />
                    </th>
                    <td>
                      <StatusChip
                        state={item.state === 'permitted' ? 'ok' : 'rejected'}
                        label={item.state.replaceAll('_', ' ')}
                      />
                    </td>
                    <td>
                      <code className="ex-code">{item.reasonCode}</code>
                    </td>
                    <td className="ex-data">{item.sourceIds.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <section className="ex-section" aria-labelledby="ex-pv-er-h">
        <h2 className="ex-h2" id="ex-pv-er-h">
          Provider deletion
        </h2>
        <ErasureLifecycle erasure={data.erasure} />
      </section>
    </>
  );
}

function Body({ jobId }: { jobId: string }) {
  const job = useResource<ExpungeJobSnapshotV2>(
    `/jobs/${encodeURIComponent(jobId)}`,
  );
  const ref = job.data?.artifacts.find((item) => item.kind === 'retraction');
  const read = useResource<ArtifactEnvelope<PrivacyData2>>(
    ref ? `/artifacts/${encodeURIComponent(ref.artifactId)}` : null,
  );
  if (job.status === 'loading') return <Skeleton label="privacy record" />;
  if (job.status === 'not_found')
    return (
      <EmptyState title="This job is not available from the projection." />
    );
  if (job.status === 'unavailable')
    return (
      <UnavailableState
        what="The privacy record"
        reason={job.error?.message ?? 'The domain service is not reachable.'}
        onRecheck={job.refresh}
      />
    );
  if (!job.data)
    return (
      <ErrorState what="the job" error={job.error} onRetry={job.refresh} />
    );
  if (!ref)
    return (
      <EmptyState title="No retraction is recorded for this job.">
        Nothing is shown in its place. A retraction appears here once a source
        deletion has been recorded.
      </EmptyState>
    );
  if (read.status === 'loading') return <Skeleton label="retraction" />;
  if (!read.data)
    return (
      <ErrorState
        what="the retraction"
        error={read.error}
        onRetry={read.refresh}
      />
    );
  return <PrivacyDocument data={read.data.payload} />;
}

export default function PrivacyPage({ route }: ViewProps) {
  const jobId = route.name === 'privacy' ? route.jobId : '';
  useDocumentTitle(`Privacy · ${jobId}`);
  if (route.name !== 'privacy') return null;
  return (
    <div className="ex-page">
      <nav aria-label="Breadcrumb" className="ex-crumbs">
        <a className="ex-link" href={formatRoute({ name: 'home' })}>
          Jobs
        </a>
        <span aria-hidden> / </span>
        <a
          className="ex-link ex-data"
          href={formatRoute({ name: 'job', jobId, tab: 'workbench' })}
        >
          {jobId}
        </a>
      </nav>
      <PageHeading eyebrow="Expunge" title="Privacy and retraction">
        What was derived from a deleted source, how far the retraction has
        reached, and where the provider&apos;s deletion stands.
      </PageHeading>
      <Body key={jobId} jobId={jobId} />
    </div>
  );
}
