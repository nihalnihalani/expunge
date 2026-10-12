import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { workerConfigFromEnv, type WorkerConfig } from './config.js';
import { runtimeHash } from '@expunge/runtime';
import { Dispatcher, type LogEntry } from './dispatch.js';
import { createDomainToolWiring } from './domain-wiring.js';
import { checkReadiness, type Readiness } from './readiness.js';
import {
  InMemoryWakeCommandStore,
  createWakeServer,
  type WakeCommandStore,
  type WakeTarget,
} from './wake.js';
import { createMongoWiring, createTelemetryWiring } from './wiring.js';

export * from './committed.js';
export * from './config.js';
export * from './dispatch.js';
export * from './domain-wiring.js';
export * from './episode-host.js';
export * from './episode-port.js';
export * from './readiness.js';
export * from './receipts.js';
export * from './telemetry.js';
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
  // The typed gateway tools are built in-process from the worker's own domain_executor client; their availability is
  // static (the module is part of the worker), so readiness only blocks on configuration.
  const readiness = checkReadiness(env, { domainToolsAvailable: true });
  for (const line of readiness.lines) console.log(line);
  for (const note of readiness.notes ?? []) console.log(`NOTE: ${note}`);

  let dispatcher: Dispatcher | undefined;
  let wakeStore: WakeCommandStore = new InMemoryWakeCommandStore();
  let closeMongo: (() => Promise<void>) | undefined;
  let closeTelemetry: (() => Promise<void>) | undefined;
  if (readiness.status === 'READY') {
    const wiring = createMongoWiring(env);
    closeMongo = () => wiring.service.close();
    wakeStore = wiring.wakeStore;
    const telemetry = createTelemetryWiring(env, wiring.service, logEntry);
    if (telemetry.enabled) closeTelemetry = telemetry.close;
    dispatcher = new Dispatcher({
      jobs: wiring.jobs,
      resolver: wiring.resolver,
      attestations: wiring.attestations,
      artifacts: wiring.artifacts,
      tools: createDomainToolWiring(wiring.service, { log: logEntry }).provider,
      runtimeHash: runtimeHash(),
      models: wiring.models,
      receipts: wiring.receipts,
      config,
      env,
      projection: wiring.projection,
      terminalSweep: wiring.terminalSweep,
      committed: wiring.committed,
      ...(telemetry.enabled ? { telemetry: telemetry.telemetry } : {}),
      log: logEntry,
    });
    dispatcher.startPolling();
    void dispatcher.repairTerminalProjections(); // a crash can leave a finished job without its terminal event
  }
  const target: WakeTarget = {
    canAccept: () => dispatcher?.canAccept() ?? false,
    wake: (command) => dispatcher?.wake(command) ?? false,
  };
  const server = createWakeServer({
    token: env.EXPUNGE_WAKE_TOKEN ?? '',
    store: wakeStore,
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
      await closeTelemetry?.(); // drains buffered Raindrop events after the last job has finished
      await closeMongo?.();
    },
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--readiness')) {
    // Readiness only: no network, no database, no secret values printed.
    const readiness = checkReadiness(process.env, { domainToolsAvailable: true });
    for (const line of readiness.lines) console.log(line);
    for (const note of readiness.notes ?? []) console.log(`NOTE: ${note}`);
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
      // The one scope this worker claims and polls; jobs queued under any other scope stay queued.
      scope: worker.config.scope ?? null,
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
