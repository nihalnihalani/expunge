import { MODEL_RETRY_POLICY } from './model-retries.js';

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
 * A counting `fetch` for the provider SDK clients. It records, per run, how many HTTP attempts were made and which
 * retriable statuses came back, and it knows when the SDK is BETWEEN attempts (the last response was retriable, or the
 * connection failed, and the SDK has attempts left): that is "a retry or backoff is pending". Observation only: the request
 * and the response pass through untouched, and nothing is read from either.
 */
export class ProviderAttemptRecorder {
  private attempts = 0;
  private readonly retriedStatuses: number[] = [];
  private consecutiveFailures = 0;
  private pending = false;
  private backoffTimeoutSeen = false;

  constructor(private readonly base: typeof fetch = globalThis.fetch) {}

  /** Pass this as the SDK client's `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    this.attempts++;
    this.pending = false;
    let response: Response;
    try {
      response = await this.base(input, init);
    } catch (error) {
      this.afterFailedAttempt(); // the SDK retries connection errors
      throw error;
    }
    if (RETRIABLE.has(response.status)) {
      if (this.retriedStatuses.length < MAX_RECORDED_STATUSES) this.retriedStatuses.push(response.status);
      this.afterFailedAttempt();
    } else this.consecutiveFailures = 0;
    return response;
  };

  private afterFailedAttempt(): void {
    this.consecutiveFailures++;
    // With attempts left the SDK sleeps and retries; on the last attempt it gives up and throws instead.
    this.pending = this.consecutiveFailures < MODEL_RETRY_POLICY.attempts;
  }

  /** True while the SDK is sleeping before its next attempt. */
  get retryPending(): boolean {
    return this.pending;
  }

  /** Called by the runtime when the phase watchdog fires during a pending retry. */
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
