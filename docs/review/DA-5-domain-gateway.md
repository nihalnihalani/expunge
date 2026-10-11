# DA-5: domain gateway (B1) review

Reviewer: devils-advocate (claude-opus-5-5). This review is read-only. It contains negative-test specifications and no exploit scripts.

The owner, mongodb-authority, is actively building, so these findings are for the owner. They are not instructions.

## Snapshot

- HEAD: `56b1de5`. `packages/domain/` is untracked working tree.
- Files were re-hashed at write time. The first 12 hex characters of each SHA-256 are shown.
- The owner changed files while I was reading, so earlier notes were re-checked against these hashes:
  - `context.ts`, `rows.ts`, `resolve-subject.ts` and `discover-references.ts` changed;
  - `closure.ts` is new.

| file                                                                                  | sha256       |
| ------------------------------------------------------------------------------------- | ------------ |
| packages/domain/src/gateway.ts                                                        | 3f7d50ec4831 |
| packages/domain/src/context.ts                                                        | 4bd819219d12 |
| packages/domain/src/closure.ts                                                        | 4a9f785a69a7 |
| packages/domain/src/rows.ts                                                           | 0c82db2760a8 |
| packages/domain/src/fields.ts                                                         | e11e73ceeaea |
| packages/domain/src/edge-index.ts                                                     | 9965f7f5f077 |
| packages/domain/src/edge-repository.ts                                                | aed079782a39 |
| packages/domain/src/record-effects.ts                                                 | b563cc7a6e29 |
| packages/domain/src/snapshot.ts                                                       | 411b337fed8e |
| packages/domain/src/store.ts                                                          | d6319de8096f |
| packages/domain/src/sweep.ts                                                          | 6566a57d172c |
| packages/domain/src/values.ts                                                         | 3842e962f1c9 |
| packages/domain/src/tools/resolve-subject.ts                                          | 0d510e598c4e |
| packages/domain/src/tools/discover-references.ts                                      | c9a708ba9117 |
| packages/domain/src/tools/preview-cleanup.ts                                          | 31dc97273c57 |
| packages/domain/src/tools/apply-cleanup-batch.ts                                      | 167f41d26363 |
| packages/domain/src/tools/verify-registered-scope.ts                                  | 88f2e114c5b1 |
| packages/domain/src/tools/complete-cleanup.ts                                         | 858511366c17 |
| packages/domain/src/tools/report-diagnostic.ts                                        | 5a59971e906e |
| packages/domain/src/tools/inspect-scope.ts                                            | b74013190f6e |
| packages/domain/test/gateway.integration.test.ts                                      | fff0465084ff |
| packages/governance/src/evaluator.ts / facts.ts / revocation.ts / ledger.ts           | b94ad520d00e / 9b8651ea0272 / 31ed1d3a105e / 93637b484f90 |
| packages/mongo/src/decisions.ts / effects.ts / worlds.ts / worldkey.ts / roles.ts     | 8fb30c9f486f / 057b22fec830 / 5ab79472d835 / 0cb07ef6d377 / a8d102a94ecd |
| packages/runtime/src/session.ts / meter.ts                                            | 059c0b4ff472 / 72174cf0f1b8 |

**Checks.**
- `npx vitest run packages/domain packages/governance` exits 0. 23 tests pass and 51 are skipped.
- The domain gateway live suite and the governance ledger integration suite skip, because `MONGODB_TEST_URI` is absent from my environment.
- I did not point the rig at the teammates' local containers, because the rig resets the database (`rig.env.reset()`).
- So the evidence here is reading plus the owner's test names. I classify a finding as DEMONSTRATED only where a grep fixes the fact.

**Since my preliminary notes, one item is resolved.** `RunContext.open` now:
- reads the stored job;
- refuses with `BundleBindingMismatch` unless `contentHash(context.bundle) === stored.binding.harnessHash` (context.ts:69-73);
- builds the run identity from the stored row.

**One item is withdrawn.** I had noted that `latestStep` is job-scoped rather than run-scoped. This is not a defect, because `binding.runId` is fixed when the job is created and nothing rebinds it.

## Findings

### DEMONSTRATED (static, fixed by grep)

**DG3 (MEDIUM-HIGH): the workflow/control graph is not enforced at runtime.**
- *Evidence.* The only runtime readers of `bundle.workflow` are:
  - `runtime/src/prompt.ts:22-26`, which puts node ids into prompt text;
  - `domain/src/tools/inspect-harness.ts:27-35`.
- `maxVisits`, edges, `entryNodeId` and `terminalNodeIds` are checked only at compile time (`harness-compiler/src/workflow.ts:181-199`).
- The gateway admits any tool order that grants, prerequisites and guardrails allow.
- *Impact.* The spec (line 47) lists the workflow graph as one of four editable executable surfaces, and requires "explicitly admitted expand/retry/approval branches" (lines 218-219). Here a candidate's workflow edit changes only prompt text, so the RSI comparison of workflow edits measures prompt wording, not control.
- *Owner:* mongodb-authority (gateway). Inform rsi-evolution.
- *Fix.* Track the current node and visit counts per run in a durable, lease-fenced row. Deny a call that has no admitted edge from the current node (`gateway:workflow_edge_missing`) or that exceeds `maxVisits` (`gateway:workflow_visits_exceeded`).
- *Negative tests (principal domain_executor, through `JobGateway.call`):*
  - **NT-3a.** Bundle with discover `maxVisits: 1`. Calling `discover_references` twice gives `ToolRefusal('PolicyDenied')` on the second call, with ruleIds containing `gateway:workflow_visits_exceeded`.
  - **NT-3b.** A workflow with no edge apply→resolve. Calling `resolve_subject` after one committed `apply_cleanup_batch` gives `PolicyDenied`, with ruleIds containing `gateway:workflow_edge_missing`.

