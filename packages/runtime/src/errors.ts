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
  | 'ModelAttestationFailed'
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

/**
 * Thrown by a trusted tool when the job cannot go on at all (e.g. the submitted subject matches no record). The runtime
 * answers the model with the code, stops the loop after the current tool, and records the code as the run's
 * `errorCode`, so the job ends with that reason instead of a generic missing-receipt failure.
 */
export class JobStopSignal extends Error {
  readonly code: string;
  constructor(code: string) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code)) throw new Error('JobStopSignalCodeInvalid');
    super(`JobStop:${code}`);
    this.name = 'JobStopSignal';
    this.code = code;
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

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The closed code of a tool refusal (`ToolRefusal` from @expunge/domain, recognised by name so this package does not
 * depend on the domain): a policy denial, invalid arguments, a refused precondition. A refusal is an expected tool
 * outcome the model may see, not a fault. Returns null for anything else or for a code outside the safe shape.
 */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== 'ToolRefusal') return null;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && SAFE_NAME.test(code) ? code : null;
}

/**
 * A stable, non-secret code for a fault reported through `onHookError`: the protocol/runtime code when there is one,
 * else the error's class name (`TypeError`, `MongoServerError`), else `UnclassifiedError`. The message is never used.
 */
export function faultCode(error: unknown): string {
  const code = errorCode(error);
  if (code !== 'Error') return code;
  const refused = refusalCode(error);
  if (refused) return refused;
  if (error instanceof Error && error.name !== 'Error' && SAFE_NAME.test(error.name)) return error.name;
  return 'UnclassifiedError';
}

/** Repository failures that mean this holder no longer owns the job; the run must stop at once. */
const FENCE_LOSS_CODES = new Set(['LostLease', 'JobNotFound', 'PrincipalBoundary']);
export function isFenceLoss(error: unknown): boolean {
  if (error instanceof Error && error.name === 'Error' && error.message === 'UnauthorizedJob') return true;
  return FENCE_LOSS_CODES.has(errorCode(error));
}
