import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { describeExpungeConfig } from '../src/server/expunge/config.js';
import { HttpExpungeDomainService } from '../src/server/expunge/domain-service.js';
import type { Config } from '../src/server/research.js';
import {
  FIXTURE_TOKENS,
  startFixture,
  type RunningFixture,
} from './fixtures/expunge-domain-fixture.js';

// Real HTTP between the operator routes and the labeled fixture backend. FIXTURE data only.
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const auth = { Authorization: 'Bearer test-owner-access-token-12345' };
const json = { ...auth, 'Content-Type': 'application/json' };
let fixture: RunningFixture;
let store: Store;
beforeEach(async () => {
  fixture = await startFixture(0, undefined, { scenarios: false });
  store = new Store(':memory:');
});
afterEach(async () => {
  await fixture.close();
  store.close();
});
const operator = (tokens = FIXTURE_TOKENS) => {
  const env = {
    EXPUNGE_DOMAIN_URL: fixture.url,
    EXPUNGE_INTERNAL_TOKEN: tokens.read,
    EXPUNGE_JOB_WRITE_TOKEN: tokens.jobWrite,
    EXPUNGE_APPROVAL_TOKEN: tokens.approval,
  };
  return createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: 'test-owner-access-token-12345',
    expungeDomain: new HttpExpungeDomainService(
      fixture.url,
      {
        readToken: tokens.read,
        jobWriteToken: tokens.jobWrite,
        approvalToken: tokens.approval,
      },
      'fixture-owner',
    ),
    expungeConfig: describeExpungeConfig(env),
  });
};
const readiness = async (app: ReturnType<typeof operator>) =>
  (await (
    await app.request('/api/expunge/readiness?fresh=1', { headers: auth })
  ).json()) as Record<string, { status: string; reason: string | null }> & {
    ready: boolean;
    backend: { kind: string };
  };

it('reports all four checks passing against a healthy fixture, labeled as a fixture', async () => {
  const body = await readiness(operator());
  expect(body.ready).toBe(true);
  expect(body.backend.kind).toBe('fixture');
  for (const key of ['configured', 'reachable', 'authorized', 'evidenceReady'])
    expect(body[key].status).toBe('pass');
});

it('separates failures by mode: down, unauthorized, unbound, evidence never proven, dead letters', async () => {
  const cases: Array<[string, string, string, string]> = [
    ['down', 'reachable', 'fail', 'http_5xx'],
    ['unauthorized', 'authorized', 'fail', 'unauthorized'],
    ['forbidden', 'authorized', 'fail', 'forbidden'],
    ['unbound', 'authorized', 'fail', 'scope_unbound'],
    ['evidence_never', 'evidenceReady', 'fail', 'evidence_never_proven'],
    ['evidence_dead_letter', 'evidenceReady', 'fail', 'evidence_dead_letter'],
  ];
  for (const [mode, check, status, reason] of cases) {
    fixture.state.mode = mode as never;
    const body = await readiness(operator());
    expect(body[check], mode).toMatchObject({ status, reason });
    expect(body.ready).toBe(false);
  }
});

it('rejects a wrong read token as unauthorized while staying reachable', async () => {
  const body = await readiness(
    operator({ ...FIXTURE_TOKENS, read: 'wrong-read-token-0123456789abcdef' }),
  );
  expect(body.reachable.status).toBe('pass');
  expect(body.authorized).toMatchObject({
    status: 'fail',
    reason: 'unauthorized',
  });
});

it('submits idempotently by requestKey and never starts a second job', async () => {
  const app = operator();
  const body = {
    requestKey: 'req-0123456789',
    worldId: 'world-northwind',
    previewId: 'preview-1',
    subject: { idType: 'objectId', value: '64b7f3a0c1d2e3f4a5b6c7d8' },
  };
  const first = await (
    await app.request('/api/expunge/jobs', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    })
  ).json();
  const second = await (
    await app.request('/api/expunge/jobs', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    })
  ).json();
  expect(first.jobId).toBe(second.jobId);
  expect(fixture.state.jobs.size).toBe(1);
  const snapshot = await (
    await app.request(`/api/expunge/jobs/${first.jobId}`, { headers: auth })
  ).json();
  expect(snapshot.status).toBe('queued');
  const events = await (
    await app.request(
      `/api/expunge/jobs/${first.jobId}/events?afterSequence=0`,
      { headers: auth },
    )
  ).json();
  expect(events.events[0].kind).toBe('job_started');
  expect(events.nextSequence).toBe(1);
});

it('previews with a masked subject and the expert-static basis, and never echoes the literal', async () => {
  const response = await operator().request('/api/expunge/previews', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      worldId: 'world-northwind',
      subject: { idType: 'string', value: 'jane.doe@example.invalid' },
    }),
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(JSON.parse(text).basis).toBe('expert_static_discovery');
  expect(text).not.toContain('jane.doe@example.invalid');
});

it('uses the write principals only on writes and the read principal only on reads', async () => {
  const app = operator();
  await app.request('/api/expunge/worlds', { headers: auth });
  await app.request('/api/expunge/previews', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      worldId: 'world-northwind',
      subject: { idType: 'string', value: 'abcdef' },
    }),
  });
  const log = fixture.state.log.filter((entry) =>
    entry.path.startsWith('/internal'),
  );
  expect(log.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
    'GET /internal/projection/worlds',
    'POST /internal/projection/previews',
  ]);
  // A read token cannot satisfy a write route on the fixture, and vice versa.
  const wrong = operator({ ...FIXTURE_TOKENS, jobWrite: FIXTURE_TOKENS.read });
  const response = await wrong.request('/api/expunge/previews', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      worldId: 'world-northwind',
      subject: { idType: 'string', value: 'abcdef' },
    }),
  });
  expect(response.status).toBe(502);
});

it('answers 404 for an unknown job and keeps projection regress detectable after a simulated restore', async () => {
  const app = operator();
  expect(
    (await app.request('/api/expunge/jobs/nope', { headers: auth })).status,
  ).toBe(404);
  const created = await (
    await app.request('/api/expunge/jobs', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        requestKey: 'req-abcdefghij',
        worldId: 'world-northwind',
        previewId: 'p',
        subject: { idType: 'int', value: '42' },
      }),
    })
  ).json();
  const job = fixture.state.jobs.get(created.jobId)!;
  job.events.push(
    {
      ...job.events[0],
      eventId: 'e2',
      sequence: 2,
      kind: 'job_status_changed',
      payload: { from: 'queued', to: 'running', reason: 'claimed' },
    } as never,
    {
      ...job.events[0],
      eventId: 'e3',
      sequence: 3,
      kind: 'job_status_changed',
      payload: { from: 'running', to: 'waiting_evidence', reason: 'wait' },
    } as never,
  );
  job.snapshot.sequence = 3;
  const before = await (
    await app.request(`/api/expunge/jobs/${created.jobId}`, { headers: auth })
  ).json();
  expect(before.sequence).toBe(3);
  await fetch(`${fixture.url}/__fixture/restart`, { method: 'POST' });
  const after = await (
    await app.request(`/api/expunge/jobs/${created.jobId}`, { headers: auth })
  ).json();
  expect(after.sequence).toBeLessThan(before.sequence);
});
