import { describe, expect, it } from 'vitest';
import { ProviderAttemptState } from '../src/attempt-recorder.js';
import { MODEL_RETRY_POLICY } from '../src/model-retries.js';

/** Numeric retry state only: no provider, endpoint, model response or service double is created. */
const response = (state: ProviderAttemptState, status: number) => {
  state.beginAttempt();
  state.observeResponse(status);
};

describe('provider attempt accounting: deterministic state transitions', () => {
  it('records every 5xx retry the installed OpenAI and Anthropic SDKs admit', () => {
    const state = new ProviderAttemptState();
    for (let status = 500; status <= 599; status++) {
      expect(MODEL_RETRY_POLICY.retriedStatuses).toContain(status);
      const each = new ProviderAttemptState();
      response(each, status);
      expect(each.snapshot().retriedStatuses).toEqual([status]);
      expect(each.retriedSinceArm).toBe(true);
      response(state, status);
    }
    expect(state.snapshot().attempts).toBe(100);
    expect(state.snapshot().retriedStatuses).toHaveLength(50);
  });

  it('records SDK-retriable 408 and 409 without treating them as provider backoff', () => {
    const state = new ProviderAttemptState();
    for (const status of [408, 409, 200, 400, 401, 403, 404]) response(state, status);
    expect(state.snapshot()).toEqual({ attempts: 7, retriedStatuses: [408, 409], backoffTimeout: false });
    expect(state.retriedSinceArm).toBe(false);
  });

  it('keeps an in-flight retry when a queued activity event re-arms the watchdog', () => {
    const state = new ProviderAttemptState();
    response(state, 429);
    state.clearWindow(); // activity emitted before the response but handled while the SDK backs off
    expect(state.retriedSinceArm).toBe(true);
    state.beginAttempt(); // the retry starts; its response has not arrived
    state.clearWindow();
    expect(state.retriedSinceArm).toBe(true);
    state.markBackoffTimeout();
    expect(state.snapshot()).toEqual({ attempts: 2, retriedStatuses: [429], backoffTimeout: true });
  });

  it('keeps a retried delay in its window until completed response activity re-arms it', () => {
    const state = new ProviderAttemptState();
    response(state, 505);
    response(state, 200);
    expect(state.retriedSinceArm).toBe(true);
    state.clearWindow();
    expect(state.retriedSinceArm).toBe(false);
    state.beginAttempt(); // a slow first attempt in this window remains behaviour
    expect(state.retriedSinceArm).toBe(false);
  });

  it('uses structured transport errors and their bounded causes, never message text', () => {
    for (const error of [
      { code: 'ECONNRESET' },
      { name: 'TypeError', cause: { code: 'ENOTFOUND' } },
      { cause: { cause: { code: 'UND_ERR_SOCKET' } } },
      { name: 'APIConnectionError' },
    ]) {
      const state = new ProviderAttemptState();
      state.beginAttempt();
      state.observeFailure(error);
      state.clearWindow();
      expect(state.retriedSinceArm).toBe(true);
    }
    const state = new ProviderAttemptState();
    state.observeFailure({ message: 'ECONNRESET rate_limit_exceeded' });
    expect(state.retriedSinceArm).toBe(false);
  });

  it('never promotes cancellation, construction failures or timeouts to connection evidence', () => {
    for (const error of [
      { name: 'AbortError' },
      { name: 'AbortError', cause: { code: 'ECONNRESET' } },
      { name: 'TypeError' },
      { name: 'TypeError', cause: { code: 'ERR_INVALID_URL' } },
      { code: 'ABORT_ERR' },
      { code: 'ETIMEDOUT' },
      { code: 'UND_ERR_CONNECT_TIMEOUT' },
      { name: 'TimeoutError' },
      { name: 'APIConnectionError', cause: { name: 'AbortError' } },
      { name: 'APIConnectionError', cause: { code: 'ERR_INVALID_ARG_TYPE' } },
      { name: 'APIConnectionError', cause: { code: 'ERR_INVALID_HTTP_TOKEN' } },
      { name: 'APIConnectionError', cause: { name: 'APIUserAbortError' } },
      { code: 'ECONNRESET', cause: { code: 'UND_ERR_INVALID_ARG' } },
      { name: 'APIConnectionError', cause: { status: 400 } },
      { name: 'APIConnectionError', cause: { status: 408 } },
    ]) {
      const state = new ProviderAttemptState();
      state.beginAttempt();
      state.observeFailure(error);
      state.clearWindow();
      expect(state.retriedSinceArm).toBe(false);
    }
  });

  it('a cancelled or invalid retry ends its in-flight marker without erasing prior window evidence', () => {
    const state = new ProviderAttemptState();
    response(state, 429);
    state.beginAttempt();
    state.observeFailure({ name: 'AbortError' });
    expect(state.retriedSinceArm).toBe(true);
    state.clearWindow();
    expect(state.retriedSinceArm).toBe(false);
  });

  it('carries durable counts and backoff history across sessions, without carrying a dead request', () => {
    const state = new ProviderAttemptState();
    state.seed({ attempts: 5, retriedStatuses: [429, 503], backoffTimeout: true });
    expect(state.retriedSinceArm).toBe(false);
    response(state, 501);
    expect(state.snapshot()).toEqual({
      attempts: 6,
      retriedStatuses: [429, 503, 501],
      backoffTimeout: true,
    });
    const snapshot = state.snapshot();
    snapshot.retriedStatuses.push(599);
    expect(state.snapshot().retriedStatuses).toEqual([429, 503, 501]);
  });
});
