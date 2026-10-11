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
  ) {}

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
