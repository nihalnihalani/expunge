# Raindrop contracts for the Expunge implementation blueprint

Fact-gathering report, 11 October 2026. No application implementation, account mutation, telemetry ingestion, experiment creation or deletion request was performed.

## 1. Findings that change the implementation contract

1. **Write acceptance, SDK enqueue and query visibility are different states.** Published `raindrop-ai@1.0.1` declares `trackSignal(...): void | void[]`; awaiting it does not confirm delivery. `Interaction.finish(...)` and `close()` return promises. Query read-back remains necessary before declaring evidence available.
2. **`GET /v1/signals` lists signal definitions, not signal occurrences.** Resolve a signal UUID from that catalog, then retrieve matched events through `GET /v1/events?signal=<UUID>`.
3. **Event enrichment is asynchronous.** Signals, tool calls, topics and error spans can be missing on very recent events. A timestamp cursor alone misses later enrichment of an already-read event.
4. **Trace retrieval is bounded, not cursor-paginated:** `GET /v1/traces?event_id=...`, default 200 spans, maximum 1,000; optional `trunc_len`. No trace cursor is in the inspected OpenAPI.
5. **There is a real user-deletion API, but it is not instant.** The public OpenAPI says completion within 30 days and returns a due date. Deletion jobs are org-wide, not project-scoped.
6. **`DELETE /v1/deletions/users/{id}/{user_id}` cancels that user's pending deletion.** It keeps their data; do not implement this as the deletion operation.
7. **Real cross-process subagent trace helpers are available.** Use `interaction.subagent()` and `resumeSubagent()`/`withSubagentRun()` with their returned carrier. No `links` field exists on the inspected `SpanParams` or `ToolParams`; do not invent a Raindrop `links: [...]` option.
8. **MCP experiment names and behavior are documented; exact tool input schemas were not retrieved.** Capture authenticated `tools/list` schemas at setup. Do not invent a `create_experiment` request object from its name.

## 2. Sources consulted and what was read

