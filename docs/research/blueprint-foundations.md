# Foundation facts for the Expunge implementation blueprint

Fact-gathering report, 11 October 2026. Scope: exact pinned OpenDots/OpenBot/OpenMuse APIs, source seams, examples and startup contracts. This is not the synthesized implementation plan and no application code was changed.

## 1. Sources consulted and evidence quality

Live OpenDots main was rechecked in this pass and still resolves to `625452e06cde74cb25b0ce319e2c1be0488f5a5f`. Earlier same-session live checks establish OpenMuse `1ac68f3909f2478ab6280883f1ab5ea65eb5719d` and OpenBot `a4dce8c47c7253ecd9bd6f4e2626f4205817a104`; existing clones match those snapshots. Source reads, not application execution, support this report.

| Source | Sections read |
|---|---|
| [OpenDots package.json](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/package.json), `package-lock.json` | Scripts, engines, dependencies; resolved lock versions. |
| [OpenDots index.ts](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/index.ts), [app.ts](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/app.ts), [platform.ts](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/platform.ts) | Initialization, auth middleware, routes, runtime factory, scheduled/headless turn, shutdown. |
| [DotAgent](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/dot-agent.ts), [TanStack bridge](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/tanstack-tools.ts) | Constructor/clone/run, per-run assembly, permissions watcher, factory, frontend-tool filtering. |
| [Chat](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/client/Chat.tsx), [review card](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/client/ConnectionActionCard.tsx), [review routes](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/connection-routes.ts) | Scoped agent, replay/turn, HITL registration, stored-request retrieval, claim/receipt and response. |
| [ComputerService](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/computer-service.ts), [computer tools](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/server/computer-tools.ts), [schemas](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/src/shared/computer-types.ts) | Bound transport, HMAC credentials, permissions, audit, lifecycle, action and exact inputs. |
| [computer compose](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/compose.computers.yml), [deployment README](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/deployment/computers/README.md), [COMPUTERS](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/docs/COMPUTERS.md), [SETUP](https://github.com/CopilotKit/OpenDots/blob/625452e06cde74cb25b0ce319e2c1be0488f5a5f/docs/SETUP.md) | Pinned sidecar source, command sequence, host/container networking, service/key requirements. |
| [OpenMuse wrapper](https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/engine/tanstack-agent.ts), `config.ts`, `engine/conversation.ts`, `agent.ts`, `engine/worker.ts` | Full 242-line wrapper; provider/retry constants, per-run inner-agent invocation, AGENT_URL, lease/checkpoint pattern. |
| [OpenBot gateway](https://github.com/CopilotKit/OpenBot/blob/a4dce8c47c7253ecd9bd6f4e2626f4205817a104/server/src/computer/gateway.ts) | Options/imports, target resolution, nested govern, decision-before-act, approval and outcome/failure. |
| [AG-UI client 0.0.59](https://github.com/ag-ui-protocol/ag-ui/tree/9f393021ecbd6bcc62dc4b1ad5a6ac4b797565f4) | `agent/agent.ts` run/constructor/clone; `agent/http.ts` POST/SSE/run/clone. |
| [CopilotKit 1.75.0](https://github.com/CopilotKit/CopilotKit/tree/70d1f3c0a832d6274e2fe710e24102f6429f14f4) | `packages/runtime/src/agent/index.ts` ToolDefinition, factory context/config, run/clone; converter context/state behavior; v2 useAgent/HITL hooks. |

Firecrawl developer searches discovered official custom-agent, factory/state-tool and AG-UI documentation. A raw pinned state-tool example and the OpenMuse wrapper were scraped. The current docs discuss several protocol generations; the pinned SDK source supersedes incompatible examples. A pinned `showcase/shell-docs/.../custom-ag-ui-agent.mdx` fetch returned404 and was excluded as evidence. No broad crawl was needed: exact repository examples plus SDK source answer the integration questions with less version ambiguity.

New retrieval artifacts are under `.firecrawl/blueprint-foundations-*`; cached `.firecrawl/winners-opendots-*`, `.firecrawl/openmuse-developer.json` and `.firecrawl/tech-openbot-*` were consulted without refetching. Exact raw SDK files saved in this pass: `agui-agent.ts`, `agui-http.ts`, `builtin-agent.ts`, `tanstack-converter.ts`, `use-agent.tsx`, `use-human-in-the-loop.tsx`. Firecrawl searches/scrapes retain JSON envelopes separately.

## 2. Pinned package and API contract

OpenDots lock resolves `@ag-ui/client/core 0.0.59`; `@copilotkit/core/react-core/runtime 1.75.0`; `@tanstack/ai 0.63.0`; `@tanstack/ai-openai 0.25.1`. Node must be at least24. OpenMuse pins runtime1.70.1 and AG-UI0.0.59, uses TanStackAI^0.59.0 plus Anthropic^0.18.13, Gemini^0.32.1 and OpenAI^0.23.2 adapters. Its package engines say>=22 while its setup README recommends24; the combined foundation should use24.

### Allowed APIs verified at these pins

| API | Verified signature/use | Location |
|---|---|---|
| `AbstractAgent` | Import from `@ag-ui/client`; `abstract run(input: RunAgentInput): Observable<BaseEvent>`; subclasses with custom dependencies override `clone()`. | AG-UI0.0.59 `sdks/typescript/packages/client/src/agent/agent.ts:148,581`; Dots `dot-agent.ts:9,33–61`. |
| `HttpAgent` | `new HttpAgent(config: HttpAgentConfig)`; `run(input: RunAgentInput): Observable<BaseEvent>`; POSTs JSON with `Accept: text/event-stream`; preserves URL/headers/fetch during clone. | AG-UI `agent/http.ts:50–103`; Muse `agent.ts:47–50`. |
| `BuiltInAgent` | `new BuiltInAgent({type:'tanstack',factory})`; factory returns `AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>`. Custom factory `type:'custom'` returns an async iterable of `BaseEvent`. | Runtime1.75 `agent/index.ts:901–921,1067`. |
| Factory context | `input`, `learnedSkills`, `abortController`, `abortSignal`, `interrupt(interrupts:Interrupt[]):Promise<ResumeEntry[]>`. The source advises using `agent.abortRun()`, not calling factory controller.abort(). | Runtime1.75 `agent/index.ts:856–879`. |
| `defineTool` / `ToolDefinition` | Object with `name`, `description`, `parameters`, optional `execute(args):Promise<unknown>`; Dots builds server tools this way. | Runtime1.75 `agent/index.ts:353–400`; Dots `computer-tools.ts:13–29`. |
| TanStack bridge | `tanstackTools(tools:ToolDefinition[])` converts to `toolDefinition({name,description,inputSchema:parameters}).server(execute)`. | Dots `tanstack-tools.ts:8–16`. |
| Input conversion | `convertInputToTanStackAI(input:RunAgentInput):TanStackInputResult`; returns messages/systemPrompts/tools. At1.75, extracts system/developer prompts and appends context/state. | Runtime converter `tanstack.ts:248–318`. |
| State conversion | Tool names exactly `AGUISendStateSnapshot`/`AGUISendStateDelta`; returned object contains `snapshot`/`delta`; converter emits the corresponding AG-UI event. | Runtime converter `tanstack.ts:499–523`; Muse wrapper `tanstack-agent.ts:83–111`. |
| Runtime integration | `new CopilotRuntime({intelligence,agents:async()=>Object.fromEntries(...),...})`, `createCopilotHonoHandler({runtime,basePath:'/api/copilotkit',cors:{origin:[]}})`. | Dots `platform.ts:85–113`; already running inside Hono app. |
| React agent | `useAgent({agentId,threadId,runtimeAgentId,updates?,throttleMs?})`; threadId/runtimeAgentId must be supplied together; returns `{agent,isReady}`. | React-core1.75 `v2/hooks/use-agent.tsx:139–163`; Dots `Chat.tsx:63–67`. |
| Turn/replay | `copilotkit.runAgent({agent})`, `connectAgent({agent})`, `agent.addMessage(...)`, `agent.subscribe({onRunErrorEvent})`. | Dots `Chat.tsx:108–158`. |
| HITL | `useHumanInTheLoop<T>(tool:ReactHumanInTheLoop<T>,deps?:ReadonlyArray<unknown>)`; render props get `respond` only while executing. | React-core1.75 `v2/hooks/use-human-in-the-loop.tsx:13–16,78–104`; Dots `Chat.tsx:177–198`. |
| Tool render | `useRenderTool({name:'*',render},deps)` and `CopilotChatToolCallsView`; existing computer cards demonstrate status/result rendering. | Dots `Chat.tsx:211+`. |
| Headless turn | `Platform.turn(threadId:string,prompt:string,signal:AbortSignal,metadata?:Record<string,unknown>):Promise<string>`. | Dots `platform.ts:212–236`. |

**Important interface distinction:** an AbstractAgent subclass returns an RxJS Observable from `run`. A TanStack or custom BuiltInAgent **factory** returns an async iterable. An async generator can be valid inside the latter; it is not the pinned AbstractAgent.run contract. Do not copy an old AG-UI architecture example whose run returns a function/closure.

## 3. Exact OpenDots domain integration seams

The following are existing source entry points; domain modules and their public methods remain new implementation work for the orchestrator to specify.

| Existing seam | Factual behavior | Consequence for Expunge |
|---|---|---|
| `src/server/index.ts:26–66,91–99` | Creates Store, WorkspaceStore, PlatformConfig, then Platform and Hono app. | Initialize domain dependencies here and inject them into the host objects; do not assume an existing Expunge registry. |
| `src/server/app.ts:31–101` | Body limit, origin/host/token checks precede `/api` routes. | Attach domain Hono routes under this authenticated boundary; consider the inherited1MB body cap for source artifacts. |
| `src/server/platform.ts:64–82,89–106` | Constructs DotAgent separately for Slack and for each runtime Dot. | Any new domain dependency/role routing must cover both instantiation sites plus clone. |
| `src/server/dot-agent.ts:33–54` | Six constructor deps; clone reconstructs them. | Preserve new immutable bundle/config/dependency fields in clone, or resolve once inside run. Parent AbstractAgent.clone does not know subclass fields. |
| `dot-agent.ts:111–142` | Watcher aborts when selected app/Dot permissions/config/fingerprint changes. | Domain version pinning is additional code. Existing watcher does not magically pin an Atlas harness. |
| `dot-agent.ts:311–320` | Reassembles serverTools and prompt each run. | Read the admitted version once before assembly and materialize that version's context/tools. Reassembly already exists; no Muse port is needed to invent it. |
| `dot-agent.ts:321–365` | Creates BuiltInAgent in TanStack factory mode with server, connected and selected frontend tools. | Inner worker/coach may use a ported Muse helper here or inside a new host agent. Fixed verifier remains outside mutable agent logic. |
| `dot-agent.ts:372–383` | Only pageReviewTool and request_connection_action are forwarded as client tools; forwardedProps reset to `{}`. | A new promotion review hook needs a corresponding explicit admission here. Do not assume registering a React hook or passing forwardedProps supplies a trusted version. |
| `Chat.tsx:63–67,121–158,177–198` | Scoped agent/replay/turn and native human review. | Copy these bindings for domain cards; bind UI progress to backend job/version records. |
| `runner.ts:58–104` and `index.ts:72–89` | One active native task,90second timeout, calls Platform.turn in original conversation. | Native scheduler can launch/observe a domain job; a full campaign needs its own persistent worker/time budget. |

OpenDots offers specialist Dot IDs/permissions/threads but no automatic `ask_dot` delegation. Issue71 remains open. Worker→coach→gate orchestration is a domain component, not an assumed foundation feature.

Approval source is useful but domain approval is not identical to MCP review. `connection-routes.ts:113–149` executes stored connection/tool/arguments after a one-time claim and completes even if the browser disconnects. `ConnectionActionCard.tsx:45–100` reads authoritative request/receipt, then calls respond. Native decline is a client response, not a MongoDB candidate-retirement record. Expunge must persist both admission and rejection in its own authority store.

## 4. OpenBot sidecar and governed-call contract

OpenDots directly reuses computer+supervisor source pinned to **OpenBot `b6932d31a8d6e7896c15139dfc27a6c6911deb27`**, not today's full OpenBot main. Compose builds `agent-computer/Dockerfile` from that revision, imports its supervisor source, patches per-Dot child credentials, and starts only the supervisor. Computers are dynamically provisioned per Dot and have persistent named volumes.

### Allowed ComputerService APIs

| Method | Signature / exact input | Source |
|---|---|---|
| Construct | `new ComputerService(workspace,config,paused,transport=fetch,deadlineMs=70000)` | Dots `computer-service.ts:26–33`. |
| Status | `status(id:string):Promise<ComputerStatus>` | `:189`. |
| Permission | `permissions(id:string,input:unknown)` parses partial enabled/browser/files/shell. | `:238–244`; schemas `computer-types.ts:2–10`. |
| Lifecycle | `start(id:string)`, `stop(id:string)`; owner-side calls supervisor `/computers/:id/ensure` or `/stop`. | `:245–259`. |
| Human control | `control(id:string,verb:'take'|'release')` | `:260–311`. |
| Tool execution | `action(id:string,action:ComputerAction,input:unknown,actor:'owner'|'agent'='owner',signal?:AbortSignal):Promise<unknown>` | `:312–369`. |
| File write | Action `files_write`, `{path,contents,append?}`; relative path, no traversal; contents<=100000characters. | `computer-types.ts:33–43,81–89`. |
| Shell | Action `exec`, `{command,timeoutMs?}`; command<=8000characters; timeout1000–60000ms, default30000. | `computer-types.ts:90–97`. |
| Agent tools | `computerTools(service,dotId,check,signal)` creates `computer_${action}` names, excludes human_ controls, calls `action(...,'agent',signal)`. | `computer-tools.ts:4–29`. |

Transport derives `HMAC-SHA256(COMPUTER_TOKEN,'opendots-computer:'+dotId)` and sends a bound `x-openbot-bot-id` header. Supervisor credentials remain server-side. Returned endpoints are accepted only for the expected computer container or matching loopback dynamic port. `action()` validates schema/permission, keeps watching revocation, records pending/success/failure and then transports. These are actual seams for staging candidate source, running bounded checks and reading its artifacts.

**The full OpenBot policy gateway is not included automatically.** Dots ComputerService does not call `createComputerGateway()` or its nested `govern()`. Full OpenBot main provides `createComputerGateway(options:ComputerGatewayOptions):ComputerGateway`, whose nested generic `govern(toolName,botId,actor,subject,run)` resolves server-held target evidence, evaluates policy, writes a decision, gates approval, acts and records failure. It depends on browser snapshots, transports, audit interfaces and policy modules. For Atlas operations, this must be a documented domain port: replace browser-target resolution with server-resolved record/collection evidence and the admitted database contract. Do not register an imagined existing `governMongo()` API.

Computer staging does not itself authorize a candidate or provide oracle access. Source files can be edited in a Dot's workspace; the fixed backend can read/hash them, store the candidate and run bounded evaluation through controlled domain tools. The completed computer audit is not a complete MongoDB domain trace and does not contain every raw command/value.

## 5. Actual OpenMuse code reuse without a third application

Copy-ready source is the full `apps/server/src/engine/tanstack-agent.ts` at Muse commit`1ac68f3...`, with MIT notice. It contains:

| Section | Location | Dependency / behavior |
|---|---|---|
| Provider adapter | Lines24–64 | `openaiText` or opted-in `openaiChatCompletions`; `anthropicText`; `geminiText`; provider env/baseURL normalization. |
| Provider diagnostic | Lines68–80 | `unknownProvider(provider,spec,baseUrl)`; gateway model IDs need correct provider prefix. |
| State tools | Lines83–111 | Exact snapshot/delta tool names, Zod inputs and return payloads. Converter compatibility verified in runtime1.75. |
| Wrapper | Lines114–169 | `tanstackAgent({model,maxSteps,tools,prompt,shouldContinue?,stepLimitNote?})`; creates TanStack BuiltInAgent and applies output helpers. |
| Multimodal history | Lines176–190 | `textOnlyToolResult(event:BaseEvent):BaseEvent`; preserves text instead of storing raw screenshot parts as thread text. |
| Step-limit explanation | Lines195–218 | `reportStepLimit(events:Observable<BaseEvent>,maxSteps:number,note:string)` | 
| Turn-message separation | Lines224–242 | `splitTextAtToolCalls(events)`; a documented runtime1.70.1 workaround. Runtime1.75 still uses a passed messageId across converted content; retain only after multi-turn verification. |

The one local import is `MODEL_MAX_RETRIES` from `../config.ts`; the verified constant is2 (`config.ts:104`). Provider adapter packages must be installed explicitly if copying the wrapper into OpenDots. Do not import the whole Muse config/app/bootstrap just to obtain that constant.

**Correct host pattern:** OpenMuse registers `ConversationAgent extends AbstractAgent`; its run constructs `tanstackAgent()` and subscribes to the resulting inner run. The wrapper monkey-patches `agent.run` after construction. Runtime1.75 BuiltInAgent.clone recreates from config, so directly registering the returned wrapper agent can lose those patched helpers. Reuse an outer Expunge host agent/appropriate DotAgent run, preserve new dependencies in its clone, and construct the wrapped inner agent inside run. That is real Muse source reuse, not a third full Muse runtime.

**Version adaptation:** the copied wrapper originated on runtime1.70.1/TanStack0.59. OpenDots' installed versions are1.75/0.63. Runtime1.75's converter already appends context/state to `converted.systemPrompts`; Muse manually assembles them while intentionally using only its own system list. Choose one composition path to avoid duplicated context. Provider adapter call signatures and content-part helpers still require typecheck plus actual provider smoke tests; state conversion itself was checked in pinned source. If preserving Muse dependencies in a dedicated backend workspace, its AG-UI0.0.59 wire contract can connect through a pinned HttpAgent, but that service still needs an actual POST/SSE endpoint—an OpenBot runtime URL is not a raw agent URL.

Muse's existing external route is `AGENT_BACKEND=agui`, `AGENT_URL`, optional `AGENT_TOKEN`, consumed in `apps/server/src/agent.ts:47–50` and `config.ts:149–151`. It replaces conversation routing only. Its OpenBotAdapter is explicitly a future seam; do not describe it as an existing full Muse/Dots/Bot composition.

## 6. Copy-ready locations and verification evidence

These are source sections to copy/read, not newly invented adapters:

| Needed pattern | Copy/read location | Existing verification references |
|---|---|---|
| Host agent preserving dependencies | Dots `dot-agent.ts:33–61`; Muse `engine/conversation.ts:29–43,405–417`. | Pinned AG-UI `agent.ts:581` explains base-clone limitation. |
| Full multi-provider inner loop | Muse `engine/tanstack-agent.ts:1–242` plus retry constant `config.ts:104`. | Muse `tests/model-provider.test.ts`, `tests/step-limit.test.ts`; not run here. |
| Pinned factory/tool bridge | Dots `dot-agent.ts:321–365`, `tanstack-tools.ts:8–16`. | Dots `tests/tanstack-agent.test.ts`; converter fixtures in CopilotKit1.75 `packages/runtime/src/agent/__tests__/converter-tanstack*.test.ts`. |
| State tools | Muse wrapper`:83–111`; official pinned showcase `factory/state-tools.ts` retrieved by Firecrawl. | Runtime1.75 converter`:499–523`; confirm frontend agent.state in a stream. |
| Scoped web agent | Dots `Chat.tsx:63–67,108–158`. | Existing setup/channel/SDK tests; pair runtimeAgentId with threadId. |
| Server-backed approval card | Dots `ConnectionActionCard.tsx:19–143`, `connection-routes.ts:73–149`. | `tests/connections.test.ts`, `tests/connection-card.test.tsx`. |
| Candidate file/exec staging | Dots `computer-tools.ts:4–29`, `computer-service.ts:312–369`, `computer-types.ts:81–97`. | `tests/computer.test.ts`, `tests/computer-deployment.test.js`; Docker live checks remain separate. |
| Durable lease design | Muse `engine/worker.ts:124–209`, `db.ts:75–87`. | Pattern only for an Atlas adaptation; native DotsRunner is90seconds. |
| Decide/record/act | OpenBot main `computer/gateway.ts:513–709`. | Domain port needs its own fixed verifier and receipt checks; computer fixtures are not Atlas tests. |

## 7. Startup/hosting contract and confidence

OpenDots existing development commands are `npm ci`, copy `.env.example`, `npm run dev` (Vite5173, API4310). Production uses `npm run build` then `npm start` and serves built assets from4310. It needs a CopilotKit Intelligence project key and app model credentials; the setup screen is not a simulated agent. `CPK_INTELLIGENCE_API_KEY` takes precedence over legacy `INTELLIGENCE_API_KEY`. App model vars are `OPENAI_API_KEY`, `OPENAI_MODEL`, optional `OPENAI_BASE_URL`; a copied multi-provider worker requires the corresponding Muse provider keys separately. `HOST` defaults loopback; external binding requires an OWNER_TOKEN of at least24characters. API/Intelligence gateway addresses must be reachable by the correct server/browser surfaces. Keep the native SQLite file persistent if hosting the shell.

Computer setup copies `docs/COMPUTERS.md`: set `COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312`, distinct supervisor/master computer secrets and stable namespace; build `computer-image` plus `computer-supervisor` with `compose.computers.yml`, start only supervisor, enable each Dot's capabilities and start its computer. The containerized app overlay removes host computer ports and uses service DNS; only supervisor mounts the Docker socket. This is the existing startup contract, not a new infrastructure design.

Confidence is **high** for pinned signatures, module locations, state-converter compatibility, existing supervisor transport and source-level reuse constraints. Confidence is **medium** for direct whole-wrapper compatibility across TanStack/provider-version differences because no install/typecheck/provider call occurred. Known gaps: live Intelligence/account/key availability; actual Docker build/runtime; domain worker's Atlas/trace/verifier API design; remote raw-AG-UI endpoint if selected; provider pricing/current model availability; production multi-user authorization; connected Slack/voice behavior. No source establishes a complete Expunge loop out of the box. New job authority, manifests, role orchestration, model budgets, Raindrop links and admission remain explicit domain implementation.
