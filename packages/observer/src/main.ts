import { pathToFileURL } from 'node:url';
import {
  PRINCIPAL_URI_VARIABLES,
  createPrincipalService,
  mongoConfigFromEnv,
  type MongoService,
} from '@expunge/mongo';
import { createEvidenceProcess, type EvidenceLog, type EvidenceSources } from './process.js';
import { createMongoExportSuppression } from './mongo-suppression.js';
import { loadGuardFile, windowFromEnv } from './sources.js';

const log: EvidenceLog = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

/**
 * The evidence process entry. It builds its two required sources and prints the readiness lines (names only); it exits 3
 * when BLOCKED, like the worker's `--readiness`. When READY it runs the dispatcher (and the observer when a window is
 * configured) until SIGINT/SIGTERM.
 *
 *  - export suppression: `createMongoExportSuppression` (bounded, hashed injective keys, HOLDs on a full list) through the process's own `observer` principal.
 *    Needs only `MONGODB_OBSERVER_URI`.
 *  - leak guard: the file the privacy controller exports (`EXPUNGE_LEAK_GUARD_FILE`, see loadGuardFile).
 *  - observer window: `EXPUNGE_OBSERVER_WINDOW_START`/`_END`/`_VERSION`/`_EVENT_NAME`; without them only the outbox
 *    dispatcher runs.
 * Anything missing leaves the process BLOCKED with the names printed; nothing is sent and nothing is invented.
 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  options: { service?: MongoService } = {},
): Promise<number> {
  let service = options.service;
  if (!service && env[PRINCIPAL_URI_VARIABLES.observer]?.trim())
    service = createPrincipalService(mongoConfigFromEnv(env), 'observer');
  let sources: EvidenceSources = {};
  let window;
  try {
    const tenantId = env.EXPUNGE_TENANT_ID?.trim();
    const scopeId = env.EXPUNGE_SCOPE_ID?.trim();
    const scopeEnv = env.EXPUNGE_ENV?.trim();
    const organization = env.RAINDROP_ORGANIZATION_ID?.trim();
    const guard =
      tenantId && scopeId && scopeEnv && organization
        ? loadGuardFile(env.EXPUNGE_LEAK_GUARD_FILE, {
            scope: { tenantId, env: scopeEnv as 'dev' | 'evaluation' | 'demo', scopeId },
            providerOrganizationId: organization,
          })
        : undefined;
    sources = {
      ...(service ? { suppression: createMongoExportSuppression(service) } : {}),
      ...(guard ? { guard } : {}),
    };
    window = windowFromEnv(env);
  } catch (error) {
    console.log(`BLOCKED: evidence (${error instanceof Error ? error.message : 'invalid configuration'})`);
    await service?.close();
    return 3;
  }
  const started = createEvidenceProcess(env, sources, {
    log,
    ...(service ? { service } : {}),
    ...(window ? { window } : {}),
  });
  for (const line of started.readiness.lines) console.log(line);
  if (started.status === 'BLOCKED') {
    await service?.close();
    return 3;
  }
  started.process.start({ dispatch: 5_000, scan: 30_000 });
  // The loop timers are unref'd; this referenced timer is what keeps the process alive until SIGINT/SIGTERM.
  const keepAlive = setInterval(() => undefined, 60_000);
  const stop = () => {
    clearInterval(keepAlive);
    started.process.stop();
    void started.service.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => void (process.exitCode = code),
    (error) => {
      console.error(JSON.stringify({ fatal: error instanceof Error ? error.name : 'unknown' }));
      process.exit(1);
    },
  );
