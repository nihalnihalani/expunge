import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { CompletionReceipt, HarnessBundle, Job, JobStatus } from '@expunge/contracts';
import { FakeChatModel, fakeText, fakeToolCalls } from '@expunge/runtime/testing';
import {
  Episode,
  closeTracing,
  dispatchSubagent,
  episodeEventId,
  initTracing,
  operationIdFor,
  type RaindropTracing,
} from '@expunge/observability';
import type { ClientSession } from 'mongodb';
import { defineTool } from '@expunge/vendor-openmuse';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeRaindrop } from '../../../packages/observability/test/fake-raindrop.js';
import {
  FakeArtifactReader,
  FakeToolProvider,
  FixedModelResolver,
  makeBundle,
  makeJob,
} from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  InMemoryWakeCommandStore,
  carrierOf,
  checkReadiness,
  createTelemetry,
  createTelemetryWiring,
  createWakeServer,
  episodeSummary,
  telemetryUserId,
  workerConfigFromEnv,
  type JobRunResult,
  type LogEntry,
  type Readiness,
  type CommittedReader,
  type Telemetry,
} from '../src/index.js';
import { MultiJobStore } from './fakes.js';
import type { MongoService } from '@expunge/mongo';

const fake = new FakeRaindrop();
let tracing: RaindropTracing;
beforeAll(async () => {
  await fake.start();
  tracing = initTracing(
    { writeKey: fake.keys().writeKey, projectId: 'proj-1', endpoint: fake.ingestUrl },
    { disableBatching: true, bufferSize: 1 },
  );
});
afterAll(async () => {
  await closeTracing();
  await fake.stop();
});
beforeEach(() => fake.reset());

async function waitUntil(predicate: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** FAKE outbox and transaction recorder: shows what was written, in what order, and whether in the same transaction. */
class Recorder {
  readonly log: string[] = [];
  readonly rows = new Map<string, { input: any; inTransaction: boolean }>();
  failEnqueue = false;
  /** Undo actions for writes made inside the current transaction (a real abort rolls them back). */
  readonly rollbacks: Array<() => void> = [];
  private nextSession = 0;
  readonly outbox = {
    enqueue: async (_scope: unknown, input: any, session?: ClientSession) => {
      if (this.failEnqueue) throw new Error('outbox unavailable');
      if (this.rows.has(input.operationId)) throw Object.assign(new Error('dup'), { code: 11000 });
      this.log.push(`enqueue${session ? ':txn' : ':plain'}`);
      this.rows.set(input.operationId, { input, inTransaction: Boolean(session) });
      return input;
    },
  };
  readonly transaction = async <T>(work: (session: ClientSession) => Promise<T>): Promise<T> => {
    const session = { id: ++this.nextSession } as unknown as ClientSession;
    this.log.push('begin');
    const staged = new Map(this.rows);
    try {
      const out = await work(session);
      this.rollbacks.length = 0;
      this.log.push('commit');
      return out;
    } catch (error) {
      for (const undo of this.rollbacks.splice(0).reverse()) undo();
      this.rows.clear();
      for (const [key, value] of staged) this.rows.set(key, value);
      this.log.push('abort');
      throw error;
    }
  };
}

class RecordingStore extends MultiJobStore {
  constructor(private readonly recorder: Recorder) {
    super();
  }
  override async finish(
    actor: Parameters<MultiJobStore['finish']>[0],
    lease: Parameters<MultiJobStore['finish']>[1],
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
    session?: ClientSession,
  ): Promise<void> {
    this.recorder.log.push(`finish${session ? ':txn' : ':plain'}:${status}`);
    if (session) {
      const before = structuredClone(this.jobs.get(lease.jobId)!);
      this.recorder.rollbacks.push(() => void this.jobs.set(lease.jobId, before));
    }
    await super.finish(actor, lease, status, outputRefs);
  }
}

const queued = (bundle: HarnessBundle, id: string): Job =>
  makeJob(bundle, {
    _id: id,
    status: 'queued',
    binding: { ...makeJob(bundle).binding, jobId: id, runId: `run-${id}` },
    lease: { ownerId: '', fence: 0, until: new Date(0), heartbeatAt: new Date(0) },
    attempt: 0,
  });

function rig(options: {
  script: ConstructorParameters<typeof FakeChatModel>[0];
  telemetry?: Telemetry;
  recorder?: Recorder;
  receipt?: (job: Job) => CompletionReceipt;
  committed?: CommittedReader;
}) {
  const bundle = makeBundle();
  const recorder = options.recorder ?? new Recorder();
  const store = new RecordingStore(recorder);
  store.add(queued(bundle, 'job-1'));
  const fakeModel = new FakeChatModel(options.script);
  const logs: LogEntry[] = [];
  const results: JobRunResult[] = [];
  const dispatcher = new Dispatcher({
    jobs: store,
    resolver: store,
    artifacts: new FakeArtifactReader(bundle),
    tools: new FakeToolProvider(() => [
      defineTool({
        name: 'echo',
        description: 'e',
        parameters: z.object({ v: z.number(), subject: z.string().optional() }),
        execute: async () => ({ ok: true, note: 'Jane Doe lives at 1 Main St' }),
      }),
    ]),
    models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fakeModel.adapter }),
    receipts: {
      find: async (_actor, binding) => {
        const job = store.jobs.get(binding.jobId);
        return job && options.receipt ? options.receipt(job) : null;
      },
    },
    ...(options.committed ? { committed: options.committed } : {}),
    config: workerConfigFromEnv({
      EXPUNGE_WORKER_ID: 'worker-under-test',
      EXPUNGE_WORKER_LEASE_MS: '500',
      EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '2000',
    }),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    log: (entry) => logs.push(entry),
    onResult: (result) => results.push(result),
  });
  return { bundle, recorder, store, dispatcher, logs, results, fakeModel };
}

