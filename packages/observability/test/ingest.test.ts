import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IngestClient, raindropQueryConfigFromEnv, raindropWriteConfigFromEnv } from '../src/index.js';
import { FakeRaindrop } from './fake-raindrop.js';

const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const client = (over: Partial<ConstructorParameters<typeof IngestClient>[0]> = {}) =>
  new IngestClient({ writeKey: fake.keys().writeKey, projectId: 'proj-1', baseUrl: fake.ingestUrl, ...over });

describe('direct HTTP ingestion', () => {
  it('posts array bodies with the write key and project header; a 204 is acceptance only', async () => {
    const result = await client().trackEvents([
      {
        user_id: 'tok_1',
        event: 'expunge.admission',
        event_id: 'evt-1',
        properties: { origin: 'admission_service' },
        ai_data: { output: 'accepted' },
      },
    ]);
    expect(result).toEqual({ ok: true, status: 204 });
    expect(fake.ingestEvents).toHaveLength(1);
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/events/track',
      auth: 'present',
      project: 'proj-1',
    });
    // Accepted for ingestion is NOT query visibility or enrichment: the event is not "ready" evidence.
    expect(fake.events.get('evt-1')?.tool_calls).toBeUndefined();

    const signal = await client().trackSignals([
      { event_id: 'evt-1', signal_name: 'candidate_admitted', signal_type: 'default', sentiment: 'POSITIVE' },
    ]);
    expect(signal.ok).toBe(true);
    expect(fake.signalPosts[0]).toMatchObject({ event_id: 'evt-1', signal_name: 'candidate_admitted' });
  });

  it('classifies failures: auth is not retryable, 429/5xx/timeouts are, Retry-After is honored', async () => {
    expect(
      await client({ writeKey: 'wrong' }).trackSignals([{ event_id: 'e', signal_name: 's' }]),
    ).toMatchObject({ ok: false, kind: 'auth', status: 401, retryable: false });
    fake.failNext(/POST \/v1\/signals\/track/, [429], { 'Retry-After': '3' });
    expect(await client().trackSignals([{ event_id: 'e', signal_name: 's' }])).toMatchObject({
      ok: false,
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 3000,
    });
    fake.failNext(/POST \/v1\/signals\/track/, [503]);
    expect(await client().trackSignals([{ event_id: 'e', signal_name: 's' }])).toMatchObject({
      ok: false,
      kind: 'server',
      retryable: true,
      status: 503,
    });
    fake.failNext(/POST \/v1\/signals\/track/, [400]);
    expect(await client().trackSignals([{ event_id: 'e', signal_name: 's' }])).toMatchObject({
      ok: false,
      kind: 'bad_request',
      retryable: false,
    });
  });

  it('reports a network failure as retryable without a status, and refuses empty or oversized batches locally', async () => {
    expect(
      await client({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 500 }).trackSignals([
        { event_id: 'e', signal_name: 's' },
      ]),
    ).toMatchObject({ ok: false, kind: 'network', retryable: true, status: null });
    expect(await client().trackSignals([])).toMatchObject({ ok: false, kind: 'bad_request' });
    expect(
      await client().trackSignals(Array.from({ length: 101 }, () => ({ event_id: 'e', signal_name: 's' }))),
    ).toMatchObject({ ok: false, kind: 'bad_request' });
    expect(fake.signalPosts).toHaveLength(0);
  });
});

describe('credential configuration names only', () => {
  it('reports missing variable NAMES, keeps the write and query keys separate, never echoes values', () => {
    expect(raindropWriteConfigFromEnv({})).toEqual({
      ok: false,
      missing: ['RAINDROP_API_KEY', 'RAINDROP_PROJECT_ID'],
    });
    expect(raindropQueryConfigFromEnv({ RAINDROP_API_KEY: 'w', RAINDROP_PROJECT_ID: 'p' })).toEqual({
      ok: false,
      missing: ['RAINDROP_QUERY_API_KEY'],
    });
    const both = {
      RAINDROP_API_KEY: 'write-secret',
      RAINDROP_QUERY_API_KEY: 'query-secret',
      RAINDROP_PROJECT_ID: 'p',
    };
    const write = raindropWriteConfigFromEnv(both);
    const query = raindropQueryConfigFromEnv(both);
    expect(write.ok && write.config.writeKey).toBe('write-secret');
    expect(query.ok && query.config.queryKey).toBe('query-secret');
    expect(JSON.stringify(raindropWriteConfigFromEnv({ RAINDROP_PROJECT_ID: 'p' }))).not.toContain('secret');
  });
});
