# Expunge experiences: data and states

Owner: ui-ux-improver. Companion to `DESIGN.md` (visuals) and `docs/ui/B3-PLAN.md` (routes and TypeScript shapes; type names such as `ExpungeJobSnapshotV2` and `ProjectionPayloadByKind` are defined there). Contract names are from `docs/expunge/CONTRACTS.md` and `packages/contracts/src/index.ts`.

Rule for every row below: a state is rendered from data the server returned or from a transport condition the client observed, and says which. Nothing is rendered as success, complete, approved or promoted from a client action alone. Where today's contracts cannot carry a state, the row says so and names the additive event or field requested in B3-PLAN section 9.

## 1. State vocabulary (applies to every region unless a table overrides it)

| State | Defined as | How it looks | Announcement | Recovery |
|---|---|---|---|---|
| loading | First request for the region is in flight and nothing is cached | Static skeleton (no shimmer under reduced motion), `aria-busy="true"` on the region, visible text "Loading <noun>"; skeleton appears only after 300 ms to avoid flashes | none (busy attribute only) | wait; Cancel for navigations |
| empty | Request succeeded and returned zero items | `EmptyState`: one sentence on what is empty and why, one next action; never a zero-filled metric | none | the stated next action |
| error | Request reached the server but failed with a non-transport error, or a response failed validation | `ErrorState`: what failed, whether the data shown is older than the failure, Retry; no raw upstream body | polite status "Could not load <noun>" | Retry |
| disconnected | Transport failing for 5 or more consecutive attempts, or `navigator.onLine` is false | `ConnectionBanner` at top of the view (`wifi-off`, "Disconnected"), last data stays readable with "Updated hh:mm:ss"; mutating controls removed or labeled | polite, once per transition | automatic retry at 30 s cap; Retry now |
| retrying | Transport failing, fewer than 5 attempts, backoff pending | dashed `retrying` chip with attempt number and next try; data stays visible | none (avoid chatter) | automatic |
| waiting-evidence | The thing depends on remote evidence not yet at `evidence_ready` (`Job.status=waiting_evidence`, outbox below `evidence_ready`) | dashed `waiting-evidence` chip plus the outbox ladder; never interpreted as "no failure" | polite on entering and leaving | wait; none needed |
| waiting-approval | `Job.status=waiting_approval` or `approval.state=pending` | warning `waiting-approval` chip "Needs your decision" with Review; note that the job released its lease and waits | polite on entering; approval dialog is the action | Review |
| stale | Data older than allowed, or superseded: expired grant, changed parent revision, candidate `stale`, projection reset | dashed `stale` chip "Out of date" with reason and age; action controls removed (not just disabled) | polite on entering | Refresh |
| rejected | An explicit committed rejection: `Candidate.state` in `schema_rejected`/`replay_rejected`/`behavior_rejected`, `GateReport.verdict=reject`, policy `deny`, approval declined, provider `rejected` | outline `rejected` chip with reason codes; raw rows stay visible | polite on entering | none or "Propose again" where the contract allows |
| cancelled | `Job.status=cancelled` (committed). Before that, "cancellation requested" is `PendingAcknowledgement` | neutral `cancelled` chip with strike label; effects already committed remain listed | polite on entering | none |
| unavailable | Domain not configured (503), unreachable, 501 (backend lacks the feature), or the projection does not provide the resource yet | `unavailable` chip with the exact reason and the configuration **names** to fix; never a fake empty state | polite once | fix configuration; Re-check |

Global transport and freshness behavior (reconnect, backoff, regress handling) is specified in B3-PLAN section 6. In **setup-only mode** (no domain configured, no provider key) only Setup/readiness is live; every other experience renders `unavailable` with "Expunge domain service is not configured" and the names `EXPUNGE_DOMAIN_URL`, `EXPUNGE_INTERNAL_TOKEN`; the chat is unavailable because no conversation can be created without CopilotKit Intelligence and a model key, and the UI says exactly that.

## 2. Routes

Hash routes (deep-linkable, survive reload): `#/expunge` (jobs home), `#/expunge/setup`, `#/expunge/new`, `#/expunge/jobs/<jobId>` with tabs `workbench` (default), `evidence`, `candidate`, `evaluation`, `receipt`, `#/expunge/lineage/<target>`, `#/expunge/campaigns/<jobId>`, `#/expunge/privacy/<jobId>`. Retraction, Hider and meta campaigns are jobs (`redact`, `external_delete`, `adversarial_generate`, `meta_evaluate`), so every screen is a projection of one job stream; Lineage reads `Deployment` and `PromotionReceipt` records by target.

