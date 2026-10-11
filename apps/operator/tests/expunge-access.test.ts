import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { readBuildId } from '../src/server/expunge/build-id.js';
import {
  applyTelemetryDefault,
  describeExpungeConfig,
} from '../src/server/expunge/config.js';
import { HttpExpungeDomainService } from '../src/server/expunge/domain-service.js';
import { ReadinessCache } from '../src/server/expunge/readiness.js';
import type { Config } from '../src/server/research.js';
import { sourceBuildId } from '../scripts/build-id.mjs';
import { hex } from './fixtures/expunge-data.js';
import { recordingTransport } from './fixtures/expunge-transport.js';

const stores: Store[] = [];
const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const READ = 'internal-read-token-unique-1234567890';
const JOB = 'internal-job-write-token-1234567890';
const APPROVAL = 'internal-approval-token-1234567890';
const env = {
  EXPUNGE_DOMAIN_URL: 'http://127.0.0.1:4320',
  EXPUNGE_INTERNAL_TOKEN: READ,
  EXPUNGE_JOB_WRITE_TOKEN: JOB,
  EXPUNGE_APPROVAL_TOKEN: APPROVAL,
};
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function app(options: { ownerToken?: string; build?: string | null } = {}) {
  const { transport, calls } = recordingTransport(() => ({}));
  const store = new Store(':memory:');
  stores.push(store);
  const instance = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: options.ownerToken,
    expungeDomain: new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ, jobWriteToken: JOB, approvalToken: APPROVAL },
      'stored-owner',
      transport,
    ),
    expungeConfig: describeExpungeConfig({
      ...env,
      ...(options.ownerToken ? { OWNER_TOKEN: options.ownerToken } : {}),
    }),
    expungeBuild: options.build ?? null,
  });
  return { instance, calls };
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

it('DA-7 K1 (NT-K1): on loopback with no owner token, every mutating route is refused with no domain call', async () => {
  const { instance, calls } = app();
  const attempts: Array<[string, unknown]> = [
    [
      '/api/expunge/proposals/p1/decision',
      { decision: 'approve', descriptorDigest: hex('d') },
    ],
    [
      '/api/expunge/jobs',
      {
        requestKey: 'req-0123456789',
        worldId: 'world-northwind',
        previewId: 'preview-1',
        subject: { idType: 'objectId', value: '64b7f3a0c1d2e3f4a5b6c7d8' },
      },
    ],
    ['/api/expunge/jobs/job-1/cancel', {}],
    [
      '/api/expunge/previews',
      {
        worldId: 'world-northwind',
        subject: { idType: 'objectId', value: '64b7f3a0c1d2e3f4a5b6c7d8' },
      },
    ],
  ];
  for (const [path, body] of attempts) {
    const response = await instance.request(path, post(body));
    expect(response.status, path).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'owner_auth_required',
      missing: ['OWNER_TOKEN'],
    });
  }
  expect(calls).toHaveLength(0);
});

it('DA-7 K1: unauthenticated loopback reads readiness and status only, not job data', async () => {
  const { instance, calls } = app();
  for (const path of [
    '/api/expunge/jobs',
    '/api/expunge/jobs/job-1',
    '/api/expunge/jobs/job-1/events',
    '/api/expunge/artifacts/a1',
    '/api/expunge/proposals/p1',
    '/api/expunge/deployments/worker',
    '/api/expunge/worlds',
  ]) {
    const response = await instance.request(path);
    expect(response.status, path).toBe(401);
  }
  expect(calls).toHaveLength(0);
  const status = await instance.request('/api/expunge/status');
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ ownerAuth: 'missing' });
  // DA-7 RD1: the uncached probe needs the owner token.
  expect(
    (await instance.request('/api/expunge/readiness?fresh=1')).status,
  ).toBe(401);
  const readiness = await instance.request('/api/expunge/readiness');
  expect(readiness.status).toBe(200);
  const body = await readiness.json();
  // Writes show as blocked, and name what is missing.
  expect(body.writes).toMatchObject({
    submit: false,
    cancel: false,
    approve: false,
  });
  expect(body.writes.missing).toContain('OWNER_TOKEN');
});

