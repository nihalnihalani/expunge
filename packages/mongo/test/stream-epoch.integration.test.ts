/**
 * Per-job stream epoch on a local replica set (MONGODB_TEST_URI): an append keeps it, a reset changes it, pages serve it, and
 * the list's receipt reference comes only from the committed `receipt_committed` event. MongoDB protocol evidence only.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ProjectionRepository } from '../src/index.js';
import { PROJECTION_SAMPLES } from '../../contracts/test/projection-samples.js';
import { actor, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const started = (jobId: string, eventId: string) => ({
  eventId,
  jobId,
  runId: `run-${jobId}`,
  artifactIds: [],
  kind: 'job_started' as const,
  payload: PROJECTION_SAMPLES.job_started,
});
const receipt = (jobId: string, eventId: string, receiptId: string, verifiedWorldRevision: number) => ({
  eventId,
  jobId,
  runId: `run-${jobId}`,
  artifactIds: [],
  kind: 'receipt_committed' as const,
  payload: { ...PROJECTION_SAMPLES.receipt_committed, receiptId, verifiedWorldRevision },
});

describeLive('projection stream epoch and receipt reference (local protocol lane)', () => {
  let env: LiveEnvironment;
  let projections: ProjectionRepository;
  beforeAll(async () => {
    env = await openEnvironment('epoch');
    projections = new ProjectionRepository(env.service);
  }, 30_000);
  beforeEach(async () => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  it('a stream has no epoch before its first event, gets one with it, and an append never changes it', async () => {
    expect(await projections.epochOf(scope, 'job-1')).toBeNull();
    await projections.append(scope, started('job-1', 'e1'));
    const epoch = await projections.epochOf(scope, 'job-1');
    expect(epoch).toMatch(/^[0-9a-f-]{36}$/);
    for (let i = 2; i <= 6; i++) await projections.append(scope, started('job-1', `e${i}`));
    expect(await projections.epochOf(scope, 'job-1')).toBe(epoch);
    // A retried append of an existing event id is a no-op and does not touch the epoch either.
    await projections.append(scope, started('job-1', 'e3'));
    expect(await projections.epochOf(scope, 'job-1')).toBe(epoch);
  });

  it('every page serves the epoch of the events it carries; other jobs have their own epoch', async () => {
    await projections.append(scope, started('job-a', 'a1'));
    await projections.append(scope, started('job-a', 'a2'));
    await projections.append(scope, started('job-b', 'b1'));
    const first = await projections.readPage(scope, 0, 'job-a');
    expect(first.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(first.streamEpoch).toBe(await projections.epochOf(scope, 'job-a'));
    const tail = await projections.readPage(scope, 2, 'job-a');
    expect(tail).toEqual({ events: [], streamEpoch: first.streamEpoch }); // an empty tail still names the epoch
    expect((await projections.readPage(scope, 0, 'job-b')).streamEpoch).not.toBe(first.streamEpoch);
    expect((await projections.readPage(scope, 0, 'job-none')).streamEpoch).toBeNull();
  });

  it('a reset changes the epoch, removes the old history, restarts the sequence, and leaves other jobs alone', async () => {
    await projections.append(scope, started('job-a', 'a1'));
    await projections.append(scope, started('job-a', 'a2'));
    await projections.append(scope, started('job-a', 'a3'));
    await projections.append(scope, started('job-b', 'b1'));
    const before = await projections.readPage(scope, 0, 'job-a');
    const otherEpoch = await projections.epochOf(scope, 'job-b');

    const reset = await projections.resetStream(scope, 'job-a', 'restore');
    expect(reset.removed).toBe(3);
    expect(reset.streamEpoch).not.toBe(before.streamEpoch);
    // A client holding cursor 3 under the old epoch now gets an empty page under a DIFFERENT epoch.
    expect(await projections.readPage(scope, 3, 'job-a')).toEqual({
      events: [],
      streamEpoch: reset.streamEpoch,
    });
    // New appends continue from 1 under the new epoch, and an append keeps it.
    const event = await projections.append(scope, started('job-a', 'a4'));
    expect(event.sequence).toBe(1);
    expect(await projections.epochOf(scope, 'job-a')).toBe(reset.streamEpoch);
    expect(await projections.epochOf(scope, 'job-b')).toBe(otherEpoch);
    expect((await projections.read(scope, 0, 'job-b')).map((e) => e.sequence)).toEqual([1]);
  });

  it('a rebuild runs in the same transaction: the new history appears together with the new epoch, or not at all', async () => {
    await projections.append(scope, started('job-a', 'a1'));
    const reset = await projections.resetStream(scope, 'job-a', 'backfill_rebuild', async (session) => {
      await projections.append(scope, started('job-a', 'r1'), session);
      await projections.append(scope, receipt('job-a', 'r2', 'rcpt-1', 7), session);
    });
    const page = await projections.readPage(scope, 0, 'job-a');
    expect(page.streamEpoch).toBe(reset.streamEpoch);
    expect(page.events.map((e) => [e.eventId, e.sequence])).toEqual([
      ['r1', 1],
      ['r2', 2],
    ]);
    // A failing rebuild rolls the whole reset back: old history and old epoch stay.
    const epoch = await projections.epochOf(scope, 'job-a');
    await expect(
      projections.resetStream(scope, 'job-a', 'resequence', async () => {
        throw new Error('rebuild failed');
      }),
    ).rejects.toThrow('rebuild failed');
    expect(await projections.epochOf(scope, 'job-a')).toBe(epoch);
    expect((await projections.read(scope, 0, 'job-a')).map((e) => e.eventId)).toEqual(['r1', 'r2']);
  });

  it('only the setup administrator may reset a stream, and the reason is a closed set', async () => {
    await projections.append(scope, started('job-a', 'a1'));
    const executor = await env.as('domain_executor');
    await expect(new ProjectionRepository(executor).resetStream(scope, 'job-a', 'restore')).rejects.toThrow(
      'PrincipalBoundary',
    );
    await expect(projections.resetStream(scope, 'job-a', 'because' as never)).rejects.toMatchObject({
      code: 'InvalidReset',
    });
    expect((await projections.read(scope, 0, 'job-a')).length).toBe(1);
  });

  it('readPage never mixes two histories under one epoch: a reset during the read makes it retry, and a stream that keeps changing is refused', async () => {
    await projections.append(scope, started('job-a', 'a1'));
    let calls = 0;
    class Flaky extends ProjectionRepository {
      override async epochOf(...args: Parameters<ProjectionRepository['epochOf']>) {
        calls += 1;
        return calls === 2 ? 'changed-during-read' : super.epochOf(...args);
      }
    }
    const page = await new Flaky(env.service).readPage(scope, 0, 'job-a');
    expect(page.streamEpoch).toBe(await projections.epochOf(scope, 'job-a'));
    expect(calls).toBeGreaterThanOrEqual(4); // first attempt discarded, second consistent
    let flip = 0;
    class Unstable extends ProjectionRepository {
      override async epochOf() {
        return `epoch-${flip++}`;
      }
    }
    await expect(new Unstable(env.service).readPage(scope, 0, 'job-a')).rejects.toMatchObject({
      code: 'StreamEpochUnstable',
    });
  });

  it('the list receipt reference comes only from the committed receipt_committed event, latest wins, and is null without one', async () => {
    await projections.append(scope, started('job-a', 'a1'));
    expect(await projections.receiptReference(scope, 'job-a')).toBeNull();
    await projections.append(scope, receipt('job-a', 'a2', 'rcpt-1', 4));
    await projections.append(scope, started('job-a', 'a3'));
    expect(await projections.receiptReference(scope, 'job-a')).toEqual({
      receiptId: 'rcpt-1',
      receiptSequence: 2,
      verifiedWorldRevision: 4,
    });
    await projections.append(scope, receipt('job-a', 'a4', 'rcpt-2', 9));
    expect(await projections.receiptReference(scope, 'job-a')).toEqual({
      receiptId: 'rcpt-2',
      receiptSequence: 4,
      verifiedWorldRevision: 9,
    });
    expect(await projections.receiptReference(scope, 'job-b')).toBeNull();
    expect(await projections.receiptReference({ ...scope, scopeId: 'elsewhere' }, 'job-a')).toBeNull();
  });
});