## 3. Jobs home (landing; not a dashboard)

Reads: `GET /api/expunge/jobs` (`ExpungeJobList`). Shows a table (job, kind, subject display, world, status chip, receipt domain verdict chip, updated) and one primary action, New cleanup. No tiles, no aggregate percentages.

| State | Rendering |
|---|---|
| loading | Skeleton rows; New cleanup already usable if readiness passed |
| empty | "No cleanup jobs yet. Choose an authorized world and an exact subject to start." plus New cleanup |
| error | ErrorState with Retry; New cleanup stays available |
| disconnected | Banner; last list kept with timestamp |
| retrying | Dashed retrying chip in the table caption |
| waiting-evidence | Rows with `waiting_evidence` carry the dashed chip; filter chip "Waiting for evidence" |
| waiting-approval | Rows with `waiting_approval` sort first with the warning chip and a Review link |
| stale | Caption "List older than 60 s" with Refresh |
| rejected | Not a list state; a row whose job `failed` shows `failed`, and rejected candidates appear in Candidate views |
| cancelled | Rows with `cancelled` show the strike chip |
| unavailable | `unavailable` chip and configuration names; New cleanup disabled with the reason |

## 4. Experiences

### 4.1 Setup and readiness

Purpose: distinguish configured, reachable, authorized and evidence-ready, with actionable missing configuration. A configured URL is never shown as connectivity.

Reads: `GET /api/expunge/readiness` (`ExpungeReadiness`: four `ReadinessCheck`s, `backend.kind`, `ready`); `GET /api/expunge/status` (existing, configuration only); `GET /api/expunge/worlds` (`WorldSummary[]`, from `ScopeRegistry` and `WorldRevision`). Layout: four rows with status chip, reason, "missing configuration" names (never values), observed-at time, and a Re-check button; below, the authorized worlds table (collections, fields, reference edges, allowed effects, eligibility policy hash, document limits, discovery completeness).

| State | Rendering |
|---|---|
| loading | Four rows "Checking..." with no pass or fail glyph; worlds skeleton |
| empty | Readiness always returns four checks. Worlds empty: "No world is authorized for this owner. The backend maps the owner to scopes; ask the operator of the domain service." (not a pass) |
| error | The readiness probe itself failed (operator error): "Readiness could not be read" with Retry; no row shows pass |
| disconnected | Banner "This browser cannot reach the operator"; last results kept with "Checked hh:mm:ss" |
| retrying | Dashed chip on the probe with attempt count |
| waiting-evidence | `evidenceReady` is `unknown` or `evidence_never_proven`: dashed chip "Evidence path not yet proven". Text: cleanup can run; improvement proposals wait for evidence. Never rendered as pass |
| waiting-approval | Not applicable: readiness has no human decision; stated in the empty region so it is not silently missing |
| stale | Last probe older than 60 s: chip "Checked 3 min ago" with Re-check; `ready` is shown as unknown rather than pass |
| rejected | `authorized` failed with `unauthorized` or `forbidden`: outline `rejected` chip "The domain service rejected this operator's credentials"; `scope_unbound`: "Owner is not bound to a scope" |
| cancelled | Not applicable: no cancellable action |
| unavailable | `configured` failed: the exact variable names that are missing or malformed (`EXPUNGE_DOMAIN_URL`, `EXPUNGE_INTERNAL_TOKEN`, plus the write-principal names the lead sets); `reachable` failed: the reason code in words; downstream checks show `unknown` (not pass, not fail) |

Setup-only mode: shows `configured` fail, the other three `unknown`, and the sentence "Setup-only: no domain service and no model provider are configured, so no cleanup can run and no conversation is possible." A fixture backend adds the persistent banner "Fixture backend: test data, not a live job".

### 4.2 New cleanup

Purpose: choose an authorized world and an exact subject, inspect scope and eligibility, preview effects, then submit once.

