import type {
  ArtifactEnvelope,
  CompletionReceiptView,
  EffectKind,
  ExpungeJobSnapshotV2,
  ExternalErasureStatus,
  ModelNarrativeView,
} from '../../../shared/expunge';
import { CommittedSeal } from '../components/CommittedSeal';
import { HashChip } from '../components/HashChip';
import { JobFrame } from '../components/JobFrame';
import { NarrativeBlock } from '../components/NarrativeBlock';
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
  id: 'receipt',
  label: 'Receipt',
  routes: ['job'],
  tab: 'receipt',
  scope: 'job',
  order: 50,
};

const EFFECT_ORDER: EffectKind[] = [
  'delete',
  'redact',
  'restrict',
  'tombstone',
];

/** The backend's external erasure state, worded exactly and without upgrading it. */
export const ERASURE_COPY: Record<ExternalErasureStatus, string> = {
  not_required: 'Not required: no external provider holds data for this job.',
  pending:
    'Pending: the provider has not yet confirmed deletion. Completion in the registered scope does not include it.',
  confirmed: 'Confirmed by the provider.',
  failed: 'Failed: the provider reported that deletion did not complete.',
};

const artifactPath = (id: string) => `/artifacts/${encodeURIComponent(id)}`;

/** Why the receipt is not shown, from the committed job status only. */
export function absenceText(snapshot: ExpungeJobSnapshotV2) {
  switch (snapshot.status) {
    case 'failed':
      return 'The job failed before committing a completion receipt. Nothing is claimed as complete.';
    case 'cancelled':
      return 'The job was cancelled before committing a completion receipt. Nothing is claimed as complete.';
    case 'succeeded':
      return 'The job is recorded as finished but the snapshot carries no completion receipt. The completion verdict is not shown.';
    default:
      return 'No completion receipt has been committed yet. Completion is not claimed until the database records one.';
  }
}

/**
 * Pure rendering of a committed receipt. The caller has already checked that the receipt
 * belongs to this job and matches the snapshot's receipt reference.
 */
