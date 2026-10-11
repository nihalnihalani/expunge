/**
 * A worker process for the E1 fault harness: the product Dispatcher over the product repositories, the labeled
 * FakeChatModel, and one real effect-committing tool. Started by driver.ts as
 *   node --import tsx tests/reliability/fault/worker-child.ts      (config in RELI_CONFIG, JSON)
 * It reports every named point and the final result as JSON lines on fd 1 (written synchronously so a SIGKILL
 * right after a point cannot swallow the report).
 */
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  ArtifactRepository,
  EffectRepository,
  JobRepository,
  ProjectionRepository,
  createPrincipalService,
} from '@expunge/mongo';
import { FakeChatModel, fakeText, fakeToolCalls } from '@expunge/runtime/testing';
import { defineTool } from '@expunge/vendor-openmuse';
import {
  Dispatcher,
  FencedProjectionSink,
  MongoCompletionReceiptReader,
  MongoJobResolver,
  MongoTerminalSweep,
  asArtifactReader,
  asDispatchJobs,
  workerConfigFromEnv,
} from '../../../apps/worker/src/index.js';
import { FakeToolProvider, FixedModelResolver } from '../../../packages/runtime/test/fakes.js';
import { buildIntent, type ChildConfig, type ChildEvent } from './protocol.js';

// The tool schema must come from the zod copy the worker itself uses (4.x, nested under apps/worker); the root copy is 3.x.
const workerRequire = createRequire(new URL('../../../apps/worker/package.json', import.meta.url));
const { z } = workerRequire('zod') as { z: { object: (shape: Record<string, never>) => never } };

const config = JSON.parse(process.env.RELI_CONFIG ?? 'null') as ChildConfig | null;
if (!config) throw new Error('RELI_CONFIG is required');

const emit = (event: ChildEvent) => writeSync(1, `${JSON.stringify(event)}\n`);
const counts = new Map<string, number>();

/** Reports the point, then performs the planned fault if this is the n-th arrival at a faulted point. */
function point(name: string): void {
  const n = (counts.get(name) ?? 0) + 1;
  counts.set(name, n);
  emit({ event: 'point', name, n, pid: process.pid });
  const spec = config!.faults.find((f) => f.point === name && (f.nth ?? 1) === n);
  if (!spec) return;
  if (spec.action === 'kill') process.kill(process.pid, 'SIGKILL');
  if (spec.action === 'stop') process.kill(process.pid, 'SIGSTOP'); // resumes here after the driver sends SIGCONT
  if (spec.action === 'exit') process.exit(spec.code ?? 70);
}

/** Wraps every method of a repository so `before-<name>` and `after-<name>` are reportable and faultable. */
function instrumented<T extends object>(target: T, skip: string[] = []): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string' || skip.includes(prop)) return value;
      return async (...args: unknown[]) => {
        point(`before-${prop}`);
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(t, args);
        point(`after-${prop}`);
        return result;
      };
    },
  });
}

async function main() {
  const c = config!;
  const service = createPrincipalService(
    {
      uris: { domain_executor: c.uri },
      worldDatabase: c.worldDb,
      controlDatabase: c.controlDb,
      privateDatabase: c.privateDb,
    },
    'domain_executor',
  );
  await service.client.connect();
  const jobsRepository = new JobRepository(service);
  const effects = new EffectRepository(service);
  const projection = new ProjectionRepository(service);
  const fenced = new FencedProjectionSink(service, jobsRepository, projection);
  const workerConfig = workerConfigFromEnv({
    EXPUNGE_WORKER_ID: c.workerId,
    EXPUNGE_WORKER_LEASE_MS: String(c.leaseMs),
    EXPUNGE_TENANT_ID: c.scope.tenantId,
    EXPUNGE_ENV: c.scope.env,
    EXPUNGE_SCOPE_ID: c.scope.scopeId,
    EXPUNGE_WORKER_POLL_MS: c.mode === 'poll' ? '250' : '0',
    EXPUNGE_WORKER_TOOL_DRAIN_MS: '500',
  });

  // FAKE scripted model: one tool call, then plain text.
  const fake = new FakeChatModel([fakeToolCalls([{ name: 'apply', args: {} }]), fakeText('Done.')]);
  const tools = new FakeToolProvider((context) => [
    defineTool({
      name: 'apply',
      description: 'Commits the harness effect for this job through the real effect repository.',
      parameters: z.object({}),
      execute: async () => {
        point('tool-start');
        point('before-effect');
        try {
          const intent = buildIntent(context.job._id, c.harnessHash);
          const alreadyCommitted = (await effects.replay(context.actor, intent)) !== null;
          const receipt = await effects.commitEffect({
            actor: context.actor,
            lease: context.lease,
            intent,
            apply: async (session) => {
              await service.world
                .collection('reliability_marker')
                .updateOne(
                  { _id: context.job._id } as never,
                  { $inc: { applied: 1 } },
                  { upsert: true, session },
                );
              return [];
            },
          });
          emit({ event: 'effect', receiptId: receipt.receiptId, replayed: alreadyCommitted });
          point('after-commit-before-ack');
          return { ok: true, receiptId: receipt.receiptId };
        } catch (error) {
          emit({ event: 'tool-error', message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    }),
  ]);

  const dispatcher = new Dispatcher({
    jobs: asDispatchJobs(
      instrumented(jobsRepository, [
        'collection',
        'resolveForDispatch',
        'readAuthorized',
        'workerJob',
        'listClaimable',
        'create',
      ]),
    ),
    resolver: new MongoJobResolver(jobsRepository),
    artifacts: asArtifactReader(new ArtifactRepository(service)),
    tools,
    models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
    receipts: new MongoCompletionReceiptReader(service),
    config: workerConfig,
    // The product's fenced sink (an append commits only while this worker still owns the job), wrapped so the same
    // named points surround every append.
    projection: {
      append: async (key, event) => {
        point('before-projection');
        const result = await fenced.append(key, event);
        point('after-projection');
        return result;
      },
      appendFenced: async (key, event, holder) => {
        point('before-projection');
        const result = await fenced.appendFenced(key, event, holder);
        point('after-projection');
        return result;
      },
      hasTerminal: (key, jobId) => fenced.hasTerminal(key, jobId),
    },
    terminalSweep: new MongoTerminalSweep(service),
    onResult: (result) => {
      if (c.mode !== 'poll') return;
      emit({
        event: 'result',
        outcome: result.outcome,
        ...(result.stats?.errorCode ? { errorCode: result.stats.errorCode } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
      void service.close().finally(() => process.exit(0));
    },
  });

  emit({ event: 'ready', pid: process.pid, workerId: c.workerId });
  // What the product worker does on start: repair terminal projections that a crash left behind.
  emit({ event: 'repaired', count: await dispatcher.repairTerminalProjections() });
  if (c.mode === 'run') {
    const result = await dispatcher.runJob(c.jobId);
    emit({
      event: 'result',
      outcome: result.outcome,
      ...(result.stats?.errorCode ? { errorCode: result.stats.errorCode } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
    // Everything the run did is committed by now; exit without waiting for pools or timers to drain.
    process.exit(0);
  } else {
    dispatcher.startPolling();
    setTimeout(() => {
      emit({ event: 'fatal', message: 'poll timed out without a result' });
      process.exit(3);
    }, c.pollTimeoutMs ?? 20_000).unref?.();
  }
}

main().catch((error) => {
  emit({
    event: 'fatal',
    message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  process.exit(2);
});