const realTelemetry = (recorder: Recorder, log?: (entry: LogEntry) => void) =>
  createTelemetry({
    tracing,
    outbox: recorder.outbox,
    transaction: recorder.transaction,
    ...(log ? { log } : {}),
  });

describe('worker telemetry (real Raindrop SDK and TanStack loop; labeled FAKE ingestion server, outbox and model)', () => {
  it('runs one job as one Raindrop episode: identity properties, model and tool spans, terminal event from committed facts', async () => {
    const recorder = new Recorder();
    const r = rig({
      recorder,
      telemetry: realTelemetry(recorder),
      script: [
        {
          ...fakeToolCalls([{ name: 'echo', args: { v: 1, subject: 'Jane Doe' } }]),
          usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        },
        {
          ...fakeText('Done. Everything is deleted.'),
          usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
        },
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed'); // no receipt: the narrative does not decide
    const job = r.store.jobs.get('job-1')!;
    const eventId = episodeEventId({
      role: 'worker',
      jobId: 'job-1',
      runId: job.binding.runId,
      attempt: job.attempt,
    });
    await waitUntil(() =>
      fake.partialEvents.some((e) => e.event_id === eventId && (e as any).is_pending === false),
    );
    const terminal = fake.partialEvents.find(
      (e) => e.event_id === eventId && (e as any).is_pending === false,
    ) as any;
    expect(terminal.properties).toMatchObject({
      run_id: job.binding.runId,
      job_id: 'job-1',
      harness_hash: job.binding.harnessHash,
      outcome: 'failed',
    });
    expect(terminal.user_id).toBe(
      telemetryUserId(
        'proj-1',
        { tenantId: job.actor.tenantId, env: job.actor.env, scopeId: job.actor.scopeId },
        'job-1',
      ),
    );
    expect(terminal.user_id).toMatch(/^u_[a-f0-9]{32}$/);
    const summary = JSON.parse(terminal.ai_data.output);
    expect(summary).toMatchObject({
      status: 'failed',
      endedBy: 'finished',
      toolCalls: 1,
      inputTokens: 16,
      outputTokens: 7,
    });
    // The model narrative never reaches Raindrop, and neither does any raw tool value.
    const everything = JSON.stringify([fake.spans, fake.partialEvents, fake.ingestEvents, fake.signalPosts]);
    expect(everything).not.toContain('Everything is deleted');
    expect(everything).not.toContain('Jane Doe');
    expect(everything).not.toContain('Main St');
    // Real GenAI model spans per provider call and a tool span, all tied to this run.
    await waitUntil(
      () => fake.spans.filter((s) => s.name.startsWith('chat fake-deterministic-1 #')).length === 2,
    );
    const toolSpan = fake.spans.find((s) => s.name === 'echo');
    expect(toolSpan).toBeDefined();
    expect(JSON.parse(String(toolSpan!.attributes['traceloop.entity.input'])).subject).toMatchObject({
      redacted: true,
    });
    for (const span of fake.spans.filter((s) => s.name.startsWith('chat fake-deterministic-1 #')))
      expect(span.attributes['traceloop.association.properties.run_id']).toBe(job.binding.runId);
  });

  it('commits the read-back intent in the SAME transaction as the terminal job state', async () => {
    const recorder = new Recorder();
    const r = rig({ recorder, telemetry: realTelemetry(recorder), script: [fakeText('narrative only')] });
    await r.dispatcher.runJob('job-1');
    const finishAt = recorder.log.indexOf('finish:txn:failed');
    expect(recorder.log).toEqual(['begin', 'finish:txn:failed', 'enqueue:txn', 'commit']);
    expect(finishAt).toBe(1);
    const [row] = [...recorder.rows.values()];
    expect(row?.inTransaction).toBe(true);
    expect(row?.input).toMatchObject({ kind: 'sdk_event', jobId: 'job-1' });
    expect(row?.input.payload).toMatchObject({ type: 'sdk_event', role: 'worker' });
    // No tool ran, so only the terminal output is promised as evidence.
    expect(row?.input.evidenceRequired).toEqual(['assistant_output']);
    // Idempotent identity: the operation id derives from kind, job and attempt.
    const job = r.store.jobs.get('job-1')!;
    expect(row?.input.operationId).toBe(
      operationIdFor({
        kind: 'sdk_event',
        jobId: 'job-1',
        discriminator: `episode:${episodeEventId({ role: 'worker', jobId: 'job-1', runId: job.binding.runId, attempt: job.attempt })}:${job.attempt}`,
      }),
    );
  });

  it('requires tool_calls evidence when the run called a tool', async () => {
    const recorder = new Recorder();
    const r = rig({
      recorder,
      telemetry: realTelemetry(recorder),
      script: [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('x')],
    });
    await r.dispatcher.runJob('job-1');
    expect([...recorder.rows.values()][0]?.input.evidenceRequired).toEqual([
      'assistant_output',
      'tool_calls',
    ]);
  });

  it('a failing outbox never strands or changes the job: the finish is retried plainly and the outcome is the same', async () => {
    const recorder = new Recorder();
    recorder.failEnqueue = true;
    const r = rig({ recorder, telemetry: realTelemetry(recorder), script: [fakeText('x')] });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed');
    expect(r.store.jobs.get('job-1')!.status).toBe('failed');
    expect(recorder.log).toEqual(['begin', 'finish:txn:failed', 'abort', 'finish:plain:failed']);
    expect(recorder.rows.size).toBe(0);
    expect(r.logs.some((l) => l.message.includes('could not commit with the job state'))).toBe(true);
  });

  it('with no telemetry configured the job runs exactly as before and nothing is written', async () => {
    const recorder = new Recorder();
    const r = rig({ recorder, script: [fakeText('x')] });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed');
    expect(recorder.log).toEqual(['finish:plain:failed']);
    expect(fake.partialEvents).toHaveLength(0);
  });

  it('runs the job exactly once and unaltered when the episode cannot be started', async () => {
    const recorder = new Recorder();
    const brokenTracing = {
      client: {
        begin: () => {
          throw new Error('sdk down');
        },
      },
      config: { projectId: 'proj-1' },
      tracer: tracing.tracer,
    } as unknown as RaindropTracing;
    const logs: LogEntry[] = [];
    const telemetry = createTelemetry({
      tracing: brokenTracing,
      outbox: recorder.outbox,
      transaction: recorder.transaction,
      log: (e) => logs.push(e),
    });
    const r = rig({ recorder, telemetry, script: [fakeText('x')] });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed');
    expect(r.fakeModel.turnsConsumed).toBe(1);
    expect(logs.some((l) => l.message.includes('could not be started'))).toBe(true);
    expect(recorder.log).toEqual(['finish:plain:failed']); // no episode, so no intent
  });
});

describe('success is reported only when it is confirmed as majority-committed (DA-6 O8)', () => {
  const receiptFor = (job: Job): CompletionReceipt => ({
    receiptId: `rcpt-${job._id}`,
    jobId: job._id,
    runId: job.binding.runId,
    harnessHash: job.binding.harnessHash,
    scopeId: job.actor.scopeId,
    scopeRevision: job.binding.scopeRevision,
    verifiedWorldRevision: 4,
    verificationPlanHash: 'c'.repeat(64),
    inspectedCollectionIds: ['customers'],
    discoveredFieldIds: ['f'],
    operationalResiduals: 0,
    excludedOrRetainedRecords: 0,
    limitations: [],
    domainStatus: 'complete_in_registered_scope',
    externalErasureStatus: 'not_required',
  });
  async function outcomeProperty(committed: CommittedReader | undefined) {
    const recorder = new Recorder();
    const r = rig({
      recorder,
      telemetry: realTelemetry(recorder),
      script: [fakeText('x')],
      receipt: receiptFor,
      ...(committed ? { committed } : {}),
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('succeeded'); // the job itself is unaffected by what telemetry can confirm
    expect(result.receiptId).toBe('rcpt-job-1');
    const job = r.store.jobs.get('job-1')!;
    const eventId = episodeEventId({
      role: 'worker',
      jobId: 'job-1',
      runId: job.binding.runId,
      attempt: job.attempt,
    });
    await waitUntil(() =>
      fake.partialEvents.some((e) => e.event_id === eventId && (e as any).is_pending === false),
    );
    const terminal = fake.partialEvents.find(
      (e) => e.event_id === eventId && (e as any).is_pending === false,
    ) as any;
    return {
      outcome: terminal.properties.outcome as string,
      receiptId: JSON.parse(terminal.ai_data.output).receiptId,
    };
  }

  it('reports succeeded when the success is confirmed', async () => {
    const asked: unknown[][] = [];
    const confirmed: CommittedReader = {
      confirmSucceeded: async (...args) => (asked.push(args), true),
    };
    expect(await outcomeProperty(confirmed)).toEqual({ outcome: 'succeeded', receiptId: 'rcpt-job-1' });
    expect(asked[0]?.slice(1)).toEqual(['job-1', 'rcpt-job-1']);
  });

  it('under-claims as aborted when the confirmation says no or fails', async () => {
    expect((await outcomeProperty({ confirmSucceeded: async () => false })).outcome).toBe('aborted');
    fake.reset();
    expect(
      (
        await outcomeProperty({
          confirmSucceeded: async () => Promise.reject(new Error('primary stepped down')),
        })
      ).outcome,
    ).toBe('aborted');
  });
});

describe('episodeSummary: committed facts only', () => {
  it('maps outcomes to the closed status set and drops free-text error codes', () => {
    const stats = { endedBy: 'finished', toolCalls: 2, phases: 2, elapsedMs: 9, release: 'none' } as const;
    expect(episodeSummary({ outcome: 'succeeded', stats, receiptId: 'rcpt-1' })).toMatchObject({
      status: 'succeeded',
      receiptId: 'rcpt-1',
      toolCalls: 2,
    });
    for (const outcome of ['lost_lease', 'aborted', 'released', 'unfinalized'] as const)
      expect(episodeSummary({ outcome, stats }).status).toBe('aborted');
    expect(episodeSummary({ outcome: 'yielded', stats }).status).toBe('yielded');
    expect(episodeSummary({ outcome: 'failed', stats, reason: 'NoCompletionReceipt' }).errorCode).toBe(
      'NoCompletionReceipt',
    );
    expect(
      episodeSummary({ outcome: 'failed', stats, reason: 'Jane Doe could not be found' }).errorCode,
    ).toBeUndefined();
  });
});

describe('carriers: only authenticated, complete, bounded carriers link an episode', () => {
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
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });
  async function wakeRig() {
    const woken: Array<{ jobId: string; carrier: unknown }> = [];
    const server = createWakeServer({
      token: TOKEN,
      store: new InMemoryWakeCommandStore(),
      readiness: () => ready,
      target: {
        canAccept: () => true,
        wake: (c, carrier) => (woken.push({ jobId: c.jobId, carrier }), true),
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, woken };
  }
  const post = (origin: string, id: string, headers: Record<string, string>) =>
    fetch(`${origin}/internal/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jobId: 'job-1', commandId: `command-${id}-0001` }),
    });
  const FULL = {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    baggage: 'a=b',
    'x-raindrop-handoff': 'handoff-token',
  };

  it('passes a complete carrier from an authenticated wake and ignores everything else', async () => {
    const { origin, woken } = await wakeRig();
    expect((await post(origin, 'a', { Authorization: `Bearer ${TOKEN}`, ...FULL })).status).toBe(202);
    expect(woken[0]?.carrier).toEqual(FULL);
    // Partial carrier: not used, but the wake itself is still accepted.
    expect(
      (await post(origin, 'b', { Authorization: `Bearer ${TOKEN}`, traceparent: FULL.traceparent })).status,
    ).toBe(202);
    expect(woken[1]?.carrier).toBeNull();
    // Oversized carrier: ignored.
    expect(
      (await post(origin, 'c', { Authorization: `Bearer ${TOKEN}`, ...FULL, baggage: 'x'.repeat(4000) }))
        .status,
    ).toBe(202);
    expect(woken[2]?.carrier).toBeNull();
    // No carrier at all is a normal, unlinked wake.
    expect((await post(origin, 'd', { Authorization: `Bearer ${TOKEN}` })).status).toBe(202);
    expect(woken[3]?.carrier).toBeNull();
  });

  it('never reads a carrier from an unauthenticated request: a forged one is rejected before it is looked at', async () => {
    const { origin, woken } = await wakeRig();
    expect((await post(origin, 'e', { ...FULL })).status).toBe(401);
    expect((await post(origin, 'f', { Authorization: 'Bearer wrong', ...FULL })).status).toBe(401);
    expect(woken).toHaveLength(0);
    expect(carrierOf({ ...FULL })).toEqual(FULL); // the helper itself is pure; authentication is the server's gate
  });

  it('links the worker episode to its dispatcher through a real carrier, and runs unlinked without one', async () => {
    const parent = Episode.begin(tracing, {
      role: 'observer',
      jobId: 'parent-1',
      runId: 'parent-run',
      attempt: 1,
      harnessHash: 'a'.repeat(64),
      telemetryUserId: 'u_00000000000000000000000000000001',
      input: 'dispatch',
    });
    const dispatched = await parent.run(async () =>
      dispatchSubagent(parent, { name: 'worker', childEventId: 'unused' }),
    );
    const carrier = carrierOf(dispatched.headers)!;
    expect(carrier).not.toBeNull();

    const spy = vi.spyOn(tracing.client, 'withSubagentRun');
    const recorder = new Recorder();
    const linkedRig = rig({ recorder, telemetry: realTelemetry(recorder), script: [fakeText('x')] });
    linkedRig.dispatcher.wake({ jobId: 'job-1', commandId: 'command-link-0001' }, carrier);
    await linkedRig.dispatcher.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toEqual(carrier);
    expect(linkedRig.results[0]?.outcome).toBe('failed');

    spy.mockClear();
    const plainRecorder = new Recorder();
    const plainRig = rig({
      recorder: plainRecorder,
      telemetry: realTelemetry(plainRecorder),
      script: [fakeText('x')],
    });
    plainRig.dispatcher.wake({ jobId: 'job-1', commandId: 'command-link-0002' });
    await plainRig.dispatcher.idle();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('readiness notes: telemetry is observed, never a blocker', () => {
  const base = {
    OPENAI_API_KEY: 'sk-test-not-real',
    EXPUNGE_MODEL: 'openai/gpt-5',
    MONGODB_DOMAIN_EXECUTOR_URI: 'mongodb://localhost/x',
    EXPUNGE_WAKE_TOKEN: 'wake-token-for-tests-0123456789abcdef',
    EXPUNGE_TENANT_ID: 't',
    EXPUNGE_ENV: 'evaluation',
    EXPUNGE_SCOPE_ID: 's',
  };
  it('names the missing variables, leaves lines and status alone, and reports enabled when configured', () => {
    const without = checkReadiness(base, { domainToolsAvailable: true });
    expect(without.notes?.[0]).toContain('RAINDROP_API_KEY, RAINDROP_PROJECT_ID');
    expect(without.notes?.[0]).not.toContain('sk-test');
    const withTelemetry = checkReadiness(
      { ...base, RAINDROP_API_KEY: 'k', RAINDROP_PROJECT_ID: 'p' },
      { domainToolsAvailable: true },
    );
    expect(withTelemetry.notes?.[0]).toContain('enabled');
    expect(withTelemetry.status).toBe(without.status);
    expect(withTelemetry.lines).toEqual(without.lines);
    expect(JSON.stringify(withTelemetry)).not.toMatch(/"k"|RAINDROP_API_KEY":/);
  });
});

describe('createTelemetryWiring', () => {
  const service = { control: {}, transaction: async () => undefined } as unknown as MongoService;
  it('is disabled, naming only the missing variables, when Raindrop is not configured', () => {
    const wiring = createTelemetryWiring({ RAINDROP_API_KEY: 'secret-write-key' }, service);
    expect(wiring).toEqual({ enabled: false, missing: ['RAINDROP_PROJECT_ID'] });
    expect(JSON.stringify(wiring)).not.toContain('secret-write-key');
    expect(createTelemetryWiring({}, service)).toEqual({
      enabled: false,
      missing: ['RAINDROP_API_KEY', 'RAINDROP_PROJECT_ID'],
    });
  });

  it('is enabled from the environment (including the ingestion URL override) and closes the tracing it opened', async () => {
    const wiring = createTelemetryWiring(
      {
        RAINDROP_API_KEY: fake.keys().writeKey,
        RAINDROP_PROJECT_ID: 'proj-1',
        RAINDROP_INGEST_URL: fake.ingestUrl,
      },
      service,
    );
    expect(wiring.enabled).toBe(true);
    if (!wiring.enabled) return;
    expect(typeof wiring.telemetry.episode).toBe('function');
    expect(wiring.telemetry.atomically).toBeDefined();
    await wiring.close();
  });
});
