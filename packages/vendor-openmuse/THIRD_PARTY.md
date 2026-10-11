# Third-party code in `@expunge/vendor-openmuse`

This package is an **attributed port** of helper code from OpenMuse, adapted to the versions pinned by the Expunge operator lock. Event-built Expunge functionality lives elsewhere (`packages/runtime`, `apps/worker`); nothing in `packages/runtime` or `apps/worker` is copied from OpenMuse.

## Source

| Item | Value |
|---|---|
| Project | OpenMuse, <https://github.com/CopilotKit/openmuse> |
| Pinned commit | `1ac68f3909f2478ab6280883f1ab5ea65eb5719d` |
| License | MIT, `Copyright (c) 2026 OpenMuse contributors`. Full text: [`LICENSE.openmuse`](LICENSE.openmuse), byte-identical to [`LICENSE` at the pin](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/LICENSE) (git blob `a3366dc2633aa74760c26210963ec8a11df02894`). The notice must stay with any copy or substantial portion. |
| Raw copies (read only, not executed) | `.firecrawl/openmuse-*.ts` in the workspace (ignored directory), fetched with `gh api` at the pin on 2026-10-11 and verified with `git hash-object` against the upstream blob SHAs below. |

## Copied or ported files

| Local file | Upstream file at the pin | Upstream git blob | sha256 of the raw upstream file | What was taken |
|---|---|---|---|---|
| `src/tanstack-agent.ts` | [`apps/server/src/engine/tanstack-agent.ts`](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/tanstack-agent.ts) (242 lines) | `9ebf2bf85d18ddc73db507856f41f31e8ce145ac` | `cd2662b6fcf1ac092d33c926b051de1c0832bb1282bce26565684ed247fde60e` | `tanstackAgent` (lines 113-168), `textOnlyToolResult` (176-189), `reportStepLimit` (195-219), `splitTextAtToolCalls` (224-242) |
| `src/provider.ts` | same file, lines 23-79 | same | same | provider adapter selection `adapter`, `unknownProvider` |
| `src/state-tools.ts` | same file, lines 81-111 | same | same | `AGUISendStateSnapshot` / `AGUISendStateDelta` tool definitions (names and schemas unchanged) |
| `src/model-retries.ts` | [`apps/server/src/config.ts`](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/config.ts), lines 94-104 | `d34a9092950466081f5b96189a58b2fb0fa26070` | `f4c97d49f6a9658d8a8345cdba0eece48f27e4fca0edfa50362d4a58f84a007a` | `MODEL_MAX_RETRIES = 2` and its explanatory comment |

### Read as reference only (no code copied)

| Upstream file at the pin | git blob | sha256 | Used for |
|---|---|---|---|
| [`apps/server/src/engine/conversation.ts`](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/conversation.ts) | `e2c0a57b76b99de870c14c7441711468e2134393` | `1cb0cb750ac5ae284b948825030d3716b8da90093a82f6e390a8da1b3e31bd83` | The pattern that a host `AbstractAgent` constructs the wrapped inner agent inside `run`, filters client tools, and tears down (`abortRun` plus inner `unsubscribe`) on Observable unsubscribe. |
| [`apps/server/src/engine/model.ts`](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/model.ts) | `2813def1909114058a2b1d539e6fd624903c282f` | `9289e36978f2d1326e5076bacb0fd06ebbf153a8b948f3141a5fae6bc57f3173` | How `tanstackAgent` is called by a durable task, and the serialised-tool-queue idea. |
| [`apps/server/src/engine/worker.ts`](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/worker.ts) | `b69fe63486dbdd3f8617aed59bbd1e48b92e344a` | `769ccdc02e3c5aa14c729cf0f6d745d408d4089e932dcdca71c5b36077642195` | The lease/heartbeat/guard/checkpoint shape. Expunge replaces it with Atlas leases and database-time write fencing (`JobRepository`). |
| OpenDots [`src/server/dot-agent.ts`](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/dot-agent.ts) at `625452e06cde74cb25b0ce319e2c1be0488f5a5f` (MIT, `Copyright (c) Atai Barkai`; local copy `apps/operator/src/server/dot-agent.ts`) | `6191cc7a45bba8dcc8f1a517222fed6fc0c5d15d` | `cb27b8bc2cf9a3c323bc20876d4a8dd9ddbf34380aef9bb51dfd7c3da75fd1cc` | `clone()` reconstruction, filtering client `system`/`developer` messages before `convertInputToTanStackAI`, and passing `[prompt, ...converted.systemPrompts]` to `chat()`. |

