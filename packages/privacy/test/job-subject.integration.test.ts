/** Submit-time subject registration against a real local replica set as the privacy_controller principal (not Atlas). */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { GuardExportRepository, type MongoService } from '@expunge/mongo';
import { jobTelemetryUserId } from '@expunge/observability';
import { describeLive, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import { privacySubjectRegistrar } from '../src/job-subject.js';

describeLive('job subject registration at submit', () => {
  const scope = { tenantId: 't-submit', env: 'evaluation' as const, scopeId: 's-submit' };
  const handle = 'subject-handle-submit-1';
  const dir = mkdtempSync(join(tmpdir(), 'job-subject-'));
  let env: LiveEnvironment;
  let privacy: MongoService;
  let register: ReturnType<typeof privacySubjectRegistrar>;
  beforeAll(async () => {
    env = await openEnvironment('jobsubject');
    privacy = await env.as('privacy_controller');
    register = privacySubjectRegistrar(privacy, {
      projectId: 'project-1',
      guard: { path: join(dir, 'guard.json'), providerOrganizationId: 'org-1' },
    });
  }, 60_000);
  afterAll(async () => {
    await env?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const rows = () => env.service.control.collection('subject_tokens').find({}).toArray();
  const status = () => new GuardExportRepository(env.service).status(scope, 'org-1');

  it('registers a job subject once, mapped to its opaque telemetry id, and exports a covering guard', async () => {
    expect(await register(scope, { jobId: 'job_a', subjectHandle: handle })).toEqual({
      registered: 'created',
      guardGeneration: 1,
    });
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      subjectHandle: handle,
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: [jobTelemetryUserId('project-1', scope, 'job_a')],
    });
    expect(JSON.stringify(found[0]!.tokens)).not.toContain(handle);
    expect(await status()).toMatchObject({
      subjectSetGeneration: 1,
      covered: true,
      latest: { generation: 1 },
    });
  });

  it('is idempotent: registering the same job again writes, bumps and exports nothing', async () => {
    expect(await register(scope, { jobId: 'job_a', subjectHandle: handle })).toEqual({
      registered: 'exists',
      guardGeneration: null,
    });
    expect(await rows()).toHaveLength(1);
    expect(await status()).toMatchObject({
      subjectSetGeneration: 1,
      covered: true,
      latest: { generation: 1 },
    });
  });

  it('a second job for the same subject adds its token as the next generation; concurrent repeats stay single', async () => {
    // Three concurrent identical calls: each may race the others' guard export for the same generation.
    const results = await Promise.all(
      [1, 2, 3].map(() => register(scope, { jobId: 'job_b', subjectHandle: handle })),
    );
    expect(results.filter((r) => r.registered === 'created')).toHaveLength(1);
    const found = await rows();
    expect(found).toHaveLength(2);
    const latest = found.find((r) => r.tokenGeneration === 2)!;
    expect([...(latest.tokens as string[])].sort()).toEqual(
      [
        jobTelemetryUserId('project-1', scope, 'job_a'),
        jobTelemetryUserId('project-1', scope, 'job_b'),
      ].sort(),
    );
    expect(await status()).toMatchObject({ subjectSetGeneration: 2, covered: true });
  });
});
