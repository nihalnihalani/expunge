// The REAL proposer: the evolver's `StructuredClient` port over the same provider stack the worker uses. Model selection,
// prices and the endpoint stamp come from @expunge/runtime (EXPUNGE_MODEL_PROVIDER / EXPUNGE_MODEL_ID /
// EXPUNGE_MODEL_PRICE_*), the adapter from @expunge/vendor-openmuse; nothing here re-reads those variables itself.
// It fails closed: no model selection, no credential or no complete price profile throws before any network call, and a
// call that would exceed the evolver's own token/cost budget is never dispatched. Every call is metered and the model
// stamp is exposed so `proposeCandidate` records it on the proposal.
import { chat, type AnyTextAdapter } from '@tanstack/ai';
import { UsageMeter, attestModel, modelSpecFromEnv, pricingFromEnv } from '@expunge/runtime';
import { adapter as selectAdapter, type ProviderEnv } from '@expunge/vendor-openmuse';
import {
  createStructuredEvolverModel,
  type EvolverModel,
  type EvolverModelStamp,
  type StructuredClient,
} from './model.js';

export interface MeteredEvolverModel extends EvolverModel {
  kind: 'provider';
  stamp(): EvolverModelStamp;
}

export class EvolverModelUnavailable extends Error {
  constructor(
    public readonly code: 'ModelNotConfigured' | 'PricingUnavailable' | 'ProviderCredentialMissing',
  ) {
    super(`EvolverModelUnavailable:${code}`);
    this.name = 'EvolverModelUnavailable';
  }
}
export class EvolverModelCallFailed extends Error {
  constructor(public readonly code: string) {
    super(`EvolverModelCallFailed:${code}`);
    this.name = 'EvolverModelCallFailed';
  }
}

/**
 * The wire schema handed to the provider. OpenAI strict structured output needs every property required and no untyped
 * value, so `after` travels as a JSON string (`afterJson`) and `reason` is always present (empty when not abstaining).
 * `fromWire` maps it back onto the evolver's own `proposalSchema` shape, which still validates the result.
 */
export const PROPOSAL_WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['abstain', 'reason', 'hypothesis', 'claimedClass', 'patches'],
  properties: {
    abstain: { type: 'boolean' },
    reason: { type: 'string' },
    hypothesis: { type: 'string' },
    claimedClass: { type: 'string', enum: ['tightening', 'behavioral', 'authority_expansion'] },
    patches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['surface', 'path', 'afterJson', 'hypothesis', 'sourceEvidenceIds'],
        properties: {
          surface: { type: 'string', enum: ['context', 'workflow', 'guardrails', 'tool_policy', 'plugin'] },
          path: { type: 'string' },
          afterJson: { type: 'string' },
          hypothesis: { type: 'string' },
          sourceEvidenceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const WIRE_NOTE =
  'Encode each patch value as JSON text in `afterJson` (for example "true", "5", "\\"all_registered_fields\\"" or an object). ' +
  'Set `reason` to an empty string unless you abstain.';

/** Wire answer to the evolver's proposal shape. Anything malformed is passed through so `proposalSchema` rejects it. */
export function fromWire(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const value = raw as Record<string, unknown>;
  const { reason, patches, ...rest } = value;
  const mapped: Record<string, unknown> = { ...rest };
  if (typeof reason === 'string' && reason.trim() !== '') mapped.reason = reason;
  if (!Array.isArray(patches)) return { ...mapped, patches };
  mapped.patches = patches.map((patch: unknown) => {
    if (!patch || typeof patch !== 'object') return patch;
    const { afterJson, ...fields } = patch as Record<string, unknown>;
    if (typeof afterJson !== 'string') return patch;
    try {
      return { ...fields, after: JSON.parse(afterJson) as unknown };
    } catch {
      return patch; // keeps `afterJson`, which the strict proposal schema rejects
    }
  });
  return mapped;
}

export interface ProviderEvolverOptions {
  env: ProviderEnv;
  /** The proposer's own ceiling, separate from any episode budget. */
  budget: { totalTokens: number; maxCostMicrousd: number };
  /** Test seam: the HTTP transport handed to the provider SDK. Production leaves it unset. */
  fetchImpl?: typeof fetch;
  maxOutputTokens?: number;
}

/** Build the real proposer. Throws `EvolverModelUnavailable` before any network call when it cannot run priced. */
export function createProviderEvolverModel(options: ProviderEvolverOptions): MeteredEvolverModel {
  const spec = modelSpecFromEnv(options.env);
  if (!spec) throw new EvolverModelUnavailable('ModelNotConfigured');
  const pricing = pricingFromEnv(options.env);
  if (pricing?.inputMicrousdPerMillion === undefined || pricing.outputMicrousdPerMillion === undefined)
    throw new EvolverModelUnavailable('PricingUnavailable');
  let textAdapter: AnyTextAdapter;
  try {
    textAdapter = selectAdapter(spec, options.env, options.fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.name === 'MissingProviderCredentialError')
      throw new EvolverModelUnavailable('ProviderCredentialMissing');
    throw new EvolverModelUnavailable('ModelNotConfigured');
  }
  // The stamp is derived from the selection, never from the injected transport: a fake fetch still talks to the real
  // provider adapter code, so the attestation stays `provider`.
  const attestation = attestModel({ spec, pricing }, options.env);
  const meter = new UsageMeter(options.budget, pricing, true);

  const client: StructuredClient = {
    async generateStructured(call) {
      const hold = meter.exhausted();
      if (!hold.ok) throw new EvolverModelCallFailed(hold.code);
      const stream = chat({
        adapter: textAdapter,
        systemPrompts: [`${call.system}\n${WIRE_NOTE}`],
        messages: [{ role: 'user', content: call.user }],
        outputSchema: PROPOSAL_WIRE_SCHEMA as never,
        stream: true,
        ...(options.maxOutputTokens ? { maxTokens: options.maxOutputTokens } : {}),
      }) as AsyncIterable<{
        type?: string;
        name?: string;
        value?: unknown;
        usage?: unknown;
        message?: string;
        code?: string;
      }>;
      let result: unknown;
      let usage: unknown;
      let error: string | undefined;
      for await (const chunk of stream) {
        if (chunk.type === 'CUSTOM' && chunk.name === 'structured-output.complete')
          result = (chunk.value as { object?: unknown } | undefined)?.object;
        if (chunk.type === 'RUN_FINISHED' && chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.type === 'RUN_ERROR') error = chunk.code ?? 'provider_error';
      }
      // One call is one meter row, whatever happened: spend that was reported is never dropped.
      const verdict = meter.record(usage);
      if (error) throw new EvolverModelCallFailed(error);
      if (result === undefined) throw new EvolverModelCallFailed('no_structured_output');
      if (!verdict.ok) throw new EvolverModelCallFailed(verdict.code);
      return fromWire(result);
    },
  };
  const base = createStructuredEvolverModel(spec, client);
  return {
    ...base,
    kind: 'provider',
    stamp: () => ({ attestation, pricing, usage: meter.summary() }),
  };
}
