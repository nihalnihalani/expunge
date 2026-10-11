import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { describeExpungeConfig } from '../src/server/expunge/config.js';
import { HttpExpungeDomainService } from '../src/server/expunge/domain-service.js';
import type { Config } from '../src/server/research.js';
import {
  baseSnapshot,
  event,
  startedPayload,
} from './fixtures/expunge-data.js';
import { recordingTransport } from './fixtures/expunge-transport.js';

const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const ownerToken = 'test-owner-access-token-12345';
const headers = { Authorization: `Bearer ${ownerToken}` };
const READ = 'internal-read-token-unique-1234567890';
const JOB = 'internal-job-write-token-1234567890';
const APPROVAL = 'internal-approval-token-1234567890';
const env = {
  EXPUNGE_DOMAIN_URL: 'http://127.0.0.1:4320',
  EXPUNGE_INTERNAL_TOKEN: READ,
  EXPUNGE_JOB_WRITE_TOKEN: JOB,
  EXPUNGE_APPROVAL_TOKEN: APPROVAL,
};
function fixture(
  domain?: HttpExpungeDomainService,
  expungeEnv: Record<string, string | undefined> = {},
) {
  const store = new Store(':memory:');
  stores.push(store);
  return createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken,
    expungeDomain: domain,
    expungeConfig: describeExpungeConfig(expungeEnv),
  });
}
afterEach(() => stores.splice(0).forEach((store) => store.close()));

it('inherits owner/origin protection and does not turn an absent backend into fake jobs', async () => {
  const app = fixture();
  expect((await app.request('/api/expunge/status')).status).toBe(401);
  expect(
    (
      await app.request('/api/expunge/status', {
        headers: { ...headers, Origin: 'https://evil.invalid' },
      })
    ).status,
  ).toBe(403);
  expect(
    await (await app.request('/api/expunge/status', { headers })).json(),
  ).toEqual({
    // DA-7 RD3: derived from the actual configuration, not asserted.
    operator: 'setup_only',
    domain: 'unconfigured',
    authority: 'unconfigured',
    telemetry: 'disabled',
    ownerAuth: 'configured',
    build: null,
  });
  const missing = await app.request('/api/expunge/jobs/job-1', { headers });
  expect(missing.status).toBe(503);
  expect(await missing.json()).toMatchObject({
    code: 'unconfigured',
    missing: ['EXPUNGE_DOMAIN_URL', 'EXPUNGE_INTERNAL_TOKEN'],
  });
});

// DA-1 D16: this test drives the real route and the real domain service with a
// recording transport, so a forwarded query parameter or header would be seen.
it('forwards only the server-configured binding, whatever the browser sends', async () => {
  const { transport, calls } = recordingTransport((call) =>
    call.path.endsWith('/events')
      ? {
          events: [event('job-1', 4, 'job_started', startedPayload)],
          nextSequence: 4,
        }
      : baseSnapshot('job-1'),
  );
  const app = fixture(
    new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ, jobWriteToken: JOB, approvalToken: APPROVAL },
      'stored-owner',
      transport,
    ),
    env,
  );
  const hostile = {
    ...headers,
    'x-expunge-owner-id': 'forged-owner',
    'x-tenant-id': 'forged-tenant',
    'x-actor-id': 'forged-actor',
  };
  const forged =
    'tenantId=forged&role=promoter&actorId=x&scopeId=other&authorizationRevision=99';
  const job = await app.request(`/api/expunge/jobs/job-1?${forged}`, {
    headers: hostile,
  });
  expect(job.status).toBe(200);
  const page = await app.request(
    `/api/expunge/jobs/job-1/events?afterSequence=3&${forged}`,
    { headers: hostile },
  );
  expect(page.status).toBe(200);
  expect(calls).toHaveLength(2);
  expect(calls[0].path).toBe('/internal/projection/jobs/job-1');
  expect(calls[0].search).toBe('');
  expect(calls[1].path).toBe('/internal/projection/jobs/job-1/events');
  expect(calls[1].search).toBe('?afterSequence=3');
  for (const call of calls) {
    expect(call.headers.authorization).toBe(`Bearer ${READ}`);
    expect(call.headers['x-expunge-owner-id']).toBe('stored-owner');
    expect(call.headers['x-tenant-id']).toBeUndefined();
    expect(call.headers['x-actor-id']).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain('forged');
    expect(JSON.stringify(call)).not.toContain(ownerToken);
  }
});

it('negative control: a service that forwarded the query string would be caught by the same assertions', async () => {
  const { transport, calls } = recordingTransport(() => baseSnapshot('job-1'));
  // A deliberately wrong service copy used only to show the assertion can fail.
  class Leaky extends HttpExpungeDomainService {
    override async readJob(jobId: string, signal?: AbortSignal) {
      await transport(
        new URL(
          `/internal/projection/jobs/${jobId}?tenantId=forged`,
          'http://127.0.0.1:4320',
        ),
        { method: 'GET', signal },
      );
      return super.readJob(jobId, signal);
    }
  }
  const app = fixture(
    new Leaky(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ },
      'stored-owner',
      transport,
    ),
    env,
  );
  await app.request('/api/expunge/jobs/job-1', { headers });
  expect(calls.some((call) => call.search.includes('forged'))).toBe(true);
});

it('refuses job and sequence substitution from a misbehaving backend', async () => {
  let reply: unknown = baseSnapshot('job-other');
  const { transport } = recordingTransport(() => reply as object);
  const service = new HttpExpungeDomainService(
    env.EXPUNGE_DOMAIN_URL,
    { readToken: READ },
    'stored-owner',
    transport,
  );
  await expect(service.readJob('job-1')).rejects.toThrow(/bad_response/);
  reply = {
    events: [event('job-1', 2, 'job_started', startedPayload)],
    nextSequence: 2,
  };
  await expect(service.readCommittedEvents('job-1', 3)).rejects.toThrow(
    /rejected/,
  );
  await expect(service.readJob('../private')).rejects.toThrow();
});