Reads: `WorldSummary[]` (as above); `POST /api/expunge/previews` returns `CleanupPreview` (masked subject, per-collection exact-identity matches, eligible effects, retained, not-inspected, limitations, expiry); `POST /api/expunge/jobs` returns the new job ID. Form: fieldset "World" (radio list of authorized worlds), fieldset "Subject" (identifier type select plus value; exact identity only; the literal subject is not echoed back, only a masked display and an identity hash), "Preview" action, and a summary of scope, eligibility policy hash and limits. The submit control appears only after a preview whose world and scope revision still match.

| State | Rendering |
|---|---|
| loading | World list skeleton; during preview "Resolving exact identity..." with Cancel |
| empty | No worlds: explained as in 4.1, form disabled with reason. No preview matches: "No record has this exact identity in the registered scope. Nothing would change." (a legitimate outcome, not an error) |
| error | Field-level errors linked by `aria-describedby` and an error summary with focus on submit; server-side validation text is fixed vocabulary |
| disconnected | Banner; form values kept; submit removed until reconnect; `requestKey` kept in `sessionStorage` |
| retrying | Preview/submit retry shown as dashed chip; the same `requestKey` is reused so a retry cannot create a second job |
| waiting-evidence | Informational: "Improvement proposals will wait for evidence" when `evidenceReady` is not pass; does not block cleanup |
| waiting-approval | Preview reports a policy `ask` for an effect: warning chip "This cleanup will need approval before applying" with the effect kinds; submit still allowed |
| stale | Preview older than its expiry or world/scope revision changed (`maintenanceMode`, revision bump): `stale` chip, Submit removed, "Preview again" shown |
| rejected | Policy `deny` for the subject or collection, or backend rejection: outline `rejected` chip with reason codes; nothing submitted |
| cancelled | User cancels preview: form returns to its last state; no job exists. After submit, cancellation is a job matter (4.3) |
| unavailable | Domain/preview unavailable: reason and names; 501 from a backend without previews: "Effect previews happen inside the job's preview phase; scope and eligibility policy are shown here." |

### 4.3 Live workbench

Purpose: follow a durable job without owning it: current phase, reference trace with table equivalent, mixed-record detail, decisions, limits, explicit coverage, cancel.

Reads: `ExpungeJobSnapshotV2` (phase, `phaseStates`, coverage, limits, graph summary, approval, receipt, evidence, cost); events `tool_decided`, `effect_committed`, `job_status_changed`, `cancel_requested`, `job_failed`; artifacts `graph_page`, `action_receipt` by ID; contract types `Job`, `PolicyDecision`, `ActionReceipt`, `AppliedEffect`, `ResourceLimits`, `CostSummary`, `ScopeRegistry.discoveryCompleteness`. A closed tab, a finished chat turn, or lost transport never changes the job; Cancel sets `cancellationRequested` through an explicit POST and is confirmed only by a committed event.

| State | Rendering |
|---|---|
| loading | Header skeleton, stepper with seven pending nodes (no progress implied), trace placeholder "Loading reference graph" |
| empty | Job exists but nothing is discovered yet: stepper at `inspect`, trace says "No references discovered yet" with coverage "0 of N registered collections inspected" |
| error | Snapshot failed validation or the server errored: ErrorState; the last good snapshot stays visible and labeled as older |
| disconnected | Banner; the sentence "The job keeps running on the server; this view is not connected" is always shown here |
| retrying | Dashed chip with attempt; sequence of last applied event shown |
| waiting-evidence | Stepper holds; chip "Waiting for evidence" with the outbox ladder from the Evidence tab inline; the job's lease note: released |
| waiting-approval | Warning chip and Review button opening `ApprovalDialog`; stepper holds at the gated step; lease released |
| stale | Projection reset or snapshot older than 3 poll intervals: `stale` chip, "Updated hh:mm:ss", Refresh; reconnect rules in B3-PLAN section 6 |
| rejected | A step was denied by policy (`tool_decided` with `deny`): the decision row shows `rejected` with rule IDs; the job may continue or fail per its own committed status |
| cancelled | "Cancellation requested" is `PendingAcknowledgement` until `job_status_changed` to `cancelled` arrives; then committed `cancelled` chip, and the list of effects that did commit before cancellation stays visible with their receipts |
| unavailable | Domain 503/404 for this job: "This job is not available from the projection" with the reason; navigation back to Jobs |

