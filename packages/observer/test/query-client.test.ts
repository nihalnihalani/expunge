import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import { RaindropQueryClient, RaindropQueryError, TRACE_CAP } from '../src/index.js';
import { makeRig, seedWorkerEvents } from './helpers.js';

const fake = new FakeRaindrop();
beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof RaindropQueryError ? error.kind : `other:${(error as Error).message}`;
  }
};

describe('Query client (labeled fake Raindrop server)', () => {
  it('sends the SEPARATE query key and project header; serializes filters exactly (ascending order encoded)', async () => {
    seedWorkerEvents(fake, 3);
    const { client } = makeRig(fake);
    const page = await client.listEvents({
      limit: 2,
      orderBy: '+timestamp',
      timestampGte: '2026-01-01T00:00:00Z',
      properties: { role: 'worker' },
    });
    expect(page.data.map((e) => e.id)).toEqual(['evt-000', 'evt-001']);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBeTruthy();
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: '/v1/events',
      auth: 'present',
      project: 'proj-1',
    });
    const wrongKey = new RaindropQueryClient({
      queryKey: fake.keys().writeKey,
      projectId: 'proj-1',
      baseUrl: fake.queryUrl,
    });
    expect(await kindOf(wrongKey.listEvents())).toBe('auth'); // the WRITE key cannot read
  });

  it('pages with meta.cursor/has_more and a cursor bound to its filters (a changed filter is rejected)', async () => {
    seedWorkerEvents(fake, 5);
    const { client } = makeRig(fake);
    const first = await client.listEvents({
      limit: 2,
      orderBy: '+timestamp',
      properties: { role: 'worker' },
    });
    const second = await client.listEvents({
      limit: 2,
      orderBy: '+timestamp',
      properties: { role: 'worker' },
      cursor: first.cursor,
    });
    const third = await client.listEvents({
      limit: 2,
      orderBy: '+timestamp',
      properties: { role: 'worker' },
      cursor: second.cursor,
    });
    expect([...first.data, ...second.data, ...third.data].map((e) => e.id)).toEqual([
      'evt-000',
      'evt-001',
      'evt-002',
      'evt-003',
      'evt-004',
    ]);
    expect(third.hasMore).toBe(false);
    expect(
      await kindOf(
        client.listEvents({
          limit: 2,
          orderBy: '+timestamp',
          properties: { role: 'improver' },
          cursor: first.cursor,
        }),
      ),
    ).toBe('bad_request');
  });

  it('returns null for an event that is not visible yet (404), not an error', async () => {
    const { client } = makeRig(fake);
    expect(await client.getEvent('does-not-exist')).toBeNull();
    fake.seedEvent({ id: 'present' });
    expect((await client.getEvent('present'))?.id).toBe('present');
  });

  it('treats /v1/signals as a CATALOG: resolves a name to the canonical UUID, null when undefined', async () => {
    fake.signalCatalog.set('cleanup_verified', {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'cleanup_verified',
      type: 'metric',
    });
    const { client } = makeRig(fake);
    expect(await client.resolveSignalId('cleanup_verified')).toBe('11111111-1111-4111-8111-111111111111');
    expect(await client.resolveSignalId('never_defined')).toBeNull();
  });

  it('flags a trace response at the 1000-span cap as potentially truncated; fewer spans are complete', async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ span_id: `s${i}`, span_name: 'x', span_type: 'INTERNAL' }));
    fake.traces.set('evt-cap', mk(1500));
    fake.traces.set('evt-small', mk(12));
    const { client } = makeRig(fake);
    const capped = await client.getTraces('evt-cap');
    expect(capped.spans).toHaveLength(TRACE_CAP);
    expect(capped.potentiallyTruncated).toBe(true);
    const small = await client.getTraces('evt-small');
    expect(small).toMatchObject({ potentiallyTruncated: false });
    expect(small.spans).toHaveLength(12);
    expect(fake.requests.at(-1)?.path).toBe('/v1/traces');
  });

  it('rejects responses that do not match the contract instead of trusting them', async () => {
    fake.seedEvent({ id: 'ok' });
    const { client } = makeRig(fake);
    // A body without meta, and an event without an id, are invalid_response.
    const bad = new RaindropQueryClient({
      queryKey: fake.keys().queryKey,
      projectId: 'proj-1',
      baseUrl: fake.queryUrl,
      maxAttempts: 1,
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ nope: true }], meta: { has_more: false } }), { status: 200 }),
    });
    expect(await kindOf(bad.listEvents())).toBe('invalid_response');
    const notJson = new RaindropQueryClient({
      queryKey: 'k',
      projectId: 'p',
      baseUrl: fake.queryUrl,
      maxAttempts: 1,
      fetch: async () => new Response('<html>', { status: 200 }),
    });
    expect(await kindOf(notJson.listEvents())).toBe('invalid_response');
    expect((await client.listEvents()).data.map((e) => e.id)).toEqual(['ok']);
  });
});

