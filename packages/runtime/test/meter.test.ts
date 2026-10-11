import { describe, expect, it } from 'vitest';
import {
  UsageMeter,
  hasCompletePricing,
  pricingFromEnv,
  profileFingerprint,
  readMeterCarry,
  readUsage,
} from '../src/index.js';

describe('directional usage: numeric metadata only', () => {
  it('preserves unknown directions and explicit provider zero', () => {
    expect(readUsage({ promptTokens: 5 })).toEqual({ input: 5 });
    expect(readUsage({ completionTokens: 4 })).toEqual({ output: 4 });
    expect(readUsage({ promptTokens: 0, completionTokens: 0 })).toEqual({ input: 0, output: 0 });
    expect(readUsage([{ inputTokens: 1, outputTokens: 2 }])).toEqual({ input: 1, output: 2 });
    expect(readUsage({ promptTokens: -1, inputTokens: 9, completionTokens: 2 })).toEqual({ output: 2 });
  });
  it('rejects fractional, unsafe and malformed counts instead of inventing usage', () => {
    for (const value of [
      undefined,
      null,
      'x',
      3,
      {},
      [],
      [{ inputTokens: 1 }, { outputTokens: 2 }],
      { promptTokens: -1 },
      { promptTokens: 0.5 },
      { promptTokens: Number.NaN },
      { promptTokens: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(readUsage(value)).toBeUndefined();
  });
});

describe('UsageMeter: coverage and budget holds', () => {
  const limits = { totalTokens: 100, maxCostMicrousd: 50 };
  const prices = { inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 1_000_000 };

  it('fails strict incomplete usage while preserving known token/cost lower bounds', () => {
    const meter = new UsageMeter(limits, prices, true);
    expect(meter.record({ promptTokens: 5 })).toEqual({ ok: false, code: 'PricingUnavailable' });
    expect(meter.summary()).toMatchObject({
      inputTokens: 5,
      outputTokens: 0,
      costMicrousd: 5,
      unpricedCalls: 1,
      unknownUsageCalls: 1,
      costCoverage: 'partial',
      usageCoverage: 'partial',
    });
    expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
  });
  it('holds another call with unknown usage even when strict pricing was explicitly disabled', () => {
    const meter = new UsageMeter(limits, prices, false);
    expect(meter.record({ outputTokens: 3 })).toEqual({ ok: true });
    expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
    const resumed = new UsageMeter(limits, prices, false, meter.carry(10));
    expect(resumed.summary()).toEqual(meter.summary());
    expect(resumed.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
  });

  it('treats zero spend as a real ceiling and never dispatches with unknown prices, even when strict was disabled', () => {
    for (const pricing of [undefined, { inputMicrousdPerMillion: 0 }]) {
      const meter = new UsageMeter({ totalTokens: 100, maxCostMicrousd: 0 }, pricing, false);
      expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
      // A reported call can still be accounted for as unknown spend, but cannot authorize another dispatch.
      meter.record({ inputTokens: 1, outputTokens: 0 });
      expect(meter.summary()).toMatchObject({ unpricedCalls: 1, usageCoverage: 'complete' });
      expect(meter.summary().costCoverage).not.toBe('complete');
      expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
    }
    // A later configured profile cannot repair an earlier call whose spend was unknown.
    const prior = new UsageMeter({ totalTokens: 100, maxCostMicrousd: 0 }, undefined, false);
    prior.record({ inputTokens: 1, outputTokens: 0 });
    const resumed = new UsageMeter(
      { totalTokens: 100, maxCostMicrousd: 0 },
      { inputMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 },
      false,
      prior.carry(1),
    );
    expect(resumed.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
  });

  it('permits an explicitly complete zero-price profile within token bounds at a zero spend ceiling', () => {
    const meter = new UsageMeter(
      { totalTokens: 100, maxCostMicrousd: 0 },
      { inputMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 },
      false,
    );
    expect(meter.exhausted()).toEqual({ ok: true });
    expect(meter.record({ inputTokens: 1, outputTokens: 0 })).toEqual({ ok: true });
    expect(meter.summary()).toMatchObject({ costMicrousd: 0, unpricedCalls: 0, costCoverage: 'complete' });
    expect(meter.exhausted()).toEqual({ ok: true });
  });
  it('rejects absent, fractional or unsafe strict prices before the first call, including ceiling zero', () => {
    for (const pricing of [
      undefined,
      { inputMicrousdPerMillion: 1 },
      { inputMicrousdPerMillion: 0.5, outputMicrousdPerMillion: 1 },
      { inputMicrousdPerMillion: Number.MAX_SAFE_INTEGER + 1, outputMicrousdPerMillion: 1 },
    ]) {
      expect(hasCompletePricing(pricing)).toBe(false);
      const meter = new UsageMeter({ ...limits, maxCostMicrousd: 0 }, pricing, true);
      expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
      expect(meter.record({ promptTokens: 0, completionTokens: 0 })).toEqual({
        ok: false,
        code: 'PricingUnavailable',
      });
    }
  });
  it('prices known directions without certifying a partial price profile', () => {
    const meter = new UsageMeter(limits, { inputMicrousdPerMillion: 5 }, false);
    meter.record({ promptTokens: 10, completionTokens: 10 });
    expect(meter.summary()).toMatchObject({
      costMicrousd: 1,
      unpricedCalls: 1,
      costCoverage: 'partial',
      usageCoverage: 'complete',
    });
    expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
  });
  it('complete usage and explicit zero prices are completely covered, with exact integer ceilings', () => {
    const meter = new UsageMeter(limits, { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1 }, true);
    expect(meter.record({ inputTokens: 1, outputTokens: 1 })).toEqual({ ok: true });
    expect(meter.summary()).toMatchObject({
      costMicrousd: 2,
      unpricedCalls: 0,
      unknownUsageCalls: 0,
      usageCoverage: 'complete',
      costCoverage: 'complete',
    });
    const free = new UsageMeter(limits, { inputMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 }, true);
    expect(free.record({ inputTokens: 1, outputTokens: 0 })).toEqual({ ok: true });
    expect(free.summary().costCoverage).toBe('complete');
  });
  it('never turns missing complete usage into a free complete call', () => {
    const meter = new UsageMeter(limits, prices, false);
    meter.record(undefined);
    expect(meter.summary()).toMatchObject({ costCoverage: 'none', usageCoverage: 'none', unpricedCalls: 1 });
    expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
  });
  it('checks zero budgets before dispatch and known token/cost excess after accounting', () => {
    expect(new UsageMeter({ totalTokens: 0, maxCostMicrousd: 0 }, prices, true).exhausted()).toEqual({
      ok: false,
      code: 'TokenBudgetExceeded',
    });
    expect(new UsageMeter({ totalTokens: 100, maxCostMicrousd: 0 }, prices, true).exhausted()).toEqual({
      ok: false,
      code: 'CostBudgetExceeded',
    });
    expect(new UsageMeter(limits, prices, false).record({ inputTokens: 101, outputTokens: 0 })).toEqual({
      ok: false,
      code: 'TokenBudgetExceeded',
    });
  });
  it('uses exact BigInt arithmetic and refuses counters that cannot be represented safely', () => {
    const value = Number.MAX_SAFE_INTEGER;
    const meter = new UsageMeter(
      { totalTokens: value, maxCostMicrousd: value },
      { inputMicrousdPerMillion: value, outputMicrousdPerMillion: 0 },
      true,
    );
    meter.record({ inputTokens: 1000, outputTokens: 0 });
    expect(meter.summary().costMicrousd).toBe(Number((1000n * BigInt(value) + 999_999n) / 1_000_000n));
    const overflow = new UsageMeter(
      { totalTokens: value, maxCostMicrousd: value },
      { inputMicrousdPerMillion: value, outputMicrousdPerMillion: value },
      true,
    );
    expect(overflow.record({ inputTokens: value, outputTokens: 0 })).toEqual({
      ok: false,
      code: 'CostBudgetExceeded',
    });
    expect(Number.isSafeInteger(overflow.summary().costMicrousd)).toBe(true);
    expect(overflow.summary().costCoverage).not.toBe('complete');
    expect(
      new UsageMeter({ totalTokens: value, maxCostMicrousd: value }, prices, true).record({
        inputTokens: value,
        outputTokens: value,
      }),
    ).toEqual({ ok: false, code: 'TokenBudgetExceeded' });
  });
  it('preserves legacy lower bounds but holds unverifiable old coverage through takeover', () => {
    const legacy = {
      v: 1 as const,
      modelCalls: 1,
      inputTokens: 5,
      outputTokens: 0,
      costMicrousd: 5,
      unpricedCalls: 0,
      wallTimeMs: 1,
    };
    const meter = new UsageMeter(limits, prices, true, legacy);
    expect(meter.summary()).toMatchObject({
      inputTokens: 5,
      costMicrousd: 5,
      unpricedCalls: 1,
      costCoverage: 'partial',
    });
    expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
    meter.record({ inputTokens: 1, outputTokens: 1 });
    expect(meter.summary()).toMatchObject({
      unpricedCalls: 1,
      costCoverage: 'partial',
      usageCoverage: 'partial',
    });
    expect(meter.exhausted()).toEqual({ ok: false, code: 'PricingUnavailable' });
  });
});

describe('pricing and profile hashes: configuration only', () => {
  it('keeps missing or malformed prices unknown', () => {
    for (const env of [
      {},
      { EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: 'abc' },
      { EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: '-1' },
    ])
      expect(pricingFromEnv(env)).toBeUndefined();
    expect(
      pricingFromEnv({
        EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: '2500000',
        EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION: '10000000',
      }),
    ).toEqual({ inputMicrousdPerMillion: 2_500_000, outputMicrousdPerMillion: 10_000_000 });
  });
  it('binds a profile hash to model identity and every directional price', () => {
    const prices = { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 };
    const hash = profileFingerprint('openai/model-A', prices);
    expect(hash).toBe(profileFingerprint('openai/model-A', prices));
    expect(hash).not.toBe(profileFingerprint('openai/model-B', prices));
    expect(hash).not.toBe(profileFingerprint('openai/model-A', { ...prices, outputMicrousdPerMillion: 3 }));
    expect(hash).not.toBe(profileFingerprint('openai/model-A', undefined));
  });
});

describe('durable meter carry: numeric metadata only', () => {
  const base = {
    v: 1,
    modelCalls: 1,
    inputTokens: 2,
    outputTokens: 3,
    costMicrousd: 4,
    unpricedCalls: 0,
    wallTimeMs: 5,
  };
  it('reads provider attempts and coverage metadata without resetting them', () => {
    const provider = { attempts: 3, retriedStatuses: [429, 503], backoffTimeout: false };
    const coverage = { coverageVersion: 2, unknownUsageCalls: 0, partialUsageCalls: 0, partialCostCalls: 0 };
    expect(readMeterCarry({ meter: { ...base, ...coverage, provider } })).toEqual({
      carry: { ...base, ...coverage, provider },
    });
    expect(readMeterCarry({ meter: base })).toEqual({ carry: base });
  });
  it('rejects zero completed calls with usage, cost or an unresolved provider dispatch; permits genuine wall-only work', () => {
    const noModel = {
      v: 1,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicrousd: 0,
      unpricedCalls: 0,
      wallTimeMs: 99,
    };
    expect(readMeterCarry({ meter: noModel })).toEqual({ carry: noModel });
    for (const meter of [
      { ...noModel, inputTokens: 5 },
      { ...noModel, outputTokens: 5 },
      { ...noModel, costMicrousd: 5 },
      { ...noModel, unpricedCalls: 1 },
      { ...noModel, provider: { attempts: 1, retriedStatuses: [], backoffTimeout: false } },
      {
        ...noModel,
        coverageVersion: 2,
        unknownUsageCalls: 0,
        partialUsageCalls: 0,
        partialCostCalls: 0,
        provider: { attempts: 1, retriedStatuses: [429], backoffTimeout: false },
      },
    ])
      expect(readMeterCarry({ meter })).toEqual({ invalid: true });
  });
  it('rejects malformed, fractional, unsafe or inconsistent carried counters', () => {
    for (const meter of [
      { ...base, modelCalls: 0.5 },
      { ...base, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
      { ...base, unpricedCalls: 2 },
      { ...base, coverageVersion: 2, unknownUsageCalls: 1, partialUsageCalls: 1, partialCostCalls: 0 },
      { ...base, unknownUsageCalls: 0 },
      { ...base, provider: { attempts: -1, retriedStatuses: [], backoffTimeout: false } },
      { ...base, provider: { attempts: 1, retriedStatuses: [99], backoffTimeout: false } },
      { ...base, provider: { attempts: 1, retriedStatuses: Array(51).fill(429), backoffTimeout: false } },
    ])
      expect(readMeterCarry({ meter })).toEqual({ invalid: true });
  });
});
