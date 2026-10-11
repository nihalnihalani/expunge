import type { ResourceLimits } from '@expunge/contracts';
import type { ModelPricing, UsageSummary } from './ports.js';

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Each direction remains unknown unless a valid count is present; explicit zero is valid. */
export function readUsage(usage: unknown): { input?: number; output?: number } | undefined {
  const record = Array.isArray(usage) ? (usage.length === 1 ? usage[0] : undefined) : usage;
  if (!record || typeof record !== 'object') return undefined;
  const fields = record as Record<string, unknown>;
  const direction = (primary: string, alias: string) =>
    count(fields[primary] === undefined ? fields[alias] : fields[primary]);
  const input = direction('promptTokens', 'inputTokens');
  const output = direction('completionTokens', 'outputTokens');
  if (input === undefined && output === undefined) return undefined;
  return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
}

export const hasCompletePricing = (pricing: ModelPricing | undefined): boolean =>
  count(pricing?.inputMicrousdPerMillion) !== undefined &&
  count(pricing?.outputMicrousdPerMillion) !== undefined;

/** Numeric totals are known lower bounds. Coverage metadata carries unknown usage through takeover. */
export type MeterCarry = {
  v: 1;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  wallTimeMs: number;
  coverageVersion?: 2;
  unknownUsageCalls?: number;
  partialUsageCalls?: number;
  partialCostCalls?: number;
  provider?: { attempts: number; retriedStatuses: number[]; backoffTimeout: boolean };
};

export const EMPTY_CARRY: MeterCarry = {
  v: 1,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrousd: 0,
  unpricedCalls: 0,
  wallTimeMs: 0,
};
const FIELDS = [
  'modelCalls',
  'inputTokens',
  'outputTokens',
  'costMicrousd',
  'unpricedCalls',
  'wallTimeMs',
] as const;
const COVERAGE_FIELDS = ['unknownUsageCalls', 'partialUsageCalls', 'partialCostCalls'] as const;

/** Present corrupt counters never become zero. Legacy carries remain readable but cannot certify complete usage. */
export function readMeterCarry(checkpoint: unknown): { carry: MeterCarry } | { invalid: true } {
  if (!checkpoint || typeof checkpoint !== 'object' || !('meter' in checkpoint))
    return { carry: EMPTY_CARRY };
  const meter = (checkpoint as { meter: unknown }).meter;
  if (!meter || typeof meter !== 'object') return { invalid: true };
  const record = meter as Record<string, unknown>;
  if (record.v !== 1) return { invalid: true };
  const carry: Record<string, number> = {};
  for (const field of FIELDS) {
    const value = count(record[field]);
    if (value === undefined) return { invalid: true };
    carry[field] = value;
  }
  if (
    !Number.isSafeInteger(carry.inputTokens! + carry.outputTokens!) ||
    carry.unpricedCalls! > carry.modelCalls!
  )
    return { invalid: true };
  if (
    carry.modelCalls === 0 &&
    (carry.inputTokens! > 0 || carry.outputTokens! > 0 || carry.costMicrousd! > 0 || carry.unpricedCalls! > 0)
  )
    return { invalid: true };
  const coverage: Record<string, number> = {};
  if (record.coverageVersion !== undefined || COVERAGE_FIELDS.some((field) => record[field] !== undefined)) {
    if (record.coverageVersion !== 2) return { invalid: true };
    for (const field of COVERAGE_FIELDS) {
      const value = count(record[field]);
      if (value === undefined || value > carry.modelCalls!) return { invalid: true };
      coverage[field] = value;
    }
    if (
      coverage.partialUsageCalls! > coverage.unknownUsageCalls! ||
      coverage.unknownUsageCalls! > carry.unpricedCalls! ||
      coverage.partialCostCalls! > carry.unpricedCalls!
    )
      return { invalid: true };
  }
  const provider = readProviderCarry(record.provider);
  if (provider === 'invalid') return { invalid: true };
  // A request began without a completed model-call accounting row. Its spend cannot be reset to a fresh/free run.
  if (carry.modelCalls === 0 && provider && provider.attempts > 0) return { invalid: true };
  return {
    carry: {
      v: 1,
      ...carry,
      ...(record.coverageVersion === 2 ? { coverageVersion: 2, ...coverage } : {}),
      ...(provider ? { provider } : {}),
    } as MeterCarry,
  };
}

function readProviderCarry(value: unknown): MeterCarry['provider'] | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return 'invalid';
  const record = value as Record<string, unknown>;
  const { attempts, retriedStatuses, backoffTimeout } = record;
  if (count(attempts) === undefined) return 'invalid';
  if (!Array.isArray(retriedStatuses) || retriedStatuses.length > 50) return 'invalid';
  if (!retriedStatuses.every((n) => Number.isInteger(n) && n >= 100 && n <= 599)) return 'invalid';
  if (typeof backoffTimeout !== 'boolean') return 'invalid';
  return { attempts: attempts as number, retriedStatuses: retriedStatuses as number[], backoffTimeout };
}

export type MeterVerdict =
  { ok: true } | { ok: false; code: 'TokenBudgetExceeded' | 'CostBudgetExceeded' | 'PricingUnavailable' };

