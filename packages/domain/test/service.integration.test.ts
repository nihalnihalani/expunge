import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeploymentRepository, GuardExportRepository } from '@expunge/mongo';
import { jobTelemetryUserId } from '@expunge/observability';
import { privacySubjectRegistrar } from '@expunge/privacy';
import { HASH, describeLive } from '../../mongo/test/support.js';
import {
  createDomainService,
  listenDomainService,
  serviceConfigFromEnv,
  type DomainService,
  type ServiceConfig,
} from '../src/index.js';
import { openRig, type Rig, type Seeded } from './rig.js';

/** A parsed JSON response body; the tests assert on the fields they name. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

const READ = 'r'.repeat(32);
const JOB = 'j'.repeat(32);
const APPROVAL = 'a'.repeat(32);
const WAKE = 'w'.repeat(32);
const PROJECT = 'project-submit-test';
const ORG = 'org-submit-test';

/**
 * The domain service in front of a real replica set. The wake transport is a recorded stand-in (FAKE: it only notes
 * which job ids the service asked to wake); everything the service reads and writes is real MongoDB state.
 */
describeLive('domain service on a real replica set (wake transport is a labeled FAKE)', () => {
  let rig: Rig;
  let seeded: Seeded;
  let config: ServiceConfig;
  let service: DomainService;
  const woken: string[] = [];

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await service.handle(
      new Request(`http://domain.test/internal/projection${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-expunge-owner-id': 'owner',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Body };
  };
  const subject = () => ({ idType: 'string' as const, value: seeded.world.subjectHandle });

  beforeAll(async () => {
    rig = await openRig('service');
    seeded = await rig.seed('direct_nested');
    config = serviceConfigFromEnv({
      EXPUNGE_INTERNAL_TOKEN: READ,
      EXPUNGE_JOB_WRITE_TOKEN: JOB,
      EXPUNGE_APPROVAL_TOKEN: APPROVAL,
      EXPUNGE_WAKE_TOKEN: WAKE,
      OWNER_ID: 'owner',
      EXPUNGE_TENANT_ID: seeded.binding.tenantId,
      EXPUNGE_ENV: seeded.binding.env,
      EXPUNGE_SCOPE_ID: seeded.binding.scopeId,
      EXPUNGE_WORKER_PROFILE_HASH: HASH,
    });
    service = createDomainService({
      env: rig.domain,
      config,
      wake: async (jobId) => {
        woken.push(jobId);
        return true;
      },
      // The real registrar, on its own privacy_controller principal (per-principal users when the lane provisions them).
      registerSubject: privacySubjectRegistrar(await rig.env.as('privacy_controller'), {
        projectId: PROJECT,
        guard: { path: join(guardDir, 'guard.json'), providerOrganizationId: ORG },
      }),
    });
  }, 60_000);
  afterAll(async () => {
    await rig?.dispose();
    rmSync(guardDir, { recursive: true, force: true });
  });

  const guardDir = mkdtempSync(join(tmpdir(), 'submit-guard-'));
  const registry = () => ({
    tokens: rig.env.service.control.collection('subject_tokens'),
    generation: async () =>
      (await rig.env.service.control.collection('subject_set_generations').findOne({}))?.generation as
        number | undefined,
    guard: () =>
      new GuardExportRepository(rig.env.service).status(seeded.binding, ORG) as Promise<{
        latest: { generation: number } | null;
        covered: boolean;
      }>,
  });

  it('reports the bound scope and lists the world with its registry counts', async () => {
    const readiness = await call('GET', '/readiness', READ);
    expect(readiness.status).toBe(200);
    expect(readiness.body.scope).toEqual({ bound: true });
    const worlds = await call('GET', '/worlds', READ);
    expect(worlds.status).toBe(200);
    const [world] = worlds.body.worlds as Array<Body>;
    expect(world.worldId).toBe(seeded.world.worldId);
    expect(world.scopeRevision).toBe(seeded.world.scope.revision);
    expect(world.fieldCount).toBe(seeded.world.scope.fields.length);
    expect(world.maintenanceMode).toBe(false);
  });

  it('derives the evidence status from the committed outbox: unconfigured until a row exists, then proven times and dead letters', async () => {
    const outbox = rig.env.service.control.collection('telemetry_outbox');
    await outbox.deleteMany({});
    const empty = await call('GET', '/readiness', READ);
    expect(empty.body.evidence).toEqual({
      configured: false,
      writeProvenAt: null,
      readBackProvenAt: null,
      deadLetters: 0,
    });
    const scope = {
      tenantId: seeded.binding.tenantId,
      env: seeded.binding.env,
      scopeId: seeded.binding.scopeId,
    };
    const row = (
      operationId: string,
      status: string,
      attained: Record<string, { at: Date; contentHash: string }>,
    ) => ({
      _id: operationId,
      ...scope,
      operationId,
      kind: 'k',
      dedupeKey: operationId,
      jobId: 'j',
      payload: {},
      status,
      attempts: 0,
      nextAttemptAt: new Date(0),
      lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
      evidenceRequired: [],
      attained,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const hash = 'a'.repeat(64);
    await outbox.insertMany([
      row('op-1', 'pending', {}),
      row('op-2', 'ingest_accepted', {
        ingest_accepted: { at: new Date('2026-10-11T10:00:00.000Z'), contentHash: hash },
      }),
      row('op-3', 'evidence_ready', {
        ingest_accepted: { at: new Date('2026-10-11T11:00:00.000Z'), contentHash: hash },
        query_visible: { at: new Date('2026-10-11T11:30:00.000Z'), contentHash: hash },
        evidence_ready: { at: new Date('2026-10-11T12:00:00.000Z'), contentHash: hash },
      }),
      row('op-4', 'dead_letter', {}),
      // Another scope's rows never count.
      { ...row('op-5', 'dead_letter', {}), scopeId: 'other-scope' },
    ] as never);
    const live = await call('GET', '/readiness', READ);
    expect(live.body.evidence).toEqual({
      configured: true,
      writeProvenAt: '2026-10-11T11:00:00.000Z',
      readBackProvenAt: '2026-10-11T12:00:00.000Z',
      deadLetters: 1,
    });
    await outbox.deleteMany({});
  });

  it('previews counts only: the same world gives the same id, and no record id or value is in the answer', async () => {
    const first = await call('POST', '/previews', JOB, { worldId: seeded.world.worldId, subject: subject() });
    expect(first.status).toBe(200);
    expect(first.body.basis).toBe('expert_static_discovery');
    const total = (first.body.perCollection as Array<{ exactIdentityMatches: number }>).reduce(
      (sum, row) => sum + row.exactIdentityMatches,
      0,
    );
    expect(total).toBeGreaterThan(0);
    const second = await call('POST', '/previews', JOB, {
      worldId: seeded.world.worldId,
      subject: subject(),
    });
    expect(second.body.previewId).toBe(first.body.previewId);
    const text = JSON.stringify(first.body);
    expect(text).not.toContain(seeded.world.subjectHandle);
    expect(first.body.subject.identityHash).toMatch(/^[a-f0-9]{64}$/);
    // A preview is not a plan: nothing was written for the worker to apply.
    expect(await rig.env.service.control.collection('preview_plans').countDocuments()).toBe(0);
    expect(await rig.env.service.control.collection('effects').countDocuments()).toBe(0);
  });

  it('answers 404 for a world that is not in the scope, and says nothing about the subject when it is absent', async () => {
    expect(
      (await call('POST', '/previews', JOB, { worldId: 'not-a-world', subject: subject() })).status,
    ).toBe(404);
    const absent = await call('POST', '/previews', JOB, {
      worldId: seeded.world.worldId,
      subject: { idType: 'string', value: 'nobody-by-this-name' },
    });
    expect(absent.status).toBe(200);
    expect(
      (absent.body.perCollection as Array<{ exactIdentityMatches: number }>).every(
        (row) => row.exactIdentityMatches === 0,
      ),
    ).toBe(true);
  });

  it('refuses to queue a job while the scope has no active worker harness, and queues nothing', async () => {
    const preview = await call('POST', '/previews', JOB, {
      worldId: seeded.world.worldId,
      subject: subject(),
    });
    const refused = await call('POST', '/jobs', JOB, {
      requestKey: 'request-before-deploy',
      worldId: seeded.world.worldId,
      previewId: preview.body.previewId,
      subject: subject(),
    });
    expect(refused).toEqual({ status: 409, body: { error: 'no_active_harness' } });
    expect(await rig.env.service.control.collection('jobs').countDocuments()).toBe(0);
    expect(woken).toEqual([]);
  });

  describe('with an active worker harness', () => {
    let previewId: string;
    beforeAll(async () => {
      await new DeploymentRepository(rig.env.service).initialize(
        seeded.actor,
        'worker',
        seeded.bundleHashes.expert,
        seeded.world.scope.revision,
      );
      previewId = (
        await call('POST', '/previews', JOB, { worldId: seeded.world.worldId, subject: subject() })
      ).body.previewId;
    });

    it('pins the job to the active harness and the configured profile, stores the subject, wakes the worker', async () => {
      const queued = await call('POST', '/jobs', JOB, {
        requestKey: 'request-first-0001',
        worldId: seeded.world.worldId,
        previewId,
        subject: subject(),
      });
      expect(queued.status).toBe(200);
      expect(queued.body.status).toBe('queued');
      const job = await rig.env.service.control
        .collection('jobs')
        .findOne({ _id: queued.body.jobId as never });
      expect(job?.kind).toBe('cleanup');
      expect(job?.binding.harnessHash).toBe(seeded.bundleHashes.expert);
      expect(job?.binding.workerProfileHash).toBe(HASH);
      expect(job?.binding.worldId).toBe(seeded.world.worldId);
      expect(job?.actor).toMatchObject({ actorId: 'owner', ...seeded.binding });
      const stored = await rig.env.service.control
        .collection('job_subjects')
        .findOne({ _id: queued.body.jobId as never });
      expect(stored?.value).toBe(seeded.world.subjectHandle);
      expect(woken).toContain(queued.body.jobId);
      // The subject is registered once, mapped to the job's opaque telemetry id, and the guard export covers it.
      const { tokens, generation, guard } = registry();
      const rows = await tokens.find({}).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ...seeded.binding,
        subjectHandle: seeded.world.subjectHandle,
        provider: 'raindrop',
        tokenGeneration: 1,
        tokens: [jobTelemetryUserId(PROJECT, seeded.binding, queued.body.jobId as string)],
      });
      expect(JSON.stringify(rows[0]!.tokens)).not.toContain(seeded.world.subjectHandle);
      expect(await generation()).toBe(1);
      expect(await guard()).toMatchObject({ latest: { generation: 1 }, covered: true });
    });

    it('is idempotent on the request key: the same submission is the same job, not a second one', async () => {
      const jobs = rig.env.service.control.collection('jobs');
      const before = await jobs.countDocuments();
      const again = await call('POST', '/jobs', JOB, {
        requestKey: 'request-first-0001',
        worldId: seeded.world.worldId,
        previewId,
        subject: subject(),
      });
      expect(again.status).toBe(200);
      expect(await jobs.countDocuments()).toBe(before);
      // Resubmission registers nothing new: same single row, no subject-set bump, no new guard export.
      const { tokens, generation, guard } = registry();
      expect(await tokens.countDocuments()).toBe(1);
      expect(await generation()).toBe(1);
      expect(await guard()).toMatchObject({ latest: { generation: 1 }, covered: true });
    });

    it('refuses a preview id the world no longer produces', async () => {
      const stale = await call('POST', '/jobs', JOB, {
        requestKey: 'request-stale-0001',
        worldId: seeded.world.worldId,
        previewId: 'f'.repeat(64),
        subject: subject(),
      });
      expect(stale).toEqual({ status: 409, body: { error: 'conflict' } });
    });

    it('cancels a queued job on the owner request, records the request in the projection, and 404s an unknown job', async () => {
      const preview = await call('POST', '/previews', JOB, {
        worldId: seeded.world.worldId,
        subject: subject(),
      });
      const queued = await call('POST', '/jobs', JOB, {
        requestKey: 'request-cancel-0001',
        worldId: seeded.world.worldId,
        previewId: preview.body.previewId,
        subject: subject(),
      });
      const cancelled = await call('POST', `/jobs/${queued.body.jobId}/cancel`, JOB, {
        reason: 'changed my mind',
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.accepted).toBe(true);
      const job = await rig.env.service.control
        .collection('jobs')
        .findOne({ _id: queued.body.jobId as never });
      expect(job?.status).toBe('cancelled');
      const event = await rig.env.service.control
        .collection('projection_events')
        .findOne({ jobId: queued.body.jobId as never, kind: 'cancel_requested' });
      expect(event?.sequence).toBe(cancelled.body.sequence);
      expect((await call('POST', '/jobs/job-that-is-not-here/cancel', JOB, {})).status).toBe(404);
    });

    it('a second job for the same subject adds its token as the next generation and the guard is re-exported', async () => {
      const { tokens, generation, guard } = registry();
      const latest = await tokens.findOne({}, { sort: { tokenGeneration: -1 } });
      // The cancel test above submitted request-cancel-0001 for the same subject.
      const jobIds = (await rig.env.service.control.collection('jobs').find({}).toArray()).map(
        (job) => job._id as unknown as string,
      );
      expect(jobIds).toHaveLength(2);
      expect(latest?.tokenGeneration).toBe(2);
      expect([...(latest?.tokens as string[])].sort()).toEqual(
        jobIds.map((id) => jobTelemetryUserId(PROJECT, seeded.binding, id)).sort(),
      );
      expect(await generation()).toBe(2);
      expect(await guard()).toMatchObject({ latest: { generation: 2 }, covered: true });
    });
  });

  it('serves the same handler over a socket', async () => {
    const listener = await listenDomainService(service, { port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${listener.port}/internal/projection/readiness`, {
        headers: { authorization: `Bearer ${READ}`, 'x-expunge-owner-id': 'owner' },
      });
      expect(response.status).toBe(200);
      const none = await fetch(`http://127.0.0.1:${listener.port}/internal/projection/readiness`);
      expect(none.status).toBe(401);
    } finally {
      await listener.close();
    }
  });
});
