# Expunge Implementation Contracts

These are new application contracts to implement. They are not exported OpenDots, OpenBot, OpenMuse or Raindrop APIs. All agents must use these names and semantics before starting parallel implementation. The coordinator owns changes to this file and the future `packages/contracts/` package.

## Identity and authority

Use string IDs for new control-plane records and BSON Dates for database times outside hashable payloads. Dates inside a canonical JSON artifact are explicit normalized ISO strings; no implicit Date.toJSON conversion participates in its hash. Existing domain `_id` types may differ; represent a domain address as `{collectionId, recordId, recordIdBsonType}` and preserve its BSON type when compiling a query. Never convert all domain IDs to strings and then silently compare them with ObjectIds.

Every authoritative request has an `ActorContext` resolved by trusted server authentication:

```ts
type ActorContext = {
  actorId: string;
  tenantId: string;
  env: "dev" | "evaluation" | "demo";
  scopeId: string;
  authorizationRevision: number;
};
type RunBinding = {
  jobId: string;
  runId: string;
  worldId: string;
  harnessHash: string;
  scopeRevision: number;
  workerProfileHash: string;
};
```

The model may select a previously issued job handle. It cannot supply authoritative tenant, actor, credentials, role or authorization revision. Resolve these from the authenticated session and stored job. Model input/state, AG-UI properties and MCP arguments are untrusted. A signed job token is a scoped capability bound to the same actor and job, with expiry and nonce; possession does not authorize a different subject or tenant.

Canonical hashes use one specified JSON canonicalization implementation, include a contract-version domain separator, and omit mutable database timestamps/statuses. Reject BSON/undefined/NaN values in hashable bundle JSON rather than relying on different serializers. Domain preimage hashes need their own BSON-preserving canonical format.

## Scope registry and world

`ScopeRegistry` contains `scopeId`, `revision`, approved collection IDs, sanitized field IDs/path descriptors, reference-edge declarations or observations, allowed effect kinds, fixed eligibility policy ID/hash, document limits and a discovery completeness description. A field ID resolves to a trusted registry entry; it is not an arbitrary MongoDB operator or a customer literal.

`WorldSpec` is an admitted generator input: version, seed commitment, synthetic identity recipe, collection layouts, reference topology, unrelated-record recipes, eligible effect policy, faults and resource bounds. It cannot contain an evaluator program or replacement expected answer. The fixed generator/reference solver creates the hidden evaluation manifest independently. The Hider proposes WorldSpecs; it cannot write manifests or scoring code.

`WorldRevision` has `worldId`, `revision`, `scopeRevision`, `maintenanceMode` and `updatedAt`. Every permitted domain mutation writes this row in the same transaction. This is a controlled-world protocol; it cannot cover external writers that bypass it.

## Harness bundle

```ts
type HarnessBundle = {
  contractVersion: 1;
  target: "worker" | "improver" | "hider";
  parentHash: string | null;
  contextPolicy: ContextPolicy;
  workflow: WorkflowGraph;
  guardrails: GuardrailAst[];
  toolPolicy: ToolPolicy;
  completionPolicy: "model_narrative" | "verified_receipt";
  pluginArtifacts: PluginBinding[];
  limits: ResourceLimits;
  evidence: EvidenceReference[];
  runtimeAdapterHash: string;
  compilerHash: string;
  vocabularyHash: string;
  authorityFloorHash: string;
  eligibilityPolicyHash: string;
};
```

`ContextPolicy` specifies schema observation selection, exact and semantic lesson retrieval, permitted-source filters, relationship expansion depth, context limits and evidence formatting. `WorkflowGraph` contains typed nodes, explicit edges, termination bounds and error/retry routes. Cycles require a bounded loop counter. No node can reach the hidden grader, approval issuer or promoter through worker tools.

`GuardrailAst` uses a bounded typed vocabulary: AND/OR/NOT, permitted fact comparison, receipt validity, prior-effect lookup and severity result. Null/missing facts fail according to a documented table; unknown AST operators are rejected. The compiler emits approved MongoDB aggregation/query expressions or trusted TypeScript operations. It never evaluates arbitrary JavaScript from the model.

`ToolPolicy` maps tool IDs to grants and prerequisite IDs. The immutable owner authority floor is separate. A learned bundle may tighten constraints within that floor; tool/scope grants and removal of constraints are classified independently by the trusted gate. The model's claimed mutation class is advisory.

`ResourceLimits` includes model calls, tool calls, scanned documents, changed documents, traversal depth, nodes/edges, wall time and total token/cost budget. The trusted execution service maintains real counters. A larger model context is not evidence of improvement.

