import { useState } from 'react';
import type {
  ApprovalDecisionResult,
  ApprovalDescriptorView,
} from '../../../shared/expunge';
import { ExpungeApiError, expungeFetch } from '../api';
import { Dialog } from '../components/Dialog';
import { HashChip } from '../components/HashChip';
import { useAnnounce } from '../components/LiveRegion';
import { PendingAcknowledgement } from '../components/PendingAcknowledgement';
import {
  ErrorState,
  Skeleton,
  UnavailableState,
} from '../components/StateViews';
import { StatusChip } from '../components/StatusChip';
import { TableWrap } from '../components/TableWrap';
import { formatTime } from '../format';
import { useNow } from '../hooks/useNow';
import { useResource } from '../hooks/useResource';
import { CHANGE_WORD, approvalAvailability, expiresIn } from './approvalState';

type Phase = 'idle' | 'submitting' | 'recorded' | 'failed';

/**
 * The only write the dialog makes. The body is exactly the decision and the digest of the
 * descriptor that was displayed; nothing executable and nothing else is ever sent.
 */
/** What the operator returns for a decision: the database's state and, on approve, the grant it minted. */
export type DecisionAnswer = ApprovalDecisionResult & {
  grantId?: string | null;
};

export function submitDecision(
  proposalId: string,
  descriptor: Pick<ApprovalDescriptorView, 'descriptorDigest'>,
  decision: 'approve' | 'decline',
) {
  return expungeFetch<DecisionAnswer>(
    `/proposals/${encodeURIComponent(proposalId)}/decision`,
    {
      method: 'POST',
      body: { decision, descriptorDigest: descriptor.descriptorDigest },
    },
  );
}

export const APPROVE_LABEL = 'Approve this change';
export const APPROVE_HELP =
  'Approving grants permission to promote; the promotion appears only when the database commits it.';

