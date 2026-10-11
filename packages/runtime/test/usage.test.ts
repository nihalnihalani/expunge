import { defineTool } from '@expunge/vendor-openmuse';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExpungeExecutionAgent, type ExecutionHooks } from '../src/index.js';
import { FakeChatModel, fakeText, fakeToolCalls } from '../src/testing/index.js';
import {
  ACTOR,
  FakeArtifactReader,
  FakeJobStore,
  FakeToolProvider,
  FixedModelResolver,
  freshLease,
  makeJobFor,
  baseDeps,
  collect,
  makeBundle,
  runInput,
} from './fakes.js';

describe('provider usage', () => {
  it('is carried on RUN_FINISHED and reported in the run stats (recorded, not yet enforced against totalTokens)', async () => {
    const bundle = makeBundle();
    const lease = freshLease();
    const fake = new FakeChatModel([
      {
        parts: [{ kind: 'text', text: 'ok' }],
        usage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 },
      },
    ]);
    const agent = new ExpungeExecutionAgent(
      baseDeps({
        jobs: new FakeJobStore(makeJobFor(bundle, lease)),
        artifacts: new FakeArtifactReader(bundle),
        tools: new FakeToolProvider(() => []),
        models: new FixedModelResolver({ spec: 'fake/fake', textAdapter: fake.adapter }),
      }),
      { actor: ACTOR, lease },
    );
    const events = await collect(agent.run(runInput()));
    const stats = await agent.settled();
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(stats?.usage).toEqual([{ inputTokens: 11, outputTokens: 5, totalTokens: 16 }]);
  });
});