Freeze these minimum shapes in the future contracts package:

```ts
type ContextPolicy = {
  schemaMode: "selected_fields" | "all_registered_fields" | "inspect_then_select";
  includeNestedArrays: boolean;
  referenceDepth: number;
  lessonRecall: { mode: "exact" | "hybrid"; topK: number; moduleIds: string[] };
  sourceEligibilityPolicyHash: string;
  maxContextTokens: number;
  evidenceFormat: "score_only" | "trace_and_score" | "contrastive_traces";
};
type WorkflowGraph = {
  entryNodeId: string;
  nodes: Array<{
    id: string;
    toolId: string;
    inputBindings: Record<string, string>; // admitted job/prior-output references
    maxVisits: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    when: "success" | "more_references" | "batches_remaining" | "needs_approval" |
      "retryable_error" | "verification_failed";
    // batches_remaining: apply_cleanup_batch committed a batch and the stored plan has unapplied batches
    // (one batch per effect kind, at most 25 documents); the last batch reports success (amendment A-1).
  }>;
  terminalNodeIds: string[];
};
type ToolPolicy = {
  grants: string[];
  prerequisites: Array<{
    toolId: string;
    requiredArtifact: "preview_plan" | "action_receipt" |
      "completion_receipt" | "approval_grant";
    binding: "same_job_same_plan_current_revision";
  }>;
};
type ResourceLimits = {
  modelCalls: number;
  toolCalls: number;
  scannedDocuments: number;
  changedDocuments: number;
  traversalDepth: number;
  graphNodes: number;
  graphEdges: number;
  wallTimeMs: number;
  totalTokens: number;
  maxCostMicrousd: number;
};
```

String tool/module/node/binding IDs are validated against the compiler vocabulary and stored scope. They cannot name arbitrary internal endpoints or JS expressions. Hash-pinned owner maxima govern numeric limits. Costs use integer micro-US dollars plus explicit unpriced-call counters; missing provider prices do not become zero cost.

For GuardrailAst, freeze a discriminated union with op `all|any|not|compare|receipt_valid|prior_effect_count`, typed fact/binding operands and result `allow|ask|deny`. Constants are bounded numeric/boolean values or approved status/tool enums; customer/task literals are not a guardrail constant kind. A rule record binds ruleId, predicate, result, source evidence IDs and an optional `appliesTo: string[]` of worker tool IDs (frozen 2026-10-11 after review finding DA-2 E3): when present, the rule is evaluated only for calls to those tools; when absent or empty, it applies to every tool call. Tool IDs must come from the compiler vocabulary. A rule that references a receipt or prior-effect fact without `appliesTo` denies every call before that artifact can exist, so the compiler rejects receipt-dependent deny rules that are not tool-scoped. The compiler also rejects a workflow whose summed `maxVisits` exceeds `limits.toolCalls` (DA-2 E4): a bundle must be internally consistent with the budget the executor enforces. The compiler rejects unknown fact IDs and normalizes deny>ask>allow severity. Receipt/history facts are built by the trusted gateway, not supplied by the model. Add AST-level size/depth and operator-semantic conformance checks before allowing model composition.

The initial bundle and static expert bundle are both explicit artifacts. Human-authored operator primitives and baseline policies are disclosed. The learner's contribution is the composed change and its measured transfer.

Store an artifact envelope `{_id: hash, payload: HarnessBundle, createdAt: Date, sourceBlobIds: string[]}`. Compute hash from the payload only. Database validation explicitly permits the envelope's `_id` and metadata and applies strict additional-property rejection to the payload. Parent/target indexes address `payload.parentHash` and `payload.target`. The trusted repository verifies the declared content hash on insert/read; database schema checks do not compute SHA-256.

`PluginBinding` specifies slot (`discovery`, `context` or `critic`), sourceHash, compiledHash, abiHash, sandboxProfileHash, exportName and input/output schema hashes. Empty bindings use typed operators only. Source edits produce new bindings inside the hashed bundle. Plugins run only in their admitted sandbox profile, return typed results and call the same scoped broker tools; they cannot load directly into privileged services. The gate pins both source and compiled artifacts to prevent evaluating one payload and running another.

## Job and effect protocol

`Job` fields: `_id`, kind, ActorContext binding, RunBinding, parentJobId, checkpoint, status, cancellationRequested, lease, logical sequence counters, input references, output references, createdAt and updatedAt. Kinds: cleanup, observe, propose, evaluate, promote, rollback, redact, external_delete, adversarial_generate and meta_evaluate.

