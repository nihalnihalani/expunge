/**
 * The model-call retry policy against the REAL provider SDK client and a local stand-in HTTP server (FAKE provider: no
 * network, no key). The client is built with `providerClientOptions()`, the same options the production adapters use, so
 * what is proven here is what runs. `retry-after-ms: 1` keeps the retries fast without changing the policy.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODEL_MAX_RETRIES,
  MODEL_RETRY_POLICY,
  PROVIDER_CLIENT_TIMEOUT_MS,
  providerClientOptions,
} from '@expunge/vendor-openmuse';
import { classifyModelFailure } from '../src/model-error.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A stand-in provider: answers each request with the next status from `statuses` (the last one repeats). */
async function provider(statuses: number[]) {
  const seen: number[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const status = statuses[Math.min(seen.length, statuses.length - 1)]!;
      seen.push(status);
      if (status === 200) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 0,
            model: 'm',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
          }),
        );
        return;
      }
      response.writeHead(status, { 'content-type': 'application/json', 'retry-after-ms': '1' });
      response.end(JSON.stringify({ error: { message: 'x', type: 'e' } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const client = new OpenAI({ apiKey: 'test-key', ...providerClientOptions(url) });
  const call = () =>
    client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  return { seen, call };
}

describe('model retry policy (real SDK client, FAKE provider)', () => {
  it('states the policy once: attempts, base, cap, and the client timeout above every phase timeout', () => {
    expect(MODEL_RETRY_POLICY).toMatchObject({
      attempts: MODEL_MAX_RETRIES + 1,
      baseDelayMs: 500,
      capDelayMs: 8000,
    });
    expect(MODEL_RETRY_POLICY.retriedStatuses).toContain(429);
    expect(providerClientOptions()).toEqual({
      maxRetries: MODEL_MAX_RETRIES,
      timeout: PROVIDER_CLIENT_TIMEOUT_MS,
    });
  });

  it('a single 429 that then succeeds is NOT a failure (the SDK retried)', async () => {
    const { seen, call } = await provider([429, 200]);
    await expect(call()).resolves.toMatchObject({ choices: [{ message: { content: 'ok' } }] });
    expect(seen).toEqual([429, 200]);
  });

  it('a 429 that never clears is attempted exactly `attempts` times, then reaches the runtime as ProviderRateLimited', async () => {
    const { seen, call } = await provider([429]);
    const error = await call().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(seen).toHaveLength(MODEL_RETRY_POLICY.attempts);
    expect(error).toMatchObject({ status: 429 });
    expect(classifyModelFailure(error)).toBe('ProviderRateLimited');
  });

  it('a request-side 400 is not retried and is ModelRunFailed', async () => {
    const { seen, call } = await provider([400]);
    const error = await call().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(seen).toEqual([400]);
    expect(classifyModelFailure(error)).toBe('ModelRunFailed');
  });
});