## Modifications (every difference from upstream behavior)

| ID | Modification | Why |
|---|---|---|
| M1 | Gemini removed. `adapter()` supports `openai` and `anthropic` only; `google`/`gemini` raise the unknown-provider error. `@tanstack/ai-gemini` is not installed. | Not required for Expunge; no key, no test path, and an unproven adapter would be dead code. Re-adding it is a compatible-version audit, not a drive-by. |
| M2 | `adapter(spec, env)` takes an injected environment and builds adapters with `createOpenaiChat` / `createOpenaiChatCompletions` / `createAnthropicChat` (explicit API key) instead of `openaiText` / `openaiChatCompletions` / `anthropicText` reading `process.env`. A missing key raises `MissingProviderCredentialError` naming the variable, before any network call. | Credentials come from the environment only and must be checkable for readiness without building a model call. Behavior otherwise matches (same base URL handling, same retry count). |
| M3 | `TanStackAgentOptions.textAdapter` can replace provider selection. | Lets protocol tests drive the real `chat()` loop with the labeled `FakeChatModel` (`packages/runtime/src/testing/fake-chat-model.ts`). Production code never sets it (a test enforces this). |
| M4 | `adapter()` returns `AnyTextAdapter`; `ProviderEnv` is a plain record. | TypeScript adaptation to TanStack AI 0.63.0 typings. |
| M5 | Client input is scoped before conversion: `system`/`developer` messages from the client are dropped and only `clientToolAllowlist` frontend tools reach the model (default none). | Client input is untrusted (OpenDots does the same for messages). Upstream filtered one named tool by hand at the call site. |
| M6 | Server tools without an `execute` function are rejected at construction; the state tools can be switched off (`stateTools: false`). | Interrupt tools are not supported in this port; upstream cast and would fail at call time. |
| M7 | `tanstackAgent()` returns a `TanStackAgent` wrapper (composition) instead of monkey-patching `agent.run` on the `BuiltInAgent`. It exposes `run`, `abortRun`, `clone`. | `@copilotkit/runtime` 1.75.0 `BuiltInAgent.clone()` rebuilds from config and would silently drop a patched `run`. |
| M8 | System prompt composition is ONE path: `[options.prompt, ...convertInputToTanStackAI(input).systemPrompts]`. The hand-built "Context from the application" / "Application State" sections are removed. | Runtime 1.75.0's converter already appends AG-UI context entries and application state (`dist/agent/converters/tanstack.mjs`); upstream (runtime 1.70.1) built them by hand and ignored that list. Keeping both would duplicate context. |
| M9 | The server-tool wrapper calls `context?.abortSignal?.throwIfAborted()` before executing a tool. Also passes `threadId` and `runId` to `chat()` (as OpenDots does). | Cancellation must stop a tool that has not started yet. `ToolExecutionContext.abortSignal` is declared in `@tanstack/ai` 0.63.0 `types.d.ts`. |
| M10 | `splitTextAtToolCalls` is retained unchanged and now has a test pair: runtime 1.75.0 still uses one message ID per stream, and the helper still splits per step. | Upstream marked it removable once the converter starts a new ID per step; that has not happened at 1.75.0. |
| M11 | Reformatted with the repository's Prettier configuration (print width 110, trailing commas) and converted from double to single quotes. No behavior change. | Repository formatting policy; line-level diffs against the raw upstream copy are therefore noisy, so compare by function. |
| M12 | `reportStepLimit` takes an optional `onLimit` callback and `TanStackAgentOptions.onStepLimit` forwards it. The callback fires, out of band, exactly when the step limit ended the run, just before the note is emitted. | A host must not infer the ending by matching text: a model can emit the note's exact words (devils-advocate DA-3 R3). |
| M13 | `onModelCall` observes each `adapter.chatStream` call through a Proxy and reports the provider-reported usage of that call. | Per-call token/cost metering for `ResourceLimits.totalTokens` / `maxCostMicrousd`; the run-end aggregate is too late to stop a run. |
| M14 | `TanStackAgent.identity` exposes the `name` and `model` of the adapter that actually served the run. | Stored run evidence must show which provider/model produced it (devils-advocate DA-3 K2). |
| M15 | `onModelFailure` reports the adapter's own failure out of band: the `{ code }` of a RUN_ERROR chunk, or the error the adapter stream threw, at the adapter boundary. | The converter reduces a RUN_ERROR to a message, so the structured code is lost downstream; a host needs it to separate provider-side failures from request-side ones without reading message text (rsi-evolution / devils-advocate X-4). |
| M15 | `TanStackAgentOptions.middleware` passes host-supplied TanStack chat middleware to `chat()`. Nothing else about the loop changes, and client input never reaches it. | Observability (C1): the OpenTelemetry GenAI middleware emits one real model span per provider call through the Raindrop SDK's tracer provider. |
| M16 | The provider SDK clients get an explicit `timeout` (`PROVIDER_CLIENT_TIMEOUT_MS`, 600 s) set above every phase timeout the runtime allows, and `model-retries.ts` states the retry policy (`MODEL_RETRY_POLICY`) and `providerClientOptions()` is the single place the SDK clients get `maxRetries` and `timeout`. | The runtime's phase watchdog must always end a slow call (`PhaseTimeout`, behaviour) before the SDK's own timeout could read as provider-side; otherwise a candidate's large-context latency would count as infrastructure (devils-advocate PKT-79 MF-1/MF-2). |
| M17 | `providerFetch` injects the `fetch` the provider SDK client uses; `ProviderAttemptRecorder` (a counting wrapper) records per run the HTTP attempt count and the retriable statuses (numbers only) and keeps a per-watchdog-window flag set by a provider-side retry (429, 5xx, connection error), cleared by `clearWindow()` when the runtime re-arms its watchdog. | The SDK's retries are silent, and 429 backoff can eat phase time; the runtime must record them and end a phase timeout during provider backoff as `ModelUnavailable` rather than `PhaseTimeout` (devils-advocate PKT-79 MF-3, lead ruling). |

