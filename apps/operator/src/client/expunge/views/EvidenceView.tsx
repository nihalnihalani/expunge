import type {
  ArtifactEnvelope,
  EvidenceBundleView,
  EvidenceReferenceView,
  ExpungeJobSnapshotV2,
  OutboxState,
  SourceOrigin,
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
import { formatTime, plural } from '../format';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useResource } from '../hooks/useResource';
import type { ViewMeta, ViewProps } from '../registry';

export const meta: ViewMeta = {
  id: 'evidence',
  label: 'Evidence',
  routes: ['job'],
  tab: 'evidence',
  scope: 'job',
  order: 15,
};

const MAX_BUNDLES = 10;

/** The delivery ladder in order. retrying and dead_letter sit off it (shown separately). */
export const LADDER: OutboxState[] = [
  'pending',
  'leased',
  'sdk_enqueued',
  'ingest_accepted',
  'query_visible',
  'evidence_ready',
];

export const OUTBOX_COPY: Record<OutboxState, string> = {
  pending: 'Recorded locally and waiting to be sent.',
  leased: 'Claimed by the sender; not yet handed to the SDK.',
  sdk_enqueued:
    'Handed to the Raindrop SDK. Enqueueing is not proof of delivery.',
  ingest_accepted:
    'The terminal event was accepted by ingest. Spans and signals may not be visible yet.',
  query_visible:
    'Visible to a separate read-back query. Not every component is proven yet.',
  evidence_ready:
    'Read back from Raindrop: every component the proposal needs is proven.',
  retrying: 'A delivery attempt failed and will be retried.',
  dead_letter:
    'Delivery gave up. The evidence is NOT available; this is not a clean result.',
};

/** evidence_ready on a truncated bundle: proven only as far as the remote cap allowed. */
export const READY_TRUNCATED_COPY =
  'Read back from Raindrop up to the cap; later components may be missing. This is not full evidence.';

export const ORIGIN_COPY: Record<SourceOrigin, string> = {
  agent_self_report: 'The agent reported it about itself',
  verifier_feedback: 'The verifier',
  human_feedback: 'A person',
  raindrop_classifier: 'A Raindrop classifier',
  experiment_result: 'An experiment',
  admission_service: 'The admission service',
};

const USE_COPY: Record<EvidenceReferenceView['permittedUse'], string> = {
  training: 'may be used to propose and train',
  gate_only: 'may be used by the gate only',
  display_only: 'display only, never learned from',
  revoked: 'revoked: not usable',
};

/** Position on the ladder, or -1 when the state is off it (retrying, dead_letter, unknown). */
export const ladderIndex = (state: OutboxState | null) =>
  state === null ? -1 : LADDER.indexOf(state);

export function OutboxLadder({
  state,
  truncated = false,
}: {
  state: OutboxState | null;
  truncated?: boolean;
}) {
  const at = ladderIndex(state);
  return (
    <>
      <ol className="ex-ladder" aria-label="Evidence delivery ladder">
        {LADDER.map((step, index) => {
          const reached = at >= index;
          const current = at === index;
          return (
            <li
              key={step}
              aria-current={current ? 'step' : undefined}
              data-reached={reached ? 'yes' : 'no'}
            >
              <span className="ex-ladder-name">
                {step.replaceAll('_', ' ')}
              </span>
              <span className="ex-note">
                {current
                  ? ' (current)'
                  : reached
                    ? ' (reached)'
                    : ' (not reached)'}
              </span>
            </li>
          );
        })}
      </ol>
      {state === null ? (
        <p className="ex-note">
          No delivery state is recorded, so none is claimed.
        </p>
      ) : (
        <p>
          <StatusChip
            state={
              state === 'evidence_ready'
                ? truncated
                  ? 'incomplete'
                  : 'ok'
                : state === 'dead_letter'
                  ? 'fail'
                  : state === 'retrying'
                    ? 'retrying'
                    : 'waiting_evidence'
            }
            label={
              state === 'evidence_ready' && truncated
                ? 'evidence ready, truncated'
                : state.replaceAll('_', ' ')
            }
          />{' '}
          {state === 'evidence_ready' && truncated
            ? READY_TRUNCATED_COPY
            : OUTBOX_COPY[state]}
        </p>
      )}
    </>
  );
}

