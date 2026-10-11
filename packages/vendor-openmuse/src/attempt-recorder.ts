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
 * Only these count as PROVIDER-side backoff for the per-window flag: 429, any 5xx, or a connection error. 408 and 409 are
 * retried by the SDK too but are never provider evidence here (every 408 is behaviour).
 */
const providerSide = (status: number): boolean => status === 429 || status >= 500;

/**
 * A counting `fetch` for the provider SDK clients. It records, per run, how many HTTP attempts were made and which
 * retriable statuses came back, and it keeps ONE flag per watchdog window: `retriedSinceArm` is set when any provider-side
 * retriable response (429, 5xx) or connection error happened since the runtime last armed its phase watchdog (`clearWindow`),
 * and cleared on re-arm. A phase timeout inside such a window is the provider's delay (retry-after backoff plus the retried
 * call), not the candidate's. Observation only: the request and the response pass through untouched, and nothing is read
 * from either. It decides from the status alone, so it ignores an `x-should-retry` response header the SDK may honour.
 */
export class ProviderAttemptRecorder {
  private attempts = 0;
  private retriedStatuses: number[] = [];
  private windowRetried = false;
  private backoffTimeoutSeen = false;

  constructor(private readonly base: typeof fetch = globalThis.fetch) {}

  /** Starts from the counts of earlier sessions of the same job (the meter carry), so the totals are per JOB. */
  seed(prior: ProviderAttempts): void {
    this.attempts = prior.attempts;
    this.retriedStatuses = prior.retriedStatuses.slice(0, MAX_RECORDED_STATUSES);
    this.backoffTimeoutSeen = prior.backoffTimeout;
  }

  /** Pass this as the SDK client's `fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    this.attempts++;
    let response: Response;
    try {
      response = await this.base(input, init);
    } catch (error) {
      this.windowRetried = true; // the SDK retries connection errors
      throw error;
    }
    if (RETRIABLE.has(response.status)) {
      if (this.retriedStatuses.length < MAX_RECORDED_STATUSES) this.retriedStatuses.push(response.status);
      if (providerSide(response.status)) this.windowRetried = true;
    }
    return response;
  };

  /** Called when the runtime (re-)arms its phase watchdog: a new window starts clean. */
  clearWindow(): void {
    this.windowRetried = false;
  }

  /** True when a provider-side retry or backoff happened since the watchdog was last armed. */
  get retriedSinceArm(): boolean {
    return this.windowRetried;
  }

  /** Called by the runtime when the phase watchdog fires inside such a window. */
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
