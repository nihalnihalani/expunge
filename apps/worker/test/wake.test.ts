import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryWakeCommandStore,
  MIN_WAKE_TOKEN_LENGTH,
  authenticateWake,
  checkReadiness,
  createWakeServer,
  startWorker,
  workerConfigFromEnv,
  type Readiness,
  type WakeCommand,
} from '../src/index.js';

const TOKEN = 'wake-token-for-tests-0123456789abcdef';
const ready: Readiness = {
  status: 'READY',
  blockers: [],
  lines: ['READY'],
  checks: {
    provider: 'configured',
    database: 'configured',
    wakeToken: 'configured',
    scope: 'configured',
    domainTools: 'configured',
  },
  reachability: 'not_checked',
};
const blocked = (): Readiness =>
  checkReadiness({ EXPUNGE_WAKE_TOKEN: TOKEN }, { domainToolsAvailable: false });

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (origin: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/internal/wake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const command: WakeCommand = { jobId: 'job-1', commandId: 'command-00000001' };

function wakeRig(readiness: () => Readiness = () => ready, accept = true) {
  const woken: WakeCommand[] = [];
  const store = new InMemoryWakeCommandStore();
  const server = createWakeServer({
    token: TOKEN,
    store,
    readiness,
    target: {
      canAccept: () => accept,
      wake: (c) => {
        if (!accept) return false;
        woken.push(c);
        return true;
      },
    },
  });
  return { server, woken, store };
}

describe('authenticated wake command', () => {
  it('compares the bearer token in constant time and rejects missing, malformed and wrong tokens', () => {
    expect(authenticateWake(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authenticateWake(undefined, TOKEN)).toBe(false);
    expect(authenticateWake(TOKEN, TOKEN)).toBe(false);
    expect(authenticateWake('Bearer wrong', TOKEN)).toBe(false);
    expect(authenticateWake(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(authenticateWake('Bearer ', '')).toBe(false);
  });

  it('accepts exactly {jobId, commandId} and hands only those two fields to the dispatcher', async () => {
    const { server, woken } = wakeRig();
    const origin = await listen(server);
    const response = await post(origin, command);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted' });
    expect(woken).toEqual([command]);
  });

  it('rejects unauthenticated, wrong-media-type, oversize and malformed commands without waking anything', async () => {
    const { server, woken } = wakeRig();
    const origin = await listen(server);
    expect(
      (await fetch(`${origin}/internal/wake`, { method: 'POST', body: JSON.stringify(command) })).status,
    ).toBe(401);
    expect((await post(origin, command, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(origin, command, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(origin, 'x'.repeat(2000))).status).toBe(413);
    expect((await post(origin, '{not json')).status).toBe(400);
    expect((await post(origin, { jobId: 'job-1' })).status).toBe(400);
    expect((await post(origin, { ...command, jobId: 'a b' })).status).toBe(400);
    // Authority-shaped extras are rejected, not ignored.
    for (const extra of [
      { tenantId: 't' },
      { actor: {} },
      { harnessHash: 'h' },
      { scopeId: 's' },
      { limits: {} },
    ])
      expect((await post(origin, { ...command, ...extra })).status).toBe(400);
    expect(woken).toEqual([]);
  });

  it('is idempotent by commandId: a replay is acknowledged as a duplicate and wakes nothing', async () => {
    const { server, woken } = wakeRig();
    const origin = await listen(server);
    expect((await post(origin, command)).status).toBe(202);
    const replay = await post(origin, command);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: 'duplicate' });
    // A new command for the same job is a new wake (claim itself is fenced).
    expect((await post(origin, { ...command, commandId: 'command-00000002' })).status).toBe(202);
    expect(woken.map((c) => c.commandId)).toEqual(['command-00000001', 'command-00000002']);
  });

  it('does not burn a commandId when the dispatcher queue is full (the sender can retry)', async () => {
    let accepting = false;
    const woken: WakeCommand[] = [];
    const server = createWakeServer({
      token: TOKEN,
      store: new InMemoryWakeCommandStore(),
      readiness: () => ready,
      target: {
        canAccept: () => accepting,
        wake: (c) => {
          if (!accepting) return false;
          woken.push(c);
          return true;
        },
      },
    });
    const origin = await listen(server);
    expect((await post(origin, command)).status).toBe(429);
    accepting = true;
    expect((await post(origin, command)).status).toBe(202);
    expect(woken).toEqual([command]);
  });

  it('answers BLOCKED readiness with 503 on /readyz and refuses wakes instead of claiming jobs', async () => {
    const { server, woken } = wakeRig(blocked);
    const origin = await listen(server);
    const readyz = await fetch(`${origin}/readyz`);
    expect(readyz.status).toBe(503);
    const body = (await readyz.json()) as { status: string; lines: string[]; reachability: string };
    expect(body.status).toBe('BLOCKED');
    expect(body.lines.some((line) => line.startsWith('BLOCKED: provider credentials'))).toBe(true);
    expect(body.reachability).toBe('not_checked');
    const wake = await post(origin, command);
    expect(wake.status).toBe(503);
    expect(((await wake.json()) as { blockers: string[] }).blockers).toContain('provider credentials');
    expect(woken).toEqual([]);
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/nope`)).status).toBe(404);
  });

  it('a worker started without provider credentials reports BLOCKED: provider credentials and never fakes success', async () => {
    const worker = await startWorker({
      EXPUNGE_WAKE_TOKEN: TOKEN,
      EXPUNGE_WORKER_PORT: '0',
      EXPUNGE_WORKER_HOST: '127.0.0.1',
      EXPUNGE_MODEL_PROVIDER: 'openai',
      EXPUNGE_MODEL_ID: 'gpt-5',
      // no OPENAI_API_KEY, no MONGODB_DOMAIN_EXECUTOR_URI
    });
    try {
      expect(worker.readiness.status).toBe('BLOCKED');
      expect(worker.readiness.lines).toContain('BLOCKED: provider credentials (Set OPENAI_API_KEY.)');
      const origin = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
      const readyz = await fetch(`${origin}/readyz`);
      expect(readyz.status).toBe(503);
      expect(JSON.stringify(await readyz.json())).toContain('BLOCKED: provider credentials');
      expect((await post(origin, command)).status).toBe(503);
    } finally {
      await worker.close();
    }
  });
});

describe('readiness reporting', () => {
  const full = {
    OPENAI_API_KEY: 'test-readiness-secret-value',
    EXPUNGE_MODEL_PROVIDER: 'openai',
    EXPUNGE_MODEL_ID: 'gpt-5',
    MONGODB_DOMAIN_EXECUTOR_URI: 'mongodb://user:secret-password@host.example/db',
    EXPUNGE_WAKE_TOKEN: TOKEN,
    EXPUNGE_TENANT_ID: 'tenant-1',
    EXPUNGE_ENV: 'evaluation',
    EXPUNGE_SCOPE_ID: 'scope-1',
  };

  it('is READY only when provider, database, wake token and domain tools are all present, and never echoes values', () => {
    const ok = checkReadiness(full, { domainToolsAvailable: true });
    expect(ok.status).toBe('READY');
    expect(ok.reachability).toBe('not_checked');
    expect(JSON.stringify(ok)).not.toMatch(
      /test-readiness-secret-value|secret-password|wake-token-for-tests/,
    );
    const noTools = checkReadiness(full, { domainToolsAvailable: false });
    expect(noTools.status).toBe('BLOCKED');
    expect(noTools.blockers.map((b) => b.code)).toEqual(['domain tools']);
  });

  it('reports each missing piece by name; nothing configured reports model AND credentials blockers', () => {
    const empty = checkReadiness({}, { domainToolsAvailable: true });
    expect(empty.lines.map((line) => line.split(' (')[0])).toEqual([
      'BLOCKED: model configuration',
      'BLOCKED: provider credentials',
      'BLOCKED: database credentials',
      'BLOCKED: wake token',
      'BLOCKED: scope binding',
    ]);
    const noKey = checkReadiness({ ...full, OPENAI_API_KEY: undefined }, { domainToolsAvailable: true });
    expect(noKey.blockers).toEqual([{ code: 'provider credentials', detail: 'Set OPENAI_API_KEY.' }]);
    const anthropic = checkReadiness(
      { ...full, EXPUNGE_MODEL_PROVIDER: 'anthropic', OPENAI_API_KEY: undefined },
      { domainToolsAvailable: true },
    );
    expect(anthropic.blockers).toEqual([{ code: 'provider credentials', detail: 'Set ANTHROPIC_API_KEY.' }]);
    const gemini = checkReadiness(
      { ...full, EXPUNGE_MODEL_PROVIDER: 'gemini' },
      { domainToolsAvailable: true },
    );
    expect(gemini.blockers[0]?.code).toBe('model configuration');
    const shortToken = checkReadiness(
      { ...full, EXPUNGE_WAKE_TOKEN: 'short' },
      { domainToolsAvailable: true },
    );
    expect(shortToken.blockers[0]?.detail).toContain(String(MIN_WAKE_TOKEN_LENGTH));
  });

  it('requires the domain_executor URI only; a setup or other principal URI is not a fallback', () => {
    const setupOnly = checkReadiness(
      { ...full, MONGODB_DOMAIN_EXECUTOR_URI: undefined, MONGODB_SETUP_URI: 'mongodb://admin:x@h/db' },
      { domainToolsAvailable: true },
    );
    expect(setupOnly.blockers.map((b) => b.code)).toEqual(['database credentials']);
  });
});

describe('worker configuration bounds', () => {
  it('derives a unique owner and a renewal interval of a third of the lease', () => {
    const a = workerConfigFromEnv({ EXPUNGE_WORKER_LEASE_MS: '30000' });
    const b = workerConfigFromEnv({ EXPUNGE_WORKER_LEASE_MS: '30000' });
    expect(a.ownerId).not.toBe(b.ownerId);
    expect(a.renewEveryMs).toBe(10_000);
    expect(a.host).toBe('127.0.0.1');
  });
  it('rejects out-of-range values instead of clamping silently', () => {
    expect(() => workerConfigFromEnv({ EXPUNGE_WORKER_LEASE_MS: '50' })).toThrow(/EXPUNGE_WORKER_LEASE_MS/);
    expect(() => workerConfigFromEnv({ EXPUNGE_WORKER_LEASE_MS: '999999' })).toThrow();
    expect(() => workerConfigFromEnv({ EXPUNGE_WORKER_MAX_CONCURRENT: '0' })).toThrow();
    expect(() => workerConfigFromEnv({ EXPUNGE_WORKER_ID: 'bad id!' })).toThrow();
  });

  it('binds the worker to one scope from trusted configuration, all-or-nothing', () => {
    expect(workerConfigFromEnv({}).scope).toBeUndefined();
    expect(
      workerConfigFromEnv({ EXPUNGE_TENANT_ID: 't', EXPUNGE_ENV: 'demo', EXPUNGE_SCOPE_ID: 's' }).scope,
    ).toEqual({ tenantId: 't', env: 'demo', scopeId: 's' });
    expect(() => workerConfigFromEnv({ EXPUNGE_TENANT_ID: 't' })).toThrow(/must be set together/);
    expect(() =>
      workerConfigFromEnv({ EXPUNGE_TENANT_ID: 't', EXPUNGE_ENV: 'prod', EXPUNGE_SCOPE_ID: 's' }),
    ).toThrow(/EXPUNGE_ENV/);
  });
  it('bounds the recovery poll and parses the pricing requirement', () => {
    expect(workerConfigFromEnv({}).pollMs).toBe(5000);
    expect(workerConfigFromEnv({ EXPUNGE_WORKER_POLL_MS: '0' }).pollMs).toBe(0);
    expect(() => workerConfigFromEnv({ EXPUNGE_WORKER_POLL_MS: '10' })).toThrow(/EXPUNGE_WORKER_POLL_MS/);
    expect(workerConfigFromEnv({ EXPUNGE_WORKER_REQUIRE_PRICING: 'true' }).requirePricing).toBe(true);
    expect(workerConfigFromEnv({}).requirePricing).toBe(false);
  });
});