Job states: `queued → running → succeeded | failed | cancelled`; a running job may yield to `waiting_evidence | waiting_approval | waiting_external`. A yielded job releases its lease and is re-enqueued by a trusted dependency transition. Retries retain the job ID and pinned artifact. Reclaimed running work obtains a new fence. Terminal jobs are never silently reset; an explicit retry attempt is recorded.

`Lease` has `ownerId`, monotonically increasing `fence`, `until` and `heartbeatAt`. Renewal, checkpoint and new-effect predicates require the exact owner/fence, a live lease using the verified database-time expression, a permitted running state and cancellationRequested=false. Every operational effect transaction conditionally **writes** the owning job under the expected fence before applying effects. A read-only lease check is insufficient. The transaction also touches the WorldRevision. A stale worker cannot commit after a newer claim wins. LLM/network calls occur outside these transactions.

`ActionIntent` binds job/run/harness, step ID, approved plan hash, batch ordinal, resolved target IDs/hash, effect kind, expected document versions, world revision, policy decision and a logical idempotency key. That key identifies the logical effect across retries; exclude a changing lease fence or provider-generated retry call ID.

`ActionReceipt` contains the intent hash, exact applied effects, pre/post data hashes or versions, resulting world revision, lease fence, status and evidence references. MongoDB effects, the unique effect ledger row and receipt commit in one transaction. External vendor effects have an outbox and reconciliation protocol; do not describe them as exactly-once merely because the local receipt is unique.

A retry first authenticates access to the stored job/action and checks for an already committed effect by its logical key and argument/plan digest. If it exists, return its existing authorized receipt without demanding the old lease, running status or pre-effect world revision. A different digest is an idempotency conflict. Recheck the committed effect inside the new-effect transaction before changing the world. Duplicate-key/commit-ambiguity recovery uses the same authenticated receipt reconciliation, never re-execution by assumption.

### Additive changes accepted 2026-10-11 (A2-R)

