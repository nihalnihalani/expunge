import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { describeExpungeConfig } from '../src/server/expunge/config.js';
import { HttpExpungeDomainService } from '../src/server/expunge/domain-service.js';
import type { Config } from '../src/server/research.js';
import { hex, preview, world } from './fixtures/expunge-data.js';
import {
  recordingTransport,
  type RecordedCall,
} from './fixtures/expunge-transport.js';

const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const ownerToken = 'test-owner-access-token-12345';
const auth = { Authorization: `Bearer ${ownerToken}` };
const json = { ...auth, 'Content-Type': 'application/json' };
const READ = 'internal-read-token-unique-1234567890';
const JOB = 'internal-job-write-token-1234567890';
const APPROVAL = 'internal-approval-token-1234567890';
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function build(
  handler: (call: RecordedCall) => Response | object | undefined,
  principals: { job?: boolean; approval?: boolean } = {
    job: true,
    approval: true,
  },
) {
  const { transport, calls } = recordingTransport(handler);
  const store = new Store(':memory:');
  stores.push(store);
  const env = {
    EXPUNGE_DOMAIN_URL: 'http://127.0.0.1:4320',
    EXPUNGE_INTERNAL_TOKEN: READ,
    ...(principals.job ? { EXPUNGE_JOB_WRITE_TOKEN: JOB } : {}),
    ...(principals.approval ? { EXPUNGE_APPROVAL_TOKEN: APPROVAL } : {}),
  };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken,
    expungeDomain: new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      {
        readToken: READ,
        jobWriteToken: principals.job ? JOB : undefined,
        approvalToken: principals.approval ? APPROVAL : undefined,
      },
      'stored-owner',
      transport,
    ),
    expungeConfig: describeExpungeConfig(env),
  });
  return { app, calls };
}
const post = (body: unknown) => ({
  method: 'POST',
  headers: json,
  body: JSON.stringify(body),
});
const validSubmit = {
  requestKey: 'req-0123456789',
  worldId: 'world-northwind',
  previewId: 'preview-1',
  subject: { idType: 'objectId', value: '64b7f3a0c1d2e3f4a5b6c7d8' },
};

