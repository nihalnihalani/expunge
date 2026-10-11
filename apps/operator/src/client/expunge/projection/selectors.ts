import type {
  ExpungeJobSnapshotV2,
  ForwardedProjectionEvent,
  JobStatus,
} from '../../../shared/expunge';
import { plural } from '../format';
import type { ChipState } from '../components/StatusChip';

/** Words for committed event kinds, shared by the feed and the decision log. */
export const EVENT_LABELS: Record<string, string> = {
  job_started: 'Job started',
  tool_decided: 'Tool decision',
  effect_committed: 'Effect committed',
  evidence_ready: 'Evidence',
  candidate_proposed: 'Candidate proposed',
  trial_completed: 'Trial completed',
  approval_required: 'Approval required',
  harness_promoted: 'Harness promoted',
  receipt_committed: 'Receipt committed',
  external_erasure_updated: 'External erasure update',
  job_failed: 'Job failed',
  job_status_changed: 'Status changed',
  cancel_requested: 'Cancellation requested',
  approval_resolved: 'Approval resolved',
  harness_rolled_back: 'Harness rolled back',
  retraction_progress: 'Retraction progress',
  campaign_row_committed: 'Campaign row',
  unknown_kind: 'Unrecognized event',
};

const words = (value: string) => value.replaceAll('_', ' ');

/** One-line, fixed-vocabulary summary of a committed event. Never renders unvalidated text. */
export function describeEvent(event: ForwardedProjectionEvent): string {
  switch (event.kind) {
    case 'job_started':
      return `${words(event.payload.jobKind)} job started, attempt ${event.payload.attempt}.`;
    case 'tool_decided':
      return `${words(event.payload.toolId)}: ${event.payload.decision} in ${event.payload.phase}. ${event.payload.summary}`;
    case 'effect_committed':
      return `${event.payload.effectKind} applied to ${plural(event.payload.appliedCount, 'record')} in ${event.payload.collectionId}; world revision ${event.payload.resultingWorldRevision}.`;
    case 'evidence_ready':
      return `Evidence ${event.payload.outboxState === 'evidence_ready' ? 'ready' : words(event.payload.outboxState)} (${words(event.payload.origin)})${event.payload.truncated ? ', possibly truncated' : ''}.`;
    case 'candidate_proposed':
      return `Candidate ${event.payload.candidateId} for ${event.payload.target}; computed class ${words(event.payload.computedClass)}.`;
    case 'trial_completed':
      return `Trial ${event.payload.pairId} completed. Split and per-arm results are withheld from this event.${event.payload.reportId === null ? ' No report is linked yet.' : ' Open the linked report with authorized access for details.'}${event.payload.verdict === null ? '' : ` Gate verdict: ${event.payload.verdict}.`}`;
    case 'approval_required':
      return `Proposal ${event.payload.proposalId} needs a decision (${words(event.payload.computedClass)}).`;
    case 'harness_promoted':
      return `Harness promoted for ${event.payload.target}: revision ${event.payload.fromRevision} to ${event.payload.toRevision}.`;
    case 'receipt_committed':
      return `Receipt ${event.payload.receiptId}: ${words(event.payload.domainStatus)} as of world revision ${event.payload.verifiedWorldRevision}.`;
    case 'external_erasure_updated':
      return `External erasure request is ${words(event.payload.providerStatus)}.`;
    case 'job_failed':
      return `Failed (${words(event.payload.code)})${event.payload.retryable ? ', retryable' : ''}. ${event.payload.message}`;
    case 'job_status_changed':
      return `${words(event.payload.from)} to ${words(event.payload.to)}. ${event.payload.reason}`;
    case 'cancel_requested':
      return `Cancellation requested by the ${event.payload.by}.`;
    case 'approval_resolved':
      return `Proposal ${event.payload.proposalId} ${event.payload.decision}.`;
    case 'harness_rolled_back':
      return `Harness rolled back for ${event.payload.target}. ${event.payload.reason}`;
    case 'retraction_progress':
      return `Retraction ${event.payload.retractionId}: ${event.payload.visited} visited, frontier ${event.payload.frontierSize}${event.payload.closureComplete ? ', closure complete' : ', closure incomplete'}.`;
    case 'campaign_row_committed':
      return `Campaign ${event.payload.campaignId} row ${event.payload.rowId}: ${event.payload.result}.`;
    case 'unknown_kind':
      return `A newer event kind (${event.originalKind}) this operator does not recognize.`;
  }
}

export const TERMINAL: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];
export const isTerminal = (status: JobStatus) => TERMINAL.includes(status);

/** Job status to chip state. `succeeded` is neutral: the verdict is a separate chip. */
export function chipForStatus(status: JobStatus): ChipState {
  return status;
}

export function notInspected(snapshot: ExpungeJobSnapshotV2) {
  const inspected = new Set(snapshot.coverage.inspectedCollectionIds);
  return snapshot.coverage.registeredCollectionIds.filter(
    (id) => !inspected.has(id),
  );
}

/** Polling interval by status; terminal jobs are re-read once and then left alone. */
export function pollInterval(status: JobStatus): number | null {
  if (status === 'queued' || status === 'running') return 1000;
  if (status.startsWith('waiting_')) return 5000;
  return null;
}
