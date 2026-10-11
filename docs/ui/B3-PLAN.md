# B3 Implementation Plan: the Expunge workflow in the OpenDots shell

Owner: ui-ux-improver. Written in U-0 (no product code edited). Line numbers cite the pinned upstream at `625452e0` as present in `apps/operator/` on 2026-10-11. Companion documents: `DESIGN.md` (visual system), `docs/ui/COMPONENT-STATES.md` (data and states per experience), `docs/ui/AUDIT-U0.md` (measured baseline).

## 0. Decisions already made by the lead (2026-10-11), effective when B3 is dispatched

| Topic | Decision |
|---|---|
| `platform.ts` agents factory | Approved: register `ExpungeProjectionAgent` under a dedicated Expunge Dot id; diff limited to the registration lines; every existing agent preserved. |
| `index.ts`, `app.ts` injection | Approved. The approval-write principal and any new env are server-only and never reach the browser. Readiness must distinguish configured, reachable, authorized and evidence-ready. |
| `App.tsx` | Approved for: hash route `#/expunge/<jobId>`, HITL review-tool registration inside `CopilotKitProvider`, Expunge nav and default view when the domain is configured, per-view `document.title`, skip link and `main` landmark, unlock-screen branding. Each change small and separately reviewable. |
| `Chat.tsx` | Not approved unless the projection-agent approach fails; message the lead with exact lines before editing. |
| `dot-agent.ts` | Frozen. A normal Dot does not surface the review card in this build. |
| `index.html` | Approved: title and description. |
| `style.css` | Approved only for the measured AA failures (`.eyebrow`, `--muted` uses and the other rows in DESIGN.md section 3.1) and the dark/light border inconsistency, with before/after ratios recorded in DESIGN.md. Do not retype the shell. Raise 8 to 11 px declarations only where Expunge views render. |
| Fonts | System stack preferred; at most one static OFL woff2 face if genuinely needed, with a `THIRD_PARTY.md` entry and size noted. No new npm dependencies. |
| Contracts | Snapshot and ProjectionEvent payload shapes in section 9 (explicit TypeScript) will be frozen by the lead into `CONTRACTS.md` and handed to runtime-raindrop and mongodb-authority. `GET /api/expunge/readiness` with four checks is part of this plan. |

## 1. Constraints that shape the design

