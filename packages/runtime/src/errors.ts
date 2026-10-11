import type { WaitStatus } from './ports.js';

/** Failure codes the runtime itself raises. They are short, stable and free of tenant/subject data. */
export type RuntimeErrorCode =
  | 'ExecutionDependenciesMissing'
  | 'LostLease'
  | 'JobCancelled'
  | 'HarnessUnavailable'
  | 'HarnessTargetMismatch'
  | 'ContextInputRejected'
  | 'RunAlreadyActive'
  | 'ToolCallBudgetExceeded'
  | 'TokenBudgetExceeded'
  | 'CostBudgetExceeded'
  | 'PricingUnavailable'
  | 'WallTimeExceeded'
  | 'PhaseTimeout'
  | 'PhaseHookFailed'
  | 'ModelUnavailable'
  | 'ProviderServerError'
  | 'ProviderRateLimited'
  | 'ToolsUnavailable'
  | 'ModelRunFailed'
  | 'CheckpointInvalid'
  | 'Aborted';

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

/**
 * Thrown by a trusted tool when the job must stop and wait (for evidence, an approval grant or an
 * external job). The runtime answers the model with a neutral "paused" result, stops the loop after
 * the current tool, and releases the lease with `JobRepository.yield`.
 */
export class JobWaitSignal extends Error {
  readonly status: WaitStatus;
  constructor(status: WaitStatus) {
    super(`JobWait:${status}`);
    this.name = 'JobWaitSignal';
    this.status = status;
  }
}

/** The short code of an error from @expunge/mongo (ProtocolError) or this package, else a generic code. */
export function errorCode(error: unknown): string {
  if (error instanceof RuntimeError) return error.code;
  if (error instanceof Error && error.name === 'ProtocolError') {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)) return code;
  }
  return 'Error';
}

/** Repository failures that mean this holder no longer owns the job; the run must stop at once. */
const FENCE_LOSS_CODES = new Set(['LostLease', 'JobNotFound', 'PrincipalBoundary']);
export function isFenceLoss(error: unknown): boolean {
  if (error instanceof Error && error.name === 'Error' && error.message === 'UnauthorizedJob') return true;
  return FENCE_LOSS_CODES.has(errorCode(error));
}
