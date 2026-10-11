import { MODEL_RETRY_POLICY } from './model-retries.js';
import { boundedErrorRecords, hasRequestFailureVeto } from './request-failures.js';

/** What was observed on the wire for one run, as numbers only (never a request, response, header or message). */
export type ProviderAttempts = {
  /** HTTP attempts made to the provider (the SDK's own retries included). */
  attempts: number;
  /** The statuses of the attempts the SDK treats as retriable, in order (capped). */
  retriedStatuses: number[];
  /** The phase watchdog fired while a provider retry or backoff was pending. */
  backoffTimeout: boolean;
};

const MAX_RECORDED_STATUSES = 50;
const RETRIABLE = new Set<number>(MODEL_RETRY_POLICY.retriedStatuses);
/**
 * Only these count as PROVIDER-side backoff for the per-window flag: 429, any 5xx, or a connection error. 408 and 409 are
 * retried by the SDK too but are never provider evidence here (every 408 is behaviour).
 */
const providerSide = (status: number): boolean => status === 429 || status >= 500;

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
]);
/** Unknown rejections are not transport proof. Fetch construction errors and cancellation cannot mark provider delay. */
function isConnectionFailure(error: unknown): boolean {
  const records = boundedErrorRecords(error);
  if (records.some(hasRequestFailureVeto)) return false;
  return records.some(
    (record) =>
      record.name === 'APIConnectionError' ||
      (typeof record.code === 'string' && CONNECTION_CODES.has(record.code)),
  );
}

/** Deterministic retry accounting shared by the SDK fetch wrapper and policy checks; contains no service or payload. */
export class ProviderAttemptState {
  private attempts = 0;
  private retriedStatuses: number[] = [];
  private windowRetried = false;
  private retryInFlight = false;
  private backoffTimeoutSeen = false;

  /** Only durable counts carry between sessions; an old session's in-flight request cannot survive a new process. */
  seed(prior: ProviderAttempts): void {
    this.attempts = prior.attempts;
    this.retriedStatuses = prior.retriedStatuses.slice(0, MAX_RECORDED_STATUSES);
    this.backoffTimeoutSeen = prior.backoffTimeout;
    this.windowRetried = false;
    this.retryInFlight = false;
  }

  beginAttempt(): void {
    this.attempts++;
  }

  observeResponse(status: number): void {
    if (RETRIABLE.has(status) && this.retriedStatuses.length < MAX_RECORDED_STATUSES)
      this.retriedStatuses.push(status);
    this.retryInFlight = RETRIABLE.has(status) && providerSide(status);
    if (this.retryInFlight) this.windowRetried = true;
  }

  observeFailure(error: unknown): void {
    this.retryInFlight = isConnectionFailure(error);
    if (this.retryInFlight) this.windowRetried = true;
  }

  /** A queued activity event may re-arm after a retry starts: keep that pending retry in the new window. */
  clearWindow(): void {
    this.windowRetried = this.retryInFlight;
  }

  get retriedSinceArm(): boolean {
    return this.windowRetried;
  }

  markBackoffTimeout(): void {
    this.backoffTimeoutSeen = true;
  }

  snapshot(): ProviderAttempts {
    return {
      attempts: this.attempts,
      retriedStatuses: [...this.retriedStatuses],
      backoffTimeout: this.backoffTimeoutSeen,
    };
  }
}

/**
 * A counting `fetch` for the provider SDK clients. It records, per run, how many HTTP attempts were made and which
 * retriable statuses came back, and it keeps ONE flag per watchdog window: `retriedSinceArm` is set when any provider-side
 * retriable response (429, 5xx) or connection error happened since the runtime last armed its phase watchdog (`clearWindow`),
 * and cleared on re-arm once the retry completes. A phase timeout inside such a window is the provider's delay (retry-after backoff plus the retried
 * call), not the candidate's. Observation only: the request and the response pass through untouched, and nothing is read
 * from either. It decides from the status alone, so it ignores an `x-should-retry` response header the SDK may honour.
 */
export class ProviderAttemptRecorder extends ProviderAttemptState {
  constructor(private readonly base: typeof fetch = globalThis.fetch) {
    super();
  }

  /** Pass this as the SDK client's `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    this.beginAttempt();
    let response: Response;
    try {
      response = await this.base(input, init);
    } catch (error) {
      this.observeFailure(error);
      throw error;
    }
    this.observeResponse(response.status);
    return response;
  };
}
