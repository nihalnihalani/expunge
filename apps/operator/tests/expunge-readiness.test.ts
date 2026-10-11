import { expect, it } from 'vitest';
import { describeExpungeConfig } from '../src/server/expunge/config.js';
import { HttpExpungeDomainService } from '../src/server/expunge/domain-service.js';
import {
  ReadinessCache,
  computeReadiness,
} from '../src/server/expunge/readiness.js';
import { recordingTransport } from './fixtures/expunge-transport.js';

const READ = 'internal-read-token-unique-1234567890';
const env = {
  EXPUNGE_DOMAIN_URL: 'http://127.0.0.1:4320',
  EXPUNGE_INTERNAL_TOKEN: READ,
};
const now = new Date('2026-10-11T09:00:00.000Z');
const clock = () => now;
const body = (patch: object = {}) => ({
  backend: { kind: 'live', version: '1.0.0' },
  scope: { bound: true },
  evidence: {
    configured: true,
    writeProvenAt: '2026-10-11T08:50:00.000Z',
    readBackProvenAt: '2026-10-11T08:55:00.000Z',
    deadLetters: 0,
  },
  ...patch,
});
const service = (handler: Parameters<typeof recordingTransport>[0]) => {
  const { transport, calls } = recordingTransport(handler);
  return {
    calls,
    service: new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ },
      'owner',
      transport,
    ),
  };
};
const run = (
  handler: Parameters<typeof recordingTransport>[0],
  e: Record<string, string | undefined> = env,
) => {
  const { service: domain, calls } = service(handler);
  return computeReadiness(
    describeExpungeConfig(e),
    domain,
    undefined,
    clock,
  ).then((result) => ({ result, calls }));
};

it('lists missing configuration names, never values, and does not touch the network', async () => {
  const { result, calls } = await run(() => body(), {});
  expect(result.configured).toMatchObject({
    status: 'fail',
    reason: 'env_missing',
    missing: ['EXPUNGE_DOMAIN_URL', 'EXPUNGE_INTERNAL_TOKEN'],
  });
  expect(result.reachable.status).toBe('unknown');
  expect(result.authorized.status).toBe('unknown');
  expect(result.evidenceReady.status).toBe('unknown');
  expect(result.ready).toBe(false);
  expect(result.backend.kind).toBe('none');
  expect(calls).toHaveLength(0);
});

it('flags a malformed token without printing it', async () => {
  const { result } = await run(() => body(), {
    EXPUNGE_DOMAIN_URL: 'http://127.0.0.1:4320',
    EXPUNGE_INTERNAL_TOKEN: 'short',
  });
  expect(result.configured.reason).toBe('env_malformed');
  expect(JSON.stringify(result)).not.toContain('short');
});

it('keeps configured, reachable, authorized and evidence-ready distinct', async () => {
  // configured passes, reachable fails
  const refused = await computeReadiness(
    describeExpungeConfig(env),
    new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ },
      'o',
      async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        });
      },
    ),
    undefined,
    clock,
  );
  expect(refused.configured.status).toBe('pass');
  expect(refused.reachable).toMatchObject({
    status: 'fail',
    reason: 'connect_refused',
  });
  expect(refused.authorized.status).toBe('unknown');

  // reachable passes, authorized fails (401 and 403)
  for (const [status, reason] of [
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ] as const) {
    const { result } = await run(() => new Response('x', { status }));
    expect(result.reachable.status).toBe('pass');
    expect(result.authorized).toMatchObject({ status: 'fail', reason });
    expect(result.evidenceReady.status).toBe('unknown');
    expect(result.ready).toBe(false);
  }

  // authorized passes, evidence fails
  const never = await run(() =>
    body({
      evidence: {
        configured: true,
        writeProvenAt: null,
        readBackProvenAt: null,
        deadLetters: 0,
      },
    }),
  );
  expect(never.result.authorized.status).toBe('pass');
  expect(never.result.evidenceReady).toMatchObject({
    status: 'fail',
    reason: 'evidence_never_proven',
  });
  expect(never.result.ready).toBe(false);
});

it('maps timeouts, TLS and server errors to their own reasons', async () => {
  const reasons = async (thrown: unknown, status?: number) => {
    const domain = new HttpExpungeDomainService(
      env.EXPUNGE_DOMAIN_URL,
      { readToken: READ },
      'o',
      async () => {
        if (status) return new Response('x', { status });
        throw thrown;
      },
    );
    return (
      await computeReadiness(
        describeExpungeConfig(env),
        domain,
        undefined,
        clock,
      )
    ).reachable.reason;
  };
  expect(
    await reasons(Object.assign(new Error('t'), { name: 'TimeoutError' })),
  ).toBe('timeout');
  expect(
    await reasons(
      Object.assign(new TypeError('x'), {
        cause: { code: 'CERT_HAS_EXPIRED' },
      }),
    ),
  ).toBe('tls_error');
  expect(await reasons(undefined, 500)).toBe('http_5xx');
});

it('reports scope_unbound, dead letters, unconfigured and stale evidence', async () => {
  expect(
    (await run(() => body({ scope: { bound: false } }))).result.authorized,
  ).toMatchObject({ status: 'fail', reason: 'scope_unbound' });
  expect(
    (
      await run(() =>
        body({
          evidence: {
            configured: true,
            writeProvenAt: 'x'.length ? '2026-10-11T08:50:00.000Z' : null,
            readBackProvenAt: '2026-10-11T08:55:00.000Z',
            deadLetters: 2,
          },
        }),
      )
    ).result.evidenceReady.reason,
  ).toBe('evidence_dead_letter');
  expect(
    (
      await run(() =>
        body({
          evidence: {
            configured: false,
            writeProvenAt: null,
            readBackProvenAt: null,
            deadLetters: 0,
          },
        }),
      )
    ).result.evidenceReady.reason,
  ).toBe('evidence_unconfigured');
  expect(
    (
      await run(() =>
        body({
          evidence: {
            configured: true,
            writeProvenAt: '2026-10-11T05:00:00.000Z',
            readBackProvenAt: '2026-10-11T05:00:00.000Z',
            deadLetters: 0,
          },
        }),
      )
    ).result.evidenceReady.reason,
  ).toBe('evidence_stale');
});

it('is ready only when all four checks pass, and carries the fixture label', async () => {
  const { result } = await run(() =>
    body({ backend: { kind: 'fixture', version: 'fx' } }),
  );
  expect(result.ready).toBe(true);
  expect(result.backend.kind).toBe('fixture');
  expect(result.writes).toMatchObject({ submit: false, approve: false });
  // DA-7 K1: the owner token on the operator is part of what a write needs, so it is named too.
  expect(result.writes.missing).toEqual([
    'OWNER_TOKEN',
    'EXPUNGE_JOB_WRITE_TOKEN',
    'EXPUNGE_APPROVAL_TOKEN',
  ]);
});

it('does not reflect upstream bodies and caches for five seconds', async () => {
  const { service: domain, calls } = service(
    () => new Response(`leak ${READ}`, { status: 500 }),
  );
  let clockMs = 0;
  const cache = new ReadinessCache(
    describeExpungeConfig(env),
    domain,
    5000,
    () => clockMs,
  );
  const first = await cache.get();
  expect(JSON.stringify(first)).not.toContain('leak');
  expect(JSON.stringify(first)).not.toContain(READ);
  await cache.get();
  expect(calls).toHaveLength(1);
  clockMs = 6000;
  await cache.get();
  expect(calls).toHaveLength(2);
  await cache.get(true);
  expect(calls).toHaveLength(3);
});
