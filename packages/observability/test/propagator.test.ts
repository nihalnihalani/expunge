import { propagation } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTracing, initTracing } from '../src/index.js';
import { FakeRaindrop } from './fake-raindrop.js';

/**
 * The SDK's tracer provider reads OTEL_PROPAGATORS. Probed separately: with the variable set to `jaeger` and no pin,
 * constructing the SDK leaves the global propagator at ["uber-trace-id"]. initTracing must make that impossible.
 */
const fake = new FakeRaindrop();
beforeAll(async () => {
  await fake.start();
  process.env.OTEL_PROPAGATORS = 'jaeger';
});
afterAll(async () => {
  delete process.env.OTEL_PROPAGATORS;
  await closeTracing();
  await fake.stop();
});

describe('propagator pin (SDK advisory: @opentelemetry/propagator-jaeger)', () => {
  it('with OTEL_PROPAGATORS=jaeger in the environment, the active propagator speaks only W3C trace context and baggage', () => {
    initTracing(
      { writeKey: fake.keys().writeKey, projectId: 'proj-1', endpoint: fake.ingestUrl },
      { disableBatching: true },
    );
    const fields = [...propagation.fields()].sort();
    expect(fields).toEqual(['baggage', 'traceparent', 'tracestate']);
    expect(fields).not.toContain('uber-trace-id');
    expect(fields.some((field) => field.startsWith('uberctx'))).toBe(false);
  });

  it('restores the caller environment after construction', () => {
    expect(process.env.OTEL_PROPAGATORS).toBe('jaeger');
  });

  it('a second initialization with the same configuration keeps the same propagator', () => {
    initTracing(
      { writeKey: fake.keys().writeKey, projectId: 'proj-1', endpoint: fake.ingestUrl },
      { disableBatching: true },
    );
    expect([...propagation.fields()].sort()).toEqual(['baggage', 'traceparent', 'tracestate']);
  });
});
