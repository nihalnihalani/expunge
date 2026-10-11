# Raindrop production requirements for the Claude Code /goal prompt

Fact gathering only, 11 October 2026. No application code, service, account, experiment, telemetry event or deletion request was changed. Three fresh Firecrawl calls checked the developer index, official TypeScript SDK page and official Query API reference. Existing same-session published SDK 1.0.1 and Query OpenAPI caches supply exact signatures and schemas.

## Primary sources and copy locations

- [TypeScript SDK](https://raindrop.ai/docs/sdk/typescript): fresh `.firecrawl/prompt-raindrop-typescript.md`; diagnostics 350–475, tool wrapping 847 onward, external OTel 1026 onward, detached subagent dispatch/resume 1120–1275. Published [1.0.1 archive](https://registry.npmjs.org/raindrop-ai/-/raindrop-ai-1.0.1.tgz) is `.firecrawl/blueprint-raindrop-sdk-1.0.1.tgz`; declarations `.firecrawl/blueprint-raindrop-types.d.ts`.
- [Query API reference](https://raindrop.ai/docs/query-api/api-reference): fresh `.firecrawl/prompt-raindrop-query-reference.md`; authentication, project and rate limits 131–173. [Query OpenAPI](https://query.raindrop.ai/v1/openapi.json): existing `.firecrawl/blueprint-raindrop-openapi.json` and selected contracts `.firecrawl/blueprint-raindrop-contracts.json`. Exact path operation objects are authoritative for request serialization.
- [HTTP ingestion](https://raindrop.ai/docs/sdk/http-api): `.firecrawl/blueprint-raindrop-http-api.md`; event arrays 63–118, signal arrays 146–166.
- [MCP](https://raindrop.ai/docs/mcp/overview): `.firecrawl/blueprint-raindrop-mcp.md`; issues 250 onward, experiments 264 onward, write scopes 303 onward.
- [Experiments](https://raindrop.ai/docs/platform/experiments): `.firecrawl/blueprint-raindrop-experiments.md`.
- [Plans](https://raindrop.ai/docs/platform/plans): `.firecrawl/blueprint-raindrop-plans.md`.
- [PII redaction](https://raindrop.ai/docs/security/pii-redaction), [privacy policy](https://raindrop.ai/docs/security/privacy-policy): `.firecrawl/blueprint-raindrop-pii.md`, `blueprint-raindrop-policy.md`.

The fresh developer index search was sparse for exact vendor contracts; its output is Markdown despite its `.json` filename. Use the official docs and package/spec evidence above, not unrelated search hits. Detailed existing findings remain in `docs/research/blueprint-raindrop.md`.

## Mandatory deep integration

Instrument real worker, observer, improver, Hider, meta-improver, evaluation and admission episodes. Preserve immutable correlation across job/run/role/world/harness/model-profile/parent/evidence/candidate/trial/experiment-arm IDs. Use one appropriate tracing initialization per process, real provider instrumentation with coverage probes, actual offered tool catalog, and explicit manual spans for trusted gateway and compile/evaluation boundaries.

For the pinned SDK, `begin(PartialAiTrackEvent & {event:string,userId:string,tools?:...})` returns Interaction. Supply explicit eventId. `withTool<T>(ToolParams, callback):Promise<T>` and `withSpan<T>(SpanParams, callback):Promise<T>` use object parameters. `finish(FinishInteractionOptions):Promise<void>` requires output. `trackSignal(SignalEvent | SignalEvent[]):void | void[]` only enqueues. `close():Promise<void>` drains at process shutdown, not after every shared-client run. Numeric tool version is distinct from harness hash; place the latter in properties.

Published package implementation confirms `finish()` awaits the terminal partial-event POST and propagates its failure, but catches span-flush failures. Awaited finish cannot prove complete spans/signals. Maintain a MongoDB outbox with deterministic logical IDs, payload hashes, leases, attempts and status; provider requests occur after domain transaction commits. Distinguish committed/pending, SDK-enqueued, terminal ingest accepted, query-visible, evidence-ready, retrying and dead-letter. At-least-once dispatch is the assumption; no exactly-once vendor guarantee was verified.

Diagnostics must be executable server tools. `createSelfDiagnosticsTool` exposes inputSchema and `execute(input,context?):Promise<result>`. OpenAI/Anthropic adapters supply definitions; dispatch must call execute. No documented forTanStack adapter exists. Preserve explicit application origin: agent_self_report, verifier_feedback, human_feedback, raindrop_classifier, experiment_result and admission_service; map to vendor types through a tested adapter. A verifier result transported through Raindrop remains verifier-origin evidence.

Use `interaction.subagent(options)`, all returned dispatch.headers, and `resumeSubagent(headers,options?)` or `withSubagentRun(headers,fn,options?)` for actual delegated work. Carry traceparent, baggage and x-raindrop-handoff inside authenticated internal jobs. Each child reports finish/fail/cancel correctly. A missing/disabled carrier is an unlinked event, not a native link. For later independent investigation, explicit observed_event_id metadata is legitimate application correlation. Do not invent links[] span options or create fake parent dispatches.

## Load-bearing evidence-to-change path

1. A worker executes the parent on a real scoped world and emits actual model/tool evidence.
2. A fixed verifier/grader records the specific failure with its true source label.
3. Observer retrieves the remote event and required tool/model spans using the separate query key; persists a sanitized, versioned observation hash and event/span IDs in Atlas.
4. Improver receives this remote trace evidence plus permitted visible schema observations. It diagnoses the mechanism (e.g. discovery stopped at direct customer references and omitted account-to-event expansion), then proposes a typed context/workflow/tool-policy/plugin change whose diff cites supporting evidence.
5. Static compile, policy replay and fresh paired independent parent/candidate execution decide eligibility. Raindrop classifications never overwrite expected outcomes or promote a harness.
6. Store score-only and wrong-incident controls under equal budgets. Compare results to establish whether detailed relevant evidence contributed. Preserve null/negative results.

Missing vendor visibility or enrichment leaves a proposal waiting/HOLD; do not fabricate trace evidence. Domain jobs may complete with a durable pending outbox, but candidates cannot be labelled Raindrop-evidence-derived before read-back succeeds.

## Query observer and experiments

Query base is https://query.raindrop.ai with separate Query-key bearer and explicit X-Raindrop-Project-Id. GET /v1/events has limit 1–500, opaque cursor and meta.cursor/has_more. Use properties[harness_hash][eq] and properties[evidence_arm][eq]; event listing has no documented feature_flags or model filter. Preserve exact time bounds and filter identity across cursor pages; URLSearchParams must encode +timestamp. GET /v1/signals is a definitions catalog; resolve canonical UUID then query matching events with signal UUID. SDK signal types and catalog types differ.

Commit each page's evidence snapshots and cursor advance together in Atlas. Deduplicate event identity while permitting new enrichment revisions. Timestamp overlap alone is insufficient: keep durable pending known event IDs beyond the watermark and poll detail until requirements are met or HOLD. GET /v1/traces requires event_id, max1000 spans, no documented cursor. Record potentially incomplete evidence if the cap is reached. Rate-limit/jitter/backoff and narrow timeout searches.

MCP exposes create_experiment/get_experiment plus issues, datasets and signal tools. Capture authenticated tools/list schemas and account capabilities at bootstrap; do not invent arguments or REST experiment paths. Experiments compare already logged cohorts; they do not execute agents. Keep cohort filters separate from outcome signals, report sample sufficiency/CI and unpriced model coverage. Pro-only availability has explicit unavailable/setup-needed UI and a local independent paired-evaluation fallback. Keep the native adapter implemented; unavailable account access is not successful integration. No plan upgrade or purchase is assumed.

## Privacy and deletion

Sanitize before every exporter, including LLM messages, attachments, errors, tool catalogs and span attributes. traceContent:false on one tool wrapper and redactPii:true regex redaction are not universal protection. Use namespaced opaque synthetic telemetry identities and structural lessons. Retract future export and source eligibility immediately while tracking provider erasure separately.

POST /v1/deletions/users with user_ids (1–100), requester and truthful regulation gdpr|ccpa|other creates an org-wide job; project header does not narrow it. Status pending/in_progress/completed/rejected and due_by reflects documented 30-day lifecycle. GET job/list tracks confirmation. DELETE /v1/deletions/users/{id}/{user_id} cancels pending deletion and preserves data. Implement cancellation under its real name, never as erasure. No instant per-event purge was verified. No contractual trace/backup TTL was available; the policy's account-data retention expressly excludes Customer Agent Data.

## Acceptance evidence required

- Real provider episode visible remotely with actual model, tokens, tool catalog and tool/error spans; compare exact domain IDs and harness hash.
- Diagnostics dispatch calls execute and creates a correctly sourced signal on the intended event.
- Authenticated cross-process carrier links real parent/child; missing/disabled carriers display unlinked.
- Fault injection: event POST fails; event succeeds but spans fail; buffered signal is not delivered; Query delays/401/403/429/5xx occur. No false evidence-ready state, no lost domain receipt, bounded retry/dead-letter/HOLD.
- More than one cursor page and restart immediately before/after the page transaction; no dropped evidence or duplicate admission.
- Late enrichment of an already-read event yields a new evidence revision and one eligible improvement job.
- Truncated/max-cap evidence is marked incomplete.
- A trace-cited executable change improves fresh worlds under the same model; score-only and wrong-incident controls remain auditable.
- Actual MCP tools/list contract capture and authorized experiment read/write probe when supported; unavailable plan/account explicitly disclosed.
- Non-destructive privacy contract tests prove POST-as-request and DELETE-as-cancel, org-wide impact and async status. Real deletion only on explicitly authorized identities; never on unrelated org data.
- Audit every telemetry path for secrets and raw personal payloads; provenance/retraction prevents future recall/export.

Confidence: high on inspected SDK/schema contracts; actual TanStack provider auto-instrumentation coverage, runtime delivery/enrichment latency, vendor deduplication and authenticated MCP schemas remain live probes. Production readiness must report these separately from local tests and mocks.