function Id({ value, label }: { value?: string; label: string }) {
  return value ? (
    <HashChip value={value} label={label} />
  ) : (
    <span className="ex-note">none</span>
  );
}

/** Pure rendering of one committed, sanitized evidence bundle. */
export function EvidenceDocument({ bundle }: { bundle: EvidenceBundleView }) {
  const lastOutbox = bundle.outbox.at(-1)?.state ?? null;
  return (
    <article
      className="ex-candidate"
      aria-label={`Evidence ${bundle.evidenceId}`}
    >
      <h3 className="ex-h3">
        <span className="ex-data">{bundle.evidenceId}</span>{' '}
        <span className="ex-note">{bundle.split} split</span>
      </h3>
      {bundle.truncated && (
        <div className="ex-banner ex-banner--warn" role="note">
          <strong>Truncated.</strong>
          <span>
            The remote trace reached its cap, so this evidence may be
            incomplete. Missing spans are not evidence of no failure.
          </span>
        </div>
      )}
      {bundle.missing.length > 0 ? (
        <div className="ex-banner ex-banner--warn" role="note">
          <strong>Missing components.</strong>
          <span>
            {bundle.missing.map((name, index) => (
              <span key={name}>
                {index > 0 && ', '}
                <code className="ex-code">{name}</code>
              </span>
            ))}{' '}
            {bundle.missing.length === 1 ? 'was' : 'were'} not read back. Until{' '}
            {bundle.missing.length === 1 ? 'it is' : 'they are'}, this evidence
            is pending, not clean.
          </span>
        </div>
      ) : (
        <p className="ex-note">No component is recorded as missing.</p>
      )}

      <h4 className="ex-h4">Delivery</h4>
      <OutboxLadder state={lastOutbox} truncated={bundle.truncated} />
      {bundle.retryAttempts > 0 && (
        <p className="ex-note">
          {plural(bundle.retryAttempts, 'retry attempt')} recorded.
        </p>
      )}
      {bundle.outbox.length > 0 && (
        <TableWrap label="Delivery history">
          <table className="ex-table">
            <caption className="ex-sr">Delivery history</caption>
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {bundle.outbox.map((entry, index) => (
                <tr key={`${entry.state}:${index}`}>
                  <th scope="row">{entry.state.replaceAll('_', ' ')}</th>
                  <td className="ex-num">
                    {entry.at ? formatTime(entry.at) : 'not recorded'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      <h4 className="ex-h4">Remote sources</h4>
      {bundle.sources.length === 0 ? (
        <p className="ex-note">
          No remote source is recorded. Nothing is shown in its place.
        </p>
      ) : (
        <TableWrap label="Remote evidence sources">
          <table className="ex-table">
            <caption className="ex-sr">Remote evidence sources</caption>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Event id</th>
                <th scope="col">Trace id</th>
                <th scope="col">Signals</th>
                <th scope="col">Origin</th>
                <th scope="col">Use</th>
                <th scope="col">Content</th>
              </tr>
            </thead>
            <tbody>
              {bundle.sources.map((source) => (
                <tr key={`${source.provider}:${source.contentHash}`}>
                  <th scope="row">{source.provider}</th>
                  <td>
                    <Id
                      value={source.externalEventId}
                      label="external event id"
                    />
                  </td>
                  <td>
                    <Id
                      value={source.externalTraceId}
                      label="external trace id"
                    />
                  </td>
                  <td>
                    {source.externalSignalIds.length === 0 ? (
                      <span className="ex-note">none</span>
                    ) : (
                      source.externalSignalIds.map((signal) => (
                        <span key={signal} className="ex-data">
                          {signal}{' '}
                        </span>
                      ))
                    )}
                  </td>
                  <td>{ORIGIN_COPY[source.origin]}</td>
                  <td>{USE_COPY[source.permittedUse]}</td>
                  <td>
                    <HashChip value={source.contentHash} label="content hash" />{' '}
                    <span className="ex-note">
                      read {formatTime(source.retrievedAt)}, redaction{' '}
                      {source.redactionPolicy}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <p className="ex-note">
        Origin says who produced a piece of evidence, not how far to trust it.
        The origins stay distinct: verifier, person, classifier, experiment,
        admission and the agent itself.
      </p>

      <h4 className="ex-h4">What the worker did</h4>
      {bundle.tools.length === 0 ? (
        <p className="ex-note">No tool decisions are recorded.</p>
      ) : (
        <ul className="ex-list">
          {bundle.tools.map((tool, index) => (
            <li key={`${tool.toolId}:${index}`}>
              <code className="ex-code">{tool.toolId}</code>{' '}
              <StatusChip
                state={
                  tool.decision === 'allow'
                    ? 'ok'
                    : tool.decision === 'deny'
                      ? 'rejected'
                      : 'waiting_approval'
                }
                label={tool.decision}
              />{' '}
              {tool.summary}
            </li>
          ))}
        </ul>
      )}
      {bundle.diagnostics.length > 0 && (
        <>
          <h4 className="ex-h4">Diagnostics</h4>
          <ul className="ex-list">
            {bundle.diagnostics.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </>
      )}
      <p className="ex-note">
        Diagnosis confidence as reported:{' '}
        <span className="ex-num">{bundle.confidence}</span>. It is the
        reporter&apos;s number, not a measured interval.
      </p>
    </article>
  );
}

function BundleLoader({ artifactId }: { artifactId: string }) {
  const read = useResource<ArtifactEnvelope<EvidenceBundleView>>(
    `/artifacts/${encodeURIComponent(artifactId)}`,
  );
  if (read.status === 'loading') return <Skeleton label="evidence" />;
  if (read.status === 'unavailable')
    return (
      <UnavailableState
        what="The evidence bundle"
        reason={read.error?.message ?? 'The artifact service is not reachable.'}
        onRecheck={read.refresh}
      />
    );
  if (!read.data)
    return (
      <ErrorState
        what="the evidence bundle"
        error={read.error}
        onRetry={read.refresh}
      />
    );
  return <EvidenceDocument bundle={read.data.payload} />;
}

/** Job-level state from the committed snapshot, before any bundle is read. */
export function EvidenceSummary({
  snapshot,
}: {
  snapshot: Pick<ExpungeJobSnapshotV2, 'status' | 'evidence'>;
}) {
  const { evidence } = snapshot;
  return (
    <>
      <OutboxLadder
        state={evidence.outboxState}
        truncated={evidence.truncated}
      />
      {snapshot.status === 'waiting_evidence' && (
        <div className="ex-banner ex-banner--info" role="note">
          <strong>Waiting for evidence.</strong>
          <span>
            An outage or a missing read-back is evidence pending, not &quot;no
            failures&quot;.
          </span>
        </div>
      )}
      <p>
        {evidence.evidenceReady && evidence.truncated ? (
          <StatusChip state="incomplete" label="evidence ready, truncated" />
        ) : evidence.evidenceReady ? (
          <StatusChip state="ok" label="evidence ready" />
        ) : (
          <>
            <StatusChip state="waiting_evidence" label="evidence not ready" />
            {evidence.truncated && (
              <>
                {' '}
                <StatusChip state="incomplete" label="truncated" />
              </>
            )}
          </>
        )}
      </p>
    </>
  );
}

export default function EvidencePage({ route }: ViewProps) {
  useDocumentTitle(
    route.name === 'job' ? `Job ${route.jobId} · Evidence` : 'Evidence',
  );
  if (route.name !== 'job') return null;
  return (
    <JobFrame route={route} title={`Job ${route.jobId}`}>
      {({ state }) => {
        const snapshot = state.snapshot!;
        const refs = snapshot.artifacts
          .filter((item) => item.kind === 'evidence_bundle')
          .slice(0, MAX_BUNDLES);
        return (
          <>
            <section className="ex-section" aria-labelledby="ex-ev-sum-h">
              <h2 className="ex-h2" id="ex-ev-sum-h">
                Evidence status
              </h2>
              <EvidenceSummary snapshot={snapshot} />
            </section>
            <section className="ex-section" aria-labelledby="ex-ev-b-h">
              <h2 className="ex-h2" id="ex-ev-b-h">
                Evidence bundles
              </h2>
              {refs.length === 0 ? (
                <EmptyState title="No evidence bundle for this job.">
                  Nothing is shown in its place. A bundle appears once the
                  remote read-back has produced one.
                </EmptyState>
              ) : (
                refs.map((item) => (
                  <BundleLoader
                    key={item.artifactId}
                    artifactId={item.artifactId}
                  />
                ))
              )}
            </section>
          </>
        );
      }}
    </JobFrame>
  );
}
