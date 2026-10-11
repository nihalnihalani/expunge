import { describe, expect, it } from 'vitest';
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

  it('the window flag is set ONLY by 429, 5xx or a connection error; 408, 409, a success and a 400 never set it', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const recorder = new ProviderAttemptRecorder(scripted([status]));
      await recorder.fetch('http://x');
      expect(recorder.retriedSinceArm, String(status)).toBe(true);
    }
    for (const status of [408, 409, 200, 400, 401]) {
      const recorder = new ProviderAttemptRecorder(scripted([status]));
      await recorder.fetch('http://x');
      expect(recorder.retriedSinceArm, String(status)).toBe(false);
    }
    const network = new ProviderAttemptRecorder(scripted(['network']));
    await expect(network.fetch('http://x')).rejects.toThrow();
    expect(network.retriedSinceArm).toBe(true);
  });

  it('408 and 409 are still recorded as retried statuses (what the SDK did), just not provider evidence', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([408, 409, 200]));
    for (let i = 0; i < 3; i++) await recorder.fetch('http://x');
    expect(recorder.snapshot().retriedStatuses).toEqual([408, 409]);
    expect(recorder.retriedSinceArm).toBe(false);
  });

  it('the flag is per watchdog window: it survives until the next arm and then starts clean', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([429, 200]));
    await recorder.fetch('http://x');
    expect(recorder.retriedSinceArm).toBe(true);
    await recorder.fetch('http://x'); // a normal reply does not clear it by itself; the runtime's re-arm does
    expect(recorder.retriedSinceArm).toBe(true);
    recorder.clearWindow();
    expect(recorder.retriedSinceArm).toBe(false);
  });

  it('seeds from earlier sessions, so the totals are per job', async () => {
    const recorder = new ProviderAttemptRecorder(scripted([503]));
    recorder.seed({ attempts: 5, retriedStatuses: [429, 429], backoffTimeout: true });
    await recorder.fetch('http://x');
    expect(recorder.snapshot()).toEqual({
      attempts: 6,
      retriedStatuses: [429, 429, 503],
      backoffTimeout: true,
    });
    expect(recorder.retriedSinceArm).toBe(true);
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
