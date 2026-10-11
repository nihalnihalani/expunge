import { contentHash, type CompletionReceipt, type HarnessBundle, type Job } from '@expunge/contracts';
import {
  FakeChatModel,
  JobWaitSignal,
  fakeHang,
  fakeText,
  fakeToolCalls,
  type CompletionReceiptReader,
} from '@expunge/runtime';
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
  RingEventSink,
  workerConfigFromEnv,
  type JobRunResult,
  type LogEntry,
} from '../src/index.js';
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
  withContextInputs?: boolean;
  env?: Record<string, string>;
  jobIds?: string[];
}) {
  const bundle = options.bundle ?? makeBundle();
  const store = new MultiJobStore(options.withContextInputs ?? true);
  const ids = options.jobIds ?? ['job-1'];
  for (const id of ids) store.add(queued(bundle, id));
  const receipts = new FakeReceipts();
  const fake = new FakeChatModel(options.script);
  const logs: LogEntry[] = [];
  const results: JobRunResult[] = [];
  const events = new RingEventSink();
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
    events,
    log: (entry) => logs.push(entry),
    onResult: (result) => results.push(result),
  });
  return { bundle, store, receipts, fake, dispatcher, logs, results, events };
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
    expect(r.events.recent('job-1').length).toBeGreaterThan(0);
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

  it('falls back to checkpoint-recorded context inputs when the repository has no recordContextInputs', async () => {
    const r = rig({ script: [fakeText('x')], withContextInputs: false });
    await r.dispatcher.runJob('job-1');
    const first = (r.store.checkpoints.get('job-1') as Array<{ contextInputs?: string[] }>)[0];
    expect(first?.contextInputs).toEqual([r.store.jobs.get('job-1')!.binding.harnessHash]);
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
