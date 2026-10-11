import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ErasureSuppressionRepository } from '@expunge/mongo';
import { serializeGuardFile } from '@expunge/observability';
import { FakeRaindrop } from '../../observability/test/fake-raindrop.js';
import {
  createEvidenceProcess,
  createMongoExportSuppression,
  loadGuardFile,
  suppressionUserKey,
} from '../src/index.js';
import { main } from '../src/main.js';
import { TEST_URI, describeLive, openEnvironment, scope, type LiveEnvironment } from './mongo-support.js';

/** Local replica set + FAKE Raindrop: protocol evidence that the packaged entry wires its two required sources. */
describeLive('evidence process entry (main) wiring', () => {
  let env: LiveEnvironment;
  const fake = new FakeRaindrop();
  const dir = mkdtempSync(join(tmpdir(), 'observer-main-'));
  const guardPath = join(dir, 'guard.json');
  beforeAll(async () => {
    env = await openEnvironment('observer_main');
    await fake.start();
    writeFileSync(
      guardPath,
      serializeGuardFile(
        { forbiddenLiterals: ['subject-handle-1'] },
        { scope, providerOrganizationId: 'org-1' },
      ),
    );
    chmodSync(guardPath, 0o600);
  });
  afterAll(async () => {
    await fake.stop();
    await env.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv = () => ({
    EXPUNGE_TENANT_ID: scope.tenantId,
    EXPUNGE_ENV: scope.env,
    EXPUNGE_SCOPE_ID: scope.scopeId,
    MONGODB_OBSERVER_URI: TEST_URI!,
    RAINDROP_API_KEY: fake.keys().writeKey,
    RAINDROP_QUERY_API_KEY: fake.keys().queryKey,
    RAINDROP_PROJECT_ID: 'proj-1',
    RAINDROP_ORGANIZATION_ID: 'org-1',
    RAINDROP_INGEST_URL: fake.ingestUrl,
    RAINDROP_QUERY_URL: fake.queryUrl,
  });

  it('createMongoExportSuppression reads active erasures with the observer principal, keyed by suppressionUserKey', async () => {
    const privacy = await env.as('privacy_controller');
    const observer = await env.as('observer');
    const repo = new ErasureSuppressionRepository(privacy);
    await repo.setActive(
      { ...scope, providerOrganizationId: 'org-1', userKey: suppressionUserKey('u_user_a'), jobId: 'job-a' },
      true,
    );
    await repo.setActive(
      { ...scope, providerOrganizationId: 'org-1', userKey: suppressionUserKey('u_user_b'), jobId: 'job-b' },
      false,
    );
    await repo.setActive(
      { ...scope, providerOrganizationId: 'org-2', userKey: suppressionUserKey('u_user_c'), jobId: 'job-c' },
      true,
    );
    const set = await createMongoExportSuppression(observer).suppressedUserIds('org-1');
    // The privacy controller writes hashed keys; the reader's membership test takes the RAW provider user id.
    expect(set.has('u_user_a')).toBe(true);
    expect(set.has('u_user_b')).toBe(false); // released
    expect(set.has('u_user_c')).toBe(false); // other organization
    expect([...set]).toEqual([suppressionUserKey('u_user_a')]);
  });

  it('is READY (local fake) with both sources present and a window configured', async () => {
    const observer = await env.as('observer');
    const started = createEvidenceProcess(
      baseEnv(),
      {
        suppression: createMongoExportSuppression(observer),
        guard: loadGuardFile(guardPath, { scope, providerOrganizationId: 'org-1' })!,
      },
      { service: observer },
    );
    expect(started.status).toBe('READY');
    expect(started.readiness.mode).toBe('local_fake');
  });

  it('main exits 3 BLOCKED naming the missing guard and never starts, even with the observer principal present', async () => {
    const observer = await env.as('observer');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    try {
      const code = await main(baseEnv(), { service: observer });
      expect(code).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).toMatch(/BLOCKED: evidence \(leak guard source/);
    expect(logs.join('\n')).not.toMatch(/export suppression source/);
  });

  it('main exits 3 on an unreadable guard file or a bad window, naming the variable only', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    try {
      expect(await main({ ...baseEnv(), EXPUNGE_LEAK_GUARD_FILE: join(dir, 'nope.json') })).toBe(3);
      expect(await main({ ...baseEnv(), EXPUNGE_OBSERVER_WINDOW_START: 'yesterday' })).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).toContain('EXPUNGE_LEAK_GUARD_FILE:unreadable');
    expect(logs.join('\n')).toContain('EXPUNGE_OBSERVER_WINDOW_START');
  });
});
