// Adapted from OpenMuse apps/server/src/config.ts (lines 94-104) at commit
// 1ac68f3909f2478ab6280883f1ab5ea65eb5719d. MIT, Copyright (c) 2026 OpenMuse contributors.
// See ../LICENSE.openmuse and ../THIRD_PARTY.md.

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
