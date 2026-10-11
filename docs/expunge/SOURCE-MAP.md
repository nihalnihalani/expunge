# Expunge Allowed APIs and Source Map

The blueprint's types, tools, routes and job protocols are **new application design**. This map identifies existing upstream APIs and source patterns. Read the pinned source before implementation. Source inspection verifies interfaces, not live startup, provider compatibility or account access.

## Foundation pins

| ID | Source | Contract to follow |
|---|---|---|
| F1 | [OpenDots snapshot](https://github.com/CopilotKit/OpenDots/tree/625452e06cde74cb25b0ce319e2c1be0488f5a5f) | Base operator app. Lock resolves CopilotKit 1.75.0, AG-UI 0.0.59, TanStack AI 0.63.0 and OpenAI adapter 0.25.1. Use Node 24. |
| F2 | [DotAgent](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/dot-agent.ts#L33) | Constructor/clone/run and per-run tool/prompt factory. Add trusted dependencies at every construction site and clone. |
| F3 | [Platform](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/platform.ts#L85) | Existing CopilotRuntime agents map and Hono handler; Platform.turn is headless turn dispatch. It is not a durable RSI campaign. |
| F4 | [Chat](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/client/Chat.tsx#L63) and [connection review](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/connection-routes.ts#L113) | Scoped useAgent/run/connect, HITL and server-stored arguments. New frontend review tools must also pass the DotAgent allowlist. |
| F5 | [ComputerService](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/computer-service.ts#L312), [deployment](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/deployment/computers/README.md) | Existing supervisor and per-Dot action transport, not the full OpenBot governance app. Bundled revision is OpenBot b6932d31a8d6e7896c15139dfc27a6c6911deb27. |
| F6 | [OpenMuse tanstackAgent](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/tanstack-agent.ts) | Actual source to port: provider wrapper, state tools, text/tool helpers and step-limit reporting. Local retry constant is 2. Requires version adaptation from runtime 1.70.1/TanStack 0.59. |
| F7 | [OpenMuse ConversationAgent](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/conversation.ts) and [worker](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/worker.ts) | Host constructs wrapped inner agent inside run; durable task ownership is separate. Adapt ownership to Atlas with write fencing. |
| F8 | [OpenBot gateway](https://github.com/CopilotKit/OpenBot/blob/a4dce8c47c7253ecd9bd6f4e2626f4205817a104/server/src/computer/gateway.ts#L513), [policy](https://github.com/CopilotKit/OpenBot/blob/a4dce8c47c7253ecd9bd6f4e2626f4205817a104/server/src/computer/policy.ts), [dry-run](https://github.com/CopilotKit/OpenBot/blob/a4dce8c47c7253ecd9bd6f4e2626f4205817a104/server/src/computer/policy-dry-run.ts#L170) | govern is nested; evaluateActionPolicy and dryRunAgainstHistory are actual exports. Sync policy callback cannot await Mongo. Dry-run changes recorded decisions, not agent outcomes. |
| F9 | [Pinned AG-UI client](https://github.com/ag-ui-protocol/ag-ui/tree/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4) and [CopilotKit runtime 1.75](https://github.com/CopilotKit/CopilotKit/tree/70d1f3c0a832d6274e2fe710e24102f6429f14f4) | AbstractAgent from @ag-ui/client; run returns Observable. BuiltInAgent factory returns AsyncIterable. Converter recognizes AGUISendStateSnapshot/AGUISendStateDelta. |
| F10 | [OpenDots setup](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/docs/SETUP.md) and [computers](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/docs/COMPUTERS.md) | Actual npm startup, Intelligence project key, owner/origin rules, computer secrets and Docker topology. |

Detailed signatures, constructor sites and copy/test sections: [foundation facts](../research/blueprint-foundations.md). Raw evidence: `.firecrawl/blueprint-foundations-*`. Incompatible examples from the local skill are superseded by these pins.

## MongoDB contracts

| ID | Primary source | Use and boundary |
|---|---|---|
| M1 | [Node transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/) | withSession/withTransaction, one-client sessions, sequential transaction operations, retries. Model/network calls stay outside. |
| M2 | [Atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) | Expected-value filters for CAS; atomic single-document control transitions. |
| M3 | [Production transactions](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/) | Snapshot reads can be stale; a real modifying write creates the conflicting lock. Lease/revision checks must write their fenced rows. |
| M4 | [JSON Schema](https://www.mongodb.com/docs/manual/core/schema-validation/specify-json-schema/) and [bypass](https://www.mongodb.com/docs/manual/core/schema-validation/bypass-document-validation/) | Supported BSON validation and why privileges matter. Cross-collection semantics require application checks. |
| M5 | [Atlas custom roles](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/) | Account prerequisites, additive privileges and collection actions. Do not use driver createRole as an Atlas role deployment shortcut. |
| M6 | [$graphLookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/) and [$lookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/) | Bounded relationship/provenance traversal. graphLookup target is same-DB; sharded target forbidden inside transaction. lookup support differs by server version/topology. |
| M7 | [Change streams](https://www.mongodb.com/docs/manual/changeStreams/) | Majority-committed changes, opaque resume tokens and privileges. Exact processing/retention recovery is new code. |
| M8 | [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) and [TTL](https://www.mongodb.com/docs/manual/core/index-ttl/) | Tier-specific pipeline/throughput limits; TTL is asynchronous retention cleanup. |
| M9 | [Vector query stage](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/) | First-stage vector retrieval and indexed prefilters. Ordinary reads enforce authority. |
| M10 | [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) and [Node crypto](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options) | Canonical JSON prerequisites/sorting and hash primitives. JSON payloads and BSON domain preimages need explicit separate serialization contracts. |

Detailed exact driver signatures and copy-ready fenced protocols: [MongoDB facts](../research/blueprint-mongodb.md). Current driver declaration audit used 7.7.0; choose/pin the implementation driver explicitly and verify its findOneAndUpdate return-document options. Raw evidence: `.firecrawl/blueprint-mongo-*`.

## Raindrop contracts

| ID | Primary source | Use and boundary |
|---|---|---|
| R1 | [TypeScript SDK](https://raindrop.ai/docs/sdk/typescript), [published 1.0.1 package](https://registry.npmjs.org/raindrop-ai/-/raindrop-ai-1.0.1.tgz) | begin, withTool/withSpan, finish, diagnostics, subagent carrier and close. trackSignal enqueues and returns void/void[]; finish/close are promises. |
| R2 | [Live Query OpenAPI](https://query.raindrop.ai/v1/openapi.json) | Exact event filters, response schemas/cursors, signal catalog, bounded traces and user deletion request/status/cancel schemas. |
| R3 | [Query reference](https://raindrop.ai/docs/query-api/api-reference) and [Query SDK](https://raindrop.ai/docs/query-api/sdk) | Separate read key; documented event/signals methods. Catalog is not occurrence feed. |
| R4 | [HTTP ingestion](https://raindrop.ai/docs/sdk/http-api) | api.raindrop.ai/v1 events/track and signals/track array bodies; 204 acceptance. Query visibility is later. |
| R5 | [Self Diagnostics](https://raindrop.ai/docs/platform/self-diagnostics) | Definitions need actual dispatch to execute in a TanStack tool. No documented forTanStack adapter. |
| R6 | [MCP](https://raindrop.ai/docs/mcp/overview) and [Experiments](https://raindrop.ai/docs/platform/experiments) | Documented tools/features; capture account tools/list for exact schemas before constructing calls. |
| R7 | [OpenTelemetry](https://raindrop.ai/docs/sdk/opentelemetry) and [PII redaction](https://raindrop.ai/docs/security/pii-redaction) | One tracing initialization and actual sensitive-field coverage. No inspected span links[] option; message spans may need separate redaction. |
| R8 | [Security/privacy](https://raindrop.ai/docs/security/data-security-and-privacy) and [privacy policy](https://raindrop.ai/docs/security/privacy-policy) | Do not infer Customer Agent Data TTL from account-data retention. User deletion is org-wide and pending until provider confirmation. |

Detailed copy examples and selected OpenAPI schemas: [Raindrop facts](../research/blueprint-raindrop.md). Raw evidence: `.firecrawl/blueprint-raindrop-*`. The SDK/catalog/HTTP signal-type enums differ; implement explicit adapters.

## Research protocol references

[Fresh literature](../../research/fresh-rsi-literature.md) supplies source-checked research distinctions. [FreeEvolve](https://arxiv.org/abs/2610.09197) motivates fresh-base improver evaluation; [Self-Healing Harness](https://arxiv.org/abs/2609.24130) motivates protected-case admission; [RRSI](https://arxiv.org/abs/2609.24972) motivates bounded edits; [Phantom Guardrails](https://arxiv.org/abs/2607.13083) motivates per-edit standing. These are research evidence, not runnable vendor contracts or general safety guarantees.

## Firecrawl architecture collection

The new pass used the developer index to discover primary API/source examples, mapped Raindrop/Mongo documentation, scraped selected official documents and exact pinned source, and reused the prior same-session cache. A Mongo docs crawl returned Bad Request and was replaced by map plus targeted scrape. Some requests hit a shared rate limit; those failures are not evidence. The SDK/archive and public OpenAPI were read directly where Firecrawl lacked typed package/version details or a fetch failed. Results are preserved under `.firecrawl/blueprint-*` and indexed by the three facts reports.

No architecture depends on every Firecrawl endpoint being used. Search, map and precise source retrieval answered the actual questions; interact/monitor were unnecessary for static public documentation. Firecrawl is the research mechanism in this blueprint. If added as an Expunge runtime documentation tool later, retrieved pages must remain untrusted evidence and cannot alter authority or scoring.
