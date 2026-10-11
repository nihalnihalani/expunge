/**
 * The real HTTP route of the domain service (createDomainService.handle) in front of a real replica set: the read token
 * gets a parseable snapshot, event page and list for a job the gateway actually ran; no token, a wrong token, another
 * principal's token and a wrong owner are refused; another scope's job is a 404; an unstable epoch is a 503.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProtocolError } from '@expunge/mongo';
import { HASH, describeLive } from '../../mongo/test/support.js';
import {
  snapshotSchema,
  jobListSchema,
  parseEventsPage,
} from '../../../apps/operator/src/server/expunge/schemas.js';
import { createDomainService, serviceConfigFromEnv, type DomainService } from '../src/index.js';
import { driveExpert, openRig, type Rig, type Seeded } from './rig.js';

const READ = 'r'.repeat(32);
const JOB = 'j'.repeat(32);
const APPROVAL = 'a'.repeat(32);

describeLive('read projection over the real HTTP route (local protocol lane, SCRIPTED DRIVER)', () => {
  let rig: Rig;
  let seeded: Seeded;
  let other: Seeded;
  let service: DomainService;
  let otherService: DomainService;
  let jobId: string;

  const configFor = (scope: Seeded) =>
    serviceConfigFromEnv({
      EXPUNGE_INTERNAL_TOKEN: READ,
      EXPUNGE_JOB_WRITE_TOKEN: JOB,
      EXPUNGE_APPROVAL_TOKEN: APPROVAL,
      OWNER_ID: 'owner',
      EXPUNGE_TENANT_ID: scope.binding.tenantId,
      EXPUNGE_ENV: scope.binding.env,
      EXPUNGE_SCOPE_ID: scope.binding.scopeId,
      EXPUNGE_WORKER_PROFILE_HASH: HASH,
    });
  const request = async (
    target: DomainService,
    path: string,
    headers: Record<string, string> = { authorization: `Bearer ${READ}`, 'x-expunge-owner-id': 'owner' },
  ) => {
    const response = await target.handle(
      new Request(`http://domain.test/internal/projection${path}`, { headers }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    rig = await openRig('projectionhttp');
    seeded = await rig.seed('direct_nested', 'http-a');
    other = await rig.seed('direct_nested', 'http-b');
    const run = await rig.open(seeded, 'expert');
    jobId = run.jobId;
    await driveExpert(run.tools);
    service = createDomainService({ env: rig.domain, config: configFor(seeded), wake: null });
    otherService = createDomainService({ env: rig.domain, config: configFor(other), wake: null });
  }, 120_000);
  afterAll(async () => {
    await rig?.dispose();
  });

  it('200 for the read token: a snapshot, an event page and the list, each parseable by the operator', async () => {
    const snapshotResponse = await request(service, `/jobs/${jobId}`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = snapshotSchema.parse(snapshotResponse.body);
    expect(snapshot).toMatchObject({ jobId, status: 'succeeded' });
    expect(snapshot.receipt).not.toBeNull();
    const pageResponse = await request(service, `/jobs/${jobId}/events?afterSequence=0&limit=5`);
    expect(pageResponse.status).toBe(200);
    const page = parseEventsPage(pageResponse.body, jobId, 0);
    expect(page.events).toHaveLength(5);
    expect(page.streamEpoch).toBe(snapshot.streamEpoch);
    const listResponse = await request(service, '/jobs');
    expect(listResponse.status).toBe(200);
    expect(jobListSchema.parse(listResponse.body).items.map((i) => i.jobId)).toEqual([jobId]);
  });

  it("401 without a token or with a wrong one, 403 for another principal's token or a wrong owner, on all three routes", async () => {
    for (const path of [`/jobs/${jobId}`, `/jobs/${jobId}/events?afterSequence=0`, '/jobs']) {
      expect(
        (await request(service, path, { 'x-expunge-owner-id': 'owner' })).status,
        `${path} no token`,
      ).toBe(401);
      expect(
        (
          await request(service, path, {
            authorization: `Bearer ${'x'.repeat(32)}`,
            'x-expunge-owner-id': 'owner',
          })
        ).status,
        `${path} wrong token`,
      ).toBe(401);
      expect(
        (await request(service, path, { authorization: `Bearer ${JOB}`, 'x-expunge-owner-id': 'owner' }))
          .status,
        `${path} job-write token`,
      ).toBe(403);
      expect(
        (await request(service, path, { authorization: `Bearer ${READ}` })).status,
        `${path} no owner`,
      ).toBe(403);
      expect(
        (
          await request(service, path, {
            authorization: `Bearer ${READ}`,
            'x-expunge-owner-id': 'someone-else',
          })
        ).status,
        `${path} wrong owner`,
      ).toBe(403);
    }
    // None of the refusals leaked a body that names the job.
    const refused = await request(service, `/jobs/${jobId}`, { 'x-expunge-owner-id': 'owner' });
    expect(JSON.stringify(refused.body)).not.toContain(jobId);
  });

  it("another scope's service sees 404 for the job on the snapshot and events routes and does not list it", async () => {
    expect((await request(otherService, `/jobs/${jobId}`)).status).toBe(404);
    expect((await request(otherService, `/jobs/${jobId}/events?afterSequence=0`)).status).toBe(404);
    const list = await request(otherService, '/jobs');
    expect(list.status).toBe(200);
    expect(jobListSchema.parse(list.body).items).toEqual([]);
  });

  it('refuses a scope or actor in the query string with 400, and an unstable epoch is a 503 with a closed code', async () => {
    expect((await request(service, '/jobs?scopeId=elsewhere')).status).toBe(400);
    expect((await request(service, `/jobs/${jobId}/events?afterSequence=0&tenantId=x`)).status).toBe(400);
    const unstable = createDomainService({
      env: {
        ...rig.domain,
        projections: Object.assign(
          Object.create(Object.getPrototypeOf(rig.domain.projections)),
          rig.domain.projections,
          {
            readPage: async () => {
              throw new ProtocolError('StreamEpochUnstable');
            },
          },
        ),
      },
      config: configFor(seeded),
      wake: null,
    });
    const refused = await request(unstable, `/jobs/${jobId}/events?afterSequence=0`);
    expect(refused).toEqual({ status: 503, body: { error: 'unavailable' } });
  });
});
