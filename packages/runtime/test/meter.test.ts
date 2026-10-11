import { describe, expect, it } from 'vitest';
import { EnvModelResolver, UsageMeter, pricingFromEnv, profileFingerprint, readUsage } from '../src/index.js';
import { makeBundle, makeJob } from './fakes.js';

describe('readUsage', () => {
  it('reads TanStack TokenUsage and AG-UI spec usage, and rejects garbage', () => {
    expect(readUsage({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })).toEqual({
      input: 3,
      output: 4,
    });
    expect(readUsage([{ inputTokens: 1, outputTokens: 2, totalTokens: 3 }])).toEqual({ input: 1, output: 2 });
    expect(readUsage({ promptTokens: 5 })).toEqual({ input: 5, output: 0 });
    for (const bad of [undefined, null, 'x', 3, {}, [], { promptTokens: -1 }, { promptTokens: Number.NaN }])
      expect(readUsage(bad), String(bad)).toBeUndefined();
  });
});

describe('UsageMeter', () => {
  const limits = { totalTokens: 100, maxCostMicrousd: 50 };
  it('uses an integer ceiling for cost and reports full coverage only when every call was priced', () => {
    const meter = new UsageMeter(limits, { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1 }, false);
    expect(meter.record({ promptTokens: 1, completionTokens: 1 })).toEqual({ ok: true });
    expect(meter.summary()).toMatchObject({ costMicrousd: 2, costCoverage: 'complete', unpricedCalls: 0 }); // ceil(0.000001) each
    meter.record(undefined);
    expect(meter.summary()).toMatchObject({ costCoverage: 'partial', unpricedCalls: 1, modelCalls: 2 });
  });
  it('prices need BOTH directions; a half-priced profile is unpriced', () => {
    const meter = new UsageMeter(limits, { inputMicrousdPerMillion: 5 }, false);
    meter.record({ promptTokens: 10, completionTokens: 10 });
    expect(meter.summary()).toMatchObject({ unpricedCalls: 1, costMicrousd: 0, costCoverage: 'none' });
  });
  it('a limit of zero means no usage is permitted', () => {
    const meter = new UsageMeter({ totalTokens: 0, maxCostMicrousd: 0 }, undefined, false);
    expect(meter.record({ promptTokens: 1, completionTokens: 0 })).toEqual({
      ok: false,
      code: 'TokenBudgetExceeded',
    });
  });
  it('requirePricing only bites when a cost ceiling exists', () => {
    expect(
      new UsageMeter({ totalTokens: 100, maxCostMicrousd: 0 }, undefined, true).record({ promptTokens: 1 }),
    ).toEqual({ ok: true });
    expect(
      new UsageMeter({ totalTokens: 100, maxCostMicrousd: 9 }, undefined, true).record({ promptTokens: 1 }),
    ).toEqual({
      ok: false,
      code: 'PricingUnavailable',
    });
  });
});

describe('profile pricing and fingerprint', () => {
  it('reads prices from the environment; absent or malformed prices stay unpriced', () => {
    expect(pricingFromEnv({})).toBeUndefined();
    expect(pricingFromEnv({ EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: 'abc' })).toBeUndefined();
    expect(pricingFromEnv({ EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: '-1' })).toBeUndefined();
    expect(
      pricingFromEnv({
        EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: '2500000',
        EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION: '10000000',
      }),
    ).toEqual({ inputMicrousdPerMillion: 2_500_000, outputMicrousdPerMillion: 10_000_000 });
  });
  it('the resolver carries prices and the fingerprint changes when the model or a price changes', () => {
    const bundle = makeBundle();
    const job = makeJob(bundle);
    const priced = new EnvModelResolver({
      EXPUNGE_MODEL_PROVIDER: 'openai',
      EXPUNGE_MODEL_ID: 'gpt-5',
      EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION: '1',
      EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION: '2',
    }).select(job, bundle);
    expect(priced.pricing).toEqual({ inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 });
    const a = profileFingerprint(priced.spec, priced.pricing);
    expect(a).toBe(profileFingerprint(priced.spec, priced.pricing));
    expect(a).not.toBe(
      profileFingerprint(priced.spec, { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 3 }),
    );
    expect(a).not.toBe(profileFingerprint('openai/gpt-5-mini', priced.pricing));
    expect(a).not.toBe(profileFingerprint(priced.spec, undefined));
  });
});
