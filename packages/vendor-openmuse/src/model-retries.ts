// Adapted from OpenMuse apps/server/src/config.ts (lines 94-104) at commit
// 1ac68f3909f2478ab6280883f1ab5ea65eb5719d. MIT, Copyright (c) 2026 OpenMuse contributors.
// See ../LICENSE.openmuse and ../THIRD_PARTY.md.

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;

/**
 * The model-call retry policy, stated once. Every provider SDK call is `MODEL_MAX_RETRIES + 1` attempts. The SDKs' own
 * backoff (openai 6.49.0 and @anthropic-ai/sdk 0.97.1, identical constants) sleeps 0.5 s x 2^n before retry n, capped at
 * 8 s, with up to 25% jitter taken off; a `retry-after-ms` or `retry-after` header the provider sends overrides it. The
 * runtime adds NO retry of its own on top: these SDK attempts are the whole budget. A 429 or quota response that is
 * retried and then succeeds is not a failure; one that still fails after the last attempt reaches the runtime and is
 * classified provider-side (`ModelUnavailable`).
 */
export const MODEL_RETRY_POLICY = {
  attempts: MODEL_MAX_RETRIES + 1,
  baseDelayMs: 500,
  capDelayMs: 8_000,
  // Both installed SDKs retry every 5xx status, including 501, 505 and nonstandard 5xx responses.
  retriedStatuses: [408, 409, 429, ...Array.from({ length: 100 }, (_, index) => 500 + index)],
} as const;

/**
 * Client-side request timeout set on the provider SDK, in ms. It is deliberately ABOVE every phase timeout the runtime
 * allows (the runtime clamps its watchdog below it), so a slow model call is always ended by the runtime's phase watchdog
 * (`PhaseTimeout`, a behaviour outcome) and never by the SDK's own timeout. A candidate that sends a large context and makes
 * the call slow therefore cannot turn its own latency into "infrastructure"; and if an SDK-side timeout still arrives, the
 * runtime classifies it as `ModelRunFailed`, not `ModelUnavailable`.
 */
export const PROVIDER_CLIENT_TIMEOUT_MS = 600_000;

/** The options every provider SDK client is built with: one place, so the policy above is what actually runs. */
export const providerClientOptions = (baseURL?: string, fetchImpl?: typeof fetch) => ({
  ...(baseURL ? { baseURL } : {}),
  ...(fetchImpl ? { fetch: fetchImpl } : {}),
  maxRetries: MODEL_MAX_RETRIES,
  timeout: PROVIDER_CLIENT_TIMEOUT_MS,
});