/** The dialog's buttons. Approve is last and never default; its label does not claim a promotion. */
export function DecisionActions({
  canDecide,
  recorded,
  busy,
  onDecline,
  onApprove,
  onRefresh,
  onClose,
}: {
  canDecide: boolean;
  recorded: boolean;
  busy: boolean;
  onDecline: () => void;
  onApprove: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const decidable = canDecide && !recorded;
  return (
    <>
      {decidable && (
        <p className="ex-note" id="ex-approve-help">
          {APPROVE_HELP}
        </p>
      )}
      <div className="ex-actions ex-dialog-actions">
        {decidable && (
          <button
            type="button"
            className="ex-btn"
            disabled={busy}
            onClick={onDecline}
          >
            Decline
          </button>
        )}
        <button type="button" className="ex-btn" onClick={onRefresh}>
          Refresh
        </button>
        <button type="button" className="ex-btn" onClick={onClose}>
          Close without deciding
        </button>
        {decidable && (
          <button
            type="button"
            className="ex-btn ex-btn--primary"
            disabled={busy}
            aria-describedby="ex-approve-help"
            onClick={onApprove}
          >
            {busy ? 'Sending' : APPROVE_LABEL}
          </button>
        )}
      </div>
    </>
  );
}

/** After a decision: what the database reported, and the grant it minted when there is one. Never "promoted". */
export function DecisionRecorded({
  decision,
  state,
  grantId,
}: {
  decision: 'approve' | 'decline';
  state: ApprovalDecisionResult['state'];
  grantId: string | null;
}) {
  return (
    <p>
      <PendingAcknowledgement>
        {decision === 'approve' ? 'Approval' : 'Decline'} sent. The database
        reports the proposal as <strong>{state}</strong>.
        {grantId && decision === 'approve' && (
          <>
            {' '}
            It minted grant <code className="ex-code">{grantId}</code>.
          </>
        )}{' '}
        Promotion appears only when the database commits it.
      </PendingAcknowledgement>
    </p>
  );
}

/** Content read only from the stored descriptor; nothing here comes from the model or the browser. */
export function ApprovalContent({
  descriptor,
  now,
}: {
  descriptor: ApprovalDescriptorView;
  now: number;
}) {
  return (
    <>
      <p className="ex-note">
        Read from the stored descriptor. The state shown is the database&apos;s,
        and expiry is{' '}
        <time dateTime={descriptor.expiresAt}>
          {formatTime(descriptor.expiresAt)}
        </time>{' '}
        ({expiresIn(descriptor.expiresAt, now)}).
      </p>
      <dl className="ex-dl">
        <dt>Target</dt>
        <dd>{descriptor.target}</dd>
        <dt>Parent harness</dt>
        <dd>
          <HashChip value={descriptor.parentHash} label="parent hash" />{' '}
          <span className="ex-note">
            expected revision {descriptor.expectedParentRevision}
          </span>
        </dd>
        <dt>Child harness</dt>
        <dd>
          <HashChip value={descriptor.childHash} label="child hash" />
        </dd>
        <dt>Authority class</dt>
        <dd>
          <strong>{descriptor.computedClass.replaceAll('_', ' ')}</strong>{' '}
          <span className="ex-note">computed by the gate, not claimed</span>
        </dd>
        <dt>Scope</dt>
        <dd>
          <span className="ex-data">{descriptor.scope.scopeId}</span>{' '}
          <span className="ex-note">
            revision {descriptor.scope.scopeRevision}, authorization revision{' '}
            {descriptor.scope.authorizationRevision}
          </span>
        </dd>
        <dt>Gate report</dt>
        <dd>
          <span className="ex-data">{descriptor.gateReportId}</span>{' '}
          <HashChip value={descriptor.gateReportDigest} label="gate digest" />
        </dd>
        <dt>Approver</dt>
        <dd>{descriptor.approver.display}</dd>
      </dl>
      <h3 className="ex-h3">Capabilities that change</h3>
      {descriptor.flipSet.length === 0 ? (
        <p className="ex-note">The flip set is empty.</p>
      ) : (
        <TableWrap label="Flip set">
          <table className="ex-table">
            <caption className="ex-sr">Capabilities that change</caption>
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {descriptor.flipSet.map((flip) => (
                <tr key={flip.capability}>
                  <th scope="row" className="ex-data">
                    {flip.capability}
                  </th>
                  <td>{CHANGE_WORD[flip.change]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <p className="ex-note">
        Flip set digest{' '}
        <HashChip value={descriptor.flipSetDigest} label="flip set digest" />
      </p>
      <h3 className="ex-h3">Consequences</h3>
      <ul className="ex-list">
        {descriptor.consequences.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * The single decision surface for a harness proposal. It posts only the decision and the
 * descriptor digest it displayed; after the call it shows what the database says, never
 * "promoted" from the click.
 */
export function ApprovalDialog({
  proposalId,
  open,
  onClose,
  onDecided,
}: {
  proposalId: string;
  open: boolean;
  onClose: () => void;
  /** Called after the operator answered, so the caller refreshes its committed state. */
  onDecided?: (result: ApprovalDecisionResult) => void;
}) {
  const read = useResource<ApprovalDescriptorView>(
    open ? `/proposals/${encodeURIComponent(proposalId)}` : null,
  );
  const now = useNow(open ? 15_000 : 3_600_000);
  const announce = useAnnounce();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ExpungeApiError | null>(null);
  const [result, setResult] = useState<{
    decision: 'approve' | 'decline';
    state: ApprovalDecisionResult['state'];
    grantId: string | null;
  } | null>(null);
  const descriptor = read.data;
  const availability = descriptor
    ? approvalAvailability(descriptor, now)
    : null;

  const close = () => {
    setPhase('idle');
    setError(null);
    setResult(null);
    onClose();
  };
  const decide = async (decision: 'approve' | 'decline') => {
    if (!descriptor) return;
    setPhase('submitting');
    setError(null);
    try {
      const answer = await submitDecision(proposalId, descriptor, decision);
      setResult({
        decision,
        state: answer.state,
        grantId: answer.grantId ?? null,
      });
      setPhase('recorded');
      announce(
        'Your decision was sent. Waiting for the database to commit the result.',
      );
      read.refresh();
      onDecided?.(answer);
    } catch (cause) {
      setError(
        cause instanceof ExpungeApiError
          ? cause
          : new ExpungeApiError(
              'transport',
              0,
              'transport',
              'Could not reach the operator.',
            ),
      );
      setPhase('failed');
    }
  };

  const busy = phase === 'submitting';
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Review harness proposal"
      titleId="ex-approval-title"
      fallbackSelector="h2"
    >
      {read.status === 'loading' && <Skeleton label="proposal" />}
      {!descriptor && read.status !== 'loading' && (
        <ErrorState
          what="the proposal"
          error={read.error}
          onRetry={read.refresh}
        />
      )}
      {descriptor && (
        <>
          <ApprovalContent descriptor={descriptor} now={now} />
          {phase === 'failed' && error && (
            <div role="alert" className="ex-banner ex-banner--warn">
              <strong>
                {error.code === 'conflict'
                  ? 'The proposal changed or was already decided.'
                  : error.kind === 'transport'
                    ? 'Could not reach the operator.'
                    : 'The decision was not accepted.'}
              </strong>
              <span>
                {error.code === 'conflict'
                  ? 'Nothing was recorded from this click. Refresh to see the committed state.'
                  : 'Nothing was recorded. Try again, or close and review again.'}
              </span>
            </div>
          )}
          {error?.code === 'write_principal_missing' ||
          error?.code === 'owner_auth_required' ? (
            <UnavailableState
              what="Approval"
              reason={
                error.code === 'owner_auth_required'
                  ? 'The operator requires its owner access token for every write.'
                  : 'This operator has no credential for approval decisions.'
              }
              missing={error.missing}
            />
          ) : null}
          {phase === 'recorded' && result && <DecisionRecorded {...result} />}
          {availability && !availability.canDecide && (
            <div className="ex-banner ex-banner--info" role="status">
              <StatusChip
                state={
                  availability.reason === 'expired' ? 'stale' : 'unavailable'
                }
                label={availability.reason}
              />
              <span>{availability.text}</span>
            </div>
          )}
          <DecisionActions
            canDecide={!!availability?.canDecide}
            recorded={phase === 'recorded'}
            busy={busy}
            onDecline={() => void decide('decline')}
            onApprove={() => void decide('approve')}
            onRefresh={read.refresh}
            onClose={close}
          />
        </>
      )}
    </Dialog>
  );
}