export function ReceiptDocument({
  receipt,
  sequence,
  narrative,
}: {
  receipt: CompletionReceiptView;
  sequence: number;
  narrative?: ModelNarrativeView | null;
}) {
  const notInspected = receipt.registeredCollectionIds.filter(
    (id) => !receipt.inspectedCollectionIds.includes(id),
  );
  const complete = receipt.domainStatus === 'complete_in_registered_scope';
  const counted = EFFECT_ORDER.filter(
    (kind) => receipt.effectCounts[kind] !== undefined,
  );
  return (
    <>
      <section className="ex-section" aria-labelledby="ex-rc-verdict-h">
        <h2 className="ex-h2" id="ex-rc-verdict-h">
          Verdict
        </h2>
        <p className="ex-receipt-verdict">
          <CommittedSeal
            source={{ kind: 'receipt', id: receipt.receiptId, sequence }}
          />{' '}
          <StatusChip
            state={complete ? 'complete_in_scope' : 'incomplete'}
            label={complete ? 'Complete in registered scope' : 'Incomplete'}
          />
        </p>
        <p className="ex-note">
          {complete
            ? `Verified at world revision ${receipt.verifiedWorldRevision} against ${plural(receipt.registeredCollectionIds.length, 'registered collection')}. This does not cover data outside the registry or any external provider.`
            : `The receipt records the job as incomplete at world revision ${receipt.verifiedWorldRevision}. See the limitations below.`}
        </p>
      </section>

      <section className="ex-section" aria-labelledby="ex-rc-ident-h">
        <h2 className="ex-h2" id="ex-rc-ident-h">
          What was verified
        </h2>
        <dl className="ex-dl">
          <dt>Receipt</dt>
          <dd>
            <HashChip value={receipt.receiptId} label="receipt id" />
          </dd>
          <dt>Job</dt>
          <dd className="ex-data">{receipt.jobId}</dd>
          <dt>Run</dt>
          <dd className="ex-data">{receipt.runId}</dd>
          <dt>Harness</dt>
          <dd>
            <HashChip value={receipt.harnessHash} label="harness hash" />
          </dd>
          <dt>Scope</dt>
          <dd>
            <span className="ex-data">{receipt.scopeId}</span>{' '}
            <span className="ex-note">revision {receipt.scopeRevision}</span>
          </dd>
          <dt>Verified world revision</dt>
          <dd className="ex-num">{receipt.verifiedWorldRevision}</dd>
          <dt>Verification plan</dt>
          <dd>
            <HashChip
              value={receipt.verificationPlanHash}
              label="verification plan hash"
            />
          </dd>
          <dt>Committed</dt>
          <dd className="ex-num">
            event {sequence}, {formatTime(receipt.committedAt)}
          </dd>
        </dl>
      </section>

      <section className="ex-section" aria-labelledby="ex-rc-eff-h">
        <h2 className="ex-h2" id="ex-rc-eff-h">
          Eligible effects applied
        </h2>
        {counted.length === 0 ? (
          <p className="ex-note">
            The receipt records no applied effects. That is a committed fact,
            not a missing value.
          </p>
        ) : (
          <TableWrap label="Effects by kind">
            <table className="ex-table">
              <caption className="ex-sr">Applied effects by kind</caption>
              <thead>
                <tr>
                  <th scope="col">Effect</th>
                  <th scope="col" className="ex-right">
                    Records
                  </th>
                </tr>
              </thead>
              <tbody>
                {counted.map((kind) => (
                  <tr key={kind}>
                    <th scope="row">{kind}</th>
                    <td className="ex-num ex-right">
                      {receipt.effectCounts[kind]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="ex-note">
          {plural(receipt.actionReceiptIds.length, 'action receipt')} back these
          counts.
        </p>
      </section>

      <section className="ex-section" aria-labelledby="ex-rc-res-h">
        <h2 className="ex-h2" id="ex-rc-res-h">
          Residual, retained and not inspected
        </h2>
        <dl className="ex-dl">
          <dt>Operational residuals</dt>
          <dd className="ex-num">{receipt.operationalResiduals}</dd>
          <dt>Excluded or retained records</dt>
          <dd className="ex-num">{receipt.excludedOrRetainedRecords}</dd>
          <dt>Collections inspected</dt>
          <dd className="ex-num">
            {receipt.inspectedCollectionIds.length} of{' '}
            {receipt.registeredCollectionIds.length}
          </dd>
          <dt>Registered fields discovered</dt>
          <dd className="ex-num">{receipt.discoveredFieldIds.length}</dd>
        </dl>
        {notInspected.length > 0 && (
          <p className="ex-note">
            Not inspected:{' '}
            {notInspected.map((name, index) => (
              <span key={name}>
                {index > 0 && ', '}
                <code className="ex-code">{name}</code>
              </span>
            ))}
            .
          </p>
        )}
        <h3 className="ex-h3">Limitations</h3>
        {receipt.limitations.length === 0 ? (
          <p className="ex-note">The receipt states no limitations.</p>
        ) : (
          <ul className="ex-list">
            {receipt.limitations.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="ex-section" aria-labelledby="ex-rc-ext-h">
        <h2 className="ex-h2" id="ex-rc-ext-h">
          External erasure
        </h2>
        <p>
          <StatusChip
            state={
              receipt.externalErasureStatus === 'confirmed'
                ? 'ok'
                : receipt.externalErasureStatus === 'failed'
                  ? 'failed'
                  : 'pending_ack'
            }
            label={receipt.externalErasureStatus.replaceAll('_', ' ')}
          />{' '}
          {ERASURE_COPY[receipt.externalErasureStatus]}
        </p>
      </section>

      {receipt.independentGrader && (
        <section className="ex-section" aria-labelledby="ex-rc-grader-h">
          <h2 className="ex-h2" id="ex-rc-grader-h">
            Independent grader
          </h2>
          <p className="ex-note">
            Evaluation view only, produced by the fixed evaluator{' '}
            <HashChip
              value={receipt.independentGrader.evaluatorHash}
              label="evaluator hash"
            />
            : {receipt.independentGrader.verdict}
            {receipt.independentGrader.reasonCodes.length > 0
              ? ` (${receipt.independentGrader.reasonCodes.join(', ')})`
              : ''}
            .
          </p>
        </section>
      )}

      {narrative && (
        <section className="ex-section" aria-labelledby="ex-rc-narr-h">
          <h2 className="ex-h2" id="ex-rc-narr-h">
            Model account of the run
          </h2>
          <p className="ex-note">
            Written by the model, untrusted, and not a source for any field
            above. Where it disagrees with the receipt, the receipt is right.
          </p>
          <NarrativeBlock text={narrative.text} replayed={narrative.replayed} />
        </section>
      )}
    </>
  );
}

function ReceiptBody({ snapshot }: { snapshot: ExpungeJobSnapshotV2 }) {
  const ref = snapshot.receipt;
  const receiptArtifact =
    snapshot.artifacts.find(
      (item) =>
        item.kind === 'completion_receipt' &&
        (!ref || item.artifactId === ref.receiptId),
    ) ?? snapshot.artifacts.find((item) => item.kind === 'completion_receipt');
  const narrativeArtifact = snapshot.artifacts.find(
    (item) => item.kind === 'model_narrative',
  );
  const receiptRead = useResource<ArtifactEnvelope<CompletionReceiptView>>(
    ref ? artifactPath(receiptArtifact?.artifactId ?? ref.receiptId) : null,
  );
  const narrativeRead = useResource<ArtifactEnvelope<ModelNarrativeView>>(
    narrativeArtifact ? artifactPath(narrativeArtifact.artifactId) : null,
  );
  if (!ref)
    return (
      <>
        <EmptyState title="No completion receipt">
          {absenceText(snapshot)}
        </EmptyState>
        {narrativeRead.data && (
          <NarrativeBlock
            text={narrativeRead.data.payload.text}
            replayed={narrativeRead.data.payload.replayed}
          />
        )}
      </>
    );
  if (receiptRead.status === 'loading') return <Skeleton label="receipt" />;
  if (receiptRead.status === 'unavailable')
    return (
      <UnavailableState
        what="The receipt"
        reason={
          receiptRead.error?.message ?? 'The artifact service is not reachable.'
        }
        onRecheck={receiptRead.refresh}
      />
    );
  if (!receiptRead.data)
    return (
      <ErrorState
        what="the receipt"
        error={receiptRead.error}
        onRetry={receiptRead.refresh}
      />
    );
  return (
    <ReceiptPanel
      snapshot={snapshot}
      receipt={receiptRead.data.payload}
      narrative={narrativeRead.data?.payload ?? null}
    />
  );
}

/** True when the fetched receipt is the one this job's committed snapshot names. */
export function receiptMatches(
  snapshot: Pick<ExpungeJobSnapshotV2, 'jobId' | 'receipt'>,
  receipt: Pick<CompletionReceiptView, 'jobId' | 'receiptId'>,
) {
  return (
    snapshot.receipt !== null &&
    receipt.jobId === snapshot.jobId &&
    receipt.receiptId === snapshot.receipt.receiptId
  );
}

/**
 * A receipt that is not this job's, or not the one the snapshot names, is never rendered:
 * no seal and no verdict, only the mismatch message.
 */
export function ReceiptPanel({
  snapshot,
  receipt,
  narrative,
}: {
  snapshot: ExpungeJobSnapshotV2;
  receipt: CompletionReceiptView;
  narrative?: ModelNarrativeView | null;
}) {
  if (!snapshot.receipt || !receiptMatches(snapshot, receipt))
    return (
      <div className="ex-state" role="alert">
        <p className="ex-state-title">The receipt does not match this job.</p>
        <p>
          The artifact returned is not the receipt the committed snapshot names,
          so no verdict is shown.
        </p>
      </div>
    );
  return (
    <ReceiptDocument
      receipt={receipt}
      sequence={snapshot.receipt.sequence}
      narrative={narrative}
    />
  );
}

export default function ReceiptView({ route }: ViewProps) {
  useDocumentTitle(
    route.name === 'job' ? `Job ${route.jobId} · Receipt` : 'Receipt',
  );
  if (route.name !== 'job') return null;
  return (
    <JobFrame route={route} title={`Job ${route.jobId}`}>
      {({ state }) => <ReceiptBody snapshot={state.snapshot!} />}
    </JobFrame>
  );
}