**DG11 (LOW): authority-loss code mismatch.**
- `gateway.ts:131` lists `'AuthorityNotFound'`, but `mongo/src/authority.ts:78,96` throws `'AuthorityMissing'`.
- So a deleted authority row is returned as `ToolRefusal('AuthorityMissing')`, and the job is NOT cancelled (gateway.ts:235-246).
- *Fix:* use `'AuthorityMissing'` in the set.
- *NT-11.* Delete the scope's `authority_revisions` row with the setup principal, then call `inspect_scope`. Expected: `ToolRefusal('AuthorityRevoked')`, and the job status becomes `cancelled`.

### LIKELY (certain code path, not executed by me)

**DG1 (HIGH): discovery over-selects through shared records, and the target ids it adds to the bindings force a cascade.**
- *The path:*
  - `discover-references.ts:75` defaults to `direction: 'both'`.
  - `edge-repository.ts:151-152` runs outgoing and incoming separately.
  - Resumed calls keep the frontier (`discover-references.ts:37-39,59-62`), so a model can alternate directions: outgoing then incoming.
  - Preview turns every selected, still-existing, eligible record into a target with no subject-linkage test (`preview-cleanup.ts:35-50`).
  - Preview adds every target's id to the bindings (`preview-cleanup.ts:56-60`).
  - Redact and tombstone replace binding values in every non-key field, reference fields included (`record-effects.ts:41-42`).
  - Verification searches for every plan binding (`verify-registered-scope.ts:16-17`). Any non-key field holding one counts as a residual (`sweep.ts:43-47`).
- *Result.* Planning a shared record S makes every other record that references S a residual. Those records belong to other subjects. A verified completion then requires erasing them too.
- *New `closure.ts` makes this structural:*
  - It computes reach with `direction: 'both'` over every edge to the floor's `traversalDepth` (closure.ts:49-54).
  - `rows.ts:27-31` states that "Verification measures completion against it".
  - With one shared record two hops away, the bidirectional reach includes the other subject's account and customer.
- *Spec.* This violates line 203 ("Preserve unrelated record/field hashes") and line 223 ("Exact identity evidence is required").
- *Fix:*
  - declare an ownership direction per `ReferenceDeclaration` (for example `owns: 'from'|'to'|'none'`);
  - make discovery and the closure follow ownership only, never back up an edge into a record the subject does not own;
  - make preview refuse or retain any target without a subject-ownership path, with reason `not_subject_owned`;
  - add only owned target ids to the bindings.
- *NT-1 (principal domain_executor).*
  - World: customers C1 (subject) and C2; accounts A1{customer_ref:C1, org_ref:O} and A2{customer_ref:C2, org_ref:O}; org O (eligible for delete); all with string ids.
  - Edges: accounts.customer_ref→customers._id and accounts.org_ref→orgs._id. `referenceDepth = traversalDepth = 3`.
  - Calls: `resolve_subject`, then `discover_references{direction:'outgoing'}`, then `discover_references{direction:'incoming'}`, then `preview_cleanup`.
  - Expected:
    - plan targets ⊆ {C1, A1};
    - O, A2 and C2 are absent, or retained with reason `not_subject_owned`;
    - the closure contains no C2, A2 or O;
    - after apply, `verify_registered_scope` returns `verified: true`;
    - the preimage hashes of C2, A2 and O are unchanged.
  - Today, by reading: O is planned at hop 2 and A2 at hop 3.

**DG2 (HIGH): every string in every content field of the subject record becomes "identity".**
- *The path:*
  - `fields.ts:14,25` classifies every non-key, non-reference, non-payload field as `content`. Its own comment includes "free fields".
  - `resolve-subject.ts:47-54` adds every string value of every content field of the root to `identityBindings`, and adds the visible ones to `bindings`.
- *Effects.* Hop-0 seeding then selects every record holding any of those values in a visible content field (`discover-references.ts:146-171`). The closure seeds from all `identityBindings` (closure.ts:41-48). Redaction and verification use the same set.
- *Example.* A registered `data.country: "US"` on the customer would select, redact and verify against every record in the world holding "US".
- The fixture registries register only identity-bearing content fields, so the suite cannot show this.
- *Fix:* add an explicit identity marker, either in `FieldDescriptor` (for example `identity: true`) or as an owner-policy list of identity field ids, and bind only those values.
- *NT-2.*
  - Registry adds `customers.country` and `accounts.country`, both `data.country`, sanitized, string. C1.country = C2.country = A2.country = "US".
  - Calls: `resolve_subject` then `discover_references`.
  - Expected:
    - the resolution's `bindings` and `identityBindings` exclude "US";
    - C2 and A2 are not selected;
    - after apply, C2.country and A2.country are byte-identical;
    - the sweep does not count them as residuals.

