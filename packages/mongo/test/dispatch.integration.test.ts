import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { JobRepository, WakeCommandRepository, type MongoService } from '../src/index.js';
import { actor, createJob, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

describeLive(
  'trusted dispatcher support: resolve, list claimable, release, wake dedupe (real replica set)',
  () => {
    let env: LiveEnvironment;
    let executor: MongoService;
    let jobs: JobRepository;
    let wake: WakeCommandRepository;

    beforeAll(async () => {
      env = await openEnvironment('dispatch');
      executor = await env.as('domain_executor');
      jobs = new JobRepository(executor);
      wake = new WakeCommandRepository(executor);
    }, 30000);
    beforeEach(() => env.reset());
    afterAll(async () => {
      if (env) await env.dispose();
    }, 30000);

    const raw = () => env.service.control.collection<Document>('jobs');

    it('resolves the stored job without a caller actor, for a worker principal of its kind only', async () => {
      const id = await createJob(env.service);
      const job = await jobs.resolveForDispatch(id);
      expect(job.actor).toEqual(actor);
      // The dispatcher then claims with the stored owner, exactly as a wake command's job would be.
      expect((await jobs.claim(job.actor, id, 'worker', 10000))?.status).toBe('running');
      await expect(jobs.resolveForDispatch('missing')).rejects.toThrow('JobNotFound');
      for (const principal of ['grader', 'observer', 'promoter', 'privacy_controller'] as const)
        await expect(
          new JobRepository(await env.as(principal)).resolveForDispatch(id),
          principal,
        ).rejects.toThrow('PrincipalBoundary');
    });

    it('lists exactly the jobs this principal could claim now, best first', async () => {
      const queued = await createJob(env.service);
      const urgent = await createJob(env.service);
      await raw().updateOne({ _id: urgent as never }, { $set: { priority: 5 } });
      const live = await createJob(env.service);
      await jobs.claim(actor, live, 'worker', 60000);
      const expired = await createJob(env.service);
      await jobs.claim(actor, expired, 'worker', 150);
      const cancelled = await createJob(env.service);
      await raw().updateOne({ _id: cancelled as never }, { $set: { cancellationRequested: true } });
      const finished = await createJob(env.service);
      await raw().updateOne({ _id: finished as never }, { $set: { status: 'failed' } });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const claimable = await jobs.listClaimable();
      expect(claimable.map((row) => row.jobId)).toEqual([urgent, queued, expired]);
      expect(claimable[0]).toMatchObject({ kind: 'cleanup', priority: 5 });
      expect(await jobs.listClaimable(1)).toHaveLength(1);
      // Another kind's principal sees none of the cleanup jobs.
      expect(await new JobRepository(await env.as('observer')).listClaimable()).toEqual([]);
      await expect(jobs.listClaimable(0)).rejects.toThrow('InvalidClaimableLimit');
      await expect(jobs.listClaimable(101)).rejects.toThrow('InvalidClaimableLimit');
    });

    it('reclaims a job whose worker died: list, resolve, claim with a higher fence', async () => {
      const id = await createJob(env.service);
      const first = (await jobs.claim(actor, id, 'dead-worker', 150))!;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const [candidate] = await jobs.listClaimable();
      expect(candidate?.jobId).toBe(id);
      const resolved = await jobs.resolveForDispatch(candidate!.jobId);
      const second = await jobs.claim(resolved.actor, id, 'new-worker', 10000);
      expect(second?.lease.fence).toBe(first.lease.fence + 1);
    });

    it('releases a lease gracefully without bumping the fence', async () => {
      const id = await createJob(env.service);
      const claimed = (await jobs.claim(actor, id, 'worker', 60000))!;
      const lease = { jobId: id, ownerId: 'worker', fence: claimed.lease.fence };
      await jobs.release(actor, lease);
      const released = await jobs.readAuthorized(actor, id);
      expect(released).toMatchObject({ status: 'queued' });
      expect(released.lease.fence).toBe(claimed.lease.fence);
      expect(released.lease.until.getTime()).toBe(0);
      await expect(jobs.release(actor, lease)).rejects.toThrow('LostLease');
      await expect(jobs.renew(actor, lease)).rejects.toThrow('LostLease');
      expect((await jobs.claim(actor, id, 'next', 10000))?.lease.fence).toBe(claimed.lease.fence + 1);
    });

    it("cannot release a stale lease, a cancel-requested job, or another principal's kind", async () => {
      const id = await createJob(env.service);
      const claimed = (await jobs.claim(actor, id, 'worker', 60000))!;
      const lease = { jobId: id, ownerId: 'worker', fence: claimed.lease.fence };
      await expect(jobs.release(actor, { ...lease, fence: lease.fence + 1 })).rejects.toThrow('LostLease');
      await expect(new JobRepository(await env.as('grader')).release(actor, lease)).rejects.toThrow(
        'PrincipalBoundary',
      );
      await jobs.cancel(actor, id);
      await expect(jobs.release(actor, lease)).rejects.toThrow('LostLease');
      await jobs.finish(actor, lease, 'cancelled', []);
      expect((await jobs.readAuthorized(actor, id)).status).toBe('cancelled');
    });

    it('records each wake command once, even under concurrent redelivery', async () => {
      expect(await wake.accept({ jobId: 'j', commandId: 'c1' })).toEqual({ accepted: true });
      expect(await wake.accept({ jobId: 'j', commandId: 'c1' })).toEqual({
        accepted: false,
        duplicate: true,
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => wake.accept({ jobId: 'j', commandId: 'c2' })),
      );
      expect(results.filter((r) => r.accepted)).toHaveLength(1);
      expect(await env.service.control.collection('wake_commands').countDocuments()).toBe(2);
      await expect(wake.accept({ jobId: '', commandId: 'c3' })).rejects.toThrow('InvalidWakeCommand');
      await expect(wake.accept({ jobId: 'j', commandId: 'x'.repeat(300) })).rejects.toThrow(
        'InvalidWakeCommand',
      );
      await expect(
        new WakeCommandRepository(await env.as('observer')).accept({ jobId: 'j', commandId: 'c4' }),
      ).rejects.toThrow('PrincipalBoundary');
    });

    it('creates the TTL housekeeping index on acceptance time only', async () => {
      const indexes = await env.service.control.collection('wake_commands').indexes();
      const ttl = indexes.find((index) => index.expireAfterSeconds !== undefined);
      expect(ttl?.key).toEqual({ acceptedAt: 1 });
    });
  },
);