Plus workbench-specific facts: committed `failed` shows `job_failed` code, phase and retryable flag; `succeeded` shows the job-finished chip next to the receipt verdict chip (two separate chips, see 4.8); coverage statement and limits strip are always present; a registered-but-uninspected collection is listed by name.

### 4.4 Evidence

Reads: events `evidence_ready`; artifacts `evidence_bundle` (`EvidenceBundle`, sanitized: tools, failure witnesses for the training split, diagnostics, sources, cost, confidence, split) and its `EvidenceReference[]` (provider, `externalEventId`, `externalTraceId`, `externalSignalIds`, `origin`, `redactionPolicy`, `retrievedAt`, `contentHash`, `permittedUse`); outbox progression from `TelemetryOutbox.attained` (`pending, leased, sdk_enqueued, ingest_accepted, query_visible, evidence_ready, retrying, dead_letter`) projected into `evidence.outboxState` and event payloads. Origin labels are the application labels from CONTRACTS, shown as words and never replaced by vendor strings.

| State | Rendering |
|---|---|
| loading | Skeleton cards; ladder with all steps unattained |
| empty | "No evidence has been committed for this job yet." If the job is `succeeded`, say that no failure evidence is a statement about the record, not proof of no failure |
| error | ErrorState; no partial evidence presented as complete |
| disconnected | Banner; attained ladder steps retained with their times |
| retrying | Ladder step `retrying` with attempt count from the outbox (distinct from the transport retrying chip) |
| waiting-evidence | The primary state of this tab: ladder shows attained steps with times; `query_visible` is explicitly short of `evidence_ready` ("readable, but required signals/spans/content not all present"); a proposal that needs remote evidence is shown waiting |
| waiting-approval | Not applicable to evidence itself; if the job is `waiting_approval` the tab header shows the job chip |
| stale | Evidence `permittedUse=revoked` or retracted source: `stale`/revoked chip, content not shown, link to Privacy |
| rejected | Evidence not admitted (`permittedUse=display_only` for a gate that needs training use): outline chip with reason |
| cancelled | Job cancelled: evidence already committed stays; chip on the header; no new items expected |
| unavailable | Raindrop/observer not configured or `dead_letter`: `unavailable` chip with `evidence_unconfigured` or `evidence_dead_letter` and what to fix. Truncated: "Trace may be truncated (maximum rows returned); no claim that all spans were inspected" |

Each item shows: Raindrop event ID and trace ID as `HashChip` with deep link, signal IDs, origin chip, redaction policy, retrieved-at, content hash, permitted use. Missing required signal/span/content fields are listed by name.

### 4.5 Candidate

Reads: events `candidate_proposed`; artifacts `candidate` (`Candidate`: target, parentHash, childHash, `TypedPatch[]` with surface/path/before/after/hypothesis/source evidence IDs, `claimedClass`, `computedClass`, `state`), `harness_bundle` for parent and child (`HarnessBundle`); compiler and replay results as the `schema_rejected` / `replay_rejected` states with reason codes. Two classes always appear as separate chips: **claimed** (advisory, from the proposer) and **computed** (authoritative, from the trusted gate); the computed class is never edited, defaulted or hidden.

| State | Rendering |
|---|---|
| loading | Diff skeleton |
| empty | "No candidate has been proposed for this job." (an honest state for a job that never triggered improvement) |
| error | ErrorState; the diff is never shown half-rendered |
| disconnected | Banner; diff stays (immutable artifact) |
| retrying | Dashed chip |
| waiting-evidence | Candidate waiting on remote evidence: dashed chip and link to Evidence |
| waiting-approval | `Candidate.state=waiting_approval`: warning chip and Review (opens the same dialog as 4.7) |
| stale | `Candidate.state=stale` (parent moved): `stale` chip "Parent changed since testing", tested parent hash vs active hash shown, no Approve |
| rejected | `schema_rejected`, `replay_rejected` or `behavior_rejected`: outline chip with reason codes; the diff, hypothesis and evidence stay readable; replay is labeled "decision replay, diagnostic only" |
| cancelled | The producing job was cancelled: chip on the header; candidate artifact (immutable) still shown |
| unavailable | Artifact not provided yet: `unavailable` with the artifact ID |

Diff: grouped by surface (context, workflow, guardrails, tool policy, plugin), each patch with hypothesis and evidence links; unchanged items collapsed; authority-affecting items marked in the computed-class chip's expanded list (the flip set).

