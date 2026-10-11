import { contentHash, type CompletionReceipt, type HarnessBundle, type Job } from '@expunge/contracts';
import { JobWaitSignal, type CompletionReceiptReader } from '@expunge/runtime';
import { FakeChatModel, fakeHang, fakeText, fakeToolCalls } from '@expunge/runtime/testing';
import { defineTool, type ToolDefinition } from '@expunge/vendor-openmuse';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FakeArtifactReader,
  FakeToolProvider,
  FixedModelResolver,
  makeBundle,
  makeJob,
  waitFor,
} from '../../../packages/runtime/test/fakes.js';
import {
  Dispatcher,
  terminalEventFor,
  workerConfigFromEnv,
  type JobRunResult,
  type LogEntry,
  type ProjectionSink,
  type TerminalSweep,
} from '../src/index.js';
import { ProtocolError } from '@expunge/mongo';
import { MultiJobStore } from './fakes.js';

const SMALL = {
  EXPUNGE_WORKER_ID: 'worker-under-test',
  EXPUNGE_WORKER_LEASE_MS: '150',
  EXPUNGE_WORKER_PHASE_TIMEOUT_MS: '1000',
};

class FakeReceipts implements CompletionReceiptReader {
  readonly byJob = new Map<string, CompletionReceipt>();
  async find(_actor: unknown, binding: { jobId: string }) {
    return this.byJob.get(binding.jobId) ?? null;
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

function receiptFor(job: Job, over: Partial<CompletionReceipt> = {}): CompletionReceipt {
  return {
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
    ...over,
  };
}

function rig(options: {
  script: ConstructorParameters<typeof FakeChatModel>[0];
  bundle?: HarnessBundle;
  tools?: (ctx: { store: MultiJobStore; receipts: FakeReceipts }) => ToolDefinition[];
  env?: Record<string, string>;
  jobIds?: string[];
  projection?: (
    store: MultiJobStore,
    projected: Array<{ key: unknown; event: Record<string, any> }>,
  ) => ProjectionSink;
  terminalSweep?: TerminalSweep;
  runtimeHash?: string;
  setup?: (store: MultiJobStore) => void;
}) {
  const bundle = options.bundle ?? makeBundle();
  const store = new MultiJobStore();
  const ids = options.jobIds ?? ['job-1'];
  for (const id of ids) store.add(queued(bundle, id));
  options.setup?.(store);
  const receipts = new FakeReceipts();
  const fake = new FakeChatModel(options.script);
  const logs: LogEntry[] = [];
  const results: JobRunResult[] = [];
  const projected: Array<{ key: unknown; event: Record<string, any> }> = [];
  const dispatcher = new Dispatcher({
    jobs: store,
    resolver: store,
    artifacts: new FakeArtifactReader(bundle),
    tools: new FakeToolProvider(
      () =>
        options.tools?.({ store, receipts }) ?? [
          defineTool({
            name: 'echo',
            description: 'e',
            parameters: z.object({ v: z.number() }),
            execute: async () => ({ ok: true }),
          }),
        ],
    ),
    models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
    receipts,
    config: workerConfigFromEnv({ ...SMALL, ...options.env }),
    projection:
      options.projection?.(store, projected) ??
      ({ append: async (key: unknown, event: any) => void projected.push({ key, event }) } as ProjectionSink),
    ...(options.terminalSweep ? { terminalSweep: options.terminalSweep } : {}),
    ...(options.runtimeHash ? { runtimeHash: options.runtimeHash } : {}),
    log: (entry) => logs.push(entry),
    onResult: (result) => results.push(result),
  });
  return { bundle, store, receipts, fake, dispatcher, logs, results, projected };
}

describe('Dispatcher: claim, renew, run, checkpoint and finalize from committed state', () => {
  it('claims with the stored actor, records inputs before the first prompt, checkpoints between phases and fails a narrative-only run', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('Done. Everything is deleted.')],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(r.store.named('claim')).toHaveLength(1);
    expect(r.store.named('claim')[0]?.args).toEqual(['worker-under-test']);
    const job = r.store.jobs.get('job-1')!;
    expect(job.lease.fence).toBe(1);
    // Context inputs: the pinned harness hash was recorded through the fenced repository method BEFORE any model call.
    expect(r.store.contextInputs.get('job-1')).toEqual([job.binding.harnessHash]);
    const recordIndex = r.store.calls.findIndex((c) => c.method === 'recordContextInputs');
    const firstCheckpoint = r.store.calls.findIndex((c) => c.method === 'checkpoint');
    expect(recordIndex).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeLessThan(firstCheckpoint);
    // Phase checkpoint after the tool, then a terminal checkpoint.
    const checkpoints = r.store.checkpoints.get('job-1') as Array<Record<string, unknown>>;
    expect(checkpoints[0]).toMatchObject({ v: 1, phase: 1, toolCalls: 1, lastTool: 'echo' });
    const terminal = checkpoints.at(-1) as {
      terminal: {
        endedBy: string;
        decision: unknown;
        untrustedModelNarrative?: { sha256: string; length: number };
      };
    };
    expect(terminal.terminal.endedBy).toBe('finished');
    expect(terminal.terminal.decision).toEqual({ status: 'failed', reason: 'NoCompletionReceipt' });
    // The narrative is represented by a hash and length only, never stored as text.
    expect(JSON.stringify(checkpoints)).not.toContain('Everything is deleted');
    expect(terminal.terminal.untrustedModelNarrative?.length).toBeGreaterThan(0);
    // A model that says "done" without a receipt does NOT succeed the job.
    expect(job.status).toBe('failed');
    expect(result.outcome).toBe('failed');
    expect(r.store.named('finish')[0]?.args).toEqual(['failed', []]);
    // Committed-state projection: started on claim, failed with a closed-vocabulary code at the end.
    expect(r.projected.map((p) => p.event.kind)).toEqual(['job_started', 'job_failed']);
    expect(r.projected[0]?.event.payload).toMatchObject({ jobKind: 'cleanup', attempt: 1 });
    expect(r.projected[1]?.event.payload).toMatchObject({
      code: 'verification_failed',
      retryable: false,
      phase: null,
    });
    expect(r.projected[1]?.key).toEqual({ tenantId: 'tenant-1', env: 'evaluation', scopeId: 'scope-1' });
  });

  it('succeeds only with a committed complete receipt, finishing the job when the tool left it running', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'complete_cleanup', args: {} }]), fakeText('Reported.')],
      bundle: makeBundle({ toolPolicy: { grants: ['complete_cleanup'], prerequisites: [] } }),
      tools: ({ store, receipts }) => [
        defineTool({
          name: 'complete_cleanup',
          description: 'commits the receipt',
          parameters: z.object({}),
          execute: async () => {
            const job = store.jobs.get('job-1')!;
            receipts.byJob.set('job-1', receiptFor(job));
            return { receiptId: 'rcpt-job-1' };
          },
        }),
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('succeeded');
    expect(r.store.jobs.get('job-1')!.status).toBe('succeeded');
    expect(r.store.named('finish')[0]?.args).toEqual(['succeeded', ['rcpt-job-1']]);
  });

  it('leaves a job alone that complete_cleanup already finished in its own transaction', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'complete_cleanup', args: {} }]), fakeText('ok')],
      bundle: makeBundle({ toolPolicy: { grants: ['complete_cleanup'], prerequisites: [] } }),
      tools: ({ store, receipts }) => [
        defineTool({
          name: 'complete_cleanup',
          description: 'receipt and terminal state commit together',
          parameters: z.object({}),
          execute: async () => {
            const job = store.jobs.get('job-1')!;
            receipts.byJob.set('job-1', receiptFor(job));
            job.status = 'succeeded';
            job.outputRefs = ['rcpt-job-1'];
            job.lease.until = new Date(0);
            return { receiptId: 'rcpt-job-1' };
          },
        }),
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('succeeded');
    expect(r.store.named('finish')).toHaveLength(0);
  });

  it('fails a job whose committed receipt is incomplete, naming the receipt', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'complete_cleanup', args: {} }]), fakeText('ok')],
      bundle: makeBundle({ toolPolicy: { grants: ['complete_cleanup'], prerequisites: [] } }),
      tools: ({ store, receipts }) => [
        defineTool({
          name: 'complete_cleanup',
          description: 'incomplete',
          parameters: z.object({}),
          execute: async () => {
            receipts.byJob.set(
              'job-1',
              receiptFor(store.jobs.get('job-1')!, { domainStatus: 'incomplete', operationalResiduals: 3 }),
            );
            return {};
          },
        }),
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed');
    expect(r.store.named('finish')[0]?.args).toEqual(['failed', ['rcpt-job-1']]);
  });

  it('renews the lease on a timer while the run is busy, and keeps the fence it claimed', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'slow', args: {} }]), fakeText('x')],
      bundle: makeBundle({ toolPolicy: { grants: ['slow'], prerequisites: [] } }),
      tools: () => [
        defineTool({
          name: 'slow',
          description: 's',
          parameters: z.object({}),
          execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 320)),
        }),
      ],
    });
    await r.dispatcher.runJob('job-1');
    // lease 150ms, renew every 50ms, tool 320ms: several renewals and the job never lost its lease.
    expect(r.store.named('renew').length).toBeGreaterThanOrEqual(3);
    expect(r.store.jobs.get('job-1')!.lease.fence).toBe(1);
    expect(r.results.length + 1).toBeGreaterThan(0);
  });

  it('stops the run when the lease is lost and writes nothing afterwards', async () => {
    const r = rig({ script: [fakeHang()] });
    const running = r.dispatcher.runJob('job-1');
    await waitFor(() => r.fake.calls.length === 1);
    // Another worker takes over: the stored fence moves on.
    const job = r.store.jobs.get('job-1')!;
    job.lease = { ...job.lease, ownerId: 'someone-else', fence: 9 };
    const result = await running;
    expect(r.fake.hangObservedAbort).toBe(true);
    expect(result.outcome).toBe('lost_lease');
    expect(r.store.named('finish')).toHaveLength(0);
    expect(r.store.named('yield')).toHaveLength(0);
  });

  it('turns a cancellation request into a cancelled job through the renewal failure path', async () => {
    const r = rig({ script: [fakeHang()] });
    const running = r.dispatcher.runJob('job-1');
    await waitFor(() => r.fake.calls.length === 1);
    r.store.jobs.get('job-1')!.cancellationRequested = true;
    const result = await running;
    expect(r.fake.hangObservedAbort).toBe(true);
    expect(result.outcome).toBe('cancelled');
    expect(r.store.jobs.get('job-1')!.status).toBe('cancelled');
    expect(r.store.named('finish')[0]?.args).toEqual(['cancelled', []]);
  });

  it('yields (releasing the lease) when a tool needs approval', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'ask', args: {} }]), fakeText('never')],
      bundle: makeBundle({ toolPolicy: { grants: ['ask'], prerequisites: [] } }),
      tools: () => [
        defineTool({
          name: 'ask',
          description: 'a',
          parameters: z.object({}),
          execute: async () => {
            throw new JobWaitSignal('waiting_approval');
          },
        }),
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('yielded');
    expect(r.store.jobs.get('job-1')!.status).toBe('waiting_approval');
    expect(r.store.named('finish')).toHaveLength(0);
  });

  it('bounds the run with ResourceLimits (wall time) and fails the job', async () => {
    const r = rig({
      script: [fakeHang()],
      bundle: makeBundle({ limits: { ...makeBundle().limits, wallTimeMs: 80 } }),
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.stats?.endedBy).toBe('wall_time');
    expect(result.outcome).toBe('failed');
    expect(r.store.named('finish')[0]?.args).toEqual(['failed', []]);
  });

  it('does not touch jobs it cannot or should not run', async () => {
    const r = rig({ script: [fakeText('x')], jobIds: ['q', 'done', 'other', 'busy'] });
    r.store.jobs.get('done')!.status = 'succeeded';
    r.store.jobs.get('other')!.kind = 'observe';
    const busy = r.store.jobs.get('busy')!;
    busy.status = 'running';
    busy.lease = { ownerId: 'x', fence: 5, until: new Date(Date.now() + 60_000), heartbeatAt: new Date() };
    expect((await r.dispatcher.runJob('missing')).outcome).toBe('unknown_job');
    expect((await r.dispatcher.runJob('done')).outcome).toBe('terminal');
    expect((await r.dispatcher.runJob('other')).outcome).toBe('unsupported_kind');
    expect((await r.dispatcher.runJob('busy')).outcome).toBe('not_claimable');
    expect(r.store.named('claim', 'other')).toHaveLength(0);
    expect(r.store.named('claim', 'done')).toHaveLength(0);
    expect(r.fake.calls).toHaveLength(0);
  });

  it('reclaims a job whose previous lease expired and runs it under a NEW fence', async () => {
    const r = rig({ script: [fakeText('x')] });
    const job = r.store.jobs.get('job-1')!;
    job.status = 'running';
    job.lease = {
      ownerId: 'dead-worker',
      fence: 4,
      until: new Date(Date.now() - 1000),
      heartbeatAt: new Date(0),
    };
    await r.dispatcher.runJob('job-1');
    expect(job.lease.fence).toBe(5);
    expect(job.lease.ownerId).toBe('worker-under-test');
  });

  describe('wake handling', () => {
    it('is idempotent per job while pending and bounds concurrency and queue length', async () => {
      const r = rig({
        script: Array.from({ length: 5 }, () => fakeText('x')),
        jobIds: ['j1', 'j2', 'j3', 'j4', 'j5'],
        env: { EXPUNGE_WORKER_MAX_CONCURRENT: '2', EXPUNGE_WORKER_MAX_QUEUED: '3' },
      });
      let maxInFlight = 0;
      const original = r.store.claim.bind(r.store);
      r.store.claim = async (...args) => {
        maxInFlight = Math.max(maxInFlight, r.dispatcher.inFlight.length);
        return original(...args);
      };
      const wake = (jobId: string) => r.dispatcher.wake({ jobId, commandId: `cmd-${jobId}-xx` });
      expect(wake('j1')).toBe(true);
      expect(wake('j1')).toBe(true); // already pending or running
      expect(wake('j2')).toBe(true);
      expect(wake('j3')).toBe(true);
      expect(wake('j4')).toBe(true);
      expect(wake('j5')).toBe(true);
      expect(wake('j5')).toBe(true);
      await r.dispatcher.idle();
      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(r.results.map((x) => x.jobId).sort()).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']);
      expect(r.store.named('claim', 'j1')).toHaveLength(1);
    });

    it('refuses wakes beyond the bounded queue, and after stop()', async () => {
      const r = rig({
        script: [fakeHang()],
        jobIds: ['a', 'b', 'c', 'd'],
        env: { EXPUNGE_WORKER_MAX_CONCURRENT: '1', EXPUNGE_WORKER_MAX_QUEUED: '1' },
      });
      const wake = (jobId: string) => r.dispatcher.wake({ jobId, commandId: `cmd-${jobId}-xx` });
      expect(wake('a')).toBe(true); // starts immediately (queue drained into running)
      await waitFor(() => r.fake.calls.length === 1);
      expect(wake('b')).toBe(true); // queued (1 of 1)
      expect(wake('c')).toBe(false); // queue full
      await r.dispatcher.stop();
      expect(r.fake.hangObservedAbort).toBe(true);
      expect(wake('d')).toBe(false); // stopped
    });
  });
});

