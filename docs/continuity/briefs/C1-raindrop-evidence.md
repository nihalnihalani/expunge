# Brief C1: Raindrop tracing, outbox, observer and evidence bundles

Owner: **runtime-raindrop** after B2-1. Owned paths: `packages/observability/`, `packages/observer/`. Depends on: A2-R (`telemetry_outbox`, `telemetry_receipts`, `observer_cursors`, `evidence` repositories), B1 (decision ledger rows to correlate), B2-1 (worker runtime hooks). Frozen interfaces: CONTRACTS.md `EvidenceReference`, `EvidenceBundle`, `TelemetryOutbox` states, `ObserverCursor`, `ExternalErasureJob`.

Status: drafted 2026-10-11 11:10 UTC, not dispatched.

## Objective

Make Raindrop the real observed evidence path (spec section 8): every worker and improver episode is a Raindrop interaction with model and tool spans; the observer reads events and traces back through the Query API; a sanitized `EvidenceBundle` is persisted and is the only input the evolver may cite. Delivery states are honest and separate: `pending → leased → sdk_enqueued → ingest_accepted → query_visible → evidence_ready`, plus `retrying`, `dead_letter` and HOLD.

## Must follow (from docs/research/blueprint-raindrop.md and prompt-raindrop.md)

- SDK 1.0.1: `begin({event, userId, eventId, properties, tools})` → Interaction; `withTool({...}, cb)`, `withSpan({...}, cb)` object params; `await interaction.finish(...)`; `close()` at shutdown; `trackSignal` is buffered and returns void. Awaited finish proves the terminal event POST only, not span or signal delivery.
- Query API: separate read key; `/v1/signals` is a catalog (resolve UUID, then `/v1/events?signal=<UUID>`); paginate with `meta.cursor` / `has_more` under a fixed filter identity; `/v1/traces` needs `event_id`, has a 1,000-row cap and no cursor → mark potentially truncated.
- Self Diagnostics: `createSelfDiagnosticsTool().execute(input, context?)` must be dispatched by a real TanStack server tool; no `forTanStack` adapter exists.
- Subagent carriers: use `interaction.subagent` and `resumeSubagent`/`withSubagentRun`; carry returned `traceparent`/`baggage`/`x-raindrop-handoff` headers through authenticated internal dispatch; never invent span `links[]`.
- User deletion: POST `{user_ids, requester, regulation}` (1 to 100 IDs; `gdpr|ccpa|other`), organization-wide; GET tracks `pending|in_progress|completed|rejected`; DELETE cancels a pending request and never purges.
- Telemetry user IDs are opaque, namespaced per project; subject handles map to them in `subject_tokens` (privacy_controller only).

## Deliverables

1. `packages/observability`: `instrumentWorkerEpisode`, `instrumentImproverCampaign`, span wrappers for the TanStack provider call (verify a real model span appears, not just a span named "model"), tool wrappers with sanitized args and outcomes, diagnostics dispatch adapter, one tracing init per process, graceful close.
2. Transactional outbox dispatcher: intents are inserted in the domain transaction (A2-R `outbox` on `commitEffect`), dispatched after commit, each attained state recorded with time and content hash; retries with jitter; dead letter after bounded attempts; HOLD when evidence is visible but incomplete.
3. `packages/observer`: Query client with fixed `ObserverQueryIdentity`, cursor persistence after dedupe and local commit, pending-ID rereads after watermark advance for late enrichment, evidence revision retention, bounded backoff on 401/403/429/5xx, trace cap flag.
4. `EvidenceBundle` assembler: origin labels preserved (`agent_self_report`, `verifier_feedback`, `human_feedback`, `raindrop_classifier`, `experiment_result`, `admission_service`), held-out manifests absent, split recorded, cost recorded, raw witnesses only for the training split. Score-only and wrong-incident control bundles use the same schema and budget.
5. MCP: capture authenticated `tools/list` before using Issues or Experiments; if the plan lacks them, record `unavailable` honestly.
6. Tests with a labeled fake Raindrop HTTP server for protocol and fault paths (terminal accepted but span flush lost; signals buffered; delayed enrichment; capped traces; 429/5xx; cursor crash mid-page), plus a live smoke that is BLOCKED until `RAINDROP_API_KEY`, `RAINDROP_QUERY_API_KEY`, `RAINDROP_PROJECT_ID` exist in the root `.env`.

## Evidence to report

Local: tests and exit codes. Live (when unblocked): one worker interaction's event ID and trace read back with matching `harness_hash` and `run_id` properties, the outbox row's attained states, and one evidence bundle citing those IDs.