### 4.6 Evaluation

Reads: `GateReport` (candidate/parent, evaluator, fixture-generator, runtime and worker-profile hashes, split manifest commitment, `pairedTrials`, `trialRowsDigest`, `causalControls`, `knownAuthorityFlips`, `cost`, `verdict`, `reasonCodes`); `TrialPair` rows with `TrialMetrics` (usefulCompletion, targetedResiduals, unrelatedRecordChanges, retentionViolations, truthfulTerminal, refused, retryFailures, cost); events `trial_completed`. Table groups: trigger, protected, validation, final (frozen). Columns show parent and candidate side by side with signed deltas as text; refusals, failures and timeouts are explicit columns; controls (score-only, wrong-incident, expert-static) are rows in the same schema and budget; totals include unpriced-call counts.

| State | Rendering |
|---|---|
| loading | Table skeleton with column headers |
| empty | "No trials have completed." If the gate is running, the count of expected vs completed pairs (text, with denominators) |
| error | ErrorState; no totals computed from partial rows |
| disconnected | Banner; completed rows stay |
| retrying | Dashed chip; a retried trial keeps its row history (never erased) |
| waiting-evidence | Gate waiting on evidence: dashed chip |
| waiting-approval | `verdict=admit` with authority flips: warning chip "Admitted; needs approval before promotion" linking to 4.7 |
| stale | Report pinned to a parent that is no longer active: `stale` chip, rows kept |
| rejected | `verdict=reject`: outline chip, reason codes, **raw rows still shown**, expert-static and control rows beside them; a candidate that lost is never hidden |
| cancelled | Evaluation job cancelled: completed pairs shown, remainder labeled "not run (cancelled)" |
| unavailable | Report not projected: `unavailable`; no placeholder averages |

Never shown: any hidden manifest, answer or private seed; hidden-grader outcomes appear only as the grader's verdict rows labeled with the fixed evaluator hash.

### 4.7 Approval

Reads: `GET /api/expunge/proposals/:id` (`ApprovalDescriptorView`: state, target, parent/child hashes, expected parent revision, computed class, flip set and digest, scope and revisions, gate report ID and digest, approver, expiry, consequences, descriptor digest) derived from the stored `ApprovalGrant.approvedDescriptor`; event `approval_required`, `approval_resolved`, `harness_promoted`. The dialog posts `{decision, descriptorDigest, toolCallId?}` only. Pattern: W3C WAI-ARIA Authoring Practices, Modal Dialog (<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>, fetched 2026-10-11).

Dialog contract (also DESIGN.md 9.3): `role="dialog"`, `aria-modal="true"`, `aria-labelledby` to the visible title, no `aria-describedby` (structured content); initial focus on the title element (`tabindex="-1"`), with "Decline" first in the Tab order after content and "Approve" last and never default; focus contained (Tab and Shift+Tab wrap), page behind `inert`; Escape closes without a decision; on close, focus returns to the invoking Review button or the chat card's Open review button, with fallback to the nearest approval `h2` if the invoker was re-rendered; the dialog has a visible Close/Decline control.

| State | Rendering |
|---|---|
| loading | Dialog opens with title and "Loading the stored review..."; Approve not present until the descriptor loads and its digest is known |
| empty | Proposal not found: "This review no longer exists." (404) with Close; no actions |
| error | Descriptor failed to load or validate: ErrorState inside the dialog, Retry and Close; Approve absent |
| disconnected | Banner inside the dialog; Approve removed while disconnected (a decision made while unsure of state is not offered) |
| retrying | After Approve/Decline was posted and the response was lost: `PendingAcknowledgement` "Submitted, waiting for the database to confirm"; the dialog re-reads the stored state with the same decision key; never offers a second blind submit |
| waiting-evidence | Descriptor present but gate evidence incomplete: Approve removed, chip explains what is awaited |
| waiting-approval | The normal state: full descriptor with flip set, consequences, absolute expiry and a low-frequency "expires in" text; Decline, then Approve |
| stale | Expired (`expiresAt` passed) or parent revision/authorization revision changed: Approve **removed**, reason shown, "Refresh" and "Close"; chat card shows "Review expired" |
| rejected | Declined (committed): shows who and when from the committed record; Approve absent; if the user declines here, `PendingAcknowledgement` until `approval_resolved` |
| cancelled | Proposal withdrawn because the candidate was revoked or the job cancelled: "This review was withdrawn" with Close |
| unavailable | Backend or write principal unavailable: dialog shows the descriptor read-only and says decisions are unavailable with the missing configuration name |