**DG4 (MEDIUM): budgets are per session or per plan, not per job.**
- *Runtime:* `toolCalls`, steps, tokens, cost and wall time are fields of `RunSession` (session.ts:56,97-105,315; meter.ts:54-55). They restart at zero after a wait or a takeover.
- *Gateway:*
  - it has no ceiling of its own;
  - `changedDocuments` is checked per preview (`preview-cleanup.ts:52-53`), not per job;
  - `scannedDocuments` is checked per call (`scanWorld`).
- The spec (line 225) says "Store immutable run binding and current budget".
- *Fix:* add a durable per-job budget row (`toolCalls`, `changedDocuments`, `tokens`, `costMicrousd`). Increment it in the decision write and the effect transaction, and refuse at the gateway with `ToolCallBudgetExceeded`, `ChangedDocumentBudgetExceeded` or `TokenBudgetExceeded`.
- *NT-4a.* `limits.toolCalls = 5`. Make 4 calls, force a lease takeover, resume, and make 2 calls. Expected: the second call after resume (the 6th in total) is refused with `ToolCallBudgetExceeded`, and the ledger holds at most 5 decisions for the job.
- *NT-4b.* `limits.changedDocuments = 3`, with 6 eligible records reached over two discovery rounds. Run preview, apply all, discover, then preview again. Expected: the second preview, or the apply after it, is refused with `ChangedDocumentBudgetExceeded`, and the count of committed applied effects is at most 3.

**DG5 (MEDIUM): gateway control writes are not lease-fenced.**
- `store.appendStep`, `putPlan`, `putSweep` and `putDiagnostic` take no lease (`store.ts:144-181,203-212,233-255,269-273`).
- The gateway checks only `signal.aborted` at entry (gateway.ts:160) and the authorization revision.
- A session whose lease was taken over can still append a discovery step or a plan. The live holder then consumes it through `latestStep` / `latestPlan` (`apply-cleanup-batch.ts:56`).
- *Fix:* fence every control write on the live job row (owner, fence, not cancelled) in the same transaction as the insert, or check the fence before and after with a conditional write.
- *NT-5.* Session A holds fence f1, and B takes over with f2. A's gateway calls `preview_cleanup`. Expected: refusal `LostLease` (or the fence-loss error), no new `preview_plans` row, and B's `apply_cleanup_batch` applies only a plan B created.

**DG6 (MEDIUM): decision inputs are not bound, and `retry_count` sticks on same-batch retries.**
- `deriveDecisionId` covers identity, `result`, `ruleIds` and `authorizationRevision`, but not `inputs` (`mongo/src/decisions.ts:28-45`).
- A re-record with the same id returns the FIRST row (decisions.ts:103-114). So the inputs recorded for a committed action can be another evaluation's.
- `verify` never checks `inputsDigest` (decisions.ts:127ff).
- For apply, the identity is fixed per batch. So a repeated attempt with an unchanged verdict deduplicates, `earlier` stays at 1 (gateway.ts:204-208), and `retry_count` never passes 1.
- *Fix:*
  - include `inputsDigest` in the id (or key rows by call ordinal), and make `verify` compare `intent.decisionInputsDigest`;
  - count attempts from a per-run call counter, not from deduplicated rows.
- *NT-6a.* Guardrail `retry_count >= 2 → deny`, appliesTo apply. Make batch 0 fail twice with `StaleTarget`: before each commit, the setup principal raises one target's `_rev`, with no re-preview. Expected: the third apply gives `PolicyDenied` with that ruleId.
- *NT-6b.* After NT-6a's second attempt, the ledger holds two distinct rows for batch 0, or the second call fails with `DecisionInputsMismatch`.

**DG7 (MEDIUM): non-string identities are never unlinked and never counted.**
- `stringValuesAt` keeps strings only (values.ts:46-56), and `idBinding` returns null for int and long ids (preview-cleanup.ts:13-17).
- So an ObjectId-, int- or long-typed reference to a deleted or redacted target is neither rewritten (record-effects.ts:41-42) nor a residual (sweep.ts:45).
- The spec (lines 188 and 390) requires that BSON identity distinctions are preserved and covered.
- *Fix:* compare typed keys through `referenceKeys`-style typed matching in redaction and in the sweep, and add typed id bindings.
- *NT-7.* `orders.customer_ref` has bsonTypes `['objectId']` and references customers._id (ObjectId, `same_bson_type`). The owner policy is: customer delete, order redact. Expected after apply plus verify: either the order's ref is replaced or unset, or `complete_cleanup` returns `ResidualsRemain`. A `complete_in_registered_scope` receipt with the ObjectId ref intact must never be issued.

**DG8 (MEDIUM, new code): the closure truncates silently, and depth greater than 5 breaks resolution.**
- `closure.ts:49-65` ignores `found.truncated` and stops at `maxDocuments` without recording it. Completion "against the closure" would then be measured against a cut set.
- `maxHops: ceiling.traversalDepth` (closure.ts:51) throws `TraversalBounds` for depths 6 to 16, which the contract allows (`contracts/src/index.ts:947`). The limit is `MAX_REACH_HOPS = 5` at edge-repository.ts:15,142.
- *Fix:* store `truncated` in the payload and refuse completion on a truncated closure (`ClosureIncomplete`). Clamp or reject the depth at floor creation.
- *NT-8.* A floor with `scannedDocuments` smaller than the reach. Expected: `resolve_subject` returns, `closure.truncated === true`, and `complete_cleanup` is refused with `ClosureIncomplete`.

