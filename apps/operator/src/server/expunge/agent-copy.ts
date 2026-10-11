import type { ExpungeJobSnapshotV2, JobStatus } from '../../shared/expunge.js';

/**
 * Acknowledgement text for the chat. Built only from a committed snapshot, never from a
 * model, and always labeled as projection output so it cannot be mistaken for one.
 */
export const STATUS_WORDS: Record<JobStatus, string> = {
  queued: 'queued',
  running: 'running',
  waiting_evidence: 'waiting for evidence',
  waiting_approval: 'waiting for your decision',
  waiting_external: 'waiting on the external provider',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const UNBOUND_COPY =
  'No Expunge job is attached to this conversation. Start a cleanup from the Expunge workbench. Nothing was started or changed by this message.';
export const UNAVAILABLE_COPY =
  'The Expunge domain service could not be reached, so there is no committed status to report. Nothing was started, changed or cancelled by this message.';
export const NO_TOOL_COPY =
  'Open the review in the Expunge workbench to see the stored proposal.';

const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 10)}…` : id);

export function acknowledgement(snapshot: ExpungeJobSnapshotV2): string {
  const parts = [
    `Projection report (not model output). Job ${shortId(snapshot.jobId)} is ${STATUS_WORDS[snapshot.status]}.`,
  ];
  if (snapshot.phase) parts.push(`Current phase: ${snapshot.phase}.`);
  const registered = snapshot.coverage.registeredCollectionIds.length;
  if (registered > 0)
    parts.push(
      `Inspected ${snapshot.coverage.inspectedCollectionIds.length} of ${registered} registered collections.`,
    );
  if (snapshot.approval.state === 'pending')
    parts.push('A harness proposal is waiting for your decision.');
  if (snapshot.cancellation.requested && snapshot.status !== 'cancelled')
    parts.push(
      'Cancellation was requested; the database has not yet confirmed it.',
    );
  parts.push(
    snapshot.receipt
      ? `A completion receipt (${shortId(snapshot.receipt.receiptId)}) is committed at event ${snapshot.receipt.sequence}.`
      : 'No completion receipt has been committed.',
  );
  parts.push(
    'A finished chat turn does not complete, cancel or approve anything.',
  );
  return parts.join(' ');
}