After an Approve, the card and dialog show `PendingAcknowledgement` until `harness_promoted` (or `approval_resolved`) arrives; a consumed grant restores as "Approved and promoted at revision R" on reload.

### 4.8 Receipt

Reads: artifact `completion_receipt` (`CompletionReceipt`: receiptId, jobId, runId, harnessHash, scopeId, scopeRevision, verifiedWorldRevision, verificationPlanHash, inspectedCollectionIds, discoveredFieldIds, operationalResiduals, excludedOrRetainedRecords, limitations, `domainStatus`, `externalErasureStatus`); `ExternalErasureJob` for the erasure ladder; `ActionReceipt[]` summary; `CostSummary`; event `receipt_committed`; for the narrative comparison the model's terminal narrative artifact. Rendered by `ReceiptDocument` (DESIGN.md 9.2). The headline words depend only on `domainStatus`; "complete" always includes "in registered scope, as of world revision N, scope revision M".

| State | Rendering |
|---|---|
| loading | Document skeleton with fixed headings (no values) |
| empty | No receipt yet: "No completion receipt has been committed. The job is <status>." plus the reason when failed or cancelled; never a placeholder receipt |
| error | ErrorState; receipt never shown from a failed parse |
| disconnected | Banner; a committed receipt remains (immutable) |
| retrying | Dashed chip |
| waiting-evidence | Not a receipt state; if the job waits, the empty explanation says so |
| waiting-approval | Not a receipt state; same |
| stale | A newer receipt or world revision supersedes: `stale` chip "Superseded by receipt R2" with link; the older receipt stays readable |
| rejected | `domainStatus=incomplete`: warning headline "Incomplete in registered scope", residuals and limitations first; not styled as success |
| cancelled | Job cancelled: no receipt unless one committed before; the chip says so |
| unavailable | Artifact missing from projection: `unavailable` with receipt ID |

External erasure ladder (inside the receipt): `not_required`; `pending` with provider deadline `dueBy` as an absolute date and "Provider has acknowledged; deletion is not complete"; `confirmed` only when the job-level provider status is `completed`; `failed` with the provider status. A revoked pending entry reads as cancellation, never as completion; a cancellation request is not displayed as a purge.

### 4.9 Lineage and rollback

Reads: `GET /api/expunge/deployments/:target` (`Deployment`: activeHash, revision, scopeRevision, authorizationRevision; `PromotionReceipt[]` chain: from/to hash and revision, gate report ID and digest, consumed grant, runtime and evaluator hashes, reason); `Candidate` parent/child; `HarnessBundle.parentHash` chain; events `harness_promoted`, `harness_rolled_back` (additive); rollback is a job of kind `rollback` with its own receipt.

| State | Rendering |
|---|---|
| loading | Graph and list skeletons |
| empty | "No promotions have been committed for this target. The active harness is the initial bundle <hash>." |
| error | ErrorState; no partial chain |
| disconnected | Banner; chain kept |
| retrying | Dashed chip |
| waiting-evidence | Promotion pending evidence: node with dashed chip |
| waiting-approval | Candidate node `waiting_approval` with Review link |
| stale | A candidate whose tested parent is not the active hash: `stale` node with both hashes; races shown as "lost promotion race" only if the committed record says so |
| rejected | Rejected candidates appear as off-chain nodes with reason codes, never as versions |
| cancelled | Rollback job cancelled: the chain is unchanged; the node says so |
| unavailable | Deployments route absent: `unavailable` |

Version graph with a text list alternative (same data): each version shows hash, parent hash, **tested parent** marker, promotion receipt and gate report links, authority class, and rollback receipts as labeled edges. The active version is the one `Deployment.activeHash` names; no client-side "current" badge.

### 4.10 Hider and meta campaigns