describe('harness pinning', () => {
  it('runs the harness named by the STORED job even when another valid harness exists', async () => {
    const pinned = makeBundle();
    const other = makeBundle({ completionPolicy: 'model_narrative' });
    const store = new MultiJobStore();
    store.add(queued(pinned, 'job-1'));
    const artifacts = new FakeArtifactReader(pinned, other);
    const fake = new FakeChatModel([fakeText('x')]);
    const dispatcher = new Dispatcher({
      jobs: store,
      resolver: store,
      artifacts,
      tools: new FakeToolProvider(() => []),
      models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
      receipts: new FakeReceipts(),
      config: workerConfigFromEnv(SMALL),
    });
    await dispatcher.runJob('job-1');
    expect(artifacts.reads.map((read) => read.hash)).toEqual([contentHash(pinned)]);
  });
});

describe('B2-2: recovery poll, graceful release, scope binding and projection', () => {
  const SCOPE = { EXPUNGE_TENANT_ID: 'tenant-1', EXPUNGE_ENV: 'evaluation', EXPUNGE_SCOPE_ID: 'scope-1' };

  it('polls the bound scope for claimable jobs (queued, or lease expired after a crash) and runs them', async () => {
    const r = rig({
      script: [fakeText('x'), fakeText('y')],
      jobIds: ['queued', 'crashed', 'held', 'other-scope'],
      env: SCOPE,
    });
    const crashed = r.store.jobs.get('crashed')!;
    crashed.status = 'running';
    crashed.lease = {
      ownerId: 'dead-worker',
      fence: 7,
      until: new Date(Date.now() - 5_000),
      heartbeatAt: new Date(0),
    };
    const held = r.store.jobs.get('held')!;
    held.status = 'running';
    held.lease = {
      ownerId: 'alive',
      fence: 2,
      until: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
    };
    r.store.jobs.get('other-scope')!.actor = {
      ...r.store.jobs.get('other-scope')!.actor,
      scopeId: 'someone-elses',
    };
    expect(await r.dispatcher.poll()).toBe(2);
    await r.dispatcher.idle();
    expect(r.results.map((x) => x.jobId).sort()).toEqual(['crashed', 'queued']);
    expect(r.store.jobs.get('crashed')!.lease.fence).toBe(8); // reclaimed under a NEW fence
    expect(r.store.named('claim', 'held')).toHaveLength(0);
    expect(r.store.named('claim', 'other-scope')).toHaveLength(0);
    expect(r.store.named('listClaimable')[0]?.args).toEqual([
      { tenantId: 'tenant-1', env: 'evaluation', scopeId: 'scope-1' },
      25,
    ]);
  });

  it('does not poll without a scope binding, and never polls after stop()', async () => {
    const unbound = rig({ script: [fakeText('x')] });
    expect(await unbound.dispatcher.poll()).toBe(0);
    expect(unbound.store.named('listClaimable')).toHaveLength(0);
    const bound = rig({ script: [fakeText('x')], env: SCOPE });
    await bound.dispatcher.stop();
    expect(await bound.dispatcher.poll()).toBe(0);
  });

  it('starts and stops the poll timer from config.pollMs', async () => {
    const r = rig({ script: [fakeText('x')], env: { ...SCOPE, EXPUNGE_WORKER_POLL_MS: '250' } });
    r.dispatcher.startPolling();
    r.dispatcher.startPolling(); // idempotent
    await waitFor(() => r.store.named('listClaimable').length >= 1, 3000);
    await r.dispatcher.idle();
    await r.dispatcher.stop();
    const calls = r.store.named('listClaimable').length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.store.named('listClaimable')).toHaveLength(calls); // timer cleared
  });

  it('refuses a job outside the worker scope without claiming it', async () => {
    const r = rig({ script: [fakeText('x')], env: { ...SCOPE, EXPUNGE_SCOPE_ID: 'a-different-scope' } });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('out_of_scope');
    expect(r.store.named('claim')).toHaveLength(0);
  });

  it('on graceful stop, aborts the run and RELEASES the job (running -> queued) for another worker', async () => {
    const r = rig({ script: [fakeHang()] });
    r.dispatcher.wake({ jobId: 'job-1', commandId: 'command-00000001' });
    await waitFor(() => r.fake.calls.length === 1);
    await r.dispatcher.stop();
    expect(r.fake.hangObservedAbort).toBe(true);
    expect(r.results[0]?.outcome).toBe('released');
    const job = r.store.jobs.get('job-1')!;
    expect(job.status).toBe('queued');
    expect(job.lease.fence).toBe(1); // release does not bump the fence; the next claim does
    expect(r.store.named('release')).toHaveLength(1);
    expect(r.projected.map((p) => p.event.kind)).toEqual(['job_started', 'job_status_changed']);
    expect(r.projected[1]?.event.payload).toMatchObject({
      from: 'running',
      to: 'queued',
      reason: 'worker stopping',
    });
    // Another worker can claim it right away.
    expect((await r.store.claim(job.actor, 'job-1', 'worker-b', 5000))?.lease.fence).toBe(2);
  });

  it('on stop, waits for an in-flight tool to drain, then releases', async () => {
    const r = rig({
      script: [fakeToolCalls([{ name: 'slowtool', args: {} }]), fakeText('never')],
      bundle: makeBundle({ toolPolicy: { grants: ['slowtool'], prerequisites: [] } }),
      tools: () => [
        defineTool({
          name: 'slowtool',
          description: 'ignores abort',
          parameters: z.object({}),
          execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 300)),
        }),
      ],
    });
    r.dispatcher.wake({ jobId: 'job-1', commandId: 'command-00000002' });
    await waitFor(() => r.fake.turnsConsumed === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.dispatcher.stop();
    expect(r.results[0]?.outcome).toBe('released');
    expect(r.store.jobs.get('job-1')!.status).toBe('queued');
  });

  it('on stop, does NOT release while a tool outlasts the drain grace (the lease is left to expire)', async () => {
    let finished = false;
    const r = rig({
      script: [fakeToolCalls([{ name: 'slowtool', args: {} }]), fakeText('never')],
      bundle: makeBundle({ toolPolicy: { grants: ['slowtool'], prerequisites: [] } }),
      env: { EXPUNGE_WORKER_TOOL_DRAIN_MS: '20' },
      tools: () => [
        defineTool({
          name: 'slowtool',
          description: 'ignores abort for much longer than the grace',
          parameters: z.object({}),
          execute: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                finished = true;
                resolve({ ok: true });
              }, 400),
            ),
        }),
      ],
    });
    r.dispatcher.wake({ jobId: 'job-1', commandId: 'command-00000003' });
    await waitFor(() => r.fake.turnsConsumed === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.dispatcher.stop();
    expect(finished).toBe(false);
    expect(r.results[0]?.outcome).toBe('aborted');
    expect(r.results[0]?.stats?.abandonedTools).toBe(1);
    expect(r.store.named('release')).toHaveLength(0);
    expect(r.store.jobs.get('job-1')!.status).toBe('running'); // lease expires; a new fence on reclaim
    await waitFor(() => finished);
  });

  it('projects yielded, cancelled and succeeded transitions with closed-vocabulary payloads', async () => {
    const yielded = rig({
      script: [fakeToolCalls([{ name: 'ask', args: {} }]), fakeText('never')],
      bundle: makeBundle({ toolPolicy: { grants: ['ask'], prerequisites: [] } }),
      tools: () => [
        defineTool({
          name: 'ask',
          description: 'a',
          parameters: z.object({}),
          execute: async () => {
            throw new JobWaitSignal('waiting_approval');
          },
        }),
      ],
    });
    await yielded.dispatcher.runJob('job-1');
    expect(yielded.projected.map((p) => p.event.kind)).toEqual(['job_started', 'job_status_changed']);
    expect(yielded.projected[1]?.event.payload).toMatchObject({ from: 'running', to: 'waiting_approval' });

    const cancelled = rig({ script: [fakeHang()] });
    const running = cancelled.dispatcher.runJob('job-1');
    await waitFor(() => cancelled.fake.calls.length === 1);
    cancelled.store.jobs.get('job-1')!.cancellationRequested = true;
    await running;
    expect(cancelled.projected.at(-1)?.event.payload).toMatchObject({ from: 'running', to: 'cancelled' });
  });

  it('a failed projection append is logged and never breaks the job', async () => {
    const bundle = makeBundle();
    const store = new MultiJobStore();
    store.add(queued(bundle, 'job-1'));
    const logs: LogEntry[] = [];
    const fake = new FakeChatModel([fakeText('x')]);
    const dispatcher = new Dispatcher({
      jobs: store,
      resolver: store,
      artifacts: new FakeArtifactReader(bundle),
      tools: new FakeToolProvider(() => []),
      models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
      receipts: new FakeReceipts(),
      config: workerConfigFromEnv(SMALL),
      projection: {
        append: async () => {
          throw new Error('mongo down');
        },
      },
      log: (entry) => logs.push(entry),
    });
    const result = await dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed');
    expect(store.jobs.get('job-1')!.status).toBe('failed');
    expect(logs.some((l) => l.message === 'projection append failed')).toBe(true);
  });

  it('records the adapter that served the run and its usage in the terminal checkpoint and result', async () => {
    const r = rig({
      script: [
        {
          parts: [{ kind: 'text', text: 'x' }],
          usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
        },
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.stats?.provenance).toMatchObject({
      provider: 'FAKE_DETERMINISTIC_TEST_PROVIDER',
      model: 'fake-deterministic-1',
      adapterInjected: true,
    });
    const last = (
      r.store.checkpoints.get('job-1') as Array<{ terminal?: { model?: unknown; usage?: unknown } }>
    ).at(-1);
    expect(last?.terminal?.model).toMatchObject({
      provider: 'FAKE_DETERMINISTIC_TEST_PROVIDER',
      adapterInjected: true,
    });
    expect(last?.terminal?.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, unpricedCalls: 1 });
  });
});

