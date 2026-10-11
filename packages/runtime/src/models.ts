import { contentHash, type HarnessBundle, type Job } from '@expunge/contracts';
import {
  adapter,
  parseModelSpec,
  requiredCredentialVariable,
  type ProviderEnv,
} from '@expunge/vendor-openmuse';
import type { ModelAttestation, ModelPricing, ModelResolver, ModelSelection } from './ports.js';

/**
 * Model selection from the process environment: EXPUNGE_MODEL_PROVIDER (openai | anthropic) and
 * EXPUNGE_MODEL_ID. The frozen worker profile (`workerProfileHash`) pins the experiment's model in
 * later phases; until the profile store exists this resolver is the only selection path.
 */
export function modelSpecFromEnv(env: ProviderEnv): string | null {
  const provider = env.EXPUNGE_MODEL_PROVIDER?.trim().toLowerCase();
  const id = env.EXPUNGE_MODEL_ID?.trim();
  if (!provider || !id) return null;
  return `${provider}/${id}`;
}

function microusd(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Prices from EXPUNGE_MODEL_PRICE_INPUT/OUTPUT_MICROUSD_PER_MILLION. Missing or malformed means unpriced, never zero. */
export function pricingFromEnv(env: ProviderEnv): ModelPricing | undefined {
  const inputMicrousdPerMillion = microusd(env.EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION);
  const outputMicrousdPerMillion = microusd(env.EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION);
  if (inputMicrousdPerMillion === undefined && outputMicrousdPerMillion === undefined) return undefined;
  return {
    ...(inputMicrousdPerMillion !== undefined ? { inputMicrousdPerMillion } : {}),
    ...(outputMicrousdPerMillion !== undefined ? { outputMicrousdPerMillion } : {}),
  };
}

/** Hash of the runtime-visible profile (model string and prices). Recorded with each run next to the job's pin. */
export function profileFingerprint(spec: string, pricing: ModelPricing | undefined): string {
  return contentHash({ spec, pricing: pricing ?? null }, 'worker-profile');
}

export class EnvModelResolver implements ModelResolver {
  constructor(private readonly env: ProviderEnv) {}
  select(_job: Job, _bundle: HarnessBundle): ModelSelection {
    const spec = modelSpecFromEnv(this.env);
    if (!spec) throw new Error('ModelNotConfigured');
    const pricing = pricingFromEnv(this.env);
    return { spec, ...(pricing ? { pricing } : {}) };
  }
}

export type ProviderBlocker = {
  blocker: 'provider credentials' | 'model configuration';
  detail: string;
};
export type ProviderReadiness =
  { ready: true; spec: string; credentialVariable: string } | { ready: false; blockers: ProviderBlocker[] };

/**
 * Presence-only readiness for the live provider. Never prints or returns a credential value. It
 * also builds the adapter (a local object, no network call) to prove the selection is valid.
 * With nothing configured at all, BOTH blockers are reported: the model is unselected and no
 * provider credential is present.
 */
export function providerReadiness(env: ProviderEnv): ProviderReadiness {
  const spec = modelSpecFromEnv(env);
  const hasAnyKey = Boolean(env.OPENAI_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim());
  if (!spec) {
    const blockers: ProviderBlocker[] = [
      {
        blocker: 'model configuration',
        detail: 'Set EXPUNGE_MODEL_PROVIDER (openai or anthropic) and EXPUNGE_MODEL_ID.',
      },
    ];
    if (!hasAnyKey)
      blockers.push({
        blocker: 'provider credentials',
        detail: 'Set OPENAI_API_KEY (openai) or ANTHROPIC_API_KEY (anthropic).',
      });
    return { ready: false, blockers };
  }
  let variable: string;
  try {
    parseModelSpec(spec);
    variable = requiredCredentialVariable(spec);
  } catch (error) {
    return {
      ready: false,
      blockers: [
        {
          blocker: 'model configuration',
          detail: error instanceof Error ? error.message : 'Invalid model configuration.',
        },
      ],
    };
  }
  if (!env[variable]?.trim())
    return { ready: false, blockers: [{ blocker: 'provider credentials', detail: `Set ${variable}.` }] };
  try {
    adapter(spec, env);
  } catch (error) {
    return {
      ready: false,
      blockers: [
        {
          blocker: 'model configuration',
          detail: error instanceof Error ? error.message : 'Provider adapter could not be built.',
        },
      ],
    };
  }
  return { ready: true, spec, credentialVariable: variable };
}

/**
 * What a selection really is. An injected text adapter (the labeled FAKE provider under src/testing, the only way an adapter
 * can be injected) is ALWAYS `fake`, with the adapter's own name and model, whatever spec the profile declares. Anything else
 * is `provider`, with provider and model parsed from the selection's spec.
 */
export function attestModel(selection: ModelSelection): ModelAttestation {
  const adapter = selection.textAdapter as { name?: unknown; model?: unknown } | undefined;
  if (adapter)
    return {
      source: 'fake',
      provider: typeof adapter.name === 'string' ? adapter.name : 'injected_adapter',
      modelId: typeof adapter.model === 'string' ? adapter.model : 'unknown',
      spec: selection.spec,
    };
  const { provider, model } = parseModelSpec(selection.spec);
  return { source: 'provider', provider, modelId: model, spec: selection.spec };
}