/** Exact ceiling without unsafe floating-point multiplication; both arguments were validated safe integers. */
const priceTokens = (tokens: number, price: number): bigint =>
  (BigInt(tokens) * BigInt(price) + 999_999n) / 1_000_000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export class UsageMeter {
  private calls: number;
  private input: number;
  private output: number;
  private cost: number;
  private unpriced: number;
  private unknownUsage: number;
  private partialUsage: number;
  private partialCost: number;
  constructor(
    private readonly limits: Pick<ResourceLimits, 'totalTokens' | 'maxCostMicrousd'>,
    private readonly pricing: ModelPricing | undefined,
    private readonly requirePricing: boolean,
    carried: MeterCarry = EMPTY_CARRY,
  ) {
    if (count(limits.totalTokens) === undefined || count(limits.maxCostMicrousd) === undefined)
      throw new Error('InvalidMeterLimits');
    const validated = readMeterCarry({ meter: carried });
    if ('invalid' in validated) throw new Error('InvalidMeterCarry');
    this.calls = carried.modelCalls;
    this.input = carried.inputTokens;
    this.output = carried.outputTokens;
    this.cost = carried.costMicrousd;
    const legacy = this.calls > 0 && carried.coverageVersion !== 2;
    this.unpriced = legacy ? this.calls : carried.unpricedCalls;
    this.unknownUsage = legacy ? this.calls : (carried.unknownUsageCalls ?? 0);
    this.partialUsage =
      legacy && this.input + this.output > 0 ? this.calls : (carried.partialUsageCalls ?? 0);
    this.partialCost = legacy && this.cost > 0 ? this.calls : (carried.partialCostCalls ?? 0);
  }

  /** Hold before another dispatch when unknown prior usage/spend prevents proof of the remaining budget. */
  exhausted(): MeterVerdict {
    // Every defined spend ceiling, including zero, needs a complete validated price profile before dispatch.
    // The post-call requirePricing option cannot turn zero into an unlimited or unknown-price allowance.
    if (!hasCompletePricing(this.pricing)) return { ok: false, code: 'PricingUnavailable' };
    if (this.unknownUsage > 0 || this.unpriced > 0) return { ok: false, code: 'PricingUnavailable' };
    if (this.input + this.output >= this.limits.totalTokens)
      return { ok: false, code: 'TokenBudgetExceeded' };
    if (
      this.cost >= this.limits.maxCostMicrousd &&
      (this.cost > 0 ||
        (hasCompletePricing(this.pricing) &&
          ((this.pricing?.inputMicrousdPerMillion ?? 0) > 0 ||
            (this.pricing?.outputMicrousdPerMillion ?? 0) > 0)))
    )
      return { ok: false, code: 'CostBudgetExceeded' };
    return { ok: true };
  }

  carry(wallTimeMs: number): MeterCarry {
    if (count(Math.round(wallTimeMs)) === undefined) throw new Error('InvalidMeterWallTime');
    return {
      v: 1,
      modelCalls: this.calls,
      inputTokens: this.input,
      outputTokens: this.output,
      costMicrousd: this.cost,
      unpricedCalls: this.unpriced,
      wallTimeMs: Math.round(wallTimeMs),
      coverageVersion: 2,
      unknownUsageCalls: this.unknownUsage,
      partialUsageCalls: this.partialUsage,
      partialCostCalls: this.partialCost,
    };
  }

  record(usage: unknown): MeterVerdict {
    if (!Number.isSafeInteger(this.calls + 1)) return { ok: false, code: 'TokenBudgetExceeded' };
    this.calls++;
    const read = readUsage(usage);
    const completeUsage = read?.input !== undefined && read.output !== undefined;
    if (!completeUsage) {
      this.unknownUsage++;
      if (read) this.partialUsage++;
    }
    const nextInput = this.input + (read?.input ?? 0);
    const nextOutput = this.output + (read?.output ?? 0);
    if (
      !Number.isSafeInteger(nextInput) ||
      !Number.isSafeInteger(nextOutput) ||
      !Number.isSafeInteger(nextInput + nextOutput)
    ) {
      this.unpriced++;
      if (completeUsage) this.unknownUsage++;
      return { ok: false, code: 'TokenBudgetExceeded' };
    }
    this.input = nextInput;
    this.output = nextOutput;
    const inputPrice = count(this.pricing?.inputMicrousdPerMillion);
    const outputPrice = count(this.pricing?.outputMicrousdPerMillion);
    const knownInputCost = read?.input !== undefined && inputPrice !== undefined;
    const knownOutputCost = read?.output !== undefined && outputPrice !== undefined;
    const priced = completeUsage && hasCompletePricing(this.pricing);
    if (!priced) {
      this.unpriced++;
      if (knownInputCost || knownOutputCost) this.partialCost++;
    }
    const increment =
      (knownInputCost ? priceTokens(read!.input!, inputPrice!) : 0n) +
      (knownOutputCost ? priceTokens(read!.output!, outputPrice!) : 0n);
    const total = BigInt(this.cost) + increment;
    if (total > MAX) {
      if (priced) {
        this.unpriced++;
        this.partialCost++;
      }
      return { ok: false, code: 'CostBudgetExceeded' };
    }
    this.cost = Number(total);
    if (this.input + this.output > this.limits.totalTokens) return { ok: false, code: 'TokenBudgetExceeded' };
    if (this.cost > this.limits.maxCostMicrousd) return { ok: false, code: 'CostBudgetExceeded' };
    if (!priced && this.requirePricing) return { ok: false, code: 'PricingUnavailable' };
    return { ok: true };
  }

  summary(): UsageSummary {
    return {
      modelCalls: this.calls,
      inputTokens: this.input,
      outputTokens: this.output,
      totalTokens: this.input + this.output,
      costMicrousd: this.cost,
      unpricedCalls: this.unpriced,
      unknownUsageCalls: this.unknownUsage,
      usageCoverage:
        this.calls === 0
          ? 'none'
          : this.unknownUsage === 0
            ? 'complete'
            : this.unknownUsage < this.calls || this.partialUsage > 0
              ? 'partial'
              : 'none',
      costCoverage:
        this.calls === 0
          ? 'none'
          : this.unpriced === 0
            ? 'complete'
            : this.unpriced < this.calls || this.partialCost > 0
              ? 'partial'
              : 'none',
    };
  }
}