**DG9 (LOW-MEDIUM): edge-index versioning and provenance.**
- The index key and the completion marker are bound by scope key, world and world revision only, not scope revision (edge-repository.ts:47-51,54-61).
- Spec line 190 says "Version edges by source/world/scope revisions".
- `fixture_builder` may insert edges and mark an index complete (edge-repository.ts:55,65,98; roles.ts:239-240 with setup.ts:13-21).
- `ensureEdgeIndex` then reuses the index unverified (edge-index.ts:113-120). The spec forbids seeding edges from oracle ids.
- Discovery rescans the whole world anyway (discover-references.ts:41), so reuse saves only derivation.
- *Fix:* key the index by scope revision and registry hash, restrict writes to `domain_executor`, and drop the fixture_builder INSERT/UPDATE grant on `identity_edges`.
- *NT-9.* As fixture_builder, call `insertEdges` then `markComplete` for (world, revision). Expected: `UnauthorizedPrincipal`, and in the RBAC lane, server code 13.

**DG10 (LOW-MEDIUM): what the sweep counts as "retained".**
- `retained = access === 'restricted' || !eligible` (sweep.ts:49-50).
- This also counts:
  - a record eligible for `delete` that was already restricted;
  - a record with `missing_metadata` or `policy_mismatch`.
- Either kind can hold the subject's identity and still yield `complete_in_registered_scope`.
- *Fix:* count as retained only (a) records whose policy effect is `restrict` and are restricted, or (b) records retained by an explicit owner rule. Report other ineligible holders as residuals, or with a separate receipt limitation.
- *NT-10.* A record not reachable by edges, holding the subject's email, with `eligibility.effect: 'delete'` and `access: 'restricted'` set beforehand. Expected: `verify_registered_scope` reports residuals of 1 or more.

**DG12 (LOW): diagnostic sanitizing matches exact case only.**
- `sanitizeDiagnostic` (report-diagnostic.ts:21-28) removes only exact substrings of at least 3 characters. "A.B@X.TEST" or the local part "a.b" are stored.
- *NT-12.* The subject's email is `a.b@x.test`. Send a message containing `A.B@X.TEST` and `a.b`. Expected: the stored `diagnostics.message` contains no case-insensitive match of any identity binding or of an email local part, or the call is refused with `SubjectLiteralInDiagnostic`.

### SPECULATIVE

- **DG13 (LOW): hidden-structure hints.**
  - `verify_registered_scope` returns residual `fieldId`s for fields the context policy hides (verify-registered-scope.ts:82-87).
  - `inspect_scope` returns `hiddenFieldCount` and per-collection registered counts (inspect-scope.ts:35,69).
  - `select` acts as an oracle for whether a field id exists (`UnknownFieldId`, inspect-scope.ts:20).
  - *NT-13.* `selected_fields` mode, with a residual in a hidden field. Expected: the residual is shown by collection and handle only.
- **DG14 (LOW): replay needs a fresh allow.**
  - Apply decides before the receipt lookup (gateway.ts:165-184), so a replay of a committed batch can be denied or asked. Spec line 194(b) puts the receipt first.
  - *NT-14.* Commit batch 0, add a guardrail that denies apply, then call apply `{batch:0}`. Expected: the saved receipt, `replayed: true`.
- **DG15 (LOW): a second WorldKey mint.**
  - `WorldRepository.bind(scope, worldId)` (worlds.ts:132-135) mints from a caller-chosen world id under the caller's scope.
  - Only tests use it today. The domain mints only through `jobs.worldKey` (context.ts:73).
  - *NT-15.* As domain_executor, call `worlds.bind(actor, otherWorldInScope)`. Expected: `UnauthorizedPrincipal`.
- **DG16 (LOW): revocation window in `liveFloorValidator`.**
  - It reads the artifact through `readPermitted` outside the transaction (revocation.ts:29). An eligibility revoke that lands during the effect transaction does not conflict.
  - *NT-16.* Revoke the pinned artifact's eligibility between the decision and the commit. Expected: `ArtifactNotPermitted` and no effect.
- **DG17 (LOW): `$graphLookup` depth results are not bounded by `limit`.**
  - Only the first hop is limited (edge-repository.ts:159). Dense graphs can hit the 100 MB stage limit, which becomes `ToolFailed`, instead of explicit truncation.
- **DG18 (LOW): external erasure status.**
  - `externalErasureStatus: 'not_required'` is a constant (complete-cleanup.ts:72), not derived from the registry or the owner policy.

## Answers to the brief

- **Registry escape.**
  - *No path escape found.*
    - Paths must be `['_id']` or sit under `data` (`isRegistryFieldPath`, contracts/src/index.ts:771-779).
    - Writes compile through `compileWritePlan` and refuse the key and envelope fields.
    - `applyEffect` binds the world and collection.
    - `$graphLookup` is restricted to the world binding, the revision and visible `edgeId`s (edge-repository.ts:146-147,171).
    - The sweep reads registry paths only.
  - *The escapes are semantic:* DG1, DG2 and DG9.
