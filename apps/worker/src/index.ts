import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { workerConfigFromEnv, type WorkerConfig } from './config.js';
import { Dispatcher, RingEventSink, type LogEntry } from './dispatch.js';
import { loadDomainTools } from './domain-tools.js';
import { checkReadiness, type Readiness } from './readiness.js';
import { InMemoryWakeCommandStore, createWakeServer, type WakeTarget } from './wake.js';
import { createMongoWiring } from './wiring.js';

export * from './config.js';
export * from './dispatch.js';
export * from './domain-tools.js';
export * from './readiness.js';
export * from './receipts.js';
export * from './terminal.js';
export * from './wake.js';
export * from './wiring.js';

export type RunningWorker = {
  config: WorkerConfig;
  readiness: Readiness;
  server: Server;
  close(): Promise<void>;
};

const logEntry = (entry: LogEntry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

/**
 * Starts the wake endpoint and, only when readiness is READY, the dispatcher. A BLOCKED worker still
 * serves /readyz (503 with the blocker names) and answers wake commands with 503; it never claims a job.
 */
export async function startWorker(env: NodeJS.ProcessEnv = process.env): Promise<RunningWorker> {
  const config = workerConfigFromEnv(env);
  const tools = loadDomainTools();
  const readiness = checkReadiness(env, { domainToolsAvailable: tools.available });
  for (const line of readiness.lines) console.log(line);

  let dispatcher: Dispatcher | undefined;
  let closeMongo: (() => Promise<void>) | undefined;
  if (readiness.status === 'READY') {
    const wiring = createMongoWiring(env);
    closeMongo = () => wiring.service.close();
    dispatcher = new Dispatcher({
      jobs: wiring.jobs,
      resolver: wiring.resolver,
      artifacts: wiring.artifacts,
      tools: tools.provider,
      models: wiring.models,
      receipts: wiring.receipts,
      config,
      env,
      events: new RingEventSink(),
      log: logEntry,
    });
  }
  const target: WakeTarget = { wake: (command) => dispatcher?.wake(command) ?? false };
  const server = createWakeServer({
    token: env.EXPUNGE_WAKE_TOKEN ?? '',
    store: new InMemoryWakeCommandStore(),
    target,
    readiness: () => readiness,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  return {
    config,
    readiness,
    server,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dispatcher?.stop();
      await closeMongo?.();
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--readiness')) {
    // Readiness only: no network, no database, no secret values printed.
    const readiness = checkReadiness(process.env, { domainToolsAvailable: loadDomainTools().available });
    for (const line of readiness.lines) console.log(line);
    console.log(
      JSON.stringify({
        status: readiness.status,
        checks: readiness.checks,
        reachability: readiness.reachability,
      }),
    );
    process.exitCode = readiness.status === 'READY' ? 0 : 3;
    return;
  }
  const worker = await startWorker();
  console.log(
    JSON.stringify({
      listening: `${worker.config.host}:${worker.config.port}`,
      ownerId: worker.config.ownerId,
      status: worker.readiness.status,
    }),
  );
  const shutdown = () => {
    void worker.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ fatal: error instanceof Error ? error.message : 'unknown' }));
    process.exit(1);
  });
}