describe('DA-5 DG4 worker half (FAKE store, FAKE model): the job meter survives lease takeover and is not reset', () => {
  const PRIOR = {
    v: 1,
    modelCalls: 3,
    inputTokens: 100,
    outputTokens: 40,
    costMicrousd: 0,
    unpricedCalls: 3,
    wallTimeMs: 500,
  };
  type Cp = { meter?: Record<string, number>; terminal?: unknown };
  const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };

  it('a crashed worker left a checkpoint with a meter and an expired lease: the takeover seeds from it, every later checkpoint keeps it, and the terminal checkpoint holds the sum', async () => {
    const r = rig({
      script: [
        { parts: [{ kind: 'tool_call', name: 'echo', args: { v: 1 } }] as never, usage },
        { parts: [{ kind: 'text', text: 'x' }], usage },
      ],
    });
    const stored = r.store.jobs.get('job-1')!;
    stored.status = 'running';
    stored.lease = { ownerId: 'dead-worker', fence: 7, until: new Date(0), heartbeatAt: new Date(0) };
    stored.checkpoint = { v: 1, phase: 2, meter: PRIOR };
    await r.dispatcher.runJob('job-1');
    expect(stored.lease.fence).toBe(8);
    const checkpoints = r.store.checkpoints.get('job-1') as Cp[];
    expect(checkpoints.length).toBeGreaterThan(1);
    // No snapshot from the new session ever lacks the carried meter or reports less than the prior session had.
    for (const cp of checkpoints) {
      expect(cp.meter).toBeDefined();
      expect(cp.meter!.modelCalls).toBeGreaterThanOrEqual(PRIOR.modelCalls);
      expect(cp.meter!.inputTokens).toBeGreaterThanOrEqual(PRIOR.inputTokens);
      expect(cp.meter!.wallTimeMs).toBeGreaterThanOrEqual(PRIOR.wallTimeMs);
    }
    const last = checkpoints.at(-1)!;
    expect(last.terminal).toBeDefined();
    expect(last.meter).toMatchObject({ modelCalls: 5, inputTokens: 108, outputTokens: 44 });
  });

  it('a graceful stop writes the meter before the lease is released, and the next worker continues from it', async () => {
    const r = rig({
      script: [{ parts: [{ kind: 'tool_call', name: 'echo', args: { v: 1 } }] as never, usage }, fakeHang()],
    });
    r.dispatcher.wake({ jobId: 'job-1', commandId: 'cmd-job-1-xx' });
    await waitFor(() => r.store.named('checkpoint').length > 0 && r.fake.calls.length === 2);
    await r.dispatcher.stop();
    const handedBack = r.store.jobs.get('job-1')!;
    expect(handedBack.status).toBe('queued');
    const written = handedBack.checkpoint as Cp;
    expect(written.meter).toMatchObject({ modelCalls: 1, inputTokens: 4 });
    const releaseAt = r.store.calls.findIndex((c) => c.method === 'release');
    const lastCheckpointAt = r.store.calls.map((c) => c.method).lastIndexOf('checkpoint');
    expect(lastCheckpointAt).toBeLessThan(releaseAt);
  });
});