it('DA-7 K1: with an owner token configured, a request without it is refused by the boundary and one with it is served', async () => {
  const token = 'test-owner-access-token-12345';
  const { instance, calls } = app({ ownerToken: token });
  const refused = await instance.request(
    '/api/expunge/jobs/job-1/cancel',
    post({}),
  );
  expect(refused.status).toBe(401);
  expect(calls).toHaveLength(0);
  const served = await instance.request(
    '/api/expunge/jobs/job-1/cancel',
    post({}, { Authorization: `Bearer ${token}` }),
  );
  expect(served.status).not.toBe(401);
  expect(calls.length).toBeGreaterThan(0);
  const readiness = await (
    await instance.request('/api/expunge/readiness', {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  expect(readiness.writes).toMatchObject({
    submit: true,
    cancel: true,
    approve: true,
    missing: [],
  });
});

it('DA-7 T1: the default is applied in process, and the server entry imports it first', () => {
  const plain: Record<string, string | undefined> = {};
  applyTelemetryDefault(plain);
  expect(plain.DO_NOT_TRACK).toBe('1');
  for (const value of ['', '0', 'true']) {
    const other: Record<string, string | undefined> = {
      EXPUNGE_ALLOW_TELEMETRY: value,
    };
    applyTelemetryDefault(other);
    expect(other.DO_NOT_TRACK).toBe('1');
  }
  const optedIn: Record<string, string | undefined> = {
    EXPUNGE_ALLOW_TELEMETRY: '1',
  };
  applyTelemetryDefault(optedIn);
  expect(optedIn.DO_NOT_TRACK).toBeUndefined();
  const entry = readFileSync(
    new URL('../src/server/index.ts', import.meta.url),
    'utf8',
  );
  expect(entry.split('\n')[0]).toBe("import './expunge/telemetry-default.js';");
});

it('DA-7 RD3 (NT-RD3): status is derived from the configuration, not asserted', async () => {
  const unconfigured = createApp({
    store: (() => {
      const store = new Store(':memory:');
      stores.push(store);
      return store;
    })(),
    runner: new Runner(stores[stores.length - 1], config),
    config,
    expungeConfig: describeExpungeConfig({}),
  });
  expect(
    await (await unconfigured.request('/api/expunge/status')).json(),
  ).toMatchObject({
    operator: 'setup_only',
    domain: 'unconfigured',
    authority: 'unconfigured',
  });
  const { instance } = app({ build: 'a'.repeat(64) });
  const configured = await (
    await instance.request('/api/expunge/status')
  ).json();
  expect(configured).toMatchObject({
    operator: 'ready',
    domain: 'configured',
    authority: 'mongodb',
    build: 'a'.repeat(64),
  });
});

it('DA-7 RD2 (NT-RD2): cleartext http to a remote domain host is malformed; loopback http and https are fine', () => {
  const view = (url: string) =>
    describeExpungeConfig({ ...env, EXPUNGE_DOMAIN_URL: url }).configured;
  expect(view('http://domain.example')).toMatchObject({
    status: 'fail',
    reason: 'env_malformed',
    missing: ['EXPUNGE_DOMAIN_URL'],
  });
  expect(view('http://10.0.0.5:4320').status).toBe('fail');
  expect(view('https://domain.example').status).toBe('pass');
  expect(view('http://127.0.0.1:4320').status).toBe('pass');
  expect(view('http://localhost:4320').status).toBe('pass');
  expect(view('http://[::1]:4320').status).toBe('pass');
});

it('DA-7 RD1 (NT-RD1): one viewer aborting does not fail the readiness every other viewer sees', async () => {
  // A domain that answers in 50 ms and honors an abort signal.
  const transport: typeof fetch = (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            new Response(
              JSON.stringify({
                backend: { kind: 'live', version: '1' },
                scope: { bound: true },
                evidence: {
                  configured: true,
                  writeProvenAt: new Date().toISOString(),
                  readBackProvenAt: new Date().toISOString(),
                  deadLetters: 0,
                },
              }),
              { headers: { 'Content-Type': 'application/json' } },
            ),
          ),
        50,
      );
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  const cache = new ReadinessCache(
    describeExpungeConfig(env),
    new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ },
      'owner',
      transport,
    ),
  );
  const a = new AbortController();
  const first = cache.get(false, a.signal);
  setTimeout(() => a.abort(), 10);
  const b = new AbortController();
  const second = await cache.get(false, b.signal);
  await first.catch(() => undefined);
  expect(second.reachable.status).toBe('pass');
  expect(second.authorized.status).toBe('pass');
});

it('DA-7 E1: the build id is a hash of the source a build is made from, and the server reads what the build wrote', () => {
  const root = mkdtempSync(join(tmpdir(), 'expunge-build-id-'));
  mkdirSync(join(root, 'src', 'client'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'src', 'client', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'index.html'), '<html></html>\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  const first = sourceBuildId(root);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(sourceBuildId(root)).toBe(first);
  // Tests and docs are not part of a build.
  writeFileSync(join(root, 'tests', 'x.test.ts'), 'it();\n');
  expect(sourceBuildId(root)).toBe(first);
  // Any source change is.
  writeFileSync(join(root, 'src', 'client', 'a.ts'), 'export const a = 2;\n');
  const changed = sourceBuildId(root);
  expect(changed).not.toBe(first);
  writeFileSync(join(root, 'src', 'client', 'b.ts'), 'export {};\n');
  expect(sourceBuildId(root)).not.toBe(changed);
  // What the build wrote is what the server reports; garbage reads as unbuilt.
  const file = join(root, 'build-id.json');
  writeFileSync(file, JSON.stringify({ buildId: changed }));
  expect(readBuildId(file)).toBe(changed);
  writeFileSync(file, '{"buildId":"short"}');
  expect(readBuildId(file)).toBeNull();
  writeFileSync(file, 'not json');
  expect(readBuildId(file)).toBeNull();
  expect(readBuildId(join(root, 'missing.json'))).toBeNull();
});
