import { describe, expect, it } from 'vitest';
import type { DomainEnv } from '../src/index.js';
import {
  ServiceConfigError,
  createDomainService,
  serviceConfigFromEnv,
  type ServiceConfig,
} from '../src/index.js';

const READ = 'r'.repeat(32);
const JOB = 'j'.repeat(32);
const APPROVAL = 'a'.repeat(32);
const WAKE = 'w'.repeat(32);
const baseEnv = {
  EXPUNGE_INTERNAL_TOKEN: READ,
  EXPUNGE_JOB_WRITE_TOKEN: JOB,
  EXPUNGE_APPROVAL_TOKEN: APPROVAL,
  EXPUNGE_WAKE_TOKEN: WAKE,
  OWNER_ID: 'owner-1',
  EXPUNGE_TENANT_ID: 'tenant-1',
  EXPUNGE_ENV: 'demo',
  EXPUNGE_SCOPE_ID: 'scope-1',
};

describe('service configuration binds the principals', () => {
  it('reads the owner and scope from configuration and keeps the four tokens apart', () => {
    const config = serviceConfigFromEnv({ ...baseEnv, EXPUNGE_WORKER_URL: 'http://127.0.0.1:4330' });
    expect(config.owner).toEqual({
      ownerId: 'owner-1',
      scope: { tenantId: 'tenant-1', env: 'demo', scopeId: 'scope-1' },
    });
    expect(config.tokens).toEqual({ read: READ, job_write: JOB, approval: APPROVAL });
    // The wake credential is outbound only: it is not one of the inbound tokens.
    expect(Object.values(config.tokens)).not.toContain(WAKE);
    expect(config.wake).toEqual({ origin: 'http://127.0.0.1:4330', token: WAKE });
  });

  it('refuses a short token, a repeated token, a missing owner or scope, and reports names only', () => {
    const problems = (overrides: Record<string, string | undefined>) => {
      try {
        serviceConfigFromEnv({ ...baseEnv, ...overrides });
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceConfigError);
        const text = (error as ServiceConfigError).problems.join(' ');
        for (const secret of [READ, JOB, APPROVAL, WAKE]) expect(text).not.toContain(secret);
        return (error as ServiceConfigError).problems;
      }
      return [];
    };
    expect(problems({ EXPUNGE_INTERNAL_TOKEN: 'short' })).toContain('EXPUNGE_INTERNAL_TOKEN:too_short');
    expect(problems({ EXPUNGE_INTERNAL_TOKEN: undefined })).toContain('EXPUNGE_INTERNAL_TOKEN:missing');
    expect(problems({ EXPUNGE_JOB_WRITE_TOKEN: READ })).toContain(
      'EXPUNGE_INTERNAL_TOKEN=EXPUNGE_JOB_WRITE_TOKEN:tokens_must_differ',
    );
    expect(problems({ EXPUNGE_WAKE_TOKEN: APPROVAL })).toContain(
      'EXPUNGE_APPROVAL_TOKEN=EXPUNGE_WAKE_TOKEN:tokens_must_differ',
    );
    expect(problems({ OWNER_ID: undefined })).toContain('OWNER_ID:missing');
    expect(problems({ EXPUNGE_SCOPE_ID: undefined })).toContain('EXPUNGE_SCOPE_ID:missing');
    expect(problems({ EXPUNGE_ENV: 'production' })).toContain('EXPUNGE_ENV:invalid');
    expect(problems({ EXPUNGE_WORKER_URL: 'ftp://worker' })).toContain('EXPUNGE_WORKER_URL:invalid');
  });

  it('refuses to build a service from a hand-made config that repeats a token', () => {
    const config = serviceConfigFromEnv(baseEnv);
    expect(() =>
      createDomainService({
        env: {} as DomainEnv,
        config: { ...config, tokens: { ...config.tokens, job_write: config.tokens.read } },
        wake: null,
      }),
    ).toThrow('ServiceConfigError:tokens_must_differ');
  });

  it('leaves a write principal that is not configured unavailable, never open', () => {
    const config = serviceConfigFromEnv({ ...baseEnv, EXPUNGE_JOB_WRITE_TOKEN: undefined });
    expect(config.tokens.job_write).toBeUndefined();
  });
});