describe('retry and backoff policy', () => {
  it('does not retry 401/403 (auth) or 408 (narrow the request): exactly one request each', async () => {
    const { client } = makeRig(fake);
    fake.failNext(/GET \/v1\/events$/, [401]);
    expect(await kindOf(client.listEvents())).toBe('auth');
    fake.failNext(/GET \/v1\/events$/, [403]);
    expect(await kindOf(client.listEvents())).toBe('forbidden');
    fake.failNext(/GET \/v1\/events$/, [408]);
    expect(await kindOf(client.listEvents())).toBe('narrow_request');
    expect(fake.requests.filter((r) => r.path === '/v1/events')).toHaveLength(3);
  });

  it('retries 429 honoring Retry-After and 5xx with exponential jittered backoff, then succeeds', async () => {
    seedWorkerEvents(fake, 1);
    const sleeps: number[] = [];
    const { client } = makeRig(fake, { sleeps });
    fake.failNext(/GET \/v1\/events$/, [429, 503, 502], { 'Retry-After': '2' });
    const page = await client.listEvents();
    expect(page.data).toHaveLength(1);
    expect(fake.requests.filter((r) => r.path === '/v1/events')).toHaveLength(4);
    // 429 carried Retry-After: 2s (>= the jittered backoff); the 5xx also carry it here, so each wait honors >= 2000.
    expect(sleeps).toHaveLength(3);
    expect(sleeps.every((ms) => ms >= 2000)).toBe(true);
  });

  it('gives up after the attempt bound on persistent 5xx, and backoff is capped', async () => {
    const sleeps: number[] = [];
    const { client } = makeRig(fake, { sleeps, maxAttempts: 3 });
    fake.failNext(/GET \/v1\/events$/, [500, 500, 500, 500]);
    expect(await kindOf(client.listEvents())).toBe('server');
    expect(fake.requests.filter((r) => r.path === '/v1/events')).toHaveLength(3);
    expect(sleeps.length).toBe(2);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(8000);
  });

  it('retries a network failure, then reports it', async () => {
    const sleeps: number[] = [];
    const client = new RaindropQueryClient({
      queryKey: 'k',
      projectId: 'p',
      baseUrl: 'http://127.0.0.1:1',
      maxAttempts: 2,
      timeoutMs: 300,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0,
    });
    expect(await kindOf(client.listEvents())).toBe('network');
    expect(sleeps).toHaveLength(1);
  });
});

describe('user deletion contract', () => {
  it('files an org-wide request (pending, due in 30 days) and tracks it; DELETE cancels and never purges', async () => {
    const { client } = makeRig(fake);
    const job = await client.requestUserDeletion({
      userIds: ['tok_a', 'tok_b'],
      requester: 'privacy@example.invalid',
      regulation: 'other',
    });
    expect(job.status).toBe('pending');
    expect(job.completed_at).toBeNull();
    expect(job.user_ids.map((u) => u.user_id)).toEqual(['tok_a', 'tok_b']);
    expect((await client.getDeletion(job.id)).status).toBe('pending');
    const cancelled = await client.cancelPendingUserDeletion(job.id, 'tok_a');
    expect(cancelled).toMatchObject({ jobId: job.id, userId: 'tok_a' });
    // The job itself is not completed by a cancel, and the other subject is still listed unrevoked.
    const after = await client.getDeletion(job.id);
    expect(after.status).toBe('pending');
    expect(after.user_ids.find((u) => u.user_id === 'tok_b')?.revoked_at).toBeNull();
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });

  it('refuses a request outside 1..100 user ids locally', async () => {
    const { client } = makeRig(fake);
    expect(
      await kindOf(client.requestUserDeletion({ userIds: [], requester: 'r', regulation: 'gdpr' })),
    ).toBe('bad_request');
    expect(
      await kindOf(
        client.requestUserDeletion({
          userIds: Array.from({ length: 101 }, (_, i) => `u${i}`),
          requester: 'r',
          regulation: 'gdpr',
        }),
      ),
    ).toBe('bad_request');
    expect(fake.requests.filter((r) => r.path.startsWith('/v1/deletions'))).toHaveLength(0);
  });
});
