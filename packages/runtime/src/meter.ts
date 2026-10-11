import type { ResourceLimits } from '@expunge/contracts';
import type { ModelPricing, UsageSummary } from './ports.js';

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Reads a provider TokenUsage (promptTokens/completionTokens) or AG-UI spec usage (inputTokens/outputTokens). */
export function readUsage(usage: unknown): { input: number; output: number } | undefined {
  const record = Array.isArray(usage) ? usage[0] : usage;
  if (!record || typeof record !== 'object') return undefined;
  const fields = record as Record<string, unknown>;
  const input = count(fields.promptTokens) ?? count(fields.inputTokens);
  const output = count(fields.completionTokens) ?? count(fields.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0 };
}

/**
 * The cumulative usage of a job across ALL its sessions, stored in the job's durable checkpoint (`checkpoint.meter`).
 * A session that takes over a lease seeds its meter from it, so budgets are per JOB, not per session. It is written
 * after every tool phase and once more when the session ends, so a crash loses at most the model call in flight.
 */
export type MeterCarry = {
  v: 1;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number;
  unpricedCalls: number;
  wallTimeMs: number;
  /** The provider SDK's HTTP attempts across all sessions (numbers only); absent when none were made. */
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

/**
 * Reads `checkpoint.meter`. No `meter` key means a job that has not been metered before (zero). A `meter` that is present
 * but malformed is an error, never zero: resetting budgets because a checkpoint is corrupt would fail open.
 */
export function readMeterCarry(checkpoint: unknown): { carry: MeterCarry } | { invalid: true } {
  if (!checkpoint || typeof checkpoint !== 'object' || !('meter' in checkpoint))
    return { carry: EMPTY_CARRY };
  const meter = (checkpoint as { meter: unknown }).meter;
  if (!meter || typeof meter !== 'object') return { invalid: true };
  const record = meter as Record<string, unknown>;
  if (record.v !== 1) return { invalid: true };
  const carry: Record<string, number> = {};
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { invalid: true };
    carry[field] = value;
  }
  const provider = readProviderCarry(record.provider);
  if (provider === 'invalid') return { invalid: true };
  return { carry: { v: 1, ...carry, ...(provider ? { provider } : {}) } as MeterCarry };
}

/** Absent is fine; present but malformed is an error, never zero (counts are evidence and must not be reset by corruption). */
function readProviderCarry(value: unknown): MeterCarry['provider'] | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return 'invalid';
  const record = value as Record<string, unknown>;
  const { attempts, retriedStatuses, backoffTimeout } = record;
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) return 'invalid';
  if (!Array.isArray(retriedStatuses) || retriedStatuses.length > 50) return 'invalid';
  if (!retriedStatuses.every((n) => Number.isInteger(n) && n >= 100 && n <= 599)) return 'invalid';
  if (typeof backoffTimeout !== 'boolean') return 'invalid';
  return { attempts, retriedStatuses: retriedStatuses as number[], backoffTimeout };
}

export type MeterVerdict =
  { ok: true } | { ok: false; code: 'TokenBudgetExceeded' | 'CostBudgetExceeded' | 'PricingUnavailable' };

/**
 * Per-call token and cost meter against ResourceLimits and the frozen profile's prices. Unknown pricing is
 * unpriced, not free: a call without prices or without reported usage increments `unpricedCalls`, and cost
 * coverage is reported as partial or none. Cost is an integer ceiling in micro-US dollars.
 */
export class UsageMeter {
  private calls = 0;
  private input = 0;
  private output = 0;
  private cost = 0;
  private unpriced = 0;
  constructor(
    private readonly limits: Pick<ResourceLimits, 'totalTokens' | 'maxCostMicrousd'>,
    private readonly pricing: ModelPricing | undefined,
    private readonly requirePricing: boolean,
    carried: MeterCarry = EMPTY_CARRY,
  ) {
    this.calls = carried.modelCalls;
    this.input = carried.inputTokens;
    this.output = carried.outputTokens;
    this.cost = carried.costMicrousd;
    this.unpriced = carried.unpricedCalls;
  }

  /**
   * Refuses to START another model call when the job's cumulative totals have already reached a limit. Nothing is
   * refused for a job that has used nothing, so a fresh run behaves exactly as before.
   */
  exhausted(): MeterVerdict {
    if (this.input + this.output > 0 && this.input + this.output >= this.limits.totalTokens)
      return { ok: false, code: 'TokenBudgetExceeded' };
    if (this.cost > 0 && this.cost >= this.limits.maxCostMicrousd)
      return { ok: false, code: 'CostBudgetExceeded' };
    return { ok: true };
  }

  /** The cumulative totals to persist; `wallTimeMs` is supplied by the session (it owns the clock). */
  carry(wallTimeMs: number): MeterCarry {
    return {
      v: 1,
      modelCalls: this.calls,
      inputTokens: this.input,
      outputTokens: this.output,
      costMicrousd: this.cost,
      unpricedCalls: this.unpriced,
      wallTimeMs: Math.max(0, Math.round(wallTimeMs)),
    };
  }

  record(usage: unknown): MeterVerdict {
    this.calls++;
    const read = readUsage(usage);
    const priced =
      read !== undefined &&
      this.pricing?.inputMicrousdPerMillion !== undefined &&
      this.pricing?.outputMicrousdPerMillion !== undefined;
    if (read) {
      this.input += read.input;
      this.output += read.output;
    }
    if (priced && read) {
      this.cost +=
        Math.ceil((read.input * (this.pricing?.inputMicrousdPerMillion ?? 0)) / 1_000_000) +
        Math.ceil((read.output * (this.pricing?.outputMicrousdPerMillion ?? 0)) / 1_000_000);
    } else this.unpriced++;
    if (this.input + this.output > this.limits.totalTokens) return { ok: false, code: 'TokenBudgetExceeded' };
    if (this.cost > this.limits.maxCostMicrousd) return { ok: false, code: 'CostBudgetExceeded' };
    if (!priced && this.requirePricing && this.limits.maxCostMicrousd > 0)
      return { ok: false, code: 'PricingUnavailable' };
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
      costCoverage:
        this.calls === 0 || this.unpriced === this.calls
          ? 'none'
          : this.unpriced > 0
            ? 'partial'
            : 'complete',
    };
  }
}
