import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { PROJECTION_EVENT_KINDS, type ProjectionEventKind } from '@expunge/contracts';
import { ProjectionRepository, projectionStreamId, setupMongo } from '../src/index.js';
import { PROJECTION_SAMPLES } from '../../contracts/test/projection-samples.js';
import { actor, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };

describeLive(
  'projection event log: per-job contiguous sequences and strict payloads (real replica set)',
  () => {
    let env: LiveEnvironment;
    let projections: ProjectionRepository;

    beforeAll(async () => {
      env = await openEnvironment('projection');
      projections = new ProjectionRepository(env.service);
    }, 30000);
    beforeEach(() => env.reset());
    afterAll(async () => {
      if (env) await env.dispose();
    }, 30000);

    const event = (jobId: string, eventId: string, kind: ProjectionEventKind = 'job_started') => ({
      eventId,
      jobId,
      runId: `run-${jobId}`,
      artifactIds: [],
      kind,
      payload: PROJECTION_SAMPLES[kind] as never,
    });
    const sequences = async (jobId: string) =>
      (await projections.read(scope, 0, jobId, 1000)).map((stored) => stored.sequence);
    const events = () => env.service.control.collection<Document>('projection_events');

    it('numbers each job stream contiguously from 1, independent of other jobs and scopes', async () => {
      for (let n = 0; n < 4; n++) {
        await projections.append(scope, event('job-a', `a-${n}`));
        await projections.append(scope, event('job-b', `b-${n}`));
      }
      await projections.append({ ...scope, scopeId: 'other-scope' }, event('job-a', 'other-a-0'));
      expect(await sequences('job-a')).toEqual([1, 2, 3, 4]);
      expect(await sequences('job-b')).toEqual([1, 2, 3, 4]);
      expect(await projections.read({ ...scope, scopeId: 'other-scope' }, 0, 'job-a')).toHaveLength(1);
      expect(await projections.read({ ...scope, tenantId: 'other' }, 0, 'job-a')).toEqual([]);
    });

    it('has no gaps or duplicates under concurrent appends to one job', async () => {
      await Promise.all(
        Array.from({ length: 24 }, (_, n) => projections.append(scope, event('busy', `e-${n}`))),
      );
      expect(await sequences('busy')).toEqual(Array.from({ length: 24 }, (_, n) => n + 1));
    });

    it('gives a sequence number back when the committing transaction aborts', async () => {
      await projections.append(scope, event('job', 'kept'));
      await expect(
        env.service.transaction(async (session) => {
          await projections.append(scope, event('job', 'doomed'), session);
          throw new Error('outer transaction aborted');
        }),
      ).rejects.toThrow('outer transaction aborted');
      await projections.append(scope, event('job', 'next'));
      expect(await sequences('job')).toEqual([1, 2]);
      expect(await events().countDocuments({ _id: 'doomed' as never })).toBe(0);
    });

    it('allocates inside the caller transaction so the event and its sequence commit together', async () => {
      const stored = await env.service.transaction(async (session) => {
        const first = await projections.append(scope, event('atomic', 'x1'), session);
        const second = await projections.append(scope, event('atomic', 'x2'), session);
        return [first.sequence, second.sequence];
      });
      expect(stored).toEqual([1, 2]);
      expect(await sequences('atomic')).toEqual([1, 2]);
      const counter = await env.service.control
        .collection<Document>('projection_sequences')
        .findOne({ _id: projectionStreamId(scope, 'atomic') as never });
      expect(counter).toHaveProperty('sequence', 2);
    });

    it('replays a duplicate event id without consuming a sequence and rejects a conflicting one', async () => {
      const first = await projections.append(scope, event('job', 'same'));
      expect(await projections.append(scope, event('job', 'same'))).toEqual(first);
      await expect(
        projections.append(scope, {
          ...event('job', 'same', 'cancel_requested'),
        }),
      ).rejects.toThrow('EventIdConflict');
      expect((await projections.append(scope, event('job', 'after'))).sequence).toBe(2);
    });

    it('reads one job after a sequence, in order, and requires the job', async () => {
      for (let n = 0; n < 5; n++) await projections.append(scope, event('job', `e-${n}`));
      expect((await projections.read(scope, 2, 'job')).map((e) => e.eventId)).toEqual(['e-2', 'e-3', 'e-4']);
      expect(await projections.read(scope, 5, 'job')).toEqual([]);
      await expect(projections.read(scope, -1, 'job')).rejects.toThrow('InvalidEventWindow');
      await expect(projections.read(scope, 0, '')).rejects.toThrow('InvalidEventWindow');
    });

    it('stores every kind, including the six additive ones, and the database validator accepts them', async () => {
      for (const kind of PROJECTION_EVENT_KINDS)
        await projections.append(scope, event('kinds', `k-${kind}`, kind));
      expect(await sequences('kinds')).toEqual(PROJECTION_EVENT_KINDS.map((_, n) => n + 1));
      await expect(
        events().insertOne({
          _id: 'raw' as never,
          ...scope,
          sequence: 99,
          eventId: 'raw',
          jobId: 'kinds',
          runId: 'r',
          artifactIds: [],
          kind: 'job_deleted',
          payload: {},
          createdAt: new Date(),
        }),
      ).rejects.toMatchObject({ code: 121 });
    });

    it('rejects an invalid payload before anything is written or numbered', async () => {
      await projections.append(scope, event('job', 'ok'));
      const sample = PROJECTION_SAMPLES.job_started;
      for (const payload of [{}, { ...sample, subject: 'Alice Example' }, { ...sample, attempt: 'one' }]) {
        await expect(
          projections.append(scope, { ...event('job', 'bad'), payload: payload as never }),
        ).rejects.toThrow('InvalidProjectionPayload:job_started');
      }
      await expect(
        projections.append(scope, { ...event('job', 'bad'), kind: 'job_deleted' as never }),
      ).rejects.toThrow('InvalidProjectionKind');
      await projections.append(scope, event('job', 'after'));
      expect(await sequences('job')).toEqual([1, 2]);
    });

    it('migrates the legacy per-scope unique sequence index so a second job can start at 1', async () => {
      await events().createIndex({ tenantId: 1, env: 1, scopeId: 1, sequence: 1 }, { unique: true });
      await expect(
        (async () => {
          await projections.append(scope, event('first', 'f-1'));
          await projections.append(scope, event('second', 's-1'));
        })(),
      ).rejects.toMatchObject({ code: 11000 });
      await env.reset();
      await setupMongo(env.service);
      await projections.append(scope, event('first', 'f-1'));
      await projections.append(scope, event('second', 's-1'));
      expect(await sequences('second')).toEqual([1]);
    });
  },
);
