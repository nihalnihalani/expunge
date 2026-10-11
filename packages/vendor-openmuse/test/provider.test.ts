import { describe, expect, it } from 'vitest';
import {
  MODEL_MAX_RETRIES,
  MissingProviderCredentialError,
  adapter,
  parseModelSpec,
  requiredCredentialVariable,
  unknownProvider,
} from '../src/index.js';

describe('provider adapter selection (OpenAI and Anthropic only in this port)', () => {
  it('keeps the upstream retry constant of 2', () => {
    expect(MODEL_MAX_RETRIES).toBe(2);
  });

  it('selects the OpenAI Responses adapter and the Chat Completions adapter on opt-in', () => {
    const responses = adapter('openai/gpt-5', { OPENAI_API_KEY: 'dummy-not-a-real-key' });
    expect(responses.name).toBe('openai');
    expect(responses.model).toBe('gpt-5');
    const chatCompletions = adapter('openai:gpt-5', {
      OPENAI_API_KEY: 'dummy-not-a-real-key',
      OPENAI_CHAT_COMPLETIONS: 'true',
    });
    expect(chatCompletions.name).toBe('openai-chat');
    expect(chatCompletions.constructor.name).not.toBe(responses.constructor.name);
  });

  it('selects the Anthropic adapter and strips a trailing /v1 from its base URL', () => {
    const selected = adapter('anthropic/claude-sonnet-4.5', {
      ANTHROPIC_API_KEY: 'dummy-not-a-real-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example/v1/',
    });
    expect(selected.name).toBe('anthropic');
  });

  it('fails before any network call, naming only the VARIABLE, when the credential is missing', () => {
    expect(() => adapter('openai/gpt-5', {})).toThrow(MissingProviderCredentialError);
    expect(() => adapter('anthropic/claude-sonnet-4.5', { ANTHROPIC_API_KEY: '  ' })).toThrow(
      /MissingProviderCredential:ANTHROPIC_API_KEY/,
    );
    expect(requiredCredentialVariable('openai/gpt-5')).toBe('OPENAI_API_KEY');
    expect(requiredCredentialVariable('anthropic:claude-x')).toBe('ANTHROPIC_API_KEY');
  });

  it('rejects malformed model strings and providers this port dropped', () => {
    expect(() => parseModelSpec('gpt-5')).toThrow(/Invalid model string/);
    expect(() => parseModelSpec('openai/')).toThrow(/Invalid model string/);
    expect(() => adapter('google/gemini-2.5-pro', {})).toThrow(/Unknown provider "google"/);
    expect(unknownProvider('x', 'x/y', 'https://gateway').message).toContain('openai/x/y');
    expect(unknownProvider('x', 'x/y').message).not.toContain('OPENAI_BASE_URL gateway');
  });
});
