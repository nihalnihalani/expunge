import { useEffect, useRef, useState } from 'react';
import { Ban } from 'lucide-react';
import type { ExpungeJobSnapshotV2 } from '../../../shared/expunge';
import { ExpungeApiError, expungeFetch } from '../api';
import { isTerminal } from '../projection/selectors';
import { useAnnounce } from './LiveRegion';
import { PendingAcknowledgement } from './PendingAcknowledgement';
import { UnavailableState } from './StateViews';

type Phase = 'idle' | 'confirming' | 'submitting' | 'submitted' | 'failed';

/**
 * Cancel is an explicit, two-step, ID-only write. Nothing here marks the job cancelled: after
 * the POST the control shows a neutral pending acknowledgement until the committed snapshot
 * says cancellation was requested (and later cancelled). Closing the tab never cancels a job.
 */
export function CancelControl({
  snapshot,
  onSubmitted,
}: {
  snapshot: ExpungeJobSnapshotV2;
  onSubmitted?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ExpungeApiError | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const pending = useRef<HTMLDivElement>(null);
  const announce = useAnnounce();
  useEffect(() => {
    if (phase === 'confirming') keep.current?.focus();
    if (phase === 'submitted') pending.current?.focus();
  }, [phase]);
  // Once the database records the request, the committed snapshot owns the display.
  if (isTerminal(snapshot.status) || snapshot.cancellation.requested)
    return null;
  const submit = async () => {
    setPhase('submitting');
    setError(null);
    try {
      await expungeFetch(`/jobs/${encodeURIComponent(snapshot.jobId)}/cancel`, {
        method: 'POST',
        body: {},
      });
      setPhase('submitted');
      announce('Cancellation submitted. Waiting for the database to confirm.');
      onSubmitted?.();
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
  if (phase === 'submitted')
    return (
      <div ref={pending} tabIndex={-1} className="ex-cancel">
        <PendingAcknowledgement>
          Cancellation submitted. Waiting for the database to confirm; the job
          stops only when it is committed as cancelled.
        </PendingAcknowledgement>
      </div>
    );
  if (phase === 'failed' && error?.code === 'owner_auth_required')
    return (
      <UnavailableState
        what="Cancel"
        reason="The operator requires its owner access token for every write. Nothing was submitted."
        missing={error.missing}
        onRecheck={() => setPhase('idle')}
      />
    );
  if (phase === 'failed' && error?.code === 'write_principal_missing')
    return (
      <UnavailableState
        what="Cancel"
        reason="This operator has no credential for job writes."
        missing={error.missing}
        onRecheck={() => setPhase('idle')}
      />
    );
  return (
    <div className="ex-cancel">
      {phase === 'failed' && error && (
        <p className="ex-note" role="alert">
          {error.code === 'conflict'
            ? 'The job already reached a state that cannot be cancelled. Refresh to see its committed status.'
            : error.kind === 'transport'
              ? 'Could not reach the operator, so nothing was submitted. Try again.'
              : 'The cancellation was not accepted. Nothing was changed.'}
        </p>
      )}
      {phase === 'confirming' || phase === 'submitting' ? (
        <div
          className="ex-confirm"
          role="group"
          aria-labelledby="ex-cancel-h"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && phase === 'confirming') {
              setPhase('idle');
              start.current?.focus();
            }
          }}
        >
          <p className="ex-state-title" id="ex-cancel-h">
            Cancel this cleanup?
          </p>
          <p className="ex-note">
            Effects the database already committed stay committed. The job stops
            at its next safe point, and you will see the committed result here.
          </p>
          <div className="ex-actions">
            <button
              ref={keep}
              type="button"
              className="ex-btn"
              disabled={phase === 'submitting'}
              onClick={() => setPhase('idle')}
            >
              Keep running
            </button>
            <button
              type="button"
              className="ex-btn ex-btn--danger"
              disabled={phase === 'submitting'}
              onClick={() => void submit()}
            >
              {phase === 'submitting' ? 'Submitting' : 'Cancel cleanup'}
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={start}
          type="button"
          className="ex-btn ex-btn--danger"
          onClick={() => setPhase('confirming')}
        >
          <Ban size={14} aria-hidden /> Cancel cleanup
        </button>
      )}
    </div>
  );
}