describe('each token works only on its own route family, for the one owner it is bound to', () => {
  const config: ServiceConfig = serviceConfigFromEnv(baseEnv);
  // These paths never reach the database, so an environment stub is enough.
  const service = createDomainService({ env: {} as DomainEnv, config, wake: null });
  const call = async (
    method: string,
    path: string,
    token: string | null,
    options: { owner?: string | null; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.owner !== null) headers['x-expunge-owner-id'] = options.owner ?? 'owner-1';
    const response = await service.handle(
      new Request(`http://domain.test${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it('answers 401 for no token or an unknown token, and never says which part was wrong', async () => {
    expect(await call('GET', '/internal/projection/jobs', null)).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect((await call('GET', '/internal/projection/jobs', 'x'.repeat(32))).status).toBe(401);
    // The wake credential is not an inbound token.
    expect((await call('GET', '/internal/projection/jobs', WAKE)).status).toBe(401);
    expect((await call('GET', '/internal/projection/jobs', READ.slice(0, -1))).status).toBe(401);
  });

  it('answers 403 for a missing or different owner: the owner is configuration, not the request', async () => {
    expect((await call('GET', '/internal/projection/jobs', READ, { owner: null })).status).toBe(403);
    expect((await call('GET', '/internal/projection/jobs', READ, { owner: 'someone-else' })).status).toBe(
      403,
    );
    expect((await call('GET', '/internal/projection/jobs', READ)).status).toBe(501);
  });

  it('keeps read, job-write and approval apart', async () => {
    const matrix: Array<[string, string, string, number]> = [
      // method, path, token, expected status (501 = allowed, but served by the projection layer)
      ['GET', '/internal/projection/jobs', READ, 501],
      ['GET', '/internal/projection/jobs', JOB, 403],
      ['GET', '/internal/projection/jobs', APPROVAL, 403],
      ['GET', '/internal/projection/jobs/job-1/events', JOB, 403],
      ['POST', '/internal/projection/jobs/job-1/cancel', READ, 403],
      ['POST', '/internal/projection/jobs/job-1/cancel', APPROVAL, 403],
      ['POST', '/internal/projection/previews', READ, 403],
      ['POST', '/internal/projection/previews', APPROVAL, 403],
      ['POST', '/internal/projection/jobs', READ, 403],
      ['POST', '/internal/projection/proposals/p-1/decision', READ, 403],
      ['POST', '/internal/projection/proposals/p-1/decision', JOB, 403],
      ['POST', '/internal/projection/proposals/p-1/decision', APPROVAL, 501],
      ['GET', '/internal/projection/artifacts/a-1', JOB, 403],
      ['GET', '/internal/projection/artifacts/a-1', READ, 501],
    ];
    for (const [method, path, token, status] of matrix)
      expect(
        (await call(method, path, token, { body: method === 'POST' ? {} : undefined })).status,
        `${method} ${path}`,
      ).toBe(status);
  });

  it('answers 404 for a path it does not serve, and 400 for an id that is not an identifier', async () => {
    expect((await call('GET', '/internal/other', READ)).status).toBe(404);
    expect((await call('DELETE', '/internal/projection/jobs', READ)).status).toBe(404);
    expect((await call('GET', '/internal/projection/jobs/%20bad%20id/events', READ)).status).toBe(400);
  });

  it('refuses a body that names a tenant, a scope, an actor or a role, before it reaches anything', async () => {
    for (const forged of [
      { worldId: 'w', subject: { idType: 'string', value: 'x' }, tenantId: 'other' },
      { worldId: 'w', subject: { idType: 'string', value: 'x', scopeId: 'other' } },
      { worldId: 'w', subject: { idType: 'string', value: 'x' }, actorId: 'admin' },
    ])
      expect(await call('POST', '/internal/projection/previews', JOB, { body: forged })).toEqual({
        status: 400,
        body: { error: 'invalid_request' },
      });
    expect((await call('POST', '/internal/projection/jobs', JOB, { body: { worldId: 'w' } })).status).toBe(
      400,
    );
  });
});
