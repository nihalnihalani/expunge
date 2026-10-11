/** The exporter CLI against a real local replica set as the privacy_controller principal (protocol evidence, not Atlas). */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SubjectTokenRepository,
  createPrincipalService,
  setupMongo,
  type MongoService,
} from '@expunge/mongo';
import { parseGuardFile } from '@expunge/observability';
import { describeLive, TEST_URI } from '../../mongo/test/support.js';
import { main } from '../src/export-guard-cli.js';

describeLive('export-guard CLI', () => {
  const prefix = `expunge_guardcli_${randomUUID().replaceAll('-', '')}`;
  const names = {
    worldDatabase: `${prefix}_world`,
    controlDatabase: `${prefix}_control`,
    privateDatabase: `${prefix}_private`,
  };
  const scope = { tenantId: 't-cli', env: 'evaluation' as const, scopeId: 's-cli' };
  const dir = mkdtempSync(join(tmpdir(), 'guard-cli-'));
  let setup: MongoService;
  beforeAll(async () => {
    setup = createPrincipalService({ uris: { setup: TEST_URI! }, ...names }, 'setup');
    await setup.client.connect();
    await setupMongo(setup);
    const privacy = createPrincipalService(
      { uris: { privacy_controller: TEST_URI! }, ...names },
      'privacy_controller',
    );
    await new SubjectTokenRepository(privacy).put(scope, {
      subjectHandle: 'subject-handle-cli-1',
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: [],
      registeredAt: new Date(),
    });
    await privacy.close();
  });
  afterAll(async () => {
    for (const db of [setup.world, setup.control, setup.privateDb!]) await db.dropDatabase();
    await setup.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = (file: string) => ({
    MONGODB_PRIVACY_CONTROLLER_URI: TEST_URI!,
    EXPUNGE_WORLD_DB: names.worldDatabase,
    EXPUNGE_CONTROL_DB: names.controlDatabase,
    EXPUNGE_PRIVATE_DB: names.privateDatabase,
    EXPUNGE_TENANT_ID: scope.tenantId,
    EXPUNGE_ENV: scope.env,
    EXPUNGE_SCOPE_ID: scope.scopeId,
    RAINDROP_ORGANIZATION_ID: 'org-cli',
    EXPUNGE_LEAK_GUARD_FILE: file,
  });
  it('exports a verified owner-only guard from the registered subjects and prints counts only', async () => {
    const file = join(dir, 'guard.json');
    expect(await main(env(file))).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { guard } = parseGuardFile(readFileSync(file, 'utf8'), {
      scope,
      providerOrganizationId: 'org-cli',
    });
    expect(guard.forbiddenLiterals).toEqual(['subject-handle-cli-1']);
    expect(
      parseGuardFile(readFileSync(file, 'utf8'), { scope, providerOrganizationId: 'org-cli' }).generation,
    ).toBe(1);
    expect(await main(env(file))).toBe(0); // a second export raises the generation
    expect(
      parseGuardFile(readFileSync(file, 'utf8'), { scope, providerOrganizationId: 'org-cli' }).generation,
    ).toBe(2);
  });
  it('exits 2 without configuration and 1 for a scope with no registered subjects, writing nothing', async () => {
    expect(await main({})).toBe(2);
    const file = join(dir, 'none.json');
    expect(await main({ ...env(file), EXPUNGE_SCOPE_ID: 'no-subjects' })).toBe(1);
    expect(() => statSync(file)).toThrow();
  });
});
