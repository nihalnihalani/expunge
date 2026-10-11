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
import { Dispatcher, workerConfigFromEnv, type JobRunResult, type LogEntry } from '../src/index.js';
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
}) {
  const bundle = options.bundle ?? makeBundle();
  const store = new MultiJobStore();
  const ids = options.jobIds ?? ['job-1'];
  for (const id of ids) store.add(queued(bundle, id));
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
    projection: { append: async (key: unknown, event: any) => void projected.push({ key, event }) },
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
