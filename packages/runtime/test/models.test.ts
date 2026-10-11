import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvModelResolver, attestModel, modelSpecFromEnv, providerReadiness } from '../src/index.js';
import { FAKE_PROVIDER_NAME, FakeChatModel, fakeText } from '../src/testing/index.js';
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

describe('attestModel: what the run really resolved', () => {
  it('a provider selection gets provider kind and model id parsed from the environment-built spec', () => {
    const bundle = makeBundle();
    const job = makeJob(bundle);
    const selection = new EnvModelResolver({
      EXPUNGE_MODEL_PROVIDER: 'Anthropic',
      EXPUNGE_MODEL_ID: 'claude-sonnet-4.5',
    }).select(job, bundle);
    expect(attestModel(selection, {})).toEqual({
      source: 'provider',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4.5',
      spec: 'anthropic/claude-sonnet-4.5',
      endpoint: 'default',
    });
    expect(attestModel({ spec: 'openai/gpt-5' })).toMatchObject({
      source: 'provider',
      provider: 'openai',
      modelId: 'gpt-5',
    });
  });

  it('an injected FakeChatModel is recorded as fake whatever spec the profile declares', () => {
    const fake = new FakeChatModel([fakeText('x')]);
    for (const spec of ['fake/fake', 'openai/gpt-5', 'anthropic/claude-opus-5']) {
      const stamp = attestModel({ spec, textAdapter: fake.adapter });
      expect(stamp).toEqual({
        source: 'fake',
        provider: FAKE_PROVIDER_NAME,
        modelId: 'fake-deterministic-1',
        spec,
      });
    }
  });

  it('an overridden base URL is recorded as overridden with a host hash, never the URL', () => {
    const openai = attestModel(
      { spec: 'openai/gpt-5' },
      { OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1/secret-token' },
    );
    expect(openai).toMatchObject({ source: 'provider', endpoint: 'overridden' });
    expect(openai.endpointHostHash).toBe(createHash('sha256').update('127.0.0.1:9999').digest('hex'));
    expect(JSON.stringify(openai)).not.toContain('secret-token');
    const anthropic = attestModel(
      { spec: 'anthropic/claude-x' },
      { ANTHROPIC_BASE_URL: 'https://Gateway.Example.com/v1' },
    );
    expect(anthropic).toMatchObject({ endpoint: 'overridden' });
    expect(anthropic.endpointHostHash).toBe(createHash('sha256').update('gateway.example.com').digest('hex'));
    // the other provider's variable does not count
    expect(attestModel({ spec: 'anthropic/claude-x' }, { OPENAI_BASE_URL: 'http://x' })).toMatchObject({
      endpoint: 'default',
    });
  });
});