`ActionIntent.decisionId` is required and must reference an insert-only `decisions` ledger row written by the gateway before action; `GateReport.computedClass?` carries the grader-written mutation class that promotion reads (never the proposer's candidate row); new exported types `DecisionRecord`, `AuthorityRevision` (authoritative per-scope row, bumped only by setup or the approval issuer, fenced by every effect, completion, promotion and rollback) and `WorldScopeBinding` (scopeRevision and maintenanceMode split from the world revision counter); `Job.contextInputs?: string[]` (every artifact, evidence and lesson hash a run used; revocation matches on it); `GuardrailAst.appliesTo?: string[]`; six additive projection kinds. Per-job-kind principals: only the worker principal for a job kind may claim, renew, fence, checkpoint, yield or finish it, and `succeeded` on a cleanup job requires a committed, job-bound completion receipt. B1-0 additions (2026-10-11): world-scoped repository access takes a branded `WorldKey` issued only from a stored run binding (`worldKeyOf(job)`) or a stored world row under a trusted scope (`WorldRepository.bind`), never a bare worldId string; `DecisionRecord` gains optional `toolId`, `inputs` (bounded canonical JSON) and `inputsDigest` with a `DecisionInputsRecord` type; new insert-only executor collections `job_subjects`, `domain_steps`, `preview_plans`, `verification_sweeps`, `diagnostics`.

## Completion receipt

```ts
type CompletionReceipt = {
  receiptId: string;
  jobId: string;
  runId: string;
  harnessHash: string;
  scopeId: string;
  scopeRevision: number;
  verifiedWorldRevision: number;
  verificationPlanHash: string;
  inspectedCollectionIds: string[];
  discoveredFieldIds: string[];
  operationalResiduals: number;
  excludedOrRetainedRecords: number;
  limitations: string[];
  domainStatus: "complete_in_registered_scope" | "incomplete";
  externalErasureStatus: "not_required" | "pending" | "confirmed" | "failed";
};
```

The operational verifier reads visible scope/schema/relationship facts. It never reads the hidden fixture manifest. A receipt proving complete registered coverage can still fail the independent hidden evaluation when the registry/discovery missed a valid path.

`complete_cleanup` rechecks the receipt's job, hash, scope and world revision, then commits the final job state. The public terminal reply is rendered from this committed receipt when `completionPolicy=verified_receipt`. Raw worker text/state tools cannot set the authoritative completion badge or emit a replacement success reply. A telemetry deletion request with a deadline is pending, not confirmed external erasure.

## Evidence and observability

`EvidenceReference` has provider, external event/trace/signal IDs, local source IDs, origin, redaction policy, retrievedAt, content hash and permitted-use state. Origin is one of `agent_self_report`, `verifier_feedback`, `human_feedback`, `raindrop_classifier`, `experiment_result` or `admission_service`. These are application labels mapped explicitly to vendor fields, not vendor enum values. Preserve them through all reports.

`EvidenceBundle` is a sanitized trace packet assembled by the trusted observer: run binding, tool inputs/outputs with permitted values, raw failure witnesses allowed for the training split, linked diagnostics, model output, source provenance, cost and confidence. Held-out manifests are absent. Score-only and wrong-incident controls use the same schema and budget.

`TelemetryOutbox` delivery states: pending, leased, sdk_enqueued, ingest_accepted, query_visible, evidence_ready, retrying, dead_letter. Keep explicit receipt times/content hashes for each attained state; a retry cannot erase past acceptance evidence. SDK enqueue/flush, transport acceptance, remote visibility and required-content readiness are separate. A readable event missing required signal/span/content fields cannot release the proposal. A proposal requiring remote evidence waits for evidence_ready. Do not turn a missing response into evidence of no failure.

`ObserverCursor` stores project, fixed filter snapshot/hash, fixed scan-window bounds, provider cursor, overlap/backfill policy, pending-enrichment IDs and last committed processing time. A cursor is resumed only under that identical query identity. It checkpoints only after event deduplication and local evidence/job records commit. `/v1/signals` is a catalog. Read matched events with the documented events filter. Query pagination and asynchronous enrichment are handled separately.

`ExternalDeletion` contains a tenant/environment-authorized requestKey, providerOrganizationId, requester, truthful regulation/basis, namespaced provider user IDs, local export-suppression state, remoteJobId, receivedAt, dueBy, completedAt and providerStatus. The Raindrop request body is `{user_ids, requester, regulation}` with 1–100 user IDs and regulation `gdpr|ccpa|other`; project headers do not narrow its org-wide scope. Its job status is `pending|in_progress|completed|rejected`. Subject entries contain user_id, requested_on and revoked_at; they do not provide independent per-user completion statuses. Store the full provider snapshot and reconcile each entry with the job status. A revoked pending entry is cancellation, not completion. Approval binds the actual organization/user set, and telemetry IDs are namespaced to prevent unrelated-project user collisions. Provider acknowledgment, completion, rejection and authorized cancellation have separate recorded transitions.

## Candidate and gate

`Candidate` has candidateId, target, parentHash, childHash, typed patch, hypothesis, source evidence references, claimed class, trusted computed class, artifact hashes and state. States: proposed, schema_rejected, replay_rejected, evaluating, behavior_rejected, waiting_approval, eligible, promoted, stale, revoked. Promotion history is append-only; candidate lifecycle may be maintained in a separate mutable record.

`GateReport` pins candidate/parent, evaluator hash, fixture-generator hash, runtime hash, worker profile, split manifest commitment, paired trial rows and their digest, causal-control results, known authority flips, cost, gate verdict and reason codes. Historical replay is diagnostic; fresh trial execution is required for behavioral admission.

`ApprovalGrant` binds proposal and hashes, expected active parent/revision, target kind, approved scope/effect descriptor, authorization/scope revision, trusted rendered flip-set digest, approver identity, expiry, nonce and consumedAt. The UI sends a proposal/grant ID and a decision. It does not supply replacement executable arguments. The promoter atomically consumes this grant, rechecks the tested parent and inserts a promotion receipt.

`PromotionReceipt` records from/to hash, active revision transition, gate report ID/digest, consumed grant ID if needed, runtime/evaluator hashes, reason and time. Promotion changes harness authority; cleanup effects remain in their separate execution transactions.

All deployment/grant/projection identities use `{tenantId, env, scopeId, target}` where target applies. scopeId alone is not globally unique across tenants or environments. Use the same trusted scope key in CAS predicates, grant bindings, receipts, sequence allocation and retrieval filters. Artifact hashes can be content-global; permission to use an artifact remains scoped.

## Evaluation and recursion

`TrialPair` binds one fixture family/seed to parent and candidate runs with the same model profile, budgets and fault plan. It reports useful completion, targeted residuals, unrelated-record changes, retention violations, refusal/retry outcomes, tokens, dollars, Mongo operations and wall time. The hidden manifest is accessed only by the grader. Raw trial outcomes remain available when a candidate loses.

`MetaTrial` resets worker W0, applies I0 and I1 separately under equal improvement budgets and the same new incident, then grades the resulting workers on further withheld fixtures. Include an I0/I0 noise control. The unit is the produced worker's outcome; a better improver explanation or growing test suite is insufficient.

`AdversaryTrial` records admitted Hider spec/hash, reference-solver admission, resource bounds, novelty family and subsequent worker failure. The Hider's reward cannot edit the scoring definition or create impossible tasks.

## UI projection and events

Backend-only `ProjectionEvent` fields: monotonically increasing per-stream sequence, event ID, scope, job/run IDs, committed artifact IDs, event kind and sanitized payload. Kinds include job_started, tool_decided, effect_committed, evidence_ready, candidate_proposed, trial_completed, approval_required, harness_promoted, receipt_committed, external_erasure_updated and job_failed, plus the six additive kinds frozen on 2026-10-11 for committed state the UI must render: job_status_changed `{from, to, reason}`, cancel_requested `{requestedAt, by: 'owner' | 'system'}`, approval_resolved `{proposalId, decision: 'approved' | 'declined' | 'expired' | 'stale', grantId | null}`, harness_rolled_back `{promotionId, target, fromHash, toHash, testedParentHash, reason}`, retraction_progress `{retractionId, sourceId, frontierSize, visited, closureComplete, revoked, regenerated, runsCancelled, failClosed}` and campaign_row_committed `{campaignId, manifestHash, kind: 'hider' | 'meta', rowId, admitted?, w0ResetProof?, budgetHash?, result: 'measured' | 'null' | 'invalid'}`. Per-job sequences are contiguous from 1 for committed events because the sequence is allocated inside the committing transaction; an aborted transaction leaves no gap. The exact payload TypeScript is in `docs/ui/B3-PLAN.md` section 9 and must stay equal to `packages/contracts` (a root test cross-checks the mirrored vocabulary in `apps/operator/src/shared/expunge.ts`).

Operator-to-backend service principals are separate tokens, each bound server-side to a fixed owner and scope: `EXPUNGE_INTERNAL_TOKEN` (read projection only), `EXPUNGE_JOB_WRITE_TOKEN` (submit and cancel jobs, request operator previews), `EXPUNGE_APPROVAL_TOKEN` (submit a `{grantId | proposalId, decision}` review result to the approval issuer), `EXPUNGE_WAKE_TOKEN` (worker wake commands carrying only `{jobId, commandId}`). An operator preview (`POST /api/expunge/previews`) is executed model-free by the trusted gateway under the expert-static discovery policy and is labeled "operator preview, not the agent's plan"; it never authorizes an effect.

AG-UI STATE_SNAPSHOT/STATE_DELTA are projections of committed state. They do not perform promotion. On reconnection, fetch an authoritative snapshot and resume projection events; deduplicate by event ID/sequence. Change-stream resume tokens are backend opaque BSON and are not JSON-patch sequence numbers. Resume-token expiry uses snapshot/backfill recovery.

The registered custom agent must preserve trusted constructor dependencies in clone. Resolve the pinned bundle from the stored job in `run`; never restore authority from client-supplied state. The verified pinned API is `AbstractAgent` from `@ag-ui/client` with `run(input): Observable<BaseEvent>`, not an async generator imported from `@ag-ui/core`.

### Additive changes recorded 2026-10-11 13:25 UTC (packet C1c, one-time additive grant to runtime-raindrop)

- `EvidenceReference.delivery?: EvidenceDelivery` where `EvidenceDelivery = { sdkEnqueued: 'observed' | 'worker_attested'; ingestAccepted: 'observed' | 'inferred' | 'resend_unverified'; queryVisible: 'observed'; evidenceReady: 'observed' }` (defined in `projection.ts`). The labels are computed by the outbox dispatcher from its own receipts and are never collapsed into a single "delivered" state.
- `EvidenceReadyPayload.delivery?: EvidenceDelivery`, same shape, strict zod, optional; operator schemas accept and strip it until the client renders it.
- `EvidenceBundle.withheld?: { freeText: boolean; values: boolean }`: set when free text or values were reduced to hash and length because no subject-literal list was supplied (fail closed); a consumer must never read absence as emptiness.
- Pure shared exports: `PRIVATE_ID_DOMAIN = 'expunge-private-id:v1'`; `privateIdHash(salt, id)` = hex SHA-256 of domain NUL salt NUL NFKC(id), test vector `('salt-world-1', 'cust-0042')` -> `a30814d6ac27eae743f8e779f8f159c9da44845082a774d374153952ef671db7`; `bundlesDisjoint(a, b)` (job, world and every source id); `selectWrongIncident(incident: readonly EvidenceBundle[], pool: readonly EvidenceBundle[]): EvidenceBundle | null` (filter disjoint, sort by evidenceId, first). The grader exports `{ salt, hashes }` per world instance with a random 16-byte salt stored only in `expunge_private`; evolution's control arm imports the selector from here.
