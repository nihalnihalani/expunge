// Port of the provider adapter selection from OpenMuse
// apps/server/src/engine/tanstack-agent.ts (lines 23-79) at commit
// 1ac68f3909f2478ab6280883f1ab5ea65eb5719d. MIT, Copyright (c) 2026 OpenMuse contributors.
// Modifications are listed in ../THIRD_PARTY.md (M1-M4).
import type { AnyTextAdapter } from '@tanstack/ai';
import { type AnthropicChatModel, createAnthropicChat } from '@tanstack/ai-anthropic';
import { type OpenAIChatModel, createOpenaiChat, createOpenaiChatCompletions } from '@tanstack/ai-openai';
import { providerClientOptions } from './model-retries.js';

/**
 * An environment map. The provider selection reads only OPENAI_API_KEY, OPENAI_BASE_URL,
 * OPENAI_CHAT_COMPLETIONS, ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL (names match the upstream SDKs).
 */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export type SupportedProvider = 'openai' | 'anthropic';

/** Thrown before any network call when the selected provider has no credential in the environment. */
export class MissingProviderCredentialError extends Error {
  readonly provider: SupportedProvider;
  readonly variable: string;
  constructor(provider: SupportedProvider, variable: string) {
    super(`MissingProviderCredential:${variable}`);
    this.name = 'MissingProviderCredentialError';
    this.provider = provider;
    this.variable = variable;
  }
}

export function parseModelSpec(spec: string): { provider: string; model: string } {
  const [, provider = '', model = ''] = spec.trim().match(/^([^/:]*)[/:](.*)$/) ?? [];
  if (!provider || !model.trim())
    throw new Error(`Invalid model string "${spec}". Use "openai/gpt-5" or "anthropic/claude-sonnet-4.5".`);
  return { provider: provider.toLowerCase(), model: model.trim() };
}

/** Which credential variable a model string needs. Used by readiness checks without building an adapter. */
export function requiredCredentialVariable(spec: string): string {
  const { provider } = parseModelSpec(spec);
  if (provider === 'openai') return 'OPENAI_API_KEY';
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  throw unknownProvider(provider, spec);
}

// Same "provider/model" strings, env vars and base URL formats as the AI SDK resolver in
// @copilotkit/runtime. Each provider SDK retries transient failures up to MODEL_MAX_RETRIES times.
export function adapter(
  spec: string,
  env: ProviderEnv = process.env,
  fetchImpl?: typeof fetch,
): AnyTextAdapter {
  const { provider, model: id } = parseModelSpec(spec);
  switch (provider) {
    case 'openai': {
      const apiKey = env.OPENAI_API_KEY?.trim();
      if (!apiKey) throw new MissingProviderCredentialError('openai', 'OPENAI_API_KEY');
      const config = { ...providerClientOptions(undefined, fetchImpl), baseURL: env.OPENAI_BASE_URL };
      // OpenAI-compatible endpoints that do not implement the Responses API
      // tool loop (e.g. DeepSeek) can opt into the Chat Completions wire format.
      if (env.OPENAI_CHAT_COMPLETIONS === 'true')
        return createOpenaiChatCompletions(id as OpenAIChatModel, apiKey, config);
      return createOpenaiChat(id as OpenAIChatModel, apiKey, config);
    }
    case 'anthropic': {
      const apiKey = env.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) throw new MissingProviderCredentialError('anthropic', 'ANTHROPIC_API_KEY');
      return createAnthropicChat(id as AnthropicChatModel, apiKey, {
        ...providerClientOptions(undefined, fetchImpl),
        // The AI SDK base URL ends in /v1; the Anthropic SDK adds /v1 itself.
        baseURL: env.ANTHROPIC_BASE_URL?.replace(/\/v1\/?$/, ''),
      });
    }
    default:
      throw unknownProvider(provider, spec, env.OPENAI_BASE_URL);
  }
}

/** With OPENAI_BASE_URL set, a gateway model ID most likely needs the openai/ prefix. */
export function unknownProvider(provider: string, spec: string, baseUrl?: string) {
  const hint = baseUrl?.trim()
    ? ` For a model on your OPENAI_BASE_URL gateway, use "openai/${spec.trim()}".`
    : '';
  return new Error(
    `Unknown provider "${provider}" in "${spec}". Supported in this port: openai, anthropic.${hint}`,
  );
}