| Source | Read / saved evidence |
|---|---|
| [Raindrop docs map](https://raindrop.ai/docs) | Firecrawl map, selected SDK, Query API, privacy, OTel, signals and experiment pages; `.firecrawl/blueprint-raindrop-map.json`. |
| [TypeScript SDK](https://raindrop.ai/docs/sdk/typescript) | Interaction, signals, diagnostics adapters, span/tool APIs, flags, multi-project routing, tool catalog and cross-process subagents. Cached fresh public page copied to `.firecrawl/blueprint-raindrop-typescript.md`. |
| [Published SDK archive](https://registry.npmjs.org/raindrop-ai/-/raindrop-ai-1.0.1.tgz) | `npm view` confirmed version **1.0.1**; archive downloaded and declarations extracted without installation/execution. `.firecrawl/blueprint-raindrop-types.d.ts` and `blueprint-raindrop-index.d.ts`. |
| [Query OpenAPI](https://query.raindrop.ai/v1/openapi.json) | Live complete spec, OpenAPI 3.1, title Query API Beta, version 1.0.0. Events/list/search/count/timeseries/detail, signals, traces and every deletion path/schema read. `.firecrawl/blueprint-raindrop-openapi.json`; selected contracts in `blueprint-raindrop-contracts.json`. |
| [Query SDK](https://raindrop.ai/docs/query-api/sdk) | `RaindropQuery`, `events.list/search/count/timeseries`, `signals.list`, read-key distinction and error class. `.firecrawl/blueprint-raindrop-query-sdk.md`. |
| [HTTP ingestion API](https://raindrop.ai/docs/sdk/http-api) | Array request bodies, base URL, event/signal field names, project header, 204 acceptance. `.firecrawl/blueprint-raindrop-http-api.md`. |
| [OpenTelemetry](https://raindrop.ai/docs/sdk/opentelemetry) | OTLP/HTTP JSON/protobuf endpoint, authentication, project header, mapped GenAI attributes, exporter limits. `.firecrawl/blueprint-raindrop-otel.md`. |
| [MCP overview](https://raindrop.ai/docs/mcp/overview) | Event/trace/issue/query tools; datasets, signal refinement and experiment tool names; write scopes. `.firecrawl/blueprint-raindrop-mcp.md`. |
| [Experiments](https://raindrop.ai/docs/platform/experiments) | Logged-traffic comparison, separate cohort/outcome filters, events/users units, statistical verdict and cost coverage. `.firecrawl/blueprint-raindrop-experiments.md`. |
| [PII redaction](https://raindrop.ai/docs/security/pii-redaction) | Default storage, server PII Guard and regex-based client redaction. `.firecrawl/blueprint-raindrop-pii.md`. |
| [Security overview](https://raindrop.ai/docs/security/data-security-and-privacy) | Vendor security/privacy claims and subprocessors; no trace-retention TTL found. `.firecrawl/blueprint-raindrop-privacy.md`. |
| [Privacy policy](https://raindrop.ai/docs/security/privacy-policy) | Customer Agent Data exclusion, account-information scope and retention section. `.firecrawl/blueprint-raindrop-policy.md`. |
| [Plans](https://raindrop.ai/docs/platform/plans) | Cached fresh plan/features page; `.firecrawl/blueprint-raindrop-plans.md`. |

Firecrawl was the primary docs-discovery/collection path. Shared rate limiting blocked two later reads; the public OpenAPI, SDK archive and those public Markdown pages were read directly with HTTP as narrow fallbacks. No failed fetch was treated as evidence.

## 3. Allowed TypeScript APIs and exact published signatures

Declaration locations refer to **`.firecrawl/blueprint-raindrop-types.d.ts`**, extracted from the published package.

| API | Exact contract / location |
|---|---|
| `new Raindrop(config)` | Analytics config at **74527**. Use `writeKey`, `projectId`, `redactPii`, `disabled`, `useExternalOtel`, `bypassOtelForTools`, `disableBatching` as verified options. |
| `begin(traceContext)` | **74779**: `PartialAiTrackEvent & { event: string; userId: string; tools?: PromptToolsOverride }` → `Interaction`. The exported partial type requires `eventId`; provide it explicitly even though some docs omit it. |
| `resumeInteraction(eventId)` | **74838**, `eventId: string` → `Interaction`. Resumes the same event; not a detached child. |
| `interaction.finish(result)` | **939**, `FinishInteractionOptions` → `Promise<void>`; output is required string. Await it. |
| `interaction.withSpan<T>(params, fn, thisArg?, ...args)` | **768**, `SpanParams` + sync/async callback → `Promise<T>`. Object form, not `withSpan("name", fn)`. |
| `interaction.withTool<T>(params, fn, thisArg?, ...args)` | **805**, `ToolParams` + callback → `Promise<T>`. |
| `interaction.startToolSpan(params)` | **839**, `ToolParams` → `ToolSpan`; methods `setInput`, `setOutput`, `setError`, `end`. Always end. |
| `interaction.trackTool(params)` | **1009**, `TrackToolParams` → `void`. Retroactive span logging; not a remote acknowledgement. |
| `createSelfDiagnosticsTool(options?)` | **74901**, `SelfDiagnosticsToolOptions` → `SelfDiagnosticsTool`. Types/options at **275–346**. |
| `diagnostics.execute(input, context?)` | **328**, unknown input + optional execute context → `Promise<SelfDiagnosticsExecuteResult>`; result has acknowledged/category/eventId and optional missing-event reason. |
| `selfDiagnose(options)` | **74943**, typed diagnostic options → `void`. It records a self-report, not external truth. |
| `trackSignal(signal)` | **74944**, `SignalEvent \| SignalEvent[]` → `void \| void[]`. Buffer enqueue; no delivery promise. |
| `trackAi(event)` | **74920**, event(s) → event ID(s)/undefined. Do not use its return value as server acknowledgement. |
| `close()` | **74993**, `Promise<void>`, drains buffered telemetry within SDK shutdown behavior. Use once at worker/process shutdown, not after every task in a shared long-lived client. |
| `asCurrent<T>(fn)` | **74807**, callback → callback return type. Scopes auto-instrumented calls to the client's project. |
| `createSpanProcessor(options?)`, `getInstrumentations()` | **74808** and **74831**; documented for an existing NodeSDK with `useExternalOtel: true`. Avoid two competing global tracing initializations. |

`SpanParams` at **490**: `name`, string-valued `properties`, `inputParameters: unknown[]`, `traceContent`, `suppressTracing`.

`ToolParams` at **510** adds numeric `version` and object `inputParameters`. A bundle hash is **not** the numeric tool version; put it in properties.

`TrackToolParams` at **534** allows paired `traceId` + `parentSpanId` overrides. It does not expose arbitrary OpenTelemetry span links.

### Copy-ready SDK pattern locations

- Task episode: SDK Markdown **54–91**.
- Span/tool wrapping: **683–747**.
- Manual tool error span: **754–783**.
- Real-time span finalization: **805–835**.
- Feature flags: **392–465**.
- Custom per-call tool catalog: **835 onward**; `begin({ tools })` overrides catalog capture on model spans. Do not record a catalog that differs from the tools actually offered.
- External OTel initialization: package declaration **74809–74831**.
- Manual `withTool` content opt-out is not proof that independently instrumented LLM message spans contain no sensitive text.

An illustrative copy adaptation, **not executed application code**:

```ts
const interaction = rd.begin({
  eventId: runId,
  event: "expunge.worker",
  userId: telemetrySubjectId,
  convoId: jobId,
  input: sanitizedTask,
  properties: { run_id: runId, harness_hash: bundleHash, role: "worker" },
  featureFlags: { harness_version: bundleHash, evidence_arm: arm }
});

const result = await interaction.withTool(
  {
    name: "discover_references",
    inputParameters: sanitizedArgs,
    properties: { harness_hash: bundleHash },
    traceContent: false
  },
  () => trustedGateway.discoverReferences(actualArgs)
);
await interaction.finish({ output: sanitizedResult });
```

`trustedGateway`, sanitization and these correlation names are **new application contracts**, not Raindrop APIs.

## 4. Diagnostic dispatch and origin labels

Docs default categories: `missing_context`, `repeatedly_broken_tool`, `capability_gap`, `complete_task_failure`. Supplying a custom `signals` map **replaces** defaults.

The factory accepts `interaction`, explicit `eventId`, or `getEventId`. Published options also include `source` and `onMissingEventId`; use `"throw"` during contract probes to expose broken correlation.

- `forVercelAI()` returns a tool object containing execute.
- `forOpenAI()` returns a **definition**, not automatic dispatch.
- `forAnthropic()` likewise returns a definition.
- TanStack/OpenDots integration must define a matching server tool using `diagnostics.inputSchema` and dispatch its invocation to `diagnostics.execute(input)`; no `forTanStack()` adapter was found.

Copy locations: SDK Markdown **210–259**, OpenAI dispatch **291–306**, Anthropic dispatch **310–324**. SDK package types **311–346**.

Maintain an application origin classification:

| Origin | Correct meaning / write-back |
|---|---|
| `agent_self_report` | Diagnostic hypothesis; SDK reports signal type `agent` and default source `agent_reporting_tool`. |
| `trusted_verifier` | Our grader's result; use feedback signal plus explicit application origin/eval ID. |
| `human_feedback` | Actual operator feedback/edit, not text invented by the observer. |
| `raindrop_classifier` | Vendor-produced signal classification, identified from its catalog/configuration. Do not infer this solely because a signal appeared in Raindrop. |
| `admission_service` | Our accepted/rejected/rollback decision; not Raindrop's verdict. |

`SignalEvent` at **238–262** supports `properties` in addition to name, eventId, type and sentiment. Use origin/proposal/eval/outbox identifiers there, while preserving the same identifiers in Atlas.

SDK-supported signal types include `default`, `standard`, `feedback`, `edit`, `agent`, `agent_internal`. HTTP docs list only the first four; do not broaden direct HTTP examples from undocumented guesses. SDK-generated diagnostics are the verified route for agent signals.

For accepted/rejected outcomes, use stable descriptive signal names plus POSITIVE/NEGATIVE sentiment. The canonical proposal record remains in Atlas. A separate admission interaction can carry the proposal hash and verification receipt; link it to the original incident by explicit event IDs. The Query event response exposes matched signal IDs/names/scores, **not all per-match custom signal properties**, so do not rely on those properties being returned in that endpoint.

## 5. Cross-process worker/observer/improver trace linkage

Package types:
- `Interaction.subagent(options: SubagentDispatchOptions): SubagentDispatch`, **1041**.
- `Raindrop.resumeSubagent(headers: CarrierHeaders | TraceCarrier | null | undefined, options?: SubagentResumeOptions): SubagentRun`, **74875**.
- `Raindrop.withSubagentRun<T>(headers, fn, options?): Promise<T>`, **74893**.
- Dispatch/resume/run contracts **555–682**.

Copy-ready docs: parent dispatch **999–1032**, worker resume **1066–1086**, wrapper **1104–1107**.

The parent can preallocate the child's event ID with `childEventId` equal to a stable domain job ID. Carry **all returned headers**, including `x-raindrop-handoff`, W3C `traceparent` and `baggage`; ordinary instrumentation can rewrite the standard fields. Only accept these carriers from authenticated internal services.

The child reports its own event, linked back to the dispatch. `finish`, `fail`, `cancel` are distinct outcomes. A disabled client still allocates an ID but supplies no actual tracing carrier; do not display a nonexistent trace link.

For an observer that investigates an already-completed incident independently, properties such as `observed_event_id`, `candidate_hash` and `parent_harness_hash` are legitimate explicit correlation. They are **application metadata**, not native span-link API claims. Use native subagent helpers only where there is an actual parent dispatch.

OTLP ingress: `POST https://api.raindrop.ai/v1/traces`, write-key bearer, optional project header. Supports OTLP/HTTP JSON/protobuf, not OTLP/gRPC or metrics/logs. Mapped attributes include provider/model/token usage/messages/system instructions/tool catalog. Public OTel docs do not establish that arbitrary link objects will be rendered or returned by Raindrop's Query trace schema.

## 6. Query REST contract: exact paths, filters and pagination

Base **`https://query.raindrop.ai`**. Bearer **Query API key**, distinct from ingestion write key. Header **`X-Raindrop-Project-Id`** selects one project; omit for default. Scope one explicit project for the observer. All-projects availability/endpoint support is conditional.

Live schema JSON Pointers are under `.paths["<path>"].get` in the saved OpenAPI.

| Read | Exact contract |
|---|---|
| `GET /v1/events` | `limit` 1–500, default 50; opaque `cursor`; `order_by` default `-timestamp`, prefix + ascending. Filters below. |
| `GET /v1/events/{id}` | Exact event ID; response `{data: Event}`. |
| `GET /v1/signals` | Catalog, limit 1–500, cursor, order_by; response `{data: Signal[], meta:{cursor,has_more}}`. |
| `GET /v1/signals/{id}` | Canonical signal UUID detail. |
| `GET /v1/events/count` | Same principal filters; `count_by=event_id|user_id|convo_id`; response `data.total`. |
| `GET /v1/events/timeseries` | Filters plus `interval=minute|hour|day|week|month`; response `data.buckets[{timestamp,count}], data.total, meta.interval`. |
| `GET /v1/events/search` | Required `query`; mode `text|semantic|regex`; `search_in` default user_input,assistant_output; limit max100; cursor; exact user_id/convo_id; timestamp[gte]/[lt]; semantic threshold. Signal UUID filter only applies to text/regex modes. |
| `GET /v1/traces` | Required `event_id`; limit default200/max1000; `trunc_len` integer ≥0. Response `{data: Span[]}`, no cursor. |

Event list/count filters:

- `timestamp[gte]`, `[gt]`, `[lte]`, `[lt]`: ISO date-time.
- `user_id`, `convo_id`, `event_name`: bare exact string or deepObject `eq|neq|startsWith|endsWith|contains`.
- `signal`: canonical UUID or eq/neq object; `signal_group`: UUID.
- `properties[key]`: direct scalar, or `properties[key][eq|neq|gt|gte|lt|lte]`.
- `traits[key]`: corresponding scalar/operator object.
- `project_ids`: comma-separated active slugs only when all-projects header is used.

**Do not assume a `feature_flags` or `model` filter parameter on REST event listing.** They appear in returned rows but are not listed as those query parameters in the inspected schema. For reliable REST cohorts, stamp `properties.harness_hash`/`properties.evidence_arm` and filter those. Experiments can use flags through its separately documented surface.

Events include `id,event_name,user_id,convo_id,timestamp,received_at,user_input,assistant_output,properties,feature_flags` plus possibly late enrichment `signals,tool_calls,error_spans,topics,attachments`. Signals on a row have canonical UUID `id`, customer name and optional score. Catalog `type` enum is **topic/regex/instrumented/metric/code**, not the SDK signal-type enum.

Trace rows include trace/span/parent IDs, span_name, span_type `INTERNAL|LLM_GENERATION|LLM_GENERATION_STREAM|TOOL_CALL`, status `UNSET|OK|ERROR`, ns timestamps/duration, input/output, tokens, model/provider and attributes.

Copy-ready REST serialization, adapted from the schema, not executed:

```ts
const url = new URL("/v1/events", "https://query.raindrop.ai");
url.searchParams.set("limit", "100");
url.searchParams.set("order_by", "+timestamp");
url.searchParams.set("timestamp[gte]", scanStartIso);
url.searchParams.set("timestamp[lt]", scanEndIso);
url.searchParams.set("properties[role][eq]", "worker");
if (cursor) url.searchParams.set("cursor", cursor);
const response = await fetch(url, {
  headers: {
    Authorization: "Bearer " + queryKey,
    "X-Raindrop-Project-Id": projectId
  }
});
if (!response.ok) throw new Error("RaindropRead:" + response.status);
const page = await response.json(); // { data, meta: { cursor, has_more } }
```

Runtime validation of the response is new code to implement. Preserve identical filters and scan bounds across a cursor page sequence; URLSearchParams must encode the + in ascending order.

Query SDK copy locations: `blueprint-raindrop-query-sdk.md` **21–33**, **65–90**, **95–106**. Allowed names: `new RaindropQuery({apiKey})`, `client.signals.list`, `client.events.list/search/count/timeseries`. These examples do not prove an SDK `issues.list` or experiment method exists.

Read limits: most endpoints 400RPM, search50RPM, combined40RPS; search rejected at combined20RPS. A 408 search timeout requires narrowing, not an unchanged retry loop.

## 7. Observer/outbox requirements derived from those facts

The following are **application design requirements/recommendations**, not Raindrop-native APIs.

### Durable domain outbox

Commit domain mutation/receipt and an outbox intent together in Atlas. Perform Raindrop network calls **after** that transaction. Do not make a provider request inside a transaction callback that can retry.

Use a unique deterministic outbox ID (run + operation + terminal revision), payload hash, lease/attempt state, remote event ID, origin, and delivery/read-back status. Event IDs must be allocated before the domain transaction. At-least-once dispatch is the safe assumption: no ingestion idempotency-key or exactly-once guarantee was verified.

Distinguish:
- `queued`: committed locally;
- `sdk_enqueued`: buffered into client;
- `ingest_accepted`: HTTP acceptance or awaited terminal send;
- `query_visible`: remote event read successfully;
- `evidence_ready`: required content/signal/span fields present and correlation/version verified;
- retry/dead-letter/held states.

Direct ingestion HTTP facts, if the dispatcher uses it: base `https://api.raindrop.ai/v1`, POST `/events/track` and `/signals/track`, **array** request bodies, write-key bearer and project header; documented authorized acceptance response **204**. Copy exact requests from `blueprint-raindrop-http-api.md` **63–118**, **146–166**. A 204 is not enrichment completion or proof of permanent retention.

Do not confuse the ingest endpoint `api.raindrop.ai/v1/traces` with Query `query.raindrop.ai/v1/traces`.

### Idempotent cursor and late-enrichment handling

Keep an observer checkpoint keyed by project, filter hash and bounded scan interval, with opaque page cursor and completion watermark. Persist a fetched page's evidence snapshots and checkpoint advancement in the same Atlas transaction. Crash before commit repeats the page safely.

Deduplicate base events by project+event ID, but permit **new observation versions** when content/enrichment hashes change. Otherwise late signals are discarded as duplicates.

A recent overlap window reduces timestamp race misses but is not a guarantee against arbitrary late arrival. For the system's own runs, maintain a durable list of known remote event IDs from its outbox and poll event detail until required enrichment is present or the evidence times out to HOLD. Keep these pending IDs even after the listing watermark advances. Periodic bounded backfill covers older external events; no latency SLA was found.

Persist the next cursor only after that page's evidence is committed. Resume the exact query, not a different filter/date window with the old opaque cursor. Stop paging when `meta.has_more` is false. Do not treat a single page as the whole cohort.

If trace count reaches the documented cap, record potentially incomplete evidence and avoid a claim that all spans were inspected. The endpoint supplies no cursor to continue beyond the cap in this spec.

### Actual load-bearing read-back

The observer should construct a proposal from **remote interaction output + actual tool/span evidence** associated with a failed task, not merely poll a ceremonial echo of its local score. Preserve the remote observation hash and exact supporting event/span IDs in the candidate.

Compare trace-informed versus score-only/wrong-incident proposals under identical budgets to test whether the extra information matters. Self-report, human report, verifier outcome and Raindrop classification remain separately labelled. Sending the verifier result to Raindrop does not make the verifier independent twice.

Read-back can be a prerequisite for proposal eligibility: when Raindrop is absent, the domain job can still finish and preserve an outbox, but no candidate is admitted as “Raindrop-evidence-derived.” Missing enrichment yields waiting/HOLD, not made-up evidence.

Admission remains independent deterministic execution of fresh parent/candidate worlds. Raindrop's classification or experiment outcome is additional evidence, not authority to alter the fixed grader.

## 8. Experiments and MCP: verified vs unresolved

Verified public tool names: `create_experiment`, `get_experiment`; `list_issues`, `get_issue`, `get_issue_events`; `get_trace`, `run_rql`; dataset and signal workflow tools. Copy overview sections at **185–212**, **260–273**.

Experiments:
- One project; Pro required for creation/editing.
- Compare already logged baseline/experiment cohorts.
- Cohort conditions can use dates/model/feature flag/property/tool.
- Outcome signals are separate from cohort filters.
- Default unit event rate; optional user rate.
- Better/worse verdict needs confidence interval excluding zero and its sample check.
- Inconclusive small samples are expected; do not label them verified improvement.
- Experiments do **not** execute or replay an agent.
- Cost percentiles exclude unpriced model calls; incomplete pricing is not zero cost.

**No exact public `create_experiment`/`get_experiment` inputSchema was extracted.** At account bootstrap, save actual MCP `tools/list` schema and read tool-specific guidance before creating a comparison. Proposed names such as `baselineFilters`, `experimentFilters`, `outcomeRule` are not approved API parameter names until discovered.

OAuth write operations require the appropriate scope; experiments use `write:experiments`. The API-key caller permissions and Pro account must be probed. No experiment was created in this research.

## 9. Data lifecycle and deletion: exact contract

Source: live Query OpenAPI `.paths["/v1/deletions/users"]` and components `DeletionJob`/`DeletionJobUser`.

### File a job

`POST https://query.raindrop.ai/v1/deletions/users`, Query-key bearer:

```json
{
  "user_ids": ["synthetic-subject-123"],
  "requester": "authorized-requester@example.invalid",
  "regulation": "other"
}
```

Required `user_ids`: 1–100 strings, each 1–512 chars. Required requester: 1–320 chars. Regulation enum `gdpr|ccpa|other`, default gdpr. Use the truthful basis, not a fabricated legal classification.

Jobs are **org-wide**: project header ignored; available every plan. The documented result wraps `data: DeletionJob`.

Job fields: id(UUID), status **pending|in_progress|completed|rejected**, regulation, requester, received_at, due_by(date30daysafterreceipt), completed_at(nullable), user_ids entries {user_id,requested_on,revoked_at(nullable)}.

### Read status

- `GET /v1/deletions/users/{id}`: job detail.
- `GET /v1/deletions/users?start_day=YYYY-MM-DD&end_day=YYYY-MM-DD`: required inclusive UTC date range, at most six months, newest first. The inspected schema supplies no list cursor.

### Cancel one pending subject

`DELETE /v1/deletions/users/{id}/{user_id}` removes that user from a **pending deletion job**, so their data is **kept**. Repetition is no-op. Response data contains job_id,user_id,revoked_at. It is not a per-user erasure endpoint.

There is no verified instant “purge all spans for this event” API in the inspected Query spec. The spec promises deletion within30days, not a synchronous deletion-stage demo.

### Retention and telemetry scope

The public privacy policy's account/personal-information retention paragraph says default indefinite retention, **but explicitly excludes Customer Agent Data (SDK inputs, outputs, traces and metadata)**, which is governed by customer contracts. Do not apply that paragraph as the trace retention policy. No contractual customer-trace TTL, backup purge timing or event-specific erasure SLA was available here.

By default, Raindrop stores/processes supplied data. Client `redactPii:true` performs regex-based redaction; it is not universal sensitive-data removal. Server PII Guard is a separate configuration/service and does not establish instant deletion.

For the synthetic hackathon worlds, use synthetic/opaque telemetry identities and sanitized structural evidence. If later handling real subjects, the provider lifecycle is a separate asynchronous connector: suppress future export for revoked IDs, track the provider deletion job/acknowledgement, and label its pending/completed status truthfully. Do not claim an Atlas cleanup transaction simultaneously purges Raindrop, Intelligence, browser volumes, model providers and backups.

## 10. Verification probes to hand to the implementation owner

These are proposed acceptance checks, not tests run during research:

- Pin `raindrop-ai@1.0.1`; type-check begin/finish/tools/diagnostic dispatch against extracted declarations.
- One actual task interaction; measured finish→Query-visible→enrichment-ready latency.
- Tool failure produces ERROR span and matches the domain run; diagnostic dispatch calls execute rather than only exposing a definition.
- Worker and improver events retain exact harness/parent/source IDs; child dispatch carrier links to its real parent.
- More than one page of events; restart before page commit, then after commit; no lost evidence or duplicate candidate admission.
- Late signal added to an already-read event updates observation and opens one eligible job.
- Observe intentionally incomplete/truncated trace evidence and HOLD it.
- SDK enqueue/network outage cannot mark evidence-ready; outbox retries preserve domain receipt and correlation.
- Wrong-incident and score-only evidence controls; no fabricated automatic-detection label.
- Discover MCP experiment input schemas; absent Pro yields an explicit unavailable state, not fake results.
- Deletion contract in a non-destructive mock first, especially DELETE-as-cancel semantics; real lifecycle calls require authorized subject scope.
- Audit every telemetry path for payloads that bypass sanitization; no privacy claim rests only on `traceContent:false`.

## Confidence and known gaps

**High confidence:** published SDK declarations, live Query paths/request/response contracts, docs examples, signals catalog semantics, subagent carrier APIs,30day deletion job contract and DELETE cancellation meaning.

**Medium / unverified at runtime:** automatic TanStack model-span coverage; account permissions/plan availability; write/read/enrichment latency; vendor deduplication across retries; exact retention governed by customer agreement; arbitrary OTLP link rendering.

**Explicit gap:** authenticated MCP experiment schemas and results were not fetched. No account writes, production privacy requests or application execution were performed. Full scope is preserved; these gaps define setup probes and integration contracts, not removed features.