- **worldId binding.** The domain mints only through `JobRepository.worldKey` on the stored job (context.ts:73). A second mint exists in mongo (DG15).
- **Decision forgery.**
  - The ledger row is written before the action, but in a separate write, not in the same transaction.
  - `commitEffect` re-reads and verifies it inside the transaction, after the job fence and the authority fence (effects.ts:205-212).
  - A non-allow decision, or a decision for another batch, plan or arguments, cannot commit.
  - The inputs are not bound (DG6).
- **Prerequisite bypass.**
  - *Apply with no plan* is impossible: `batch_unknown` is denied (evaluator.ts:79-81) and `NoPreviewPlan` follows.
  - *A stale plan* is caught by per-target `_rev` checks in the transaction and by the world-revision compare-and-set (effects.ts:213-229).
  - *Complete without verify* is impossible: `verified_receipt` needs a current zero-residual sweep (complete-cleanup.ts:36-39), and `model_narrative` sweeps itself.
  - *Compiler and gateway agree.* The compiler's `ARTIFACT_PRODUCER` (vocabulary.ts:51-56) matches the facts.ts bindings: `completion_receipt` is valid on a current clean sweep, and its producer is verify.
  - *The floor does not require prerequisites* (floor.ts:50-62). Dropping one is classified as `authority_expansion`.
- **Preview as authorization.**
  - The model's latest preview becomes `approvedPlanHash` (apply-cleanup-batch.ts:56,98), and no human approval binds it, because G7 is open. So preview authorizes itself under grants and guardrails.
  - Preview returns counts only. Discovery returns record ids, which is acceptable.
  - The domain does not import the private database. Its package imports are contracts, mongo, governance, runtime, baselines and vendor-openmuse.
- **Live revocation.**
  - *Reads:* checked before deciding (gateway.ts:203) and after the run (gateway.ts:186). The control rows a read wrote stay, but the job is cancelled.
  - *Effects:* the authority fence plus `liveFloorValidator` run inside the transaction, so there is no window apart from DG16.
  - *Ask → approve → revoke:* the approve step does not exist (G7). Revoke gives `AuthorityRevisionStale`, then the job is cancelled, except for `AuthorityMissing` (DG11).
- **ToolRefusal and JobWaitSignal honesty.**
  - A deny becomes `PolicyDenied` only after the ledger row and the `tool_decided` event.
  - An ask records the decision, then `JobWaitSignal('waiting_approval')`. The test at gateway.integration.test.ts:192 asserts there are no effects.
  - Success is never fabricated.
  - The refusal vocabulary is open: any `ProtocolError` code matching `SAFE_CODE` reaches the model (gateway.ts:248).
  - The wait is honest but cannot resolve (G7).
- **Resource limits.** See DG3 and DG4.
  - The compiler bounds limits within the floor and checks that the sum of `maxVisits` is at most `toolCalls`.
  - At runtime only per-session counters, per-plan document caps and per-call scan caps apply.
- **Model narrative.**
  - None reaches receipts (complete-cleanup.ts:54-73, built from the registry and the sweep).
  - None reaches effects (apply-cleanup-batch.ts:184-191, hashes and versions).
  - None reaches decisions (an argument digest only) or projections (summary `toolId: result`).
  - Diagnostics are stored as `agent_self_report` (DG12).

## DA-5a governance fixes

- **G1 fixed.** `PolicyEvaluator` throws `FloorMismatch` (evaluator.ts:59). `decide` denies `gateway:floor_mismatch` on a stored-hash mismatch (evaluator.ts:75). Covered at governance.test.ts:400,418.
- **G2 fixed.** An effect with an unknown batch is denied `gateway:batch_unknown` (evaluator.ts:79-81). Covered at governance.test.ts:432 and gateway.integration.test.ts:265.
- **G4 fixed.** `liveFloorValidator` loads the stored job and the pinned bundle in the session (revocation.ts:27-33). Integration tests are at ledger.integration.test.ts:149-198 (skipped here). The residual issue is DG16.
- **G7 open (MEDIUM, functional).**
  - `approval_grant: null` (facts.ts:71), so `ask` can never become `allow`.
  - Resuming re-decides to ask, then waits again.
  - The test at governance.test.ts:470 pins the fail-closed behaviour, and the positive case is deferred to C3.
  - *NT-G7*, when C3 lands:
    - a grant bound to (jobId, planHash, batchOrdinal, authorizationRevision) turns the ask into allow;
    - a grant for plan P1 does not authorize P2 (`PolicyDenied`, `gateway:prerequisite_approval_grant`);
    - a revoke after approval gives `AuthorityRevoked` and cancels the job.

## PKT-16 re-read, part 1: GC-1 gateway controls (2026-10-11, about 13:40Z, claude-opus-5-5)

