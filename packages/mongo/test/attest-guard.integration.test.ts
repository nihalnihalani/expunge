/**
 * run_attestations (per-fence model stamps) and guard_exports (leak-guard generations). Local replica-set protocol
 * evidence (MONGODB_TEST_URI); made-up jobs and digests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AttestationRepository,
  GuardExportRepository,
  JobRepository,
  SubjectTokenRepository,
  type RunAttestation,
} from '../src/index.js';
import { actor, createJob, describeLive, openEnvironment, type LiveEnvironment } from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const HOST = 'c'.repeat(64);

describeLive('run attestations and guard exports (local protocol lane)', () => {
  let env: LiveEnvironment;
  let attest: AttestationRepository;
  let jobs: JobRepository;
  beforeAll(async () => {
    env = await openEnvironment('attest');
    const executor = await env.as('domain_executor');
    attest = new AttestationRepository(executor);
    jobs = new JobRepository(executor);
  }, 30_000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 30_000);

  const stamp = (fence: number, extra: Partial<RunAttestation> = {}): RunAttestation => ({
    fence,
    source: 'configuration',
    provider: 'anthropic',
    modelId: 'claude-model',
    spec: 'spec-v1',
    endpointHostHash: HOST,
    at: new Date('2026-10-11T12:00:00.000Z'),
    ...extra,
  });
  async function leased(owner = 'worker') {
    const id = await createJob(env.service);
    const job = (await jobs.claim(actor, id, owner, 10000))!;
    return { jobId: id, ownerId: owner, fence: job.lease.fence };
  }

  describe('run_attestations', () => {
    it('stores one row per fence for the live lease, and an identical repeat returns it', async () => {
      const lease = await leased();
      const row = await attest.record(actor, lease, stamp(lease.fence));
      expect(row).toMatchObject({ jobId: lease.jobId, fence: lease.fence, modelId: 'claude-model' });
      expect((await attest.record(actor, lease, stamp(lease.fence))).createdAt).toEqual(row.createdAt);
      expect(await attest.list(scope, lease.jobId)).toHaveLength(1);
    });
    it('refuses a different stamp for the same fence, a wrong fence and a malformed stamp', async () => {
      const lease = await leased();
      await attest.record(actor, lease, stamp(lease.fence));
      await expect(attest.record(actor, lease, stamp(lease.fence, { modelId: 'other' }))).rejects.toThrow(
        'AttestationConflict',
      );
      await expect(attest.record(actor, lease, stamp(lease.fence + 1))).rejects.toThrow('InvalidAttestation');
      await expect(attest.record(actor, lease, stamp(lease.fence, { modelId: '' }))).rejects.toThrow(
        'InvalidAttestation',
      );
      await expect(
        attest.record(actor, lease, stamp(lease.fence, { endpointHostHash: 'nothex' })),
      ).rejects.toThrow('InvalidAttestation');
    });
    it('a fenced-out holder cannot attest', async () => {
      const lease = await leased('first');
      await env.service.control
        .collection('jobs')
        .updateOne({ _id: lease.jobId as never }, { $set: { 'lease.until': new Date(Date.now() - 1000) } });
      await expect(attest.record(actor, lease, stamp(lease.fence))).rejects.toThrow('LostLease');
    });
    it('is the worker principal only; the grader and the projection reader read it', async () => {
      const lease = await leased();
      await attest.record(actor, lease, stamp(lease.fence));
      const grader = new AttestationRepository(await env.as('grader'));
      expect(await grader.list(scope, lease.jobId)).toHaveLength(1);
      expect(
        await new AttestationRepository(await env.as('projection_reader')).list(scope, lease.jobId),
      ).toHaveLength(1);
      await expect(grader.record(actor, lease, stamp(lease.fence))).rejects.toThrow('PrincipalBoundary');
      await expect(
        new AttestationRepository(await env.as('observer')).list(scope, lease.jobId),
      ).rejects.toThrow('PrincipalBoundary');
    });
  });

  describe('guard_exports and the subject-set generation', () => {
    const exportOf = (generation: number, extra: Record<string, unknown> = {}) => ({
      providerOrganizationId: 'org-1',
      generation,
      subjectSetGeneration: 0,
      count: 7,
      digest: 'd'.repeat(64),
      exportedAt: new Date('2026-10-11T12:00:00.000Z'),
      ...extra,
    });
    const token = (handle: string, generation = 1) => ({
      subjectHandle: handle,
      provider: 'raindrop',
      tokenGeneration: generation,
      tokens: [`tok-${handle}`],
      registeredAt: new Date('2026-10-11T12:00:00.000Z'),
    });
    it('records generations that only rise, and the observer reads the latest by generation', async () => {
      const privacy = new GuardExportRepository(await env.as('privacy_controller'));
      const observer = new GuardExportRepository(await env.as('observer'));
      expect(await observer.latest(scope, 'org-1')).toBeNull();
      await privacy.record(scope, exportOf(1), null);
      await privacy.record(scope, exportOf(3, { count: 9 }), 1);
      await expect(privacy.record(scope, exportOf(2), 3)).rejects.toThrow('GuardGenerationRegression');
      expect((await observer.latest(scope, 'org-1'))?.generation).toBe(3);
      expect(await observer.latest(scope, 'org-2')).toBeNull();
    });
    it('an identical repeat returns the stored row; a different row under the same generation conflicts', async () => {
      const privacy = new GuardExportRepository(await env.as('privacy_controller'));
      const first = await privacy.record(scope, exportOf(1), null);
      expect((await privacy.record(scope, exportOf(1), null)).createdAt).toEqual(first.createdAt);
      await expect(privacy.record(scope, exportOf(1, { count: 8 }), null)).rejects.toThrow(
        'GuardExportConflict',
      );
      await expect(privacy.record(scope, exportOf(0), 1)).rejects.toThrow('InvalidGuardExport');
      await expect(privacy.record(scope, exportOf(2, { digest: 'x' }), 1)).rejects.toThrow(
        'InvalidGuardExport',
      );
    });
    it('G-4: an export that raced another is refused, and an unconditional record is refused', async () => {
      const privacy = new GuardExportRepository(await env.as('privacy_controller'));
      await privacy.record(scope, exportOf(1), null);
      // A read "latest = none" before generation 1 landed, then tries to record generation 2.
      await expect(privacy.record(scope, exportOf(2), null)).rejects.toThrow('GuardExportRaced');
      await expect(privacy.record(scope, exportOf(2))).rejects.toThrow('GuardExportNotConditional');
      expect((await privacy.record(scope, exportOf(2), 1)).generation).toBe(2);
    });
    it('G-1: registering a subject bumps the generation in the same transaction, and the observer sees the guard as behind', async () => {
      const privacyService = await env.as('privacy_controller');
      const tokens = new SubjectTokenRepository(privacyService);
      const privacy = new GuardExportRepository(privacyService);
      const observer = new GuardExportRepository(await env.as('observer'));
      expect(await observer.status(scope, 'org-1')).toMatchObject({
        latest: null,
        subjectSetGeneration: 0,
        covered: false,
      });
      expect(await tokens.put(scope, token('s-1'))).toBe('created');
      const read = await privacy.subjectSetGeneration(scope);
      expect(read).toBe(1);
      await privacy.record(scope, exportOf(1, { subjectSetGeneration: read }), null);
      expect(await observer.status(scope, 'org-1')).toMatchObject({ subjectSetGeneration: 1, covered: true });
      // A subject registered AFTER the export: the file still reads as the latest, but it does not cover the subject set.
      await tokens.put(scope, token('s-2'));
      const behind = await observer.status(scope, 'org-1');
      expect(behind).toMatchObject({ subjectSetGeneration: 2, covered: false });
      expect(behind.latest?.generation).toBe(1);
      // An existing entry changes nothing and bumps nothing.
      expect(await tokens.put(scope, token('s-2'))).toBe('exists');
      expect(await privacy.subjectSetGeneration(scope)).toBe(2);
      // Re-exporting at the current generation covers it again.
      await privacy.record(scope, exportOf(2, { subjectSetGeneration: 2 }), 1);
      expect((await observer.status(scope, 'org-1')).covered).toBe(true);
    });
    it('an older subject snapshot cannot become the latest, and a future generation cannot be claimed', async () => {
      const privacyService = await env.as('privacy_controller');
      const tokens = new SubjectTokenRepository(privacyService);
      const privacy = new GuardExportRepository(privacyService);
      await tokens.put(scope, token('s-1'));
      await tokens.put(scope, token('s-2'));
      await privacy.record(scope, exportOf(1, { subjectSetGeneration: 2 }), null);
      await expect(privacy.record(scope, exportOf(2, { subjectSetGeneration: 1 }), 1)).rejects.toThrow(
        'GuardGenerationRegression',
      );
      await expect(privacy.record(scope, exportOf(2, { subjectSetGeneration: 9 }), 1)).rejects.toThrow(
        'InvalidGuardExport',
      );
    });
    it('only the privacy controller writes; the observer reads; a registration that fails bumps nothing', async () => {
      const observer = new GuardExportRepository(await env.as('observer'));
      await expect(observer.record(scope, exportOf(1), null)).rejects.toThrow('PrincipalBoundary');
      await expect(new GuardExportRepository(await env.as('grader')).latest(scope, 'org-1')).rejects.toThrow(
        'PrincipalBoundary',
      );
      const privacyService = await env.as('privacy_controller');
      await expect(
        new SubjectTokenRepository(privacyService).put(scope, { ...token('s-3'), provider: 'bad provider!' }),
      ).rejects.toThrow();
      expect(await new GuardExportRepository(privacyService).subjectSetGeneration(scope)).toBe(0);
    });
  });
});