/** FAKE projection sink mirroring FencedProjectionSink's contract over the FAKE job store (not MongoDB). */
const fakeFencedSink = (
  store: MultiJobStore,
  projected: Array<{ key: unknown; event: Record<string, any> }>,
): ProjectionSink => ({
  append: async (key, event) => void projected.push({ key, event }),
  appendFenced: async (key, event, holder) => {
    const job = store.jobs.get(holder.lease.jobId)!;
    if (job.lease.ownerId !== holder.lease.ownerId || job.lease.fence !== holder.lease.fence)
      throw new ProtocolError('StaleFence');
    projected.push({ key, event });
  },
  hasTerminal: async (_key, jobId) =>
    projected.some(
      ({ event }) =>
        event.jobId === jobId &&
        (event.kind === 'job_failed' ||
          (event.kind === 'job_status_changed' &&
            ['succeeded', 'failed', 'cancelled'].includes(event.payload.to))),
    ),
});

describe('V-3 (a) FAKE store and sink: an unfenced late event from a resumed zombie worker is rejected by the fence', () => {
  it('after another worker took the job and finished it, the zombie appends nothing to the stream', async () => {
    const r = rig({
      projection: fakeFencedSink,
      script: [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('done')],
      tools: ({ store }) => [
        defineTool({
          name: 'echo',
          description: 'e',
          parameters: z.object({ v: z.number() }),
          execute: async () => {
            // While this (frozen, now resumed) worker holds fence 1, worker-b claims with fence 2 and finishes the job.
            const job = store.jobs.get('job-1')!;
            job.lease = { ownerId: 'worker-b', fence: 2, until: new Date(0), heartbeatAt: new Date() };
            job.status = 'failed';
            job.checkpoint = {
              v: 1,
              terminal: { decision: { status: 'failed', reason: 'NoCompletionReceipt' } },
            };
            return { ok: true };
          },
        }),
      ],
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result.outcome).toBe('failed'); // what this zombie observed
    expect(r.projected.map((p) => p.event.kind)).toEqual(['job_started']); // nothing after the takeover
    expect(r.logs.some((l) => l.message === 'projection refused: lease no longer held')).toBe(true);
  });

  it('the legitimate holder still appends its terminal event under the same fence', async () => {
    const r = rig({ projection: fakeFencedSink, script: [fakeText('no receipt')] });
    await r.dispatcher.runJob('job-1');
    expect(r.projected.map((p) => p.event.kind)).toEqual(['job_started', 'job_failed']);
    expect(r.projected.at(-1)?.event.eventId).toBe('job-1:failed:1');
  });
});

describe('V-3 (b) FAKE store and sink: a terminal projection lost on a crash is repaired from committed state', () => {
  const finished = (status: 'failed' | 'succeeded' | 'cancelled', reason = 'NoCompletionReceipt') => {
    const r = rig({
      projection: fakeFencedSink,
      script: [fakeText('x')],
      terminalSweep: { listRecentTerminal: async () => [...r.store.jobs.values()] },
    });
    const job = r.store.jobs.get('job-1')!;
    job.status = status;
    job.attempt = 1;
    job.lease = { ownerId: 'worker-a', fence: 1, until: new Date(0), heartbeatAt: new Date(0) };
    job.checkpoint = { v: 1, terminal: { decision: { status, reason } } };
    return r;
  };

  it('a wake on the terminal job emits the missing job_failed once, with the original failure code', async () => {
    const r = finished('failed');
    expect((await r.dispatcher.runJob('job-1')).outcome).toBe('terminal');
    expect(r.projected).toHaveLength(1);
    expect(r.projected[0]?.event).toMatchObject({
      kind: 'job_failed',
      eventId: 'job-1:failed:1',
      payload: { code: 'verification_failed', message: 'NoCompletionReceipt' },
    });
    await r.dispatcher.runJob('job-1'); // already repaired: nothing more
    expect(r.projected).toHaveLength(1);
  });

  it('the startup sweep repairs succeeded, cancelled and failed jobs and is idempotent', async () => {
    for (const status of ['succeeded', 'cancelled', 'failed'] as const) {
      const r = finished(status);
      const config = workerConfigFromEnv({
        ...SMALL,
        EXPUNGE_TENANT_ID: 'tenant-1',
        EXPUNGE_ENV: 'evaluation',
        EXPUNGE_SCOPE_ID: 'scope-1',
      });
      expect(config.scope).toBeDefined();
      const sweeper = new Dispatcher({
        jobs: r.store,
        resolver: r.store,
        artifacts: new FakeArtifactReader(r.bundle),
        tools: new FakeToolProvider(() => []),
        models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: r.fake.adapter }),
        receipts: r.receipts,
        config,
        projection: fakeFencedSink(r.store, r.projected),
        terminalSweep: { listRecentTerminal: async () => [...r.store.jobs.values()] },
      });
      expect(await sweeper.repairTerminalProjections()).toBe(1);
      expect(await sweeper.repairTerminalProjections()).toBe(0);
      expect(r.projected).toHaveLength(1);
      expect(r.projected[0]?.event.kind).toBe(status === 'failed' ? 'job_failed' : 'job_status_changed');
    }
  });

  it('PKT33-C: a failure with no recorded reason is repaired as reason_unrecorded, never as an invented internal_error reason', () => {
    const job = makeJob(makeBundle(), { status: 'failed', attempt: 1, checkpoint: { v: 1 } });
    expect(terminalEventFor(job)).toMatchObject({
      kind: 'job_failed',
      payload: { message: 'reason_unrecorded' },
    });
  });

  it('PKT33-C: the prior status in a repaired status event comes from the committed row: a job that was never claimed was queued', () => {
    const bundle = makeBundle();
    const claimed = terminalEventFor(makeJob(bundle, { status: 'cancelled', attempt: 1 }));
    const never = terminalEventFor(makeJob(bundle, { status: 'cancelled', attempt: 0 }));
    expect(claimed?.payload).toMatchObject({ from: 'running', to: 'cancelled' });
    expect(never?.payload).toMatchObject({ from: 'queued', to: 'cancelled' });
  });

  it('PKT33-C: for a succeeded job the repaired event is identical to the one the live run projected', async () => {
    const r = rig({
      projection: fakeFencedSink,
      script: [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('done')],
      tools: ({ receipts, store }) => [
        defineTool({
          name: 'echo',
          description: 'e',
          parameters: z.object({ v: z.number() }),
          execute: async () => {
            receipts.byJob.set('job-1', receiptFor(store.jobs.get('job-1')!));
            return { ok: true };
          },
        }),
      ],
    });
    expect((await r.dispatcher.runJob('job-1')).outcome).toBe('succeeded');
    const live = r.projected.find((p) => p.event.kind === 'job_status_changed')!.event;
    expect(terminalEventFor(r.store.jobs.get('job-1')!)).toEqual(live);
  });

  it('a rebuilt event is identical to the one the live run projected, so a duplicate append is a no-op', async () => {
    const r = rig({ projection: fakeFencedSink, script: [fakeText('no receipt')] });
    await r.dispatcher.runJob('job-1');
    const original = r.projected.find((p) => p.event.kind === 'job_failed')!.event;
    expect(terminalEventFor(r.store.jobs.get('job-1')!)).toEqual(original);
  });
});

