import { contentHash, type CompletionReceipt, type Job } from '@expunge/contracts';
import { describe, expect, it } from 'vitest';
import { makeBundle, makeJob } from '../../../packages/runtime/test/fakes.js';
import {
  WorkerEpisodeRunner,
  costOf,
  type CommittedEpisode,
  type EpisodeJobHost,
  type SeededInstance,
  type EpisodeRequest,
  type EpisodeWorker,
} from '../src/episode-port.js';
import type { JobRunResult } from '../src/dispatch.js';

/** FAKE host, FAKE evidence and FAKE worker: logic of the port only. Nothing here touches MongoDB or a model. */
const instance: SeededInstance = {
  actor: { tenantId: 't', env: 'evaluation', scopeId: 's', actorId: 'owner', authorizationRevision: 1 },
  worldId: 'w1',
  collectionIds: ['customers'],
  scopeRevision: 1,
  subjectHandle: 'subj',
};
const bundle = makeBundle();
const bundleHash = contentHash(bundle);

function rig(
  committed: Partial<CommittedEpisode> | null,
  over: { pinError?: Error; outcomes?: JobRunResult['outcome'][]; maxSessions?: number } = {},
) {
  const calls: string[] = [];
  const wrapped: boolean[] = [];
  const host: EpisodeJobHost = {
    pinBundle: async () => {
      calls.push('pin');
      if (over.pinError) throw over.pinError;
    },
    createJob: async (_i, job) =>
      void calls.push(`job:${job.binding.runId}:${job.binding.harnessHash === bundleHash}`),
  };
  const job = (patch: Partial<Job>): Job => ({ ...makeJob(bundle), ...patch });
  const port = new WorkerEpisodeRunner({
    host,
    evidence: {
      read: async () =>
        committed === null
          ? null
          : {
              job: job({ status: 'succeeded' }),
              receipt: null,
              worldRevision: 4,
              plannedBatches: 2,
              committedBatches: 2,
              ...committed,
            },
    },
    baseTools: { create: () => [] },
    ...(over.maxSessions ? { maxSessions: over.maxSessions } : {}),
    workerFactory: ({ onResult, tools, session }) => {
      const base = { create: () => [] };
      wrapped.push(tools(base) !== base); // the port must hand the worker the real provider, never a fault wrapper
      const outcome = over.outcomes?.[session - 1] ?? 'failed';
      calls.push(`session:${session}:${outcome}`);
      const worker: EpisodeWorker = {
        wake: () => (onResult({ jobId: 'j', outcome } as JobRunResult), true),
        idle: async () => undefined,
        stop: async () => undefined,
      };
      return worker;
    },
  });
  return { port, calls, wrapped };
}
const request = (over: Partial<EpisodeRequest> = {}): EpisodeRequest => ({
  campaignId: 'c',
  runId: 'run-1',
  instanceId: 'w1',
  bundle,
  bundleHash,
  profile: { profileId: 'p', modelId: 'm', modelKind: 'fake', params: {} },
  limits: bundle.limits,
  faults: { partialAcknowledgements: 0, interruptAfterEffects: null, transientFailures: 0 },
  signal: new AbortController().signal,
  ...over,
});
const receipt = (over: Partial<CompletionReceipt> = {}): CompletionReceipt =>
  ({
    receiptId: 'r1',
    jobId: 'job-1',
    runId: 'run-1',
    harnessHash: bundleHash,
    domainStatus: 'complete_in_registered_scope',
    operationalResiduals: 0,
    ...over,
  }) as CompletionReceipt;