**Pin (sha256, first 8 hex, matched the lead's list).** `src/controls.ts` ff3ec9b8, `src/workflow.ts` 2a4ae9c9, `src/budget.ts` eb2819ac, `test/controls.integration.test.ts` a0b61bf4, `test/controls-helpers.ts` 22335b55. I also read `store.ts` (fenced insert), `context.ts`, `runtime/src/session.ts` (tool wrapper) and the TanStack executor (`tool-calls.js`), all unpinned. I did not run the suite: it resets the database on gateway-controls' own replica set (27418), which is in use. The owner reports 25 passed there; the verifier reproduces.

| Item | Disposition | Basis |
|---|---|---|
| DG3 workflow enforced | CLOSED in controls | `admitTransition` from the latest durable workflow row, with visit limits; denied, refused and failed calls do not move the run (controls.ts:134-157,160-180; tests at 45-205). The wiring of the violations into DENY is in gateway.ts, which is re-read in part 2. |
| DG4 cumulative budgets | CLOSED for tool calls, scanned and changed documents | All three are counted from the job's rows and committed receipts, and survive a takeover (budget.ts:57-152; tests at 238,254,297,462,528). Tokens and cost are the runtime meter's carry through the job checkpoint (runtime-raindrop), outside GC-1. |
| DG5 lease fencing on `domain_steps` | CLOSED for writes, with residual GC-a | `rt.store = env.store.fenced(jobs.fence)` (context.ts:52). Every insert runs in a transaction with `findOneAndUpdate(liveJobFilter, $inc commitSeq)` (store.ts:134-145, jobs.ts:297-305). Test at 209. |
| DG6 replay and inputs digest | CLOSED for call rows, with residual GC-b | `inputsDigest` and `logicalKey` are on every call row. A replay with another digest is denied. A committed effect replays for free. An admitted call that never ended resumes under its own number. Tests at 344-415. |
| A-1 `batches_remaining` | Controls side CLOSED; runtime proof NOT PRESENT | Test 137 walks the real expert bundle through a four-batch plan, with outcomes scripted by the test. Two things are not in GC-1: deriving the outcome from committed batches (gateway.ts `outcomeOf`), and the lead's BLOCKING runtime test, in which each baseline completes a four-batch mixed_eligibility world and a partial_retry world through the real gateway. Both are checked in part 2. |
| Finished-job test (line 549) | CLOSED for `succeeded`; gap | After completion, writing tools fail with `LostLease` in their own fenced writes, apply on batch 0 returns the saved receipt, and the effect and call counts are unchanged. *Gap:* `jobFinished` also covers `failed` and `cancelled`. There, controls admit with no row, so a remaining uncommitted batch is stopped only by the effect transaction's fence. *NT-F:* cancel mid-plan (batch 0 committed, 2 batches); apply on batch 1 gives `LostLease`, with no effect or receipt row. |

**GC-a (LOW-MEDIUM, LIKELY): the control check is not atomic with its row.**
- `begin` reads the call count, per-tool count, position, scanned and changed totals outside any transaction, then appends the call row in a separate fenced transaction (controls.ts:96-156). `end` reads `position()` and appends a workflow row computed from it (controls.ts:168-179).
- The fence serializes lease holders, but not two calls of the same holder.
- TanStack executes a turn's tool calls one after another (`tool-calls.js:489` loop with `yield*`). However, the runtime's bounded phase can give up on a slow tool while its execution keeps running (`session.ts` `executions` and `abandonedTools`; see the earlier rt-tool-outlives repro). The model then issues the next call while the first is still inside the gateway.
- Two overlapping `begin`s both see `totalCalls = limit - 1` and both pass. Two overlapping `end`s each write visits computed from the same `before`, so one increment is lost. That is a workflow-visit undercount.
- *Fix:* do the control reads and the row insert inside the same fenced transaction. The `$inc commitSeq` on the job row already makes concurrent fenced transactions conflict, so the retry re-reads.
- *NT-a:* hold call A in the tool (slow) past the phase bound, then issue B. Call rows never exceed `limits.toolCalls`, and the final `visits` equals the number of advancing calls.

**GC-b (MEDIUM, DEMONSTRATED static): `retry_count` is not retries.**
- The disclosed fact is "Retries already spent on the current step" (baselines/primitives.ts:108-111).
- But it is computed as `priorCalls - 1` (governance/facts.ts:53), with `priorCalls = callsToThisTool`: every call to that tool in the whole job (controls.ts:29,96; gateway.ts:265).
- Under A-1, a normal four-batch plan presents `retry_count` 0, 1, 2, 3 to the guardrails on batches 0 to 3 with no retry at all. Three ordinary discovery rounds present 2.
- So a guardrail such as `retry_count >= 2 → deny apply`, of the kind evolution is expected to propose, denies batch 2 of every four-batch plan. The fact misleads both the evolved and the expert surfaces.
- Related, for part 2: gateway.ts:281 sets the decision identity's `batchOrdinal` to `callsToThisTool - 1`, not to the batch's ordinal.
- *Fix:* for an effectful call, count the earlier call rows of the same `logicalKey`. For other tools, count calls since the last advancing move out of the current node, or those whose previous outcome was `retryable_error`.
- *NT-b:* guardrail `retry_count >= 1 → deny` on apply, with a four-batch plan. All four batches are admitted. A `StaleTarget` retry of batch 0 is denied on its second attempt.

**Smaller notes.**
- A replay with a mismatched digest is denied without writing a row, so it costs no budget. That is harmless, because the model cannot choose `argsDigest`, but the doc comment says every denied call is counted.
- The `callNumber` in the payload can trail the row `ordinal` after a duplicate-key retry in `appendStep`. `end` uses the ordinal, so this is cosmetic.
- Lead ruling: an apply on an empty plan returns success with zero effects. The controls are neutral to it (`documentsToChange` 0). Checked in part 2.

## PKT-16 re-read, part 2: gateway, tools, service (2026-10-11, about 14:20Z, claude-opus-5-5)

**Pin.** These matched the packet: `gateway.ts` 30233d67, `store.ts` e8f563ca, `tools/apply-cleanup-batch.ts` 0c741169, `test/baselines-walk.integration.test.ts` 4e24d6ef. The full `src` and `test` list is in `pkt16-p2-pin.txt` in the scratchpad. The controls files are still moving (the overlap flake fix); they are re-read last.

**Checks.** I did not run the live suites. They reset databases on the replica sets the owners and the verifiers are using; the verifiers are running them in parallel. Every disposition below is by reading.

| Item | Disposition | Basis |
|---|---|---|
| `batches_remaining` derivation | CLOSED | `batchesRemaining` comes from the stored plan's batches and `committedBatchCount` over committed receipts (apply-cleanup-batch.ts:56-66 and the result). The gateway maps it to the edge outcome (gateway.ts:151-163). The model supplies only an ordinal. |
| Empty-plan apply | CLOSED | With 0 batches, apply returns `emptyPlan: true` and `appliedEffects: 0` with no effect, receipt or counter write, and refuses a named non-zero batch (apply-cleanup-batch.ts:141-158). Verification then says "not verified". The call row and the decision row are still written, which is correct. |
| `callNumber` ordinal and decision identity | CLOSED for the gateway | A non-apply decision is identified by (toolId, `callNumber`, `argsDigest`). Apply uses the real batch ordinal (gateway.ts:279-283). The `retry_count` semantics (GC-b) are still open in controls. |
| `appendStepAfter` fencing (GC-a) | CLOSED in design | The fence write, the control reads and the insert all run in one transaction (store.ts:220-262). Concurrent same-holder calls conflict on the job row's `commitSeq` and retry. Final disposition waits until the controls pass `session` to their reads, or are shown not to need it. |
| Blocking baseline walk | **Partly CLOSED** | *Closed:* both baselines complete a four-batch mixed_eligibility plan through the real gateway (visits.apply = 4, effects = 4; expert verifies, W0 is denied verify); a replay of ordinal 0 mid-plan writes no workflow row and takes no visit; a skipped ordinal is `BatchOutOfOrder` with no visit; the empty plan. **Not closed:** the `partial_retry` case runs with NO faults (P2-1). |
| DG1 shared records | **NOT CLOSED** | See P2-2. |
| DG2 content as identity | CLOSED | Only fields the owner policy marks as identity become identity bindings (fields.ts:14-26, resolve-subject.ts:50-53). |
| DG7 non-string ids | CLOSED by reading | Typed binding keys (`s:`, `o:`, `l:`, `n:`) and the identity-rule conversions are in values.ts:61-106. Not executed by me. |
| DG8 silent truncation | CLOSED | A truncated closure is recorded (resolve-subject.ts:70), and completion refuses with `ClosureIncomplete` (complete-cleanup.ts:34). |
| DG11 authority-loss code | CLOSED | `AuthorityMissing` is in `AUTHORITY_CODES` (gateway.ts:138). |
| DG12 diagnostic sanitizing | CLOSED | NFKC, case-insensitive, and also covers the e-mail local part (report-diagnostic.ts:28-41). Residual LOW: values under 3 characters, and split or encoded forms, are not covered here. |
| DG10, DG13, DG16 | Not re-verified this pass | No claim either way. |
| Principals | CLOSED | `DomainStore` and `createDomainEnv` require `domain_executor` or a gateway principal (store.ts:122, env.ts:59). The edge repository requires executor, fixture_builder or setup. |
| Service routes | CLOSED, with a note | Constant-time bearer to exactly one principal, the owner id taken from configuration, and a token that never works outside its own route family (auth.ts, handler.ts:106-112). Routes not served answer 501 honestly. *LOW:* configuration does not require the three tokens to be distinct. If the read token equals the approval token, the last match wins (`approval`), so a read-only holder could post decisions once that route is served. Refuse duplicate tokens at load. |

**P2-1 (MEDIUM-HIGH for the experiment, DEMONSTRATED static): the world's fault plan is not realized on the real execution path.**
- `partial_retry` worlds carry `faults: { partialAcknowledgements: 2, interruptAfterEffects: 2, transientFailures: 1 }` (fixtures recipes.ts:123).
- Nothing in `packages/domain/src` or the test rig injects them (grep finds no fault code). The only fault injector is the grader's labelled simulator, used by the FAKE gate port.
- So the blocking walk "completes partial_retry" on a fault-free world, the `retryable_error` edge is never driven at runtime, and in a real campaign `partial_retry` is structurally the same as `direct_nested`.
- Spec line 289 requires partial-ack, interruption and retry faults, and line 295 requires equal faults per pair.
- *Related (LIKELY):* `StaleTarget`, `StaleDocumentVersion` and `StaleWorldRevision` are retryable, but no baseline graph has an edge from `apply` back to `discover` or `preview`. A retry of the same stale plan fails again until apply visits run out, so on a genuinely stale target both baselines dead-end. Whether that is intended W0 and expert behaviour is a lead decision; it must at least be disclosed.
- *Fix:* a labelled fault layer in the domain effect path, driven by the trusted run binding's fault plan for campaign worlds only (never selectable by the model). It covers transient pre-commit errors, interruption after N effects, and lost post-commit acknowledgement reconciled through the saved-receipt path.
- *Test:* each baseline on a fault-injected `partial_retry` world, through the real gateway. The trace contains a `retryable_error` that the graph admits, and the effects are committed exactly once.

**P2-2 (DG1 still open, HIGH, LIKELY by reading): an outgoing chain reaches a shared parent, and the binding cascade remains.**
- Discovery now never turns back along an edge (discover-references.ts:29-32), which removes the up-then-down path.
- But `direction` defaults to both ways (discover-references.ts:90), and the closure walks `direction: 'both'` (closure.ts:59-64). A record that the subject *references* is reached outgoing.
- *Counterexample:* C1{org_ref: O} and C2{org_ref: O}, with O eligible for delete and the edge `customers.org_ref → orgs._id`.
  - Outgoing from C1 reaches O, so O is in the closure and the plan.
  - Preview still adds every target id to the bindings (preview-cleanup.ts:64-68).
  - So after apply, C2.org_ref is a residual. Redacting it rewrites another subject's record; leaving it fails verification.
- The `ReferenceDeclaration.owner` field recorded as a PKT-16b decision is absent from contracts (grep finds no `owner?:` in `ReferenceDeclaration`). So nothing tells the walk which direction means ownership.
- *Fix:* as in DG1. Per-edge ownership (`owner: 'from' | 'to' | 'none'`), set by the owner and the generator; follow owned direction only; a reached record without an ownership path is retained `not_subject_owned` and never becomes a binding.
- *NT-1b:* the counterexample above. O is not a target, C2 is byte-identical after the job, and verification is `verified: true`.

## Footer

```
EFFECTIVE_MODEL: claude-opus-5-5
OWNED_PATHS: docs/review/DA-5-domain-gateway.md
CHECKS: npx vitest run packages/domain packages/governance -> exit code 0 (23 passed, 51 skipped: live suites, no MONGODB_TEST_URI)
FINDINGS: demonstrated=2 likely=10 speculative=6
BLOCKED: live domain gateway suite not run by reviewer (no test URI; teammates' containers not used because the rig resets the database)
STATUS: COMPLETE
```

## GC-a and GC-b, from the overlap analysis (2026-10-11, about 14:30Z)

- **GC-a: CLOSED as a design, with a disclosed residual.**
  - The compiler admits one edge per (from, when) (`workflow_duplicate_transition`, harness-compiler/workflow.ts:131-135). From a settled position, therefore, only one non-exempt node is admissible, and an overlap cannot produce a hop the graph does not have.
  - `begin` and `end` read and append inside one fenced transaction (`appendStepAfter`). `end` recomputes from the latest committed workflow row. A begun call reserves its node's visit.
  - *Residual:* the same node can repeat without a self edge for that outcome, bounded by `maxVisits` and `toolCalls`. It is not driven through the real runtime phase bound.
  - I do not recommend refusing `begin` while an unended admitted call exists: an abandoned tool would then block the run.
- **GC-b: CLOSED by reading.** `retry_count` now counts earlier attempts at the same `logicalKey` for effects, and calls since the last edge-taking move for reads (controls.ts, `attemptsAt` and `callsSinceLastMove`).
- **Hash caveat.** gateway-controls reported its frozen controls at `controls.ts` 75f3e89b and test 67087b09. At 14:30Z the tree has `controls.ts` bb2740b5 and test 78471637 (`workflow.ts` 2a4ae9c9, `budget.ts` 2b90c4e2 and helpers 89377e82 match). The final disposition binds to the hashes the verifier runs on.
- **Hash caveat resolved (about 14:35Z).** gateway-controls confirms that `controls.ts` bb2740b5221e and `controls.integration.test.ts` 78471637c1f5 are its current tree: a comment-only change to controls (the DISCLOSED overlap note) and an added overlapping-applies test pair. I re-checked the hashes. I did not diff against 75f3e89b because I hold no copy of those bytes. The GC-a and GC-b dispositions bind to bb2740b5 and 78471637.

## Lead override on PKT-16 (2026-10-11, about 14:50Z)

The lead lands PKT-16 with P2-1 and P2-2 recorded OPEN and freeze-blocking. The conditions are a KNOWN GAP test pinning NT-1b, the partial_retry walk relabelled fault-free, README disclosure, and PKT-16b scheduled first.

**Reviewer: ACCEPTED.** I found no harm path today:
- Generated worlds have no shared parent by construction (fixtures README, design notes).
- Grep finds no code outside tests that creates a custom scope registry or world.

**Added condition:** until PKT-16b lands, any path that registers a non-generated scope stays blocked on PKT-16b. That includes demo seeds, customer-shaped worlds, and Hider WorldSpecs if they can express a shared parent.
- **Hider condition: SATISFIED (about 15:00Z).**
  - PKT-42 adds `packages/adversary/test/hider.test.ts:258+`: union-find over registered edges for every admitted enumerator world, with a mutated case that fails.
  - Every generated edge targets `record_id`, which is path `_id` (generator.ts:324,359), so joining on `_id` values covers every edge the generator can emit. The structural guarantee is the WorldSpec grammar, which cannot name another chain's record.
  - *Notes for PKT-16b:* extend the check if registries ever join on non-`_id` keys. A model-driven Hider needs this check at admission, not only in a test.