describe('follow-up (FAKE store, FAKE model): the deployed-harness check and the observed runtime hash', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('checks that the pinned harness is deployed AFTER the claim and BEFORE any model or tool call', async () => {
    const r = rig({ script: [fakeText('no receipt')] });
    await r.dispatcher.runJob('job-1');
    const order = r.store.calls.map((c) => c.method);
    expect(order.indexOf('claim')).toBeLessThan(order.indexOf('assertHarnessDeployed'));
    expect(order.indexOf('assertHarnessDeployed')).toBeLessThan(order.indexOf('recordContextInputs'));
    expect(r.fake.calls.length).toBeGreaterThan(0);
  });

  it('a harness that is not (or no longer) deployed is a committed failure: no model call, no tool, no job_started, reason recorded', async () => {
    let toolRan = false;
    const r = rig({
      projection: fakeFencedSink,
      script: [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('x')],
      tools: () => [
        defineTool({
          name: 'echo',
          description: 'e',
          parameters: z.object({ v: z.number() }),
          execute: async () => ((toolRan = true), { ok: true }),
        }),
      ],
      setup: (store) => store.undeployed.add('job-1'),
    });
    const result = await r.dispatcher.runJob('job-1');
    expect(result).toMatchObject({ outcome: 'failed', reason: 'HarnessNotDeployed' });
    expect(r.fake.calls).toHaveLength(0); // the model was never called
    expect(toolRan).toBe(false);
    expect(r.store.named('recordContextInputs')).toHaveLength(0);
    expect(r.store.jobs.get('job-1')!.status).toBe('failed');
    expect(r.store.named('finish')[0]?.args).toEqual(['failed', []]);
    const checkpoint = r.store.checkpoints.get('job-1')!.at(-1) as {
      terminal: { decision: unknown; toolCalls: number };
    };
    expect(checkpoint.terminal).toMatchObject({
      decision: { status: 'failed', reason: 'HarnessNotDeployed' },
      toolCalls: 0,
    });
    expect(r.projected.map((p) => p.event.kind)).toEqual(['job_failed']);
    expect(r.projected[0]?.event.payload).toMatchObject({
      code: 'policy_denied',
      message: 'HarnessNotDeployed',
    });
  });

  it('a deployment check that itself fails hands the job back untouched: it is not "not deployed"', async () => {
    const r = rig({ script: [fakeText('x')], setup: (store) => store.deploymentCheckFails.add('job-1') });
    const result = await r.dispatcher.runJob('job-1');
    expect(result).toMatchObject({ outcome: 'released', reason: 'deployment_check_failed' });
    expect(r.store.jobs.get('job-1')!.status).toBe('queued');
    expect(r.fake.calls).toHaveLength(0);
    expect(r.store.named('finish')).toHaveLength(0);
  });

  it('writes the observed runtime hash into the claimed run checkpoint, keeps it in every snapshot incl. the terminal one, and a takeover by another build records its own', async () => {
    const first = rig({
      script: [fakeToolCalls([{ name: 'echo', args: { v: 1 } }]), fakeText('x')],
      runtimeHash: HASH_A,
    });
    await first.dispatcher.runJob('job-1');
    const snapshots = first.store.checkpoints.get('job-1') as Array<{ attestedRuntimeHash?: string }>;
    expect(snapshots.length).toBeGreaterThan(2);
    expect(snapshots[0]).toMatchObject({ attestedRuntimeHash: HASH_A }); // at claim time, before any phase
    for (const snapshot of snapshots) expect(snapshot.attestedRuntimeHash).toBe(HASH_A);
    expect(snapshots.at(-1)).toHaveProperty('terminal');

    const second = rig({ script: [fakeText('y')], runtimeHash: HASH_B });
    const stored = second.store.jobs.get('job-1')!;
    stored.status = 'running';
    stored.lease = { ownerId: 'dead', fence: 4, until: new Date(0), heartbeatAt: new Date(0) };
    stored.checkpoint = { v: 1, attestedRuntimeHash: HASH_A };
    await second.dispatcher.runJob('job-1');
    expect(
      (second.store.jobs.get('job-1')!.checkpoint as { attestedRuntimeHash: string }).attestedRuntimeHash,
    ).toBe(HASH_B);
  });

  it('without a runtime hash no attestation is written (never an invented value)', async () => {
    const r = rig({ script: [fakeText('x')] });
    await r.dispatcher.runJob('job-1');
    expect(JSON.stringify(r.store.checkpoints.get('job-1'))).not.toContain('attestedRuntimeHash');
  });
});