- The operator is a standalone npm project with its own lock; it cannot import `@expunge/contracts`. Shapes are duplicated in `src/shared/expunge.ts` and cross-checked by a root-level test against `packages/contracts`.
- No model, browser tab or chat turn is authority. The operator is a read projection plus a few explicit, idempotent, ID-only writes (submit, cancel, approval decision). Actor, tenant, scope, role and authorization revision are resolved from server configuration and the stored job; they are never accepted from the browser, model state or AG-UI properties.
- A configured `EXPUNGE_DOMAIN_URL` is not a connectivity check (BUILD-A1). Setup-only mode (no domain, no provider key) must boot and say so.
- Node: `tests/telemetry.test.ts` fails 7 of 8 on Node 24.11.1 and 25.2.1 and passes 8 of 8 on Node 22.23.2 (reproduced; also on the pristine upstream clone). The verifier attributes this to a Node `util.inspect` regression (nodejs/node#60717, fixed in Node 24.13.1 and 25.4.0) triggered when the SDK logs a Zod error. **Rule for B3 code:** never `console.error` a `ZodError` or any object with accessor properties; log `error.issues` or `error.message` only (until a Node floor of at least 24.13.1 is in place).
- Performance and style budgets: DESIGN.md sections 3 and 11.

## 2. File inventory

Everything B3 adds is under owned paths. `ExpungeFoundation.tsx` is deleted when `ExpungeApp` takes over (App.tsx change).

### 2.1 `apps/operator/src/shared/expunge.ts` (extend)

Types from section 9 plus zod schemas for the wire shapes used on both sides (kept small; the client imports types only, and `zod` guards only where a payload is rendered). Existing exports remain source compatible (`ExpungeJobSnapshot` becomes the V1 subset of `ExpungeJobSnapshotV2`).

### 2.2 `apps/operator/src/server/expunge/`

| File | Purpose |
|---|---|
| `domain-service.ts` (extend) | Add methods to `ExpungeDomainService` and `HttpExpungeDomainService`: `readReadiness`, `listWorlds`, `previewCleanup`, `submitCleanup`, `listJobs`, `readJob` (V2), `readCommittedEvents` (existing, payload schemas per kind), `readArtifact`, `readApproval`, `decideApproval`, `cancelJob`, `readJobByThread`. Same hardening as today: fixed origin, `redirect: 'error'`, 5 s timeout, 1 MB bound, bound-ID checks, no upstream body or credential reflection. Writes use a separate server-only principal env (name chosen by the lead, for example `EXPUNGE_APPROVAL_TOKEN`) and send only IDs and enumerations. |
| `schemas.ts` | zod schemas for every response, strict for requests. Unknown event kinds are kept as `unknown_kind` events (rendered generically, counted, never crash). |
| `readiness.ts` | The four-check probe (section 3.3), 5 s cache, fixed-vocabulary messages. |
| `routes.ts` (extend) | Section 3.1 route table. |
| `projection-agent.ts` | `ExpungeProjectionAgent` (section 4). |
| `agent-copy.ts` | Acknowledgement text built only from a committed snapshot; pure functions, unit tested. |

### 2.3 `apps/operator/src/client/expunge/`

```
index.ts                     lazy entry: export const ExpungeApp = lazy(() => import('./ExpungeApp'))
ExpungeApp.tsx               hash-route shell, tabs per job, ConnectionBanner, LiveRegion, document.title
routes.ts                    parse/format #/expunge/... (pure)
expunge.css                  tokens (rgb(), explicit dark) + components, rules R1-R9 of DESIGN.md
api.ts                       typed wrappers over ../api (zod parse of responses; AbortSignal everywhere)
projection/
  reducer.ts                 pure: (state, action) -> state; snapshot + ordered events -> view model
  useJobProjection.ts        bootstrap, poll, backoff with jitter, visibility/online catch-up, gap detection
  buffer.ts                  bounded ring (2,000 events, 2 MB) addressable by sequence
  selectors.ts               phases, coverage, decision groups, graph model; no I/O
views/
  JobsHome.tsx               list + New cleanup action (no KPI tiles)
  ReadinessView.tsx          Setup/readiness
  NewCleanupView.tsx         world, exact subject, scope and eligibility, preview, submit
  WorkbenchView.tsx          Live workbench
  EvidenceView.tsx           Raindrop evidence and outbox ladder
  CandidateView.tsx          harness diff, hypotheses, compiler/replay results
  EvaluationView.tsx         paired rows, protected cases, controls, cost, reject reasons
  ReceiptView.tsx            verified receipt document
  LineageView.tsx            versions, tested parent, promotions, rollbacks
  CampaignView.tsx           Hider and meta campaigns
  PrivacyView.tsx            source derivation graph, retraction progress, provider lifecycle
components/                  vocabulary of DESIGN.md section 9 (one file each; ReferenceTrace lazy)
review/
  expungeReviewTool.ts       tool name, strict args schema, description (client and server import this)
  ExpungeReviewTool.tsx      useHumanInTheLoop registration (mounted in App inside CopilotKitProvider)
  ReviewCard.tsx             chat card: summary + "Open review" (opens ApprovalDialog)
  ApprovalDialog.tsx         single decision surface (also used by the workbench)
hooks/                       useContainerWidth, useReducedMotion, useFocusReturn, useInert
```

### 2.4 Tests (`apps/operator/tests/expunge-*.test.ts(x)`; browser script is `.mjs` so vitest does not collect it)

`expunge-reducer.test.ts`, `expunge-states.test.tsx`, `expunge-agent.test.ts`, `expunge-readiness.test.ts`, `expunge-routes.test.ts`, `expunge-css.test.ts`, `expunge-contract-parity.test.ts` (run from root), `expunge-browser.e2e.mjs` (Playwright; run by the verifier and by me before reporting a slice). Details in section 10.

## 3. Server routes

### 3.1 Route table (all under the existing owner/origin/JSON boundary in `app.ts`; none accepts tenant, actor, role or authorization revision)

| Route | Method | Operator to domain (private) | Status |
|---|---|---|---|
| `/api/expunge/status` | GET | none (configuration only) | exists |
| `/api/expunge/readiness` | GET | `GET /internal/projection/readiness` | new (section 3.3) |
| `/api/expunge/worlds` | GET | `GET /internal/projection/worlds` | new |
| `/api/expunge/previews` | POST | `POST /internal/projection/previews` | new; if the backend has no preview, the route returns 501 and the UI shows scope inspection only |
| `/api/expunge/jobs` | GET | `GET /internal/projection/jobs?cursor&limit&kind&status` | new |
| `/api/expunge/jobs` | POST | `POST /internal/projection/jobs` (`requestKey` idempotent) | new |
| `/api/expunge/jobs/:jobId` | GET | `GET /internal/projection/jobs/:jobId` (snapshot V2) | exists (V1), extended |
| `/api/expunge/jobs/:jobId/events?afterSequence=N&limit=M` | GET | same path | exists; add `limit` (default and max 500) |
| `/api/expunge/jobs/:jobId/cancel` | POST | `POST /internal/projection/jobs/:jobId/cancel` | new |
| `/api/expunge/artifacts/:artifactId` | GET | `GET /internal/projection/artifacts/:artifactId` | new |
| `/api/expunge/proposals/:proposalId` | GET | `GET /internal/projection/proposals/:proposalId` | new |
| `/api/expunge/proposals/:proposalId/decision` | POST | `POST /internal/projection/proposals/:proposalId/decision` | new |
| `/api/expunge/deployments/:target` | GET | `GET /internal/projection/deployments/:target` (active, revision, promotion chain) | new, for Lineage |
| (internal only) thread binding | n/a | `GET /internal/projection/threads/:threadId` | new; used by the agent only |

Every response from the domain passes a per-kind zod schema (unknown fields stripped, bounds enforced, invalid payloads rejected with a never-throwing log) before it is forwarded to the browser (section 15.2). Mutating routes require `application/json` (existing boundary), strict zod bodies, bounded size (1 MB existing limit; these are tiny), and return the **re-read committed state**, not an echo of the request. Idempotency: `requestKey` for submit; `descriptorDigest` plus proposal ID for decisions (a second decision on a consumed grant returns the committed state, not an error loop). Errors map to a closed set: 400 invalid, 404 unknown, 409 conflict/stale, 429, 501 unsupported by backend, 502 backend bad response, 503 unconfigured/unreachable. Messages are fixed vocabulary; upstream bodies, tokens and URLs are never reflected. Server logs write `error.message` or `error.issues`, never a raw `ZodError`.

### 3.2 Write-principal isolation

`EXPUNGE_INTERNAL_TOKEN` stays read-projection only. Submit and cancel use a second server-only principal; approval decision uses a third (approval issuer identity per spec section 4: "separate identities ... approval issuer"). The lead names the variables; they are listed in `.env.example` with no values; the readiness `authorized` check reports which principals the backend accepted without revealing them. Nothing reaches the browser bundle (a build-time test greps `dist/client` for the variable names).

### 3.3 Readiness (four distinct checks)

`GET /api/expunge/readiness` returns `ExpungeReadiness` (section 9). Evaluation order and dependency:

1. **configured**: pure local check of `EXPUNGE_DOMAIN_URL` (HTTP(S) origin), token lengths, owner binding. Lists missing variable **names**. Fails to `env_missing` or `env_malformed`. No network.
2. **reachable**: `GET /internal/projection/readiness` within 3 s with the read principal. Distinguishes `connect_refused`, `timeout`, `tls_error`, `http_5xx`, `bad_response`. `unknown` if `configured` failed.
3. **authorized**: HTTP 401 gives `unauthorized`, 403 gives `forbidden`, a 200 whose body shows the owner is not bound to a scope gives `scope_unbound`. `unknown` if `reachable` failed. Reachable can pass while authorized fails: that is the point.
4. **evidenceReady**: taken from the backend's own body (`evidence.write` and `evidence.readBack` proven by the observability path, last proof time, outbox dead-letter count), never inferred by the operator. Missing proof gives `evidence_never_proven`, an old proof gives `evidence_stale`, dead letters give `evidence_dead_letter`, no Raindrop credentials on the backend give `evidence_unconfigured`. `unknown` if `authorized` failed.

`ready` is true only when all four pass and is computed server-side. A fixture backend answers `backend.kind: 'fixture'` and the UI shows a persistent banner "Fixture backend: test data, not a live job". Probe results are cached 5 s and the client re-checks on demand and every 60 s while the readiness view is open.

## 4. `ExpungeProjectionAgent`

Role (spec section 4): an OpenDots-side `AbstractAgent` that observes and acknowledges. It **never runs the model campaign** (that is the durable `ExpungeExecutionAgent` in the worker), never calls an LLM, never parses free text into authority, and every turn is finite and short. Closing the tab, completing a turn or aborting the stream cannot complete or cancel a job.

### 4.1 Class shape

Mirror `DotAgent` (`dot-agent.ts` L33-L55): `extends AbstractAgent` from `@ag-ui/client`; trusted dependencies in the constructor (`ExpungeDomainService`, owner binding, clock); `clone()` constructs a new instance with the **same** trusted dependencies (the runtime clones agents before running; losing them on clone is the defect the spec calls out); `run(input): Observable<BaseEvent>` resolves everything from the stored job, not from client state or `forwardedProps`; `abortRun()` aborts the domain reads via `AbortController`. Do not copy the 90 s watchdog (`TURN_TIME_LIMIT_MS`, L32 and L72-L76): the turn is a handful of bounded reads (each capped at 5 s by the domain transport) so a 15 s total cap is enough and a breach emits an error event, not a job state change.

### 4.2 `run` sequence

1. `RUN_STARTED`.
2. Resolve the job: `domain.readJobByThread(input.threadId)` (the domain holds the thread correlation; the operator stores nothing). Not bound or backend unavailable: emit one assistant text message that says exactly that (fixed copy from `agent-copy.ts`), then `RUN_FINISHED`. No error theatre, no invented status.
3. Read the committed snapshot (`readJob`) and, if `approval.state === 'pending'`, the stored descriptor summary (`readApproval`).
4. Emit one assistant message (deterministic message ID derived from `jobId` and `sequence`) whose text is rendered from the snapshot by `agent-copy.ts`: phase, status, coverage sentence, receipt sentence if a committed receipt exists. The text is labeled as projection output, not model output.
5. If the review tool was admitted (section 5) and approval is pending: `TOOL_CALL_START/ARGS/END` for `review_expunge_proposal` with args `{ proposalId }` only, in the **same assistant message** as the text (so the shell's `Chat.tsx` visibility filter L231-L243, which hides assistant messages without text or a listed tool, still shows it; this is what avoids editing `Chat.tsx`).
6. `STATE_SNAPSHOT` containing only IDs, status and sequence (a projection; it can render a badge only through `CommittedSeal` with a source, so even this state cannot create a client-only authority badge).
7. `RUN_FINISHED`.

If the user sends text, the agent answers with the same status acknowledgement. It does not interpret subjects, worlds or "delete user X": New cleanup is a structured form (exact identifier type and value, authorized world, preview) that posts to `POST /api/expunge/jobs`. The agent's "submit" capability is limited to resolving a server-stored pending request by `requestKey`, so chat text never becomes authority.

Follow-up run after the human responds to the review card (CopilotKit sends the tool result back and runs the agent again): the agent **ignores the tool-result payload as authority** and re-reads the committed approval/job state, then acknowledges what the database says ("The database recorded your approval and has not yet committed the promotion" or "...committed promotion P at revision R").

### 4.3 Registration and the Expunge Dot

`validateRuntimeScope` (`runtime-scope.ts` L66) denies any agent id that is not a workspace Dot, and L78 requires every thread to be bound to a Dot. So the agent must live behind a Dot. B3 ensures a dedicated Dot (fixed server constant id, for example `expunge`) exists at platform start using the public `workspace.createDot(...)` (no `workspace.ts` edit; the Dot is created only when the domain is configured) and changes only the factory in `platform.ts` L89-L104:

```ts
// platform.ts, inside new CopilotRuntime({ agents: async () => ... })
Object.fromEntries(
  workspace.dots().map((dot) => [
    dot.id,
    dot.id === EXPUNGE_DOT_ID && expungeDomain
      ? new ExpungeProjectionAgent(expungeDomain, workspace.ownerId)
      : new DotAgent(store, workspace, config, dot.id, false, this.setupTelemetry),
  ]),
)
```

The Slack channel factory (L64-L78) and every other `DotAgent` are untouched. `Platform` gains an optional `expungeDomain` constructor argument injected from `index.ts` (approved). The Expunge Dot cannot be edited into a DotAgent by users: its row is read-only in the Dot settings dialog (a one-line `disabled` check in the Dot editor is **not** planned; instead the factory keys on id, so editing the Dot's text has no authority effect).

Chat availability: creating a conversation requires CopilotKit Intelligence (`platform.createConversation`, `platform.ts` L150-L167). In setup-only mode (no provider key) no conversation, and therefore no chat acknowledgement or HITL card, is possible. The workbench and the approval dialog do not depend on chat and remain the primary surfaces. This is stated in the UI ("Chat acknowledgements need the conversation service; the workbench is fully available").

## 5. Review tool: registered through BOTH the client hook and the backend allowlist

Existing pattern, for reference:

- Client: `Chat.tsx` L177-L198 calls `useHumanInTheLoop({ name, description, parameters, render }, deps)` twice (page review, connection action). `useRenderTool('*')` at L214-L230 renders computer tool cards. Transcript visibility: L231-L243 keeps only user/assistant messages that have non-empty text or a tool call named `computer_*`, `review_space_page` or `request_connection_action`.
- Backend: `dot-agent.ts` L278-L284 filters `input.tools` to an allowlist (`[pageReviewTool.name, connectionActionTool.name]`); L285-L287 derive `approvals`; L372-L377 pass only the admitted tools to the inner run. A client-registered tool that is not in this allowlist never reaches the model (this is the missing-tool failure mode ACCEPTANCE "HITL exposure" tests).
- Decision storage pattern: `connection-routes.ts` L74-L95 (`approvalFor`: the record is bound to its own conversation, expires, and only runs the stored arguments) and `PageReviewCard.tsx` `restorePageReview`.

B3 does the same, in new files, without editing `dot-agent.ts` (frozen) or `Chat.tsx` (not approved):

1. `review/expungeReviewTool.ts` exports `expungeReviewTool = { name: 'review_expunge_proposal', description, parameters: z.toJSONSchema(expungeReviewSchema) }` where `expungeReviewSchema = z.object({ proposalId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict()`. Imported by both sides so names cannot drift.
2. **Client hook**: `review/ExpungeReviewTool.tsx` calls `useHumanInTheLoop({ name, description, parameters: expungeReviewSchema, render: (props) => <ReviewCard {...props} /> }, [])`. It is mounted once in `App.tsx` inside `CopilotKitProvider` (App.tsx L975-L977; approved). `CopilotChatToolCallsView` resolves renderers from the provider's registry, so it renders for messages in any chat without a `Chat.tsx` edit.
3. **Backend allowlist**: `ExpungeProjectionAgent` contains `const ADMITTED = new Set([expungeReviewTool.name])` and emits the tool call only if `input.tools.some((t) => ADMITTED.has(t.name))`. If the client did not register the tool, the agent emits the text plus "Open the review in the workbench" and no tool call. A test covers both directions (registered and admitted; registered but not allowlisted; allowlisted but not registered).
4. The card shows a summary and an **Open review** button. The decision surface is the single `ApprovalDialog` (DESIGN.md section 9.3), the same component the workbench uses. The card never renders approve/decline directly, so there is one accessible implementation.
5. The dialog reads the stored descriptor (`GET /api/expunge/proposals/:id`), shows its state (pending, approved, declined, expired, consumed, stale), and posts only `{ decision, descriptorDigest, toolCallId? }`. Then it calls `respond({ decision, committed: boolean })`; the payload is informational and the agent re-reads committed state on the follow-up turn.
6. Restore on reload: the card calls `GET /api/expunge/proposals/:id` on mount, so a reload after a decision shows the committed result and not a live button (same idea as `restorePageReview`).

If this approach fails an acceptance test (for example the shell's visibility filter still hides the message), I message the lead with the exact `Chat.tsx` lines (L231-L243) and the one-line proposed change before editing anything.

## 6. Reconnect: authoritative snapshot plus event sequence, never re-running cleanup

State machine in `projection/reducer.ts` (pure) driven by `useJobProjection.ts`:

```
bootstrapping -> live <-> retrying -> disconnected
                   |         |             |
                   +-> unavailable (503/unconfigured)   +-> not_found (404)   +-> stale
```

1. **Bootstrap**: `Promise.all([GET job snapshot, GET events?afterSequence=0&limit=500])`. Render the snapshot immediately (it is authoritative for aggregate state). Page events forward (`afterSequence=nextSequence`, 500 per page) until `nextSequence >= snapshot.sequence`, keeping the newest 2,000 in a ring (`buffer.ts`); older events stay on the server addressable by sequence. Request `GET /api/expunge/jobs/:id/events?afterSequence=N`.
2. **Live**: poll `GET .../events?afterSequence=<lastApplied>` every 1 s while `queued` or `running`, every 5 s while `waiting_*`, and stop 15 s after a terminal status once the snapshot confirms it. Pause when the tab is hidden; on `visibilitychange` to visible, on `online`, and on window focus, run an immediate catch-up. One request in flight at a time; every request has an `AbortController` tied to unmount and job change.
3. **Apply**: validate `jobId`, strictly increasing `sequence`, and `nextSequence === last event sequence` (the existing `HttpExpungeDomainService` already enforces these server-side; the client re-checks). Deduplicate by `eventId` and `sequence`. Required contract: sequences are contiguous per job stream starting at 1, so a gap is detectable (see open question 1); on a gap the client re-fetches the snapshot and re-pages.
4. **Failure**: exponential backoff 1, 2, 4, 8, 16, 30 s with full jitter. State `retrying` (shows attempt number and next try) for the first 5 consecutive failures, then `disconnected` (banner) while still retrying at the 30 s cap. HTTP 503 gives `unavailable` (no retry storm: re-check readiness every 30 s). 404 gives `not_found`. 401 hands off to the shell's unlock screen.
5. **Backend restart or restore**: if a fresh snapshot has `sequence` lower than the client's last applied sequence, mark `stale`, drop the buffer and re-bootstrap, showing "The projection was reset by the backend; this is its current committed state."
6. **Freshness**: every region shows "Updated hh:mm:ss"; if no successful read for 3 poll intervals while the transport claims to be connected, the region goes `stale` with a Refresh action.
7. **No side effects on reconnect**: only GETs run automatically. Submit, cancel and approve are explicit user POSTs with idempotency keys; a reload mid-submit reuses the `requestKey` kept in `sessionStorage` with the form state and returns the existing job.
8. **Batching**: events are applied to a ref buffer and flushed to React state at most every 250 ms inside `startTransition`; derived graph models are `useDeferredValue`. No setState per event.
9. **Later (optional)**: a streaming variant `GET /api/expunge/jobs/:id/stream?afterSequence=N` using `fetch` + a stream reader (the shell authenticates with a bearer header, which `EventSource` cannot send), resuming from `Last-Event-ID`. Polling is the baseline and is sufficient for the demonstration.

## 7. Client architecture

- **Lazy by default.** `App.tsx` imports only `index.ts` (a `React.lazy` boundary with a skeleton fallback). The Expunge stylesheet is imported from `ExpungeApp.tsx`, so Vite splits it into the lazy chunk (rule R9). The reference trace is a second lazy chunk loaded on first graph view. Icons are imported per icon (`lucide-react` is already a dependency; no barrel imports).
- **State.** One reducer per open job (`projection/reducer.ts`), pure and unit tested; no global store library. The view model separates **committed** fields (from snapshot and events) from **client** fields (pending acknowledgements, selection, filters, density). Only committed fields can reach `CommittedSeal`; the type of `CommittedSeal`'s `source` prop makes it impossible to build one from client state.
- **Data.** Parallel fetches with `Promise.all`; every request has an `AbortSignal`; responses are zod-parsed at the edge; unknown event kinds degrade to a generic row.
- **Graph.** `ReferenceTrace` takes an immutable graph model from `selectors.ts` (nodes, edges, per-node committed marks). Deterministic layered layout by hop distance (no force simulation, so it is stable and cheap), SVG rendering, roving tabindex, aggregation beyond 300 nodes; `ReferenceTable` renders the same model. No graph or chart library is added.
- **Large data.** Tables paginate at 50 rows or window with `aria-rowcount`/`aria-rowindex`; the decision log uses `content-visibility: auto` and a windowed list; hashes and payloads expand on demand.
- **Live region.** One polite `LiveRegion` per view fed by a coalescing queue (at most one message per 2 s; phase changes, terminal states, approval-needed, connection changes only).
- **Focus.** `Dialog.tsx` is the only modal primitive: `role="dialog"`, `aria-modal`, `aria-labelledby`, initial focus per section 9.3 of DESIGN.md, focus containment, `inert` on siblings, Escape, focus return with a fallback target. `useFocusReturn` stores the invoker and a fallback selector.
- **Reduced motion and container queries** via CSS (`@media (prefers-reduced-motion)`, `@container`), with `useReducedMotion` only where JS drives an animation.

## 8. Shell integration (small, separately reviewable changes)

Each is its own commit packet. Cited lines are the pinned upstream as of 2026-10-11.

| # | File and lines | Change | Approved |
|---|---|---|---|
| 1 | `src/server/platform.ts` L89-L104 | Registration of `ExpungeProjectionAgent` for the Expunge Dot (section 4.3); optional constructor argument for the domain service | yes |
| 2 | `src/server/platform.ts` top | One side-effect import of `./expunge/safe-console.js` with a comment citing nodejs/node#60717 (lead exception, see section 11, item F1) | yes (exception) |
| 3 | `src/server/index.ts` ~L96-L100, `src/server/app.ts` L105 and `AppOptions` | Inject the expanded domain service and write-principal env; `.env.example` entries (lead-owned file, names only) | yes |
| 4 | `src/client/App.tsx` L68 (`view` state), L477-L486 (nav), L556-L557 (breadcrumb), L606-L607 (`ExpungeFoundation` render), L975-L977 (provider), unlock screen at `needsAuth` (L252) | Hash route `#/expunge/<jobId>`; default view and nav position when the domain is configured; per-view `document.title`; skip link and `main` landmark; mount `ExpungeReviewTool` inside the provider; Expunge name on the unlock screen | yes |
| 5 | `index.html` | Title and description | yes |
| 6 | `src/client/style.css`, `src/client/editor.css` | Only the rows of DESIGN.md section 3.1 | yes (measured defects only) |
| 7 | `apps/operator/package.json` engines and `apps/operator/.nvmrc` | Same Node range as the root (`>=24.13.1 <25.0.0 || >=25.4.0`) and an identical `.nvmrc` (lead decision F2). The `Dockerfile` base stays as is; **the image must be built from a Node patch at or above 24.13.1 / 25.4.0** or `tests/telemetry.test.ts` and the SDK error path fail on the affected `util.inspect` regression. | yes |
| 8 | `src/client/Chat.tsx`, `src/server/dot-agent.ts` | No change planned | no (frozen) |

## 9. Contracts needed from other lanes, as explicit TypeScript

These are the shapes the UI reads. They are sanitized projections: no raw subject literal (the operator sees a masked display and an identity hash), no hidden manifest, no credentials, no free model text that could be mistaken for committed state. They type-check under `tsc --strict` (verified standalone on 2026-10-11). The lead freezes them into `CONTRACTS.md`; runtime-raindrop (projection service, event emission) and mongodb-authority (job/receipt/grant reads) implement them. Requirements in prose that the types cannot carry:

1. **Per-job event sequences are contiguous from 1** and `snapshot.sequence` equals the highest event sequence reflected in the snapshot.
2. **Events are immutable once committed**; the projection never rewrites a sequence.
3. **Terminal text is rendered from the committed receipt**; any model narrative is a separate artifact the UI labels untrusted.
4. **Additive event kinds** beyond the 11 in `CONTRACTS.md` are required because the current list has no committed signal for waiting transitions, cancellation request, approval resolution (declined/expired), rollback, retraction progress or campaign rows: `job_status_changed`, `cancel_requested`, `approval_resolved`, `harness_rolled_back`, `retraction_progress`, `campaign_row_committed`. Without them the UI cannot render committed `cancelled`, declined or expired approvals, or privacy progress from authoritative data and would have to infer them.
5. **Readiness `evidenceReady` is the backend's own proof** (write and read-back through the observability path), not an operator inference.
6. **Fixture backends declare themselves** (`backend.kind: 'fixture'`).

```ts
/**
 * Proposed additions to apps/operator/src/shared/expunge.ts (owned by ui-ux-improver at B3).
 * Standalone: the operator has its own lock and cannot import @expunge/contracts.
 * Names and unions mirror docs/expunge/CONTRACTS.md and packages/contracts/src/index.ts.
 * Everything here is a sanitized read projection. No raw subject literal, no hidden manifest,
 * no credential, no model text that could be mistaken for committed state.
 */

// ---- Mirrored vocabulary (must stay equal to packages/contracts; a root test cross-checks) ----
export type JobKind =
  | 'cleanup' | 'observe' | 'propose' | 'evaluate' | 'promote' | 'rollback'
  | 'redact' | 'external_delete' | 'adversarial_generate' | 'meta_evaluate';
export type JobStatus =
  | 'queued' | 'running' | 'waiting_evidence' | 'waiting_approval' | 'waiting_external'
  | 'succeeded' | 'failed' | 'cancelled';
export type EffectKind = 'delete' | 'redact' | 'restrict' | 'tombstone';
export type MutationClass = 'tightening' | 'behavioral' | 'authority_expansion';
export type SourceOrigin =
  | 'agent_self_report' | 'verifier_feedback' | 'human_feedback'
  | 'raindrop_classifier' | 'experiment_result' | 'admission_service';
export type OutboxState =
  | 'pending' | 'leased' | 'sdk_enqueued' | 'ingest_accepted' | 'query_visible'
  | 'evidence_ready' | 'retrying' | 'dead_letter';
export type ExternalErasureStatus = 'not_required' | 'pending' | 'confirmed' | 'failed';
export type ProviderErasureStatus =
  | 'unsubmitted' | 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled';
export type CandidateState =
  | 'proposed' | 'schema_rejected' | 'replay_rejected' | 'evaluating' | 'behavior_rejected'
  | 'waiting_approval' | 'eligible' | 'promoted' | 'stale' | 'revoked';
export type PolicyResult = 'allow' | 'ask' | 'deny';
export type TargetKind = 'worker' | 'improver' | 'hider';

/** Worker workflow nodes shown by the phase stepper (spec section 7). */
export type JobPhase = 'inspect' | 'resolve' | 'discover' | 'preview' | 'apply' | 'verify' | 'complete';
export type PhaseState = 'pending' | 'active' | 'committed' | 'skipped' | 'failed';

export type ToolId =
  | 'inspect_scope' | 'resolve_subject' | 'discover_references' | 'preview_cleanup'
  | 'apply_cleanup_batch' | 'verify_registered_scope' | 'complete_cleanup'
  | 'inspect_harness' | 'report_diagnostic';

// ---- Readiness: GET /api/expunge/readiness ----
export type ReadinessReason =
  | 'env_missing' | 'env_malformed'                         // configured
  | 'connect_refused' | 'timeout' | 'tls_error' | 'http_5xx' | 'bad_response' // reachable
  | 'unauthorized' | 'forbidden' | 'scope_unbound'          // authorized
  | 'evidence_unconfigured' | 'evidence_never_proven' | 'evidence_stale' | 'evidence_dead_letter'; // evidence-ready

export interface ReadinessCheck {
  /** unknown = not evaluated because an earlier check failed (never rendered as pass). */
  status: 'pass' | 'fail' | 'unknown';
  reason: ReadinessReason | null;
  /** Server-side configuration NAMES that are missing or malformed. Never values. */
  missing: string[];
  /** Fixed-vocabulary sentence chosen by the operator, not echoed from upstream bodies. */
  detail: string;
  /** Time the operator or backend actually observed this result. */
  observedAt: string | null;
}

export interface ExpungeReadiness {
  checkedAt: string;
  /** 'fixture' = deterministic test backend; the UI shows a persistent banner. */
  backend: { kind: 'live' | 'fixture' | 'none'; version: string | null };
  configured: ReadinessCheck;     // operator env present and well formed; no network
  reachable: ReadinessCheck;      // backend answered the readiness route within the bound
  authorized: ReadinessCheck;     // backend accepted the service principal and bound the owner to a scope
  evidenceReady: ReadinessCheck;  // observability write and read-back proven by the backend, not by the operator
  /** true only when all four pass. Derived server-side; the client never computes it. */
  ready: boolean;
}

// ---- Worlds and previews: GET /api/expunge/worlds, POST /api/expunge/previews ----
export interface WorldSummary {
  worldId: string;
  label: string;
  env: 'dev' | 'evaluation' | 'demo';
  scopeId: string;
  scopeRevision: number;
  worldRevision: number;
  maintenanceMode: boolean;
  collectionIds: string[];
  fieldCount: number;
  referenceEdgeCount: number;
  allowedEffectKinds: EffectKind[];
  eligibilityPolicyId: string;
  eligibilityPolicyHash: string;
  documentLimits: { maxScanned: number; maxChanged: number };
  discoveryCompleteness: { kind: 'declared' | 'observed' | 'partial'; limitations: string[] };
}

export type SubjectIdType = 'objectId' | 'string' | 'int' | 'long';
export interface CleanupSubjectInput { idType: SubjectIdType; value: string }

export interface CleanupPreview {
  previewId: string;
  worldId: string;
  worldRevision: number;
  scopeRevision: number;
  /** Masked display and a hash. The literal subject is not echoed back. */
  subject: { display: string; identityHash: string; idType: SubjectIdType };
  perCollection: Array<{
    collectionId: string;
    exactIdentityMatches: number;
    eligibleEffects: Partial<Record<EffectKind, number>>;
    retained: number;
    notInspected: boolean;
  }>;
  limitations: string[];
  expiresAt: string;
}

export interface SubmitCleanupRequest {
  requestKey: string;                // client UUID; server dedupes
  worldId: string;
  previewId: string;                 // preview must match current world/scope revision
  subject: CleanupSubjectInput;
}                                    // strict: no tenant, actor, role, authorization revision fields

// ---- Snapshot v2: GET /api/expunge/jobs/:jobId (additive over today's snapshot) ----
export interface Counter { used: number; cap: number }
export type GraphNodeState =
  | 'discovered' | 'inspected' | 'previewed' | 'applied' | 'retained' | 'excluded' | 'residual' | 'not_inspected';

export interface ExpungeJobSnapshotV2 {
  schemaVersion: 2;
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  /** Highest committed event sequence reflected in this snapshot (contiguous per job stream). */
  sequence: number;
  runId?: string;
  harness?: { hash: string; parentHash: string | null; activeRevision: number };
  scope: { scopeId: string; scopeRevision: number; env: 'dev' | 'evaluation' | 'demo' };
  world?: { worldId: string; revision: number; maintenanceMode: boolean };
  subject?: { display: string; identityHash: string; idType: SubjectIdType };
  phase: JobPhase | null;
  phaseStates: Record<JobPhase, PhaseState>;
  cancellation: { requested: boolean; requestedAt: string | null };
  coverage: {
    registeredCollectionIds: string[];
    inspectedCollectionIds: string[];
    discoveredFieldIds: string[];
    completeness: 'declared' | 'observed' | 'partial';
    limitations: string[];
  };
  limits: {
    modelCalls: Counter; toolCalls: Counter; scannedDocuments: Counter; changedDocuments: Counter;
    traversalDepth: Counter; graphNodes: Counter; graphEdges: Counter;
    wallTimeMs: Counter; totalTokens: Counter; costMicrousd: Counter;
    /** Calls without a provider price. Shown as a count, never folded into cost as zero. */
    unpricedCalls: number;
  };
  graph: {
    artifactId: string | null;
    nodeCount: number;
    edgeCount: number;
    truncated: boolean;
    byState: Record<GraphNodeState, number>;
  };
  evidence: { outboxState: OutboxState | null; evidenceReady: boolean; truncated: boolean };
  approval: {
    state: 'none' | 'pending' | 'approved' | 'declined' | 'expired' | 'consumed' | 'stale';
    proposalId: string | null;
    expiresAt: string | null;
  };
  receipt: { receiptId: string; sequence: number } | null;
  externalErasure: { status: ExternalErasureStatus; providerStatus: ProviderErasureStatus | null; dueBy: string | null } | null;
  cost: {
    modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number;
    costMicrousd: number; unpricedCalls: number; mongoOperations: number; wallTimeMs: number;
  };
  updatedAt: string;
}

export interface ExpungeJobListItem {
  jobId: string;
  kind: JobKind;
  status: JobStatus;
  sequence: number;
  subjectDisplay?: string;
  worldId?: string;
  harnessHash?: string;
  receiptDomainStatus?: 'complete_in_registered_scope' | 'incomplete';
  updatedAt: string;
}
export interface ExpungeJobList { items: ExpungeJobListItem[]; nextCursor: string | null }

// ---- ProjectionEvent payloads (sanitized, bounded). Kind -> payload. ----
export interface JobStartedPayload { jobKind: JobKind; harnessHash: string; worldId?: string; scopeRevision: number; attempt: number }
export interface ToolDecidedPayload {
  stepId: string; phase: JobPhase; toolId: ToolId; decision: PolicyResult; ruleIds: string[];
  /** fixed-vocabulary summary, at most 200 chars, no subject literals */
  summary: string; targetCount?: number;
}
export interface EffectCommittedPayload {
  receiptId: string; stepId: string; batchOrdinal: number; effectKind: EffectKind;
  collectionId: string; appliedCount: number; resultingWorldRevision: number;
  /** graph node ids touched, at most 100; full set in the graph artifact */
  nodeIds: string[];
}
export interface EvidenceReadyPayload {
  evidenceId: string; provider: string; externalEventId?: string; externalTraceId?: string;
  externalSignalIds: string[]; origin: SourceOrigin; outboxState: OutboxState;
  truncated: boolean; missing: string[]; contentHash: string;
  permittedUse: 'training' | 'gate_only' | 'display_only' | 'revoked';
}
export interface CandidateProposedPayload {
  candidateId: string; target: TargetKind; parentHash: string; childHash: string;
  claimedClass: MutationClass; computedClass: MutationClass; surfaces: string[];
  hypothesis: string; state: CandidateState;
}
export interface TrialCompletedPayload {
  reportId: string | null; candidateId: string; pairId: string; family: string;
  split: 'train' | 'protected' | 'validation' | 'final';
  parentUseful: boolean; candidateUseful: boolean; verdict: 'admit' | 'reject' | 'hold' | null;
}
export interface ApprovalRequiredPayload {
  proposalId: string; candidateId: string; computedClass: MutationClass;
  flipSetDigest: string; expiresAt: string;
}
export interface HarnessPromotedPayload {
  promotionId: string; target: TargetKind; fromHash: string; toHash: string;
  fromRevision: number; toRevision: number; gateReportId: string; consumedGrantId: string | null;
}
export interface ReceiptCommittedPayload {
  receiptId: string; domainStatus: 'complete_in_registered_scope' | 'incomplete';
  externalErasureStatus: ExternalErasureStatus; verifiedWorldRevision: number;
}
export interface ExternalErasureUpdatedPayload {
  requestKey: string; providerStatus: ProviderErasureStatus; dueBy: string | null;
  completedAt: string | null; subjectCount: number; snapshotHash: string;
}
export type JobFailureCode =
  | 'budget_exhausted' | 'lease_lost' | 'policy_denied' | 'verification_failed' | 'provider_error'
  | 'world_conflict' | 'internal_error';
export interface JobFailedPayload { code: JobFailureCode; retryable: boolean; phase: JobPhase | null; message: string }

// Additive kinds the UI needs because today's list has no committed signal for these states.
export interface JobStatusChangedPayload { from: JobStatus; to: JobStatus; reason: string }
export interface CancelRequestedPayload { requestedAt: string; by: 'owner' | 'system' }
export interface ApprovalResolvedPayload {
  proposalId: string; decision: 'approved' | 'declined' | 'expired' | 'stale'; grantId: string | null;
}
export interface HarnessRolledBackPayload {
  promotionId: string; target: TargetKind; fromHash: string; toHash: string; testedParentHash: string; reason: string;
}
export interface RetractionProgressPayload {
  retractionId: string; sourceId: string; frontierSize: number; visited: number;
  closureComplete: boolean; revoked: number; regenerated: number; runsCancelled: number;
  failClosed: boolean;
}
export interface CampaignRowPayload {
  campaignId: string; manifestHash: string; kind: 'hider' | 'meta';
  rowId: string; admitted?: boolean; w0ResetProof?: string; budgetHash?: string; result: 'measured' | 'null' | 'invalid';
}

export interface ProjectionPayloadByKind {
  job_started: JobStartedPayload;
  tool_decided: ToolDecidedPayload;
  effect_committed: EffectCommittedPayload;
  evidence_ready: EvidenceReadyPayload;
  candidate_proposed: CandidateProposedPayload;
  trial_completed: TrialCompletedPayload;
  approval_required: ApprovalRequiredPayload;
  harness_promoted: HarnessPromotedPayload;
  receipt_committed: ReceiptCommittedPayload;
  external_erasure_updated: ExternalErasureUpdatedPayload;
  job_failed: JobFailedPayload;
  job_status_changed: JobStatusChangedPayload;
  cancel_requested: CancelRequestedPayload;
  approval_resolved: ApprovalResolvedPayload;
  harness_rolled_back: HarnessRolledBackPayload;
  retraction_progress: RetractionProgressPayload;
  campaign_row_committed: CampaignRowPayload;
}
export type ProjectionKind = keyof ProjectionPayloadByKind;
export type TypedProjectionEvent = {
  [K in ProjectionKind]: {
    eventId: string; sequence: number; jobId: string; runId?: string; kind: K;
    artifactIds: string[]; payload: ProjectionPayloadByKind[K];
  };
}[ProjectionKind];

// ---- Artifacts by id: GET /api/expunge/artifacts/:artifactId ----
export type ArtifactKind =
  | 'completion_receipt' | 'action_receipt' | 'graph_page' | 'candidate' | 'gate_report' | 'trial_pair'
  | 'harness_bundle' | 'evidence_bundle' | 'approval_descriptor' | 'promotion_receipt'
  | 'external_erasure' | 'provenance_page' | 'retraction' | 'deployment';
export interface ArtifactEnvelope<T = unknown> {
  artifactId: string; kind: ArtifactKind; jobId: string | null;
  /** event sequence at which this artifact became visible; used to order against the log */
  committedAtSequence: number;
  /** content hash for immutable artifacts, null for mutable lifecycle records */
  contentHash: string | null;
  payload: T;
}

// ---- Proposal review and decision ----
export interface ApprovalDescriptorView {
  proposalId: string; grantId: string | null;
  state: 'pending' | 'approved' | 'declined' | 'expired' | 'consumed' | 'stale';
  target: TargetKind; parentHash: string; childHash: string; expectedParentRevision: number;
  computedClass: MutationClass; flipSet: Array<{ capability: string; change: 'added' | 'widened' | 'removed' | 'tightened' }>;
  flipSetDigest: string;
  scope: { scopeId: string; scopeRevision: number; authorizationRevision: number };
  gateReportId: string; gateReportDigest: string;
  approver: { actorId: string; display: string };
  expiresAt: string; consequences: string[];
  /** digest the client must echo; the server re-derives and compares */
  descriptorDigest: string;
}
export interface ApprovalDecisionRequest {
  decision: 'approve' | 'decline';
  descriptorDigest: string;
  toolCallId?: string;             // when the review was opened from the chat card
}                                  // strict: never carries executable arguments
export interface ApprovalDecisionResult {
  accepted: boolean;
  /** committed state after the call, re-read from the domain, not echoed from the request */
  state: ApprovalDescriptorView['state'];
  committedEventSequence: number | null;
}

export interface CancelJobRequest { reason?: string }
```

## 10. Test plan

Fast lane (vitest, `cd apps/operator && npm test`) and a browser lane (Playwright, which is already an operator dependency; Google Chrome is used locally because the pinned Playwright browser build is not installed and I do not download browsers). Claims follow the spec rule: automated tooling is an input, not WCAG compliance.

| Test | Proves |
|---|---|
| `expunge-reducer.test.ts` | Ordered apply, dedupe by eventId/sequence, gap detection, regress/restart handling, bounded buffer, terminal handling, no authority derived from narrative or client-only state. |
| `expunge-states.test.tsx` | Static markup matrix (`renderToStaticMarkup`) for every component x every applicable state from COMPONENT-STATES.md: labels present, icon `aria-hidden`, no `ex-seal` markup without a `source`, "Complete" never rendered without scope and revision, narrative always inside `NarrativeBlock` with its label. |
| `expunge-agent.test.ts` | `clone()` preserves trusted dependencies; finite event sequence; no model call; tool call emitted only when allowlisted and registered (three-way matrix); follow-up turn ignores tool-result payload; abort stops reads; job completion is independent of stream end. |
| `expunge-readiness.test.ts` | Four checks stay distinct (configured pass + reachable fail, reachable pass + authorized fail, authorized pass + evidence fail); missing names listed without values; fixture banner; no upstream body reflection. |
| `expunge-routes.test.ts` | Strict bodies reject tenant/actor/role/authorizationRevision fields; submit idempotent by `requestKey`; decision returns re-read state; 501/503 mapping; owner and origin boundary inherited; **D16 rewrite**: the browser-to-domain path is exercised through the real route and the real `HttpExpungeDomainService` with a recording transport (section 15.1). |
| `expunge-projection-schema.test.ts` | **K9**: every snapshot and event payload is parsed by a per-kind zod schema before forwarding; unknown fields stripped; malformed, oversized and unknown-kind payloads handled as in section 15.2; logging never throws and never prints payload values. |
| `expunge-css.test.ts` | Runs the real `darkTheme()` plugin over `expunge.css` and asserts R1 (scoped selectors), R2 (no hex/white/black literals; explicit dark block wins), R3 (no `prefers-color-scheme`), R4, and recomputes every token pair against DESIGN.md thresholds. |
| `expunge-safe-console.test.ts` | Lead exception F1 (section 11). |
| `expunge-contract-parity.test.ts` (root) | Unions in `src/shared/expunge.ts` equal `packages/contracts` (`JobKind`, `JobStatus`, `EffectKind`, `OutboxState`, `ProjectionEventKind` is a subset of `ProjectionKind`). |
| `expunge-browser.e2e.mjs` | Real navigation at 1440/1024/768/390 in light and dark; Setup-only readiness; keyboard walk; dialog open, contain, Escape, focus return, reload while open; reconnect after backend restart without re-running a job (fixture backend); reduced motion (`getAnimations()` empty); target size scan; focus-not-obscured scan; contrast scan of computed colors; no horizontal page overflow; performance budgets recorded. Screenshots saved under `docs/ui/`. |

Fixture backend: tests need a deterministic domain. `apps/operator/tests/fixtures/expunge-domain-fixture.ts` serves the internal projection routes with committed-looking data, answers `backend.kind: 'fixture'` and is the only place scripted states exist. It is never used for a live claim; any screenshot taken against it says so in its filename and caption. Real-domain journeys (cleanup, approval, rejection, privacy, reconnect after restart) are rerun against the worker when it exists.

## 11. Lead exception items

**F1 (defense in depth, approved as a frozen-file exception).** `src/server/expunge/safe-console.ts` patches `console.error/warn/info/log`: when the original call throws and an argument is an `Error`, it retries once with each `Error` replaced by `${name}: ${message}`; non-Error arguments are never changed or dropped, successful output is unchanged, and if no argument is an `Error` (or the retry also throws) the original error is rethrown, so nothing is swallowed. `platform.ts` gets exactly one side-effect import at the top, with a comment citing nodejs/node#60717. Covered by `expunge-safe-console.test.ts` using a real v3-shaped `ZodError` under the affected Node. Result recorded in the U-0 report. (Implemented in the U-0 follow-up, not left for B3.)

**F2 (toolchain).** `apps/operator/package.json` engines and `.nvmrc` match the root when B3 touches the package (table row 7).

## 12. Slices and order (each slice ends with a browser check and screenshots)

| Slice | Content | Depends on |
|---|---|---|
| S1 | Shared types, `readiness.ts`, `/api/expunge/readiness`, `ReadinessView`, route shell and `App.tsx` hash route, skip link and landmarks, setup-only screen that says it is setup-only | none (works without a backend) |
| S2 | Projection client (reducer, hook, backoff, buffer), `JobsHome`, `WorkbenchView` header with phase stepper, limits, coverage, `ConnectionBanner`, snapshot V2 reads | domain snapshot V2 or fixture |
| S3 | `NewCleanupView` (worlds, exact subject, preview), submit, cancel, `ReferenceTable`, `RecordInspector` | previews/jobs routes or fixture |
| S4 | `ReferenceTrace` graph (lazy) and `DecisionLog` | S2, S3 |
| S5 | Evidence (outbox ladder, Raindrop IDs) and `ReceiptDocument` | evidence and receipt events |
| S6 | `ExpungeProjectionAgent`, review tool, `ApprovalDialog`, Candidate and Evaluation views | worker and gate artifacts |
| S7 | Lineage/rollback, Hider/meta campaigns, Privacy | deployment reads, campaign and retraction events |
| S8 | Approved shell CSS fixes with before/after ratios, full accessibility pass, performance budget record | all |

### 12.1 Three-minute demonstration mapping (`ACCEPTANCE.md`)

| Time | Screen | Data it must show (never scripted) |
|---|---|---|
| 0:00-0:25 | Live workbench (baseline job) | Real or labeled-replay job; narrative block beside committed status; surviving reference and protected records in the trace; replay labeled if used |
| 0:25-0:50 | Evidence | Raindrop event and trace IDs, origin chips, outbox ladder to `evidence_ready`, truncated/missing state |
| 0:50-1:30 | Candidate + Evaluation | Harness diff with computed class, paired rows, the rejected unsafe candidate with reason codes, declared coverage |
| 1:30-1:55 | Approval + Lineage | Stored descriptor and flip set, consumed grant, promotion receipt, parent/child hashes, no client-only badge |
| 1:55-2:30 | Live workbench + Receipt | New subject and layout, same model, committed completion receipt with scope and revision |
| 2:30-3:00 | Evaluation table + Campaigns | Frozen table with expert-static and control rows, total cost, Hider result, measured or null meta result |

## 13. Upstream files needing a lead-approved change (status after the lead's 2026-10-11 decisions)

| File | Reason (one line) | Status |
|---|---|---|
| `src/server/platform.ts` L89-L104 | Register `ExpungeProjectionAgent` behind a dedicated Dot because `runtime-scope.ts` L66 admits only Dot agent ids | approved |
| `src/server/platform.ts` top | Side-effect import of `safe-console` for the Node `util.inspect` regression (F1) | approved (exception) |
| `src/server/index.ts`, `src/server/app.ts` | Inject domain service and server-only write principals | approved |
| `src/client/App.tsx` | Hash route, HITL registration inside the provider, nav/default view, titles, skip link, landmark, unlock branding | approved |
| `index.html` | Title and description still say OpenDots template | approved |
| `src/client/style.css`, `src/client/editor.css` | Measured AA contrast failures and the dark-only border (rows in DESIGN.md 3.1) | approved (limited) |
| `apps/operator/package.json`, `.nvmrc` | Node floor to match the root (F2) | approved |
| `src/client/Chat.tsx` | Visibility filter L231-L243 only if the same-message text approach fails | not approved; ask first |
| `src/server/dot-agent.ts` | Allowlist L278-L284 and L372-L377 only for a normal Dot surfacing the card | frozen; not needed |

## 14. Risks and open questions for the lead

1. **Sequence contiguity.** Gap detection needs contiguous per-job sequences. If the backend cannot guarantee it, the UI compares `snapshot.sequence` against the last applied sequence after each catch-up and re-fetches on mismatch (slower, still correct).
2. **Thread to job binding.** Plan: the domain holds the correlation (`readJobByThread`). Alternative: a small SQLite table in the operator, rejected because the operator would then own Expunge state.
3. **Preview before submit.** Spec asks the user to inspect scope and eligibility and preview effects before a job. If the backend has no pre-submit preview, the screen shows registry-derived scope and eligibility policy and states that effect preview happens in the job's preview phase (the route returns 501 and the UI says so; no fabricated preview).
4. **Write principals.** Three server-only principals (read, submit/cancel, approval) need names and backend support; until then submit/cancel/decision render `unavailable` with the exact missing configuration names.
5. **Chat requires Intelligence.** No provider key means no conversation; the review dialog and workbench carry the approval flow regardless.
6. **Font.** Default none (system stacks); one OFL face only if fallback review fails.
7. **Static asset compression.** The shell serves 2.7 MB of uncompressed JS (measured). Adding compression is an upstream server change and is not proposed here; the lazy chunk budgets stay small instead.

## 15. DA-1 review items folded into B3 (docs/review/DA-1-foundation.md)

### 15.1 D16: the "forged tenant/role" test proves nothing today

Defect (`apps/operator/tests/expunge-foundation.test.ts` around L79): the case runs against an inline fake `ExpungeDomainService` whose methods receive only `(jobId, afterSequence)`, so a query parameter such as `?tenantId=forged&role=promoter` can never reach it; the assertion that "the server binding wins" cannot fail. Rewrite in S1, in my owned test file, so that it can fail:

1. Build the app with the **real** `HttpExpungeDomainService` (fixed origin, token and owner ID) and an injected `transport` that **records** every upstream call: method, full URL including query string, and all headers.
2. Send browser requests through the real route (`app.request`) with hostile input: query `?tenantId=forged&role=promoter&actorId=x&scopeId=other&authorizationRevision=99`, headers `x-expunge-owner-id: forged`, `x-tenant-id: forged`, a different `Authorization`, and for POST routes a body carrying the same forged fields.
3. Assert on the recorded upstream request: path exactly `/internal/projection/jobs/<id>[/events]`; query string contains only `afterSequence` (and `limit` where defined); headers contain exactly the server-configured `Authorization: Bearer <configured service token>`, `x-expunge-owner-id: <configured owner>`, `Accept`; no `x-tenant-id` or any client-supplied header value appears anywhere; the browser's owner token is not forwarded upstream.
4. For POST routes, assert forged body fields cause a 400 (strict schema) and that no upstream call was made; for valid bodies assert the upstream body equals the validated fields only.
5. Mutation check inside the test: temporarily forward the query string in a copy of the service and assert the test fails (kept as a documented negative control, not shipped), so the test is shown able to fail.

### 15.2 K9: projection payloads must be validated before reaching the browser

Defect (`domain-service.ts` L67): `payload: z.record(z.string(), z.unknown())` forwards any JSON the backend (or a compromised backend) sends, including raw subject content or grader fields. Plan, applied to every route in section 3.1:

- **Per-kind schemas** in `src/server/expunge/schemas.ts` for every kind in `ProjectionPayloadByKind` (section 9) and for `ExpungeJobSnapshotV2`, `ExpungeJobList`, `ArtifactEnvelope` payloads, `ApprovalDescriptorView`, `WorldSummary`, `CleanupPreview` and `ExpungeReadiness`. Object schemas use zod's default behavior of **stripping unknown fields**, so a payload carrying `manifest`, `expectedPostState`, `seed`, `subjectLiteral` or any other unlisted key reaches the browser without it.
- **Bounds** in the schemas: every string has a maximum length (IDs 128, summary 200, hypothesis 500, message 300, hashes exactly 64 hex), arrays have maximum counts (artifact IDs 100, node IDs 100, flip set 50), numbers are finite integers where required, ISO timestamps use `z.iso.datetime()`. Serialized limits: event payload 16 KB, snapshot 256 KB, page 500 events and 1 MB (the existing transport bound stays the outer limit).
- **Reject, do not repair.** An event page containing any invalid event fails closed with HTTP 502 `bad_response` for the whole page (dropping one event would fabricate a sequence gap), as do an invalid snapshot, an oversized payload, or a job/sequence binding mismatch (already enforced). An unknown event **kind** is accepted as `unknown_kind` with its payload reduced to `{}` so a newer backend cannot crash an older operator, and it is counted and shown generically.
- **Logging cannot throw and cannot leak.** A `logRejection({route, jobId?, sequence?, kind?, issues})` helper logs only issue paths and codes plus the route, job and sequence, never payload values, inside a `try/catch` that swallows logging failures, and never passes a `ZodError` or any Error with accessor properties to `console` (Node `util.inspect` regression, section 1). It is exercised under the safe-console wrapper as well as without it.
- **Tests** (`expunge-projection-schema.test.ts`): extra fields stripped for every kind (forbidden-key canaries `manifest`, `seed`, `expectedPostState`, `subjectLiteral`, `grader`); wrong types rejected; oversized string, array and serialized payload rejected; one bad event in a page rejects the page; unknown kind accepted with empty payload; the rejection is logged exactly once without the offending value; a logger that throws does not change the response; the browser-facing JSON equals the schema's parsed output (no pass-through of the raw upstream body).
- **Both ends:** the backend (mongodb-authority, `ProjectionRepository.append`) must validate the same per-kind shapes at write time once the lead freezes them; the operator never relies on that and validates anyway.
