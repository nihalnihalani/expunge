# @expunge/observability

Raindrop tracing for worker and improver episodes: one tracing initialization per process, committed-facts episode
events, a structural sanitizer, tool and diagnostics spans, subagent carriers, an ingestion client and telemetry
outbox intents. The delivery side (outbox dispatch, Query API read-back, evidence bundles) is `@expunge/observer`.

## Dependency note

`raindrop-ai` 1.0.1 is a spec-pinned dependency and it is heavy: it brings about 126 third-party packages and raises
`npm audit` advisories, among them `@opentelemetry/propagator-jaeger` and `@opentelemetry/sdk-trace-node` 1.x, and
`langsmith` through `@langchain/core` under `@traceloop/instrumentation-langchain`.

- The SDK bundles Traceloop instrumentations for LangChain, LlamaIndex, vector stores and other providers. Its default
  list constructs them at init (including `LangChainInstrumentation`), but they are **inert**: an instrumentation patches
  a library only when that module is loaded, and nothing in this repository imports `langchain`, `@langchain/core` or
  `langsmith` (the only text match is a generated lockfile).
- The audited fixes are outside what `raindrop-ai` 1.0.1 accepts: `@opentelemetry/propagator-jaeger` is fixed in 2.9.0
  and `langsmith` (high) in 0.6.0. The pinned SDK range stays on the vulnerable majors, which is why the Jaeger path is
  closed in code (next point) and the LangChain path is closed by never loading that library.
- The Jaeger propagator is never active. `initTracing` pins `OTEL_PROPAGATORS` to `tracecontext,baggage` while the
  SDK is constructed and then sets the global propagator to W3C trace context plus W3C baggage, so the environment
  cannot select Jaeger. The fields on the wire are `traceparent`, `tracestate` and `baggage` only.
- Replacing the SDK with direct OTLP export plus the existing `IngestClient` is a recorded production-readiness
  option. It would remove the dependency weight; the episode, sanitizer, outbox and carrier code do not depend on
  SDK internals beyond `begin`, `withSpan`, `startToolSpan`, `finish` and the subagent carrier calls.

## Free text fails closed

The worker cannot know a subject's literals (they live in a privacy-controller-only collection), so free text is
reduced to a hash and length unless the caller supplies a forbidden-literal list. The leak guard (`leak.ts`) refuses
held-out keys, literals in keys and values (folded, split and encoded forms) and private ids from a salted-hash set.