Reads: job kinds `adversarial_generate` and `meta_evaluate`; artifacts `trial_pair`, `AdversaryTrial` (specHash, referenceSolverHash, admitted, reason codes, noveltyFamily, resource bounds, worker run, metrics) and `MetaTrial` (incident, W0/improver hashes, resulting workers, `improvementBudgetHash`, `futureTrials`, `noiseControl`); events `campaign_row_committed` (additive) carrying manifest hash, W0 reset proof and budget hash. The screen shows validity and novelty families, the W0 reset proof (same base hash for I0 and I1), equal budgets (identical budget hash), the I0/I0 noise control and no-data control, and the measured result or an explicit null/invalid result. Hider proposals that were quarantined stay listed with reasons. No placeholder gains and no unmeasured percentages.

| State | Rendering |
|---|---|
| loading | Table skeletons |
| empty | "No campaign rows have been committed. Planned configuration (not results): <manifest hash>, <planned counts>." Planned counts are labeled planned |
| error | ErrorState |
| disconnected | Banner |
| retrying | Dashed chip |
| waiting-evidence | Rows waiting on evidence marked; totals show completed vs planned with denominators |
| waiting-approval | Not applicable unless a promotion is involved; then link to 4.7 |
| stale | Campaign manifest changed after freeze: `stale`/invalidated chip "New campaign hash; earlier results are not comparable" |
| rejected | Hider spec not admitted (reference solver failed): outline chip with reason; reward not shown |
| cancelled | Cancelled campaign: completed rows kept, remainder "not run" |
| unavailable | Campaign artifacts not provided: `unavailable` |

### 4.11 Privacy

Reads: `ProvenanceEdge` (`derived_from`, `source_deleted`), `ArtifactEligibility` (permitted, revoked, source_deleted; reason; sources), `retraction_progress` events (additive: frontier size, visited, closure completeness, revoked, regenerated, runs cancelled, fail-closed), `ExternalErasureJob` (providerStatus lifecycle, `dueBy`, history with snapshot hashes, `localExportSuppression`), `TelemetryOutbox` suppression. Views: source derivation graph (with the same text/table alternative as the reference trace), retraction progress as a labeled list (not a ring), provider deletion lifecycle as a ladder (`unsubmitted`, `pending`, `in_progress`, `completed`, `rejected`, `cancelled`) with provider acknowledgement, deadline, completion, rejection and authorized cancellation as **separate** recorded transitions.

| State | Rendering |
|---|---|
| loading | Skeletons |
| empty | "No source has been retracted." |
| error | ErrorState; until traversal completeness is known, the affected retrieval is labeled **fail-closed** (shown as such), never as cleared |
| disconnected | Banner; last progress kept with time |
| retrying | Dashed chip |
| waiting-evidence | Closure traversal incomplete: dashed chip "Traversal frontier: N remaining; affected retrieval is blocked" |
| waiting-approval | Provider deletion request awaiting owner approval: warning chip and Review (organization-wide scope shown; approval binds the actual organization and user set) |
| stale | A new derivation appeared during traversal: `stale` chip, traversal restarts and the frontier is shown |
| rejected | Provider `rejected`: outline chip with the provider status snapshot hash; local suppression state shown separately |
| cancelled | Authorized cancellation of a pending provider request: "Cancelled; not erased" (never "purged"); a revoked pending entry reads as cancellation |
| unavailable | No provider/privacy projection: `unavailable`; the screen never invents an instantaneous purge |

Statement shown on this screen at all times: "Provider acknowledgement is not completion. Deletion is complete only when the provider reports completed." Retained artifact bytes are checked for subject literals by the backend; this screen shows that check's committed result when present and says "not checked" otherwise.

## 5. Announcement policy (live-region restraint)

One polite `LiveRegion` per view. It announces: phase change; terminal state (`succeeded`, `failed`, `cancelled`); approval needed; approval resolved; receipt committed; connection lost and restored; stale detected. It does not announce individual events, counters, poll ticks, selection changes (selection is announced only inside the graph's own keyboard help region on request), or retry attempts. At most one message per 2 seconds; later messages replace earlier ones. Errors that need immediate attention (submit failed, decision failed) use `role="alert"` in the form or dialog only.

## 6. Copy rules

Plain, specific, calm. Say what the database recorded, what is pending, what failed and what to do. Words: "committed", "registered scope", "revision", "waiting for evidence", "needs your decision". Avoid: "successfully", "all clear", "safe", "purged", "complete" without scope, percentages without denominators, apology theatre. Error text names the failed thing and whether shown data may be older, and never reflects upstream bodies, URLs or tokens.