it('rejects forged tenant, actor, role and revision fields without any upstream call', async () => {
  const { app, calls } = build(() => ({}));
  for (const extra of [
    { tenantId: 'forged' },
    { actorId: 'forged' },
    { role: 'promoter' },
    { authorizationRevision: 99 },
    { env: 'dev' },
  ]) {
    expect(
      (
        await app.request(
          '/api/expunge/jobs',
          post({ ...validSubmit, ...extra }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/expunge/previews',
          post({
            worldId: 'world-northwind',
            subject: validSubmit.subject,
            ...extra,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          '/api/expunge/proposals/proposal-1/decision',
          post({ decision: 'approve', descriptorDigest: hex('d'), ...extra }),
        )
      ).status,
    ).toBe(400);
  }
  expect(calls).toHaveLength(0);
});

it('submits only validated fields with the job-write principal and returns the committed reply', async () => {
  const { app, calls } = build((call) =>
    call.method === 'POST' ? { jobId: 'job-new', status: 'queued' } : undefined,
  );
  const response = await app.request('/api/expunge/jobs', post(validSubmit));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ jobId: 'job-new', status: 'queued' });
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe('/internal/projection/jobs');
  expect(calls[0].headers.authorization).toBe(`Bearer ${JOB}`);
  expect(calls[0].headers.authorization).not.toContain(READ);
  expect(calls[0].body).toEqual(validSubmit);
});

const descriptor = (patch: Record<string, unknown> = {}) => ({
  proposalId: 'proposal-1',
  grantId: 'grant-1',
  state: 'pending',
  target: 'worker',
  parentHash: hex('a'),
  childHash: hex('b'),
  expectedParentRevision: 3,
  computedClass: 'tightening',
  flipSet: [],
  flipSetDigest: hex('f'),
  scope: { scopeId: 'scope-1', scopeRevision: 4, authorizationRevision: 2 },
  gateReportId: 'gate-1',
  gateReportDigest: hex('g'),
  approver: { actorId: 'stored-owner', display: 'Owner' },
  expiresAt: '2026-10-11T12:00:00.000Z',
  consequences: [],
  descriptorDigest: hex('d'),
  ...patch,
});

it('uses the approval principal for decisions, names the grant and approver itself, and re-reads committed state', async () => {
  const { app, calls } = build((call) =>
    call.method === 'GET'
      ? descriptor()
      : { accepted: true, state: 'approved', committedEventSequence: 12 },
  );
  const response = await app.request(
    '/api/expunge/proposals/proposal-1/decision',
    post({
      decision: 'approve',
      descriptorDigest: hex('d'),
      toolCallId: 'call-1',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    accepted: true,
    state: 'approved',
    committedEventSequence: 12,
  });
  // The stored descriptor is read first, with the read principal, to learn the grant.
  expect(calls[0].method).toBe('GET');
  expect(calls[0].headers.authorization).toBe(`Bearer ${READ}`);
  expect(calls[1].headers.authorization).toBe(`Bearer ${APPROVAL}`);
  // DA-7 K1: the forward carries the approver identity and the grant, taken from the server.
  expect(calls[1].body).toEqual({
    decision: 'approve',
    descriptorDigest: hex('d'),
    toolCallId: 'call-1',
    grantId: 'grant-1',
    approverId: 'stored-owner',
  });
});

it('DA-7 K1: refuses an approval that cannot name a pending grant or that does not match the stored digest, without forwarding it', async () => {
  for (const stored of [
    descriptor({ grantId: null }),
    descriptor({ state: 'consumed' }),
    descriptor({ state: 'expired' }),
  ]) {
    const { app, calls } = build((call) =>
      call.method === 'GET' ? stored : { accepted: true },
    );
    const response = await app.request(
      '/api/expunge/proposals/proposal-1/decision',
      post({ decision: 'approve', descriptorDigest: hex('d') }),
    );
    expect(response.status).toBe(409);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  }
  const mismatch = build((call) =>
    call.method === 'GET' ? descriptor() : { accepted: true },
  );
  const stale = await mismatch.app.request(
    '/api/expunge/proposals/proposal-1/decision',
    post({ decision: 'approve', descriptorDigest: hex('e') }),
  );
  expect(stale.status).toBe(409);
  expect(mismatch.calls.every((call) => call.method === 'GET')).toBe(true);
  const none = build(() => undefined);
  const missing = await none.app.request(
    '/api/expunge/proposals/proposal-1/decision',
    post({ decision: 'approve', descriptorDigest: hex('d') }),
  );
  expect(missing.status).toBe(404);
});

it('names the missing write principal instead of silently using another credential', async () => {
  const { app, calls } = build(() => ({}), { job: false, approval: false });
  const submit = await app.request('/api/expunge/jobs', post(validSubmit));
  expect(submit.status).toBe(503);
  expect(await submit.json()).toMatchObject({
    code: 'write_principal_missing',
    missing: ['EXPUNGE_JOB_WRITE_TOKEN'],
  });
  const decision = await app.request(
    '/api/expunge/proposals/proposal-1/decision',
    post({ decision: 'decline', descriptorDigest: hex('d') }),
  );
  expect(await decision.json()).toMatchObject({
    missing: ['EXPUNGE_APPROVAL_TOKEN'],
  });
  expect(calls).toHaveLength(0);
});

it('maps upstream failures to a closed set without reflecting bodies or credentials', async () => {
  const cases: Array<[number, number, string]> = [
    [401, 502, 'unauthorized'],
    [403, 502, 'forbidden'],
    [409, 409, 'conflict'],
    [501, 501, 'unsupported'],
    [503, 502, 'upstream_error'],
  ];
  for (const [upstream, status, code] of cases) {
    const { app } = build(
      () => new Response(`secret ${READ} detail`, { status: upstream }),
    );
    const response = await app.request('/api/expunge/worlds', {
      headers: auth,
    });
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe(code);
    expect(text).not.toContain('secret');
    expect(text).not.toContain(READ);
  }
  const { app } = build(() => new Response('{}', { status: 404 }));
  expect(
    (await app.request('/api/expunge/jobs/missing-1', { headers: auth }))
      .status,
  ).toBe(404);
});

it('serves worlds and previews through the schemas and labels the preview basis', async () => {
  const { app } = build((call) =>
    call.method === 'POST' ? preview : { worlds: [world] },
  );
  const worlds = await (
    await app.request('/api/expunge/worlds', { headers: auth })
  ).json();
  expect(worlds.worlds[0].worldId).toBe('world-northwind');
  const body = await (
    await app.request(
      '/api/expunge/previews',
      post({ worldId: 'world-northwind', subject: validSubmit.subject }),
    )
  ).json();
  expect(body.basis).toBe('expert_static_discovery');
});

it('validates identifiers, cursors and enumerations before any upstream call', async () => {
  const { app, calls } = build(() => ({}));
  for (const path of [
    '/api/expunge/jobs/bad%20id',
    '/api/expunge/jobs/job-1/events?afterSequence=-1',
    '/api/expunge/jobs/job-1/events?afterSequence=1&limit=9999',
    '/api/expunge/jobs?kind=nope',
    '/api/expunge/jobs?status=nope',
    '/api/expunge/jobs?limit=abc',
    '/api/expunge/artifacts/bad%20id',
    '/api/expunge/deployments/nope',
  ])
    expect((await app.request(path, { headers: auth })).status).toBe(400);
  expect(calls).toHaveLength(0);
});

it('requires application/json for mutations (inherited boundary)', async () => {
  const { app } = build(() => ({}));
  const response = await app.request('/api/expunge/jobs', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body: JSON.stringify(validSubmit),
  });
  expect(response.status).toBe(415);
});
