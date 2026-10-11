import type { Job, JsonValue, ProjectionPayloadByKind } from '@expunge/contracts';
import type { RunStats } from '@expunge/runtime';

export type TerminalAction =
  | { kind: 'none'; reason: 'already_terminal' | 'released_by_run' | 'not_ours' }
  | { kind: 'finish'; status: 'succeeded' | 'failed'; outputRefs: string[]; reason: string };

/** A committed completion receipt as the dispatcher sees it (ids and verdict only). */
export type ReceiptFact = { receiptId: string; domainStatus: string; operationalResiduals: number } | null;

/**
 * Decides how a job whose run just ended is finalized. The model's narrative never decides this:
 *  - the run already released the lease (yield, cancelled): nothing to do;
 *  - we do not hold the lease any more, or the process was aborted: nothing to write (the lease expires
 *    and the job is reclaimed with a new fence, or the dispatcher's shutdown path handles it);
 *  - the stored job is already terminal (e.g. complete_cleanup committed receipt and job state together):
 *    nothing to do;
 *  - otherwise `succeeded` only with a committed, complete receipt (JobRepository.finish enforces this
 *    again for cleanup jobs); every other ending is `failed` with the receipt id when one exists.
 */
export function decideTerminal(input: {
  stats: RunStats;
  stored: Pick<Job, 'status' | 'lease' | 'cancellationRequested'> | null;
  fence: number;
  receipt: ReceiptFact;
  /** The heartbeat could not renew: the lease is lost or cancellation was requested. */
  renewalFailed?: boolean;
}): TerminalAction {
  const { stats, stored, fence, receipt } = input;
  if (stats.release === 'yielded' || stats.release === 'cancelled')
    return { kind: 'none', reason: 'released_by_run' };
  // Committed terminal state wins: complete_cleanup commits receipt and terminal job state together, after which
  // this holder's lease is gone by design and a late checkpoint fails. That is a normal ending, not a lost lease.
  if (stored && ['succeeded', 'failed', 'cancelled'].includes(stored.status))
    return { kind: 'none', reason: 'already_terminal' };
  if (stats.release === 'lost' || stats.endedBy === 'lost_lease' || input.renewalFailed)
    return { kind: 'none', reason: 'not_ours' };
  if (stats.endedBy === 'aborted') return { kind: 'none', reason: 'released_by_run' };
  if (!stored) return { kind: 'none', reason: 'already_terminal' };
  if (stored.lease.fence !== fence) return { kind: 'none', reason: 'not_ours' };
  if (
    receipt &&
    receipt.domainStatus === 'complete_in_registered_scope' &&
    receipt.operationalResiduals === 0
  )
    return {
      kind: 'finish',
      status: 'succeeded',
      outputRefs: [receipt.receiptId],
      reason: 'receipt_committed',
    };
  if (receipt)
    return {
      kind: 'finish',
      status: 'failed',
      outputRefs: [receipt.receiptId],
      reason: 'incomplete_receipt',
    };
  return {
    kind: 'finish',
    status: 'failed',
    outputRefs: [],
    reason: stats.errorCode ?? (stats.endedBy === 'step_limit' ? 'StepLimitReached' : 'NoCompletionReceipt'),
  };
}

/** Terminal checkpoint: counts, reason codes and a hash of the narrative. No model text, no subject data. */
export function terminalCheckpoint(stats: RunStats, action: TerminalAction): JsonValue {
  return {
    v: 1,
    // The job's cumulative meter stays at the checkpoint root, where `readMeterCarry` reads it on any later session.
    ...(stats.meterCarry ? { meter: stats.meterCarry as unknown as JsonValue } : {}),
    terminal: {
      endedBy: stats.endedBy,
      ...(stats.errorCode ? { errorCode: stats.errorCode } : {}),
      toolCalls: stats.toolCalls,
      phases: stats.phases,
      elapsedMs: stats.elapsedMs,
      decision:
        action.kind === 'finish' ? { status: action.status, reason: action.reason } : { none: action.reason },
      ...(stats.provenance
        ? {
            model: {
              spec: stats.provenance.spec,
              ...(stats.provenance.provider ? { provider: stats.provenance.provider } : {}),
              ...(stats.provenance.model ? { model: stats.provenance.model } : {}),
              adapterInjected: stats.provenance.adapterInjected,
              profileHash: stats.provenance.profileHash,
              boundWorkerProfileHash: stats.provenance.boundWorkerProfileHash,
            },
          }
        : {}),
      ...(stats.metered ? { usage: stats.metered } : {}),
      ...(stats.abandonedTools ? { abandonedTools: stats.abandonedTools } : {}),
      ...(stats.narrative
        ? { untrustedModelNarrative: { sha256: stats.narrative.sha256, length: stats.narrative.length } }
        : {}),
    },
  };
}

type FailureCode = ProjectionPayloadByKind['job_failed']['code'];

/** Maps the dispatcher's short reason codes to the projection's closed failure vocabulary. */
export function projectionFailureCode(reason: string): FailureCode {
  switch (reason) {
    case 'WallTimeExceeded':
    case 'ToolCallBudgetExceeded':
    case 'TokenBudgetExceeded':
    case 'CostBudgetExceeded':
    case 'PricingUnavailable':
    case 'PhaseTimeout':
    case 'StepLimitReached':
      return 'budget_exhausted';
    case 'LostLease':
    case 'JobCancelled':
      return 'lease_lost';
    case 'ModelRunFailed':
    case 'ModelUnavailable':
      return 'provider_error';
    case 'HarnessNotDeployed':
      return 'policy_denied';
    case 'NoCompletionReceipt':
    case 'incomplete_receipt':
    case 'CompletionReceiptRequired':
      return 'verification_failed';
    default:
      return 'internal_error';
  }
}
