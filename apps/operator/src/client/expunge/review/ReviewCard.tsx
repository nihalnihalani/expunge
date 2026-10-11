import { useRef, useState } from 'react';
import { FileSearch } from 'lucide-react';
import {
  expungeReviewSchema,
  type ApprovalDescriptorView,
} from '../../../shared/expunge';
import { StatusChip } from '../components/StatusChip';
import { useResource } from '../hooks/useResource';
import { ApprovalDialog } from './ApprovalDialog';
import '../css/00-tokens.css';
import '../css/10-base.css';
import '../css/60-dialog.css';
import '../css/70-review-card.css';

/** One sentence per stored state; the card never offers a decision, only the review. */
export const CARD_STATE_COPY: Record<ApprovalDescriptorView['state'], string> =
  {
    pending: 'A decision is owed. Open the review to read what would change.',
    approved: 'The database recorded an approval for this proposal.',
    declined: 'The database recorded a decline for this proposal.',
    expired: 'This proposal expired before a decision.',
    consumed: 'The grant for this proposal was already used.',
    stale: 'This proposal went stale and cannot be approved.',
  };

/** Presentation only, so it can be rendered statically in tests. */
export function ReviewCardBody({
  proposalId,
  state,
  loading,
  preparing = false,
  onOpen,
  openerRef,
  children,
}: {
  proposalId: string | null;
  state: ApprovalDescriptorView['state'] | null;
  loading: boolean;
  /** The tool call's arguments are still streaming in. */
  preparing?: boolean;
  onOpen: () => void;
  openerRef?: React.Ref<HTMLButtonElement>;
  /** Rendered inside the root so scoped styles reach it (the approval dialog). */
  children?: React.ReactNode;
}) {
  if (!proposalId)
    return (
      <div className="ex-root ex-chatcard">
        <p className="ex-state-title">
          {preparing
            ? 'Preparing the review request.'
            : 'This review request was not understood, so nothing can be opened.'}
        </p>
      </div>
    );
  return (
    <div className="ex-root ex-chatcard">
      <p className="ex-state-title">
        <FileSearch size={14} aria-hidden /> Harness proposal review
      </p>
      <p className="ex-note">
        Proposal <code className="ex-code">{proposalId}</code>
        {state && (
          <>
            {' '}
            <StatusChip
              state={
                state === 'pending'
                  ? 'waiting_approval'
                  : state === 'approved'
                    ? 'ok'
                    : state === 'declined'
                      ? 'rejected'
                      : 'stale'
              }
              label={state}
            />
          </>
        )}
      </p>
      <p>
        {loading
          ? 'Reading the stored proposal.'
          : state
            ? CARD_STATE_COPY[state]
            : 'The stored proposal could not be read. Open the workbench to see its committed state.'}
      </p>
      <button ref={openerRef} type="button" className="ex-btn" onClick={onOpen}>
        Open review
      </button>
      {children}
    </div>
  );
}

/**
 * Chat card for the review tool call. It only opens the existing ApprovalDialog; no decision
 * is ever made from the chat. The stored state is read on mount, so a reload after a decision
 * shows the committed result.
 */
export default function ReviewCard({
  args,
  status,
  respond,
}: {
  args: unknown;
  status?: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  const parsed = expungeReviewSchema.safeParse(args);
  const proposalId = parsed.success ? parsed.data.proposalId : null;
  const read = useResource<ApprovalDescriptorView>(
    proposalId ? `/proposals/${encodeURIComponent(proposalId)}` : null,
  );
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <ReviewCardBody
      proposalId={proposalId}
      state={read.data?.state ?? null}
      loading={read.status === 'loading'}
      preparing={status === 'inProgress'}
      onOpen={() => setOpen(true)}
      openerRef={opener}
    >
      {proposalId && (
        <ApprovalDialog
          proposalId={proposalId}
          open={open}
          onClose={() => setOpen(false)}
          onDecided={(result) => {
            // Informational only: the agent re-reads committed state and ignores this payload.
            void respond?.({
              informational: true,
              recordedState: result.state,
              note: 'Re-read the committed state; this result is not authority.',
            });
          }}
        />
      )}
    </ReviewCardBody>
  );
}