describe('WorkerEpisodeRunner logic (FAKE host, evidence and worker)', () => {
  it('refuses limits that differ from the pinned bundle before creating any job', async () => {
    const { port, calls } = rig(null);
    const result = await port.run(
      request({ limits: { ...bundle.limits, modelCalls: bundle.limits.modelCalls + 1 } }),
      instance,
    );
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'LimitsMismatch' });
    expect(calls.some((c) => c.startsWith('job:'))).toBe(false);
  });

  it('reports a host setup failure by error name, never by message', async () => {
    const error = Object.assign(new Error('secret detail'), { name: 'BundleHashMismatch' });
    const { port } = rig(null, { pinError: error });
    const result = await port.run(request(), instance);
    expect(result.failureCode).toBe('BundleHashMismatch');
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('maps committed states: success with a receipt is completed and carries the hash the grader recomputes', async () => {
    const r = receipt();
    const attested = 'a'.repeat(64);
    const { port } = rig({
      receipt: r,
      job: makeJob(bundle, { status: 'succeeded', checkpoint: { v: 1, attestedRuntimeHash: attested } }),
    });
    const result = await port.run(request(), instance);
    expect(result).toMatchObject({
      outcome: 'completed',
      terminal: { status: 'complete', claim: 'registered_scope' },
      runtimeHash: attested,
    });
    expect(result.receipt).toMatchObject({
      currentWorldRevision: 4,
      committedReceiptHash: contentHash(r as never, 'completion-receipt'),
    });
  });

  it('reports no runtime hash when the committed checkpoint carries none (never a supplied constant)', async () => {
    const { port } = rig({ receipt: receipt() });
    expect((await port.run(request(), instance)).runtimeHash).toBeUndefined();
  });

  it('a failed job with an incomplete receipt is incomplete; without a receipt it is failed with the decision code; neither carries receipt evidence', async () => {
    const failedJob = makeJob(bundle, {
      status: 'failed',
      checkpoint: { v: 1, terminal: { decision: { status: 'failed', reason: 'NoCompletionReceipt' } } },
    });
    const a = rig({ job: failedJob, receipt: receipt({ operationalResiduals: 2 }) });
    const incomplete = await a.port.run(request(), instance);
    expect(incomplete).toMatchObject({ outcome: 'incomplete', terminal: { status: 'incomplete' } });
    expect(incomplete.receipt).toBeUndefined();
    const b = rig({ job: failedJob, receipt: null });
    expect(await b.port.run(request(), instance)).toMatchObject({
      outcome: 'failed',
      failureCode: 'NoCompletionReceipt',
    });
  });

  it('a job that is not terminal after the sessions is a failure, and unreadable committed state is a failure', async () => {
    const running = rig({ job: makeJob(bundle, { status: 'running' }) });
    expect((await running.port.run(request(), instance)).failureCode).toBe('NotTerminal');
    const unreadable = rig(null);
    expect((await unreadable.port.run(request(), instance)).failureCode).toBe('CommittedStateUnreadable');
  });

  it('a timeout during provider backoff is a ModelUnavailable failure with its detail and attempts; an ordinary failure carries neither', async () => {
    const backedOff = makeJob(bundle, {
      status: 'failed',
      checkpoint: {
        v: 1,
        terminal: {
          decision: { status: 'failed', reason: 'ModelUnavailable' },
          providerAttempts: { attempts: 1, retriedStatuses: [429], backoffTimeout: true },
        },
      },
    });
    const a = await rig({ job: backedOff, receipt: null }).port.run(request(), instance);
    expect(a).toMatchObject({
      outcome: 'failed',
      failureCode: 'ModelUnavailable',
      failureDetail: 'phase_timeout_during_provider_backoff',
      providerRetries: { attempts: 1, retriedStatuses: [429], backoffTimeout: true },
    });
    const plain = makeJob(bundle, {
      status: 'failed',
      checkpoint: { v: 1, terminal: { decision: { status: 'failed', reason: 'PhaseTimeout' } } },
    });
    const b = await rig({ job: plain, receipt: null }).port.run(request(), instance);
    expect(b.failureCode).toBe('PhaseTimeout');
    expect(b.failureDetail).toBeUndefined();
    expect(b.providerRetries).toBeUndefined();
  });

  it('retry failures are the planned batches that have no committed effect', async () => {
    const { port } = rig({ receipt: receipt(), plannedBatches: 5, committedBatches: 3 });
    expect((await port.run(request(), instance)).retryFailures).toBe(2);
  });

  it('cost comes from the job checkpoint meter and tool-call count, never from model text', () => {
    const job = makeJob(bundle, {
      checkpoint: {
        v: 1,
        toolCalls: 3,
        meter: {
          v: 1,
          modelCalls: 4,
          inputTokens: 10,
          outputTokens: 5,
          costMicrousd: 7,
          unpricedCalls: 1,
          wallTimeMs: 99,
        },
        terminal: { toolCalls: 6 },
      },
    });
    expect(costOf(job, 2)).toEqual({
      modelCalls: 4,
      toolCalls: 6,
      inputTokens: 10,
      outputTokens: 5,
      costMicrousd: 7,
      unpricedCalls: 1,
      mongoOperations: 2,
      wallTimeMs: 99,
    });
    expect(costOf(makeJob(bundle, { checkpoint: null }), 0).modelCalls).toBe(0);
  });
});

describe('sessions: the worker injects no faults and restarts only on a reported lost lease (FAKE worker)', () => {
  const sessionCalls = (calls: string[]) => calls.filter((c) => c.startsWith('session:'));
  const runningJob = () => makeJob(bundle, { status: 'running' });

  it('hands the worker the real tool provider, never a fault wrapper, whatever fault plan the request declares', async () => {
    const { port, wrapped } = rig({ receipt: receipt() });
    await port.run(
      request({ faults: { partialAcknowledgements: 2, interruptAfterEffects: 1, transientFailures: 3 } }),
      instance,
    );
    expect(wrapped).toEqual([false]);
  });

  it('a session that ends lost_lease (the gateway spent its stored-plan interruption) is followed by a new session that finishes the job', async () => {
    const { port, calls } = rig({ receipt: receipt() }, { outcomes: ['lost_lease', 'succeeded'] });
    const result = await port.run(request(), instance);
    expect(sessionCalls(calls)).toEqual(['session:1:lost_lease', 'session:2:succeeded']);
    expect(result.outcome).toBe('completed');
  });

  it('any other session end does not restart: released, failed and terminal sessions stop after one', async () => {
    for (const outcome of ['released', 'failed', 'terminal', 'unfinalized'] as const) {
      const { port, calls } = rig({ receipt: receipt() }, { outcomes: [outcome, 'succeeded'] });
      await port.run(request(), instance);
      expect(sessionCalls(calls)).toEqual([`session:1:${outcome}`]);
    }
  });

  it('exhausting maxSessions with the job still not terminal is a RECORDED failure (SessionsExhausted), never a silent stop', async () => {
    const { port, calls } = rig(
      { job: runningJob() },
      { outcomes: ['lost_lease', 'lost_lease', 'lost_lease', 'lost_lease'], maxSessions: 3 },
    );
    const result = await port.run(request(), instance);
    expect(sessionCalls(calls)).toHaveLength(3);
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'SessionsExhausted' });
  });

  it('an aborted request starts no further session', async () => {
    const controller = new AbortController();
    controller.abort();
    const { port, calls } = rig({ job: runningJob() }, { outcomes: ['lost_lease', 'lost_lease'] });
    await port.run(request({ signal: controller.signal }), instance);
    expect(sessionCalls(calls)).toEqual([]);
  });
});
