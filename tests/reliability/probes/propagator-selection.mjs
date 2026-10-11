// Which context propagator does raindrop-ai register? Evidence probe for packet C1a/C1c, not a unit test.
//
// Usage (from a tree where `raindrop-ai` is installed; no network is used, the endpoint is a closed local port):
//   env OTEL_PROPAGATORS=jaeger node tests/reliability/probes/propagator-selection.mjs env
//   node tests/reliability/probes/propagator-selection.mjs default
// Modes: default | env | cast-propagator | global-override | disable-then-set | env-assign-in-code
// Prints one JSON line: { mode, OTEL_PROPAGATORS, fields } where `fields` is what the global propagator injects.
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(`${process.cwd()}/package.json`);
const { Raindrop } = await import(require.resolve('raindrop-ai'));
const api = await import(require.resolve('@opentelemetry/api'));
const core = await import(require.resolve('@opentelemetry/core'));

const mode = process.argv[2] ?? 'default';
const w3c = () =>
  new core.CompositePropagator({
    propagators: [new core.W3CTraceContextPropagator(), new core.W3CBaggagePropagator()],
  });

const options = {
  writeKey: 'fixture-key-not-real',
  projectId: 'probe',
  endpoint: 'http://127.0.0.1:1',
  redactPii: true,
  localWorkshopUrl: false,
  debugLogs: false,
  disableBatching: true,
};
// `propagator` is not in the public AnalyticsConfig type; this mode shows whether a cast would even take effect.
if (mode === 'cast-propagator') options.propagator = w3c();
if (mode === 'env-assign-in-code') process.env.OTEL_PROPAGATORS = 'tracecontext,baggage';

new Raindrop(options);

// The SDK registers its provider (and therefore the global propagator) synchronously in the constructor.
if (mode === 'global-override') api.propagation.setGlobalPropagator(w3c());
if (mode === 'disable-then-set') {
  api.propagation.disable();
  api.propagation.setGlobalPropagator(w3c());
}

process.stdout.write(
  `${JSON.stringify({ mode, OTEL_PROPAGATORS: process.env.OTEL_PROPAGATORS ?? null, fields: api.propagation.fields() })}\n`,
);
process.exit(0);
