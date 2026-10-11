/**
 * Projection stream consumer under resume-token failure, on a real local replica set (observer principal).
 *
 * The consumer is the product's ProjectionStreamConsumer reading the product's `projection_events` collection,
 * written by the product's ProjectionRepository. Stored tokens are manipulated directly in `stream_offsets`.
 * What the local mongod can and cannot do is stated per case: it cannot reproduce oplog truncation (error 286),
 * because that needs a 990 MB oplog on tmpfs, so that branch is covered only by the owner's invalidation test and
 * by reading the code. Local replica-set evidence only; not Atlas.
 *
 * Findings recorded by these tests:
 *  - delivery is at-least-once (offset is written after the handler; a crash between them re-delivers an event);
 *  - a parseable but ancient token is accepted by the server and the consumer re-reads from the start of the oplog;
 *  - a corrupt stored token is recovered (V-3c): snapshot/backfill recovery is recorded with the server code and the
 *    exact bad offset is removed; an error after events flowed still throws.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ProjectionEvent } from '@expunge/contracts';
import {
  ProjectionRepository,
  ProjectionStreamConsumer,
  type MongoService,
  type StreamRecovery,
} from '@expunge/mongo';
import { PROJECTION_SAMPLES } from '../../packages/contracts/test/projection-samples.js';
import { actor, openEnvironment, type LiveEnvironment } from '../../packages/mongo/test/support.js';
import { liveGate, sleep } from './support.js';

const describeLive = liveGate(
  Boolean(process.env.MONGODB_TEST_URI),
  'MONGODB_TEST_URI',
  'no local replica set configured',
);
const CONSUMER = 'reliability-consumer';
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

const input = (eventId: string, jobId = 'job-rt') => ({
  eventId,
  jobId,
  runId: `run-${jobId}`,
  artifactIds: [],
  kind: 'job_started' as const,
  payload: PROJECTION_SAMPLES.job_started,
});

describeLive('ProjectionStreamConsumer resume handling (local replica set)', () => {
  let env: LiveEnvironment;
  let observer: MongoService;
  let projections: ProjectionRepository;

  beforeAll(async () => {
    env = await openEnvironment('resumetoken');
    observer = await env.as('observer');
    projections = new ProjectionRepository(env.service);
  }, 30_000);
  beforeEach(async () => {
    await env.service.control.collection('stream_offsets').deleteMany({});
    await env.service.control.collection('projection_events').deleteMany({});
    await env.service.control.collection('projection_sequences').deleteMany({});
  });
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  const offsets = () => env.service.control.collection('stream_offsets');
  const storeToken = (token: unknown, pipelineVersion = 'v1') =>
    offsets().insertOne({
      _id: CONSUMER,
      pipelineVersion,
      resumeToken: token,
      updatedAt: new Date(),
    } as never);

  /** Runs one consumer for `ms` and reports what it saw. */
  async function consumeFor(
    ms: number,
    handler: (event: ProjectionEvent) => Promise<void> = async () => {},
    service = observer,
  ) {
    const seen: string[] = [];
    const recoveries: StreamRecovery[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    let thrown: { code?: number; message: string } | undefined;
    try {
      await new ProjectionStreamConsumer(service, CONSUMER, 'v1').consume(
        async (event) => {
          seen.push(event.eventId);
          await handler(event);
        },
        async (reason) => {
          recoveries.push(reason);
        },
        controller.signal,
      );
    } catch (error) {
      const e = error as { code?: number; message?: string };
      thrown = { ...(e.code !== undefined ? { code: e.code } : {}), message: e.message ?? String(error) };
    } finally {
      clearTimeout(timer);
    }
    return { seen, recoveries, thrown };
  }

  async function realToken(): Promise<{ _data: string }> {
    const stream = env.service.control.collection('projection_events').watch([], { maxAwaitTimeMS: 50 });
    await stream.tryNext();
    const token = stream.resumeToken as { _data: string };
    await stream.close();
    return token;
  }

  it('a changed pipeline version triggers one snapshot/backfill recovery and forgets the stored offset', async () => {
    await storeToken(await realToken(), 'v0');
    const run = await consumeFor(1200);
    expect(run.thrown).toBeUndefined();
    expect(run.recoveries).toEqual([
      { kind: 'snapshot_backfill', consumerId: CONSUMER, pipelineVersion: 'v1' },
    ]);
    expect(await offsets().countDocuments({ _id: CONSUMER } as never)).toBe(0);
  });

  it('delivery is at-least-once: if the process dies between the handler and the offset write, the event comes back after restart', async () => {
    await projections.append(scope, input('ev-1'));
    await projections.append(scope, input('ev-2'));
    const token = await realToken(); // positioned after both events: nothing should be delivered from here
    await storeToken(token);

    // Consumer A: a service whose offset write fails for the SECOND event, as if the process died right after the handler.
    const handled: string[] = [];
    let writes = 0;
    const flaky = new Proxy(observer, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'control') return value;
        return new Proxy(value as object, {
          get(db, dbProp) {
            const member = Reflect.get(db, dbProp) as unknown;
            if (dbProp !== 'collection' || typeof member !== 'function')
              return typeof member === 'function' ? member.bind(db) : member;
            return (name: string, ...rest: unknown[]) => {
              const collection = (member as (n: string, ...r: unknown[]) => object).call(
                db,
                name,
                ...rest,
              ) as {
                updateOne: (...a: unknown[]) => Promise<unknown>;
              };
              if (name !== 'stream_offsets') return collection;
              return new Proxy(collection, {
                get(c, cProp) {
                  const m = Reflect.get(c, cProp) as unknown;
                  if (cProp !== 'updateOne')
                    return typeof m === 'function' ? (m as (...a: unknown[]) => unknown).bind(c) : m;
                  return async (...args: unknown[]) => {
                    writes += 1;
                    if (writes === 2)
                      throw new Error('simulated crash after the handler, before the offset write');
                    return (m as (...a: unknown[]) => Promise<unknown>).apply(c, args);
                  };
                },
              });
            };
          },
        });
      },
    }) as MongoService;

    const a = consumeFor(2500, async (event) => void handled.push(event.eventId), flaky);
    await sleep(300);
    await projections.append(scope, input('ev-3'));
    await projections.append(scope, input('ev-4'));
    const runA = await a;
    expect(runA.thrown?.message).toContain('simulated crash');
    expect(handled).toEqual(['ev-3', 'ev-4']); // ev-4 was handled, but its offset was never written

    // Consumer B restarts from the stored offset and is handed ev-4 again.
    const runB = await consumeFor(1500, async (event) => void handled.push(event.eventId));
    expect(runB.thrown).toBeUndefined();
    expect(runB.seen).toEqual(['ev-4']);
    expect(handled.filter((id) => id === 'ev-4')).toHaveLength(2);
    // Every delivery carries what an idempotent consumer needs: a unique event id and a per-job contiguous sequence.
    const rows = await projections.read(scope, 0, 'job-rt');
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(4);
  }, 60_000);

  it('a parseable but ancient token is accepted by the server and the consumer re-reads from the start of the oplog (events come again)', async () => {
    await projections.append(scope, input('ev-1'));
    await projections.append(scope, input('ev-2'));
    const real = await realToken();
    await storeToken({ _data: `82${'0000000100000001'}${real._data.slice(18)}` });
    const run = await consumeFor(2000);
    expect(run.thrown).toBeUndefined();
    expect(run.recoveries).toEqual([]); // not treated as lost history: the local oplog still covers that timestamp
    expect(run.seen).toEqual(expect.arrayContaining(['ev-1', 'ev-2'])); // redelivery, so downstream must dedupe by eventId
  }, 30_000);

  const corrupt: Array<[string, number, unknown]> = [
    ['hex garbage', 9, { _data: 'zz' }],
    ['empty object', 40647, {}],
    ['a bare string', 14, 'not-a-token'],
  ];
  it.each(corrupt)(
    'a corrupt stored token (%s, server error %i) is recovered: no throw, one snapshot/backfill recovery recording the code, the bad offset removed, and the next start does not recover again',
    async (_name, code, token) => {
      await storeToken(token);
      const run = await consumeFor(1500);
      expect(run.thrown).toBeUndefined();
      expect(run.recoveries).toEqual([
        { kind: 'snapshot_backfill', consumerId: CONSUMER, pipelineVersion: 'v1', cause: { code } },
      ]);
      expect(await offsets().countDocuments({ _id: CONSUMER } as never)).toBe(0);
      const again = await consumeFor(1000);
      expect(again.thrown).toBeUndefined();
      expect(again.recoveries).toEqual([]);
    },
    30_000,
  );

  it('recovery removes only the exact bad token: an offset a concurrent consumer stored meanwhile is kept', async () => {
    await storeToken({ _data: 'zz' });
    const newer = await realToken();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1500);
    const recoveries: StreamRecovery[] = [];
    await new ProjectionStreamConsumer(observer, CONSUMER, 'v1').consume(
      async () => {},
      async (reason) => {
        recoveries.push(reason);
        // A concurrent consumer replaces the offset between the failure and our cleanup.
        await offsets().updateOne({ _id: CONSUMER } as never, { $set: { resumeToken: newer } } as never);
      },
      controller.signal,
    );
    expect(recoveries).toHaveLength(1);
    expect(await offsets().findOne({ _id: CONSUMER } as never)).toMatchObject({ resumeToken: newer });
  }, 30_000);

  /** The observer service, except that opening the projection change stream fails on the first read with `code`. */
  const failingWatch = (code: number): MongoService =>
    new Proxy(observer, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== 'control') return value;
        return new Proxy(value as object, {
          get(db, dbProp) {
            const member = Reflect.get(db, dbProp) as unknown;
            if (dbProp !== 'collection' || typeof member !== 'function')
              return typeof member === 'function' ? member.bind(db) : member;
            return (name: string, ...rest: unknown[]) => {
              const collection = (member as (n: string, ...r: unknown[]) => object).call(db, name, ...rest);
              if (name !== 'projection_events') return collection;
              return new Proxy(collection, {
                get(c, cProp) {
                  if (cProp !== 'watch') {
                    const m = Reflect.get(c, cProp) as unknown;
                    return typeof m === 'function' ? (m as (...a: unknown[]) => unknown).bind(c) : m;
                  }
                  return () => ({
                    close: async () => undefined,
                    [Symbol.asyncIterator]: () => ({
                      next: async () => {
                        throw Object.assign(new Error('injected server error'), { code });
                      },
                    }),
                  });
                },
              });
            };
          },
        });
      },
    }) as MongoService;

  it('an unrelated server code while resuming from a stored token still throws and keeps the offset (no blanket recovery)', async () => {
    await storeToken(await realToken());
    const run = await consumeFor(1500, async () => {}, failingWatch(11000));
    expect(run.thrown?.code).toBe(11000);
    expect(run.recoveries).toEqual([]);
    expect(await offsets().countDocuments({ _id: CONSUMER } as never)).toBe(1);
  }, 30_000);

  it('a code in the resume-failure set on a FRESH start (no stored token) still throws: there was no token to blame', async () => {
    const run = await consumeFor(1500, async () => {}, failingWatch(9));
    expect(run.thrown?.code).toBe(9);
    expect(run.recoveries).toEqual([]);
  }, 30_000);

  it('an error AFTER events flowed is not treated as a resume failure: it still throws and the offset stays', async () => {
    await projections.append(scope, input('ev-1'));
    await storeToken(await realToken());
    await projections.append(scope, input('ev-2'));
    const run = await consumeFor(2500, async () => {
      throw Object.assign(new Error('handler failed after delivery'), { code: 9 });
    });
    expect(run.thrown?.message).toContain('handler failed after delivery');
    expect(run.recoveries).toEqual([]);
    expect(await offsets().countDocuments({ _id: CONSUMER } as never)).toBe(1);
  }, 30_000);

  it('the handled branch for lost history (server codes 286 and 280) triggers backfill and deletes the offset (code-path check by reading)', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../packages/mongo/src/events.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/code === 286 \|\| code === 280/);
    expect(source).toMatch(/offsets\.deleteOne\(\{ _id: this\.consumerId \}\)/);
  });
});