Version adaptation facts (verified against installed declarations/source):

* `@tanstack/ai` 0.63.0 requires tool schemas that expose a JSON-Schema converter on `~standard.jsonSchema` (zod 4.2+). The root workspace's zod 3.25.76 (used by `@expunge/contracts`) does not, so this package, `@expunge/runtime` and `@expunge/worker` pin `zod` **4.6.5**, the version the operator lock resolves. Contracts keep their own zod 3.25.76; no schema crosses between them.
* `@tanstack/ai-anthropic` is pinned to **0.19.3**, the newest release whose peer range admits `@tanstack/ai` 0.63.0 (`^0.63.0`; 0.19.4 and later require 0.64+). The operator does not install it.

## Dependency pins (exact, no ranges)

`@ag-ui/client` 0.0.59, `@ag-ui/core` 0.0.59, `@copilotkit/runtime` 1.75.0, `@tanstack/ai` 0.63.0, `@tanstack/ai-openai` 0.25.1, `@tanstack/ai-anthropic` 0.19.3, `rxjs` 7.8.1, `zod` 4.6.5 equal the operator lock where the operator has them. Four transitive packages are also pinned **directly** to the operator-lock versions because a fresh resolution otherwise drifts and installs a second AG-UI client or a second `@tanstack/ai`:

| Package | Pin | Reason |
|---|---|---|
| `@ag-ui/mcp-apps-middleware` | 0.1.1 | 0.1.2 peers `@ag-ui/client >=1.0.0`, which forced `@ag-ui/client` 1.0.2 next to the runtime's 0.0.59. |
| `@copilotkit/core` | 1.75.0 | 1.78.0 depends on `@ag-ui/client` 1.x. |
| `@tanstack/openai-base` | 0.12.1 | 0.12.6 peers a newer `@tanstack/ai`, producing two copies. |
| `@tanstack/ai-event-client` | 0.13.0 | matches the operator lock. |

`test/dependency-coherence.test.ts` re-derives these facts from `package-lock.json` and `apps/operator/package-lock.json`.
