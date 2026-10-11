import { describe, expect, it } from 'vitest';
import { MODEL_RETRY_POLICY } from '../src/model-retries.js';
import { ProviderAttemptRecorder } from '../src/attempt-recorder.js';

/** FAKE base fetch: answers with the next status (or throws for 'network'); nothing leaves the process. */
const scripted = (steps: Array<number | 'network'>) => {
  let index = 0;
  return (async () => {
    const step = steps[Math.min(index++, steps.length - 1)]!;
    if (step === 'network') throw new TypeError('fetch failed');
    return new Response('{}', { status: step });
  }) as typeof fetch;
};

describe('ProviderAttemptRecorder (FAKE fetch)', () => {
  it('counts attempts and records only retriable statuses, in order', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([429, 503, 200]));
    await recorder.fetch('http://x');
    await recorder.fetch('http://x');
    await recorder.fetch('http://x');
    expect(recorder.snapshot()).toEqual({ attempts: 3, retriedStatuses: [429, 503], backoffTimeout: false });
  });

  it('knows a retry is pending between attempts, and not after a success or a non-retriable status', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([429, 200, 400]));
    expect(recorder.retryPending).toBe(false);
    await recorder.fetch('http://x');
    expect(recorder.retryPending).toBe(true); // 429: the SDK is sleeping before its next attempt
    await recorder.fetch('http://x');
    expect(recorder.retryPending).toBe(false);
    await recorder.fetch('http://x');
    expect(recorder.retryPending).toBe(false); // 400 is never retried
  });

  it('a connection error is retried by the SDK, so it leaves a retry pending', async () => {
    const recorder = new ProviderAttemptRecorder(scripted(['network']));
    await expect(recorder.fetch('http://x')).rejects.toThrow();
    expect(recorder.retryPending).toBe(true);
  });

  it('after the last attempt the SDK gives up, so nothing is pending (no backoff to blame)', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([429]));
    for (let i = 0; i < MODEL_RETRY_POLICY.attempts; i++) await recorder.fetch('http://x');
    expect(recorder.retryPending).toBe(false);
    expect(recorder.snapshot().attempts).toBe(MODEL_RETRY_POLICY.attempts);
  });

  it('records the backoff timeout only when the runtime marks it, and keeps the status list bounded', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([503]));
    for (let i = 0; i < 80; i++) await recorder.fetch('http://x');
    expect(recorder.snapshot().retriedStatuses).toHaveLength(50);
    expect(recorder.snapshot().backoffTimeout).toBe(false);
    recorder.markBackoffTimeout();
    expect(recorder.snapshot().backoffTimeout).toBe(true);
  });

  it('passes the request and response through untouched', async () => {
    const seen: unknown[] = [];
    const base = (async (input: unknown, init: unknown) => {
      seen.push(input, init);
      return new Response('payload', { status: 200 });
    }) as typeof fetch;
    const recorder = new ProviderAttemptRecorder(base);
    const response = await recorder.fetch('http://x/path', { method: 'POST', body: 'b' });
    expect(await response.text()).toBe('payload');
    expect(seen).toEqual(['http://x/path', { method: 'POST', body: 'b' }]);
  });
});
