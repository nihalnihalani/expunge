import { describe, expect, it } from 'vitest';
import { EnvModelResolver, modelSpecFromEnv, providerReadiness } from '../src/index.js';
import { makeBundle, makeJob } from './fakes.js';

describe('model selection and provider readiness', () => {
  it('builds the spec from EXPUNGE_MODEL_PROVIDER and EXPUNGE_MODEL_ID', () => {
    expect(modelSpecFromEnv({ EXPUNGE_MODEL_PROVIDER: 'OpenAI', EXPUNGE_MODEL_ID: 'gpt-5' })).toBe(
      'openai/gpt-5',
    );
    expect(modelSpecFromEnv({ EXPUNGE_MODEL_PROVIDER: 'openai' })).toBeNull();
    const bundle = makeBundle();
    const job = makeJob(bundle);
    expect(
      new EnvModelResolver({
        EXPUNGE_MODEL_PROVIDER: 'anthropic',
        EXPUNGE_MODEL_ID: 'claude-sonnet-4.5',
      }).select(job, bundle),
    ).toEqual({
      spec: 'anthropic/claude-sonnet-4.5',
    });
    expect(() => new EnvModelResolver({}).select(job, bundle)).toThrow('ModelNotConfigured');
  });

  it('is ready only when the selected provider has its key, without exposing the key', () => {
    const ready = providerReadiness({
      EXPUNGE_MODEL_PROVIDER: 'openai',
      EXPUNGE_MODEL_ID: 'gpt-5',
      OPENAI_API_KEY: 'test-secret-value-not-real',
    });
    expect(ready).toEqual({ ready: true, spec: 'openai/gpt-5', credentialVariable: 'OPENAI_API_KEY' });
    expect(JSON.stringify(ready)).not.toContain('test-secret-value-not-real');
    // A key for a different provider does not satisfy the selected one.
    expect(
      providerReadiness({
        EXPUNGE_MODEL_PROVIDER: 'anthropic',
        EXPUNGE_MODEL_ID: 'c',
        OPENAI_API_KEY: 'test-secret-value-not-real',
      }),
    ).toEqual({
      ready: false,
      blockers: [{ blocker: 'provider credentials', detail: 'Set ANTHROPIC_API_KEY.' }],
    });
  });

  it('flags unsupported providers as model configuration, never as missing credentials', () => {
    const result = providerReadiness({
      EXPUNGE_MODEL_PROVIDER: 'gemini',
      EXPUNGE_MODEL_ID: 'x',
      GOOGLE_API_KEY: 'k',
    });
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.blockers[0]?.blocker).toBe('model configuration');
  });
});