describe('DA-5 DG4: budgets are per JOB, carried in the durable checkpoint across sessions', () => {
  const prior = (over: Partial<Record<string, number>> = {}) => ({
    v: 1,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    unpricedCalls: 0,
    wallTimeMs: 0,
    ...over,
  });
  function rig(options: {
    script: ConstructorParameters<typeof FakeChatModel>[0];
    meter?: unknown;
    limits?: Partial<ReturnType<typeof makeBundle>['limits']>;
    pricing?: { inputMicrousdPerMillion: number; outputMicrousdPerMillion: number };
    hooks?: ExecutionHooks;
  }) {
    const base = makeBundle();
    const bundle = {
      ...base,
      limits: {
        ...base.limits,
        modelCalls: 3,
        totalTokens: 100,
        maxCostMicrousd: 1000,
        wallTimeMs: 20_000,
        toolCalls: 20,
        ...options.limits,
      },
    };
    const lease = freshLease();
    const checkpoint = options.meter === undefined ? null : { v: 1, phase: 1, meter: options.meter };
    const fake = new FakeChatModel(options.script);
    const agent = new ExpungeExecutionAgent(
      baseDeps({
        jobs: new FakeJobStore(makeJobFor(bundle, lease, { checkpoint: checkpoint as never })),
        artifacts: new FakeArtifactReader(bundle),
        tools: new FakeToolProvider(() => [
          defineTool({
            name: 'echo',
            description: 'e',
            parameters: z.object({ v: z.number() }),
            execute: async () => ({ ok: true }),
          }),
        ]),
        models: new FixedModelResolver({
          spec: 'fake/fake',
          textAdapter: fake.adapter,
          pricing: options.pricing,
        }),
        ...(options.hooks ? { hooks: options.hooks } : {}),
      }),
      { actor: ACTOR, lease },
    );
    return { agent, fake };
  }
  const turn = (input: number, output: number) => ({
    ...fakeToolCalls([{ name: 'echo', args: { v: 1 } }]),
    usage: { promptTokens: input, completionTokens: output, totalTokens: input + output },
  });
  const done = (input: number, output: number) => ({
    ...fakeText('done'),
    usage: { promptTokens: input, completionTokens: output, totalTokens: input + output },
  });

  it('a takeover counts the earlier session: the model-call limit applies to the job, not to the session', async () => {
    const r = rig({
      meter: prior({ modelCalls: 1, inputTokens: 5, outputTokens: 5, unpricedCalls: 1 }),
      script: [turn(1, 1), turn(1, 1), turn(1, 1), done(1, 1)],
    });
    await collect(r.agent.run(runInput()));
    const stats = await r.agent.settled();
    expect(r.fake.turnsConsumed).toBe(2); // limit 3, one already used by the earlier session
    expect(stats?.endedBy).toBe('step_limit');
    expect(stats?.metered).toMatchObject({
      modelCalls: 3,
      inputTokens: 7,
      outputTokens: 7,
      unpricedCalls: 3,
    });
    expect(stats?.meterCarry).toMatchObject({ v: 1, modelCalls: 3, inputTokens: 7, outputTokens: 7 });
  });

  it('refuses to start any model call when the earlier sessions already used the model-call limit', async () => {
    const r = rig({ meter: prior({ modelCalls: 3 }), script: [done(1, 1)] });
    await collect(r.agent.run(runInput()));
    const stats = await r.agent.settled();
    expect(r.fake.turnsConsumed).toBe(0);
    expect(stats).toMatchObject({ endedBy: 'step_limit', errorCode: 'StepLimitReached' });
  });

  it('refuses to start a model call when carried tokens already reach totalTokens, and counts this session on top otherwise', async () => {
    const exhausted = rig({ meter: prior({ inputTokens: 60, outputTokens: 40 }), script: [done(1, 1)] });
    await collect(exhausted.agent.run(runInput()));
    expect(exhausted.fake.turnsConsumed).toBe(0);
    expect(await exhausted.agent.settled()).toMatchObject({
      endedBy: 'token_budget',
      errorCode: 'TokenBudgetExceeded',
    });

    const crossing = rig({
      meter: prior({ modelCalls: 1, inputTokens: 40, outputTokens: 20 }),
      script: [turn(30, 20), done(1, 1)],
    });
    await collect(crossing.agent.run(runInput()));
    const stats = await crossing.agent.settled();
    expect(crossing.fake.turnsConsumed).toBe(1); // 60 carried + 50 = 110 > 100: stopped after the first call of THIS session
    expect(stats).toMatchObject({ endedBy: 'token_budget', errorCode: 'TokenBudgetExceeded' });
    expect(stats?.metered).toMatchObject({ inputTokens: 70, outputTokens: 40, totalTokens: 110 });
  });

  it('refuses to start a model call when carried cost already reaches the cost ceiling', async () => {
    const r = rig({
      meter: prior({ modelCalls: 1, costMicrousd: 50, inputTokens: 10, outputTokens: 10 }),
      limits: { maxCostMicrousd: 50 },
      pricing: { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1 },
      script: [done(1, 1)],
    });
    await collect(r.agent.run(runInput()));
    expect(r.fake.turnsConsumed).toBe(0);
    expect(await r.agent.settled()).toMatchObject({
      endedBy: 'cost_budget',
      errorCode: 'CostBudgetExceeded',
    });
  });

  it('subtracts the wall time earlier sessions used, and refuses to start when none is left', async () => {
    const spent = rig({ meter: prior({ modelCalls: 1, wallTimeMs: 20_000 }), script: [done(1, 1)] });
    await collect(spent.agent.run(runInput()));
    expect(spent.fake.turnsConsumed).toBe(0);
    expect(await spent.agent.settled()).toMatchObject({
      endedBy: 'wall_time',
      errorCode: 'WallTimeExceeded',
    });

    const some = rig({ meter: prior({ modelCalls: 1, wallTimeMs: 5_000 }), script: [done(1, 1)] });
    await collect(some.agent.run(runInput()));
    const stats = await some.agent.settled();
    expect(stats?.endedBy).toBe('finished');
    expect(stats?.meterCarry?.wallTimeMs).toBeGreaterThanOrEqual(5_000); // cumulative, never reset
  });

  it('a checkpoint without a meter is a fresh job; one with a malformed meter fails closed instead of resetting the budgets', async () => {
    const fresh = rig({ script: [done(1, 1)] });
    await collect(fresh.agent.run(runInput()));
    expect((await fresh.agent.settled())?.endedBy).toBe('finished');

    for (const meter of [
      { v: 2 },
      { v: 1, modelCalls: -1 },
      { ...prior(), inputTokens: 1.5 },
      { ...prior(), wallTimeMs: 'x' },
      'bogus',
      null,
    ]) {
      const bad = rig({ meter, script: [done(1, 1)] });
      const events = await collect(bad.agent.run(runInput()));
      expect(bad.fake.turnsConsumed, JSON.stringify(meter)).toBe(0);
      expect((events.at(-1) as unknown as { code?: string }).code).toBe('CheckpointInvalid');
    }
  });

  it('persists the cumulative totals after every phase and once more at the end, before the lease is released', async () => {
    const phases: unknown[] = [];
    const ends: unknown[] = [];
    const order: string[] = [];
    const r = rig({
      meter: prior({ modelCalls: 1, inputTokens: 10, outputTokens: 10, unpricedCalls: 1 }),
      script: [turn(5, 5), done(2, 2)],
      hooks: {
        onPhaseComplete: async (info) => void (phases.push(info.meter), order.push('phase')),
        onMeter: async (carry) => void (ends.push(carry), order.push('meter')),
      },
    });
    await collect(r.agent.run(runInput()));
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ v: 1, modelCalls: 2, inputTokens: 15, outputTokens: 15 });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ v: 1, modelCalls: 3, inputTokens: 17, outputTokens: 17 });
    expect(order).toEqual(['phase', 'meter']);
  });

  it('a failing onMeter hook is reported and never fails the run', async () => {
    const errors: string[] = [];
    const r = rig({
      script: [done(1, 1)],
      hooks: {
        onMeter: async () => Promise.reject(new Error('write failed')),
        onHookError: (hook) => void errors.push(hook),
      },
    });
    await collect(r.agent.run(runInput()));
    expect((await r.agent.settled())?.endedBy).toBe('finished');
    expect(errors).toContain('onMeter');
  });
});
