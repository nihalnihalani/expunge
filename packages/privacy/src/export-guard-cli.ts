import { pathToFileURL } from 'node:url';
import { createPrincipalService, mongoConfigFromEnv, SubjectTokenRepository } from '@expunge/mongo';
import { exportGuardFile } from './export-guard.js';

/**
 * Exports the leak guard for the evidence process.
 *   MONGODB_PRIVACY_CONTROLLER_URI, EXPUNGE_TENANT_ID, EXPUNGE_ENV, EXPUNGE_SCOPE_ID, RAINDROP_ORGANIZATION_ID,
 *   EXPUNGE_LEAK_GUARD_FILE (output path)
 *   node --import tsx packages/privacy/src/export-guard-cli.ts
 * Prints counts only, never a literal. Exit 0 on success, 1 on a refused or failed export (the reason is a closed code).
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const path = env.EXPUNGE_LEAK_GUARD_FILE?.trim();
  const organization = env.RAINDROP_ORGANIZATION_ID?.trim();
  const { EXPUNGE_TENANT_ID: tenantId, EXPUNGE_ENV: scopeEnv, EXPUNGE_SCOPE_ID: scopeId } = env;
  if (
    !path ||
    !organization ||
    !tenantId ||
    !scopeId ||
    !['dev', 'evaluation', 'demo'].includes(scopeEnv ?? '')
  ) {
    console.error(
      'MissingConfiguration: EXPUNGE_LEAK_GUARD_FILE, RAINDROP_ORGANIZATION_ID, EXPUNGE_TENANT_ID, EXPUNGE_ENV, EXPUNGE_SCOPE_ID',
    );
    return 2;
  }
  const service = createPrincipalService(mongoConfigFromEnv(env), 'privacy_controller');
  try {
    await service.client.connect();
    const counts = await exportGuardFile(
      { tokens: new SubjectTokenRepository(service) },
      { tenantId, env: scopeEnv as 'dev' | 'evaluation' | 'demo', scopeId },
      path,
      { providerOrganizationId: organization },
    );
    console.log(JSON.stringify({ exported: counts }));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : 'unknown',
        code: (error as { code?: string }).code,
      }),
    );
    return 1;
  } finally {
    await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((code) => void (process.exitCode = code));
