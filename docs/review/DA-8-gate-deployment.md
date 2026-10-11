# DA-8: gate and deployment (C3) review: DRAFT, pass 2

Reviewer: devils-advocate (claude-opus-5-5). This review is read-only, by reading the working tree at HEAD `e2e1db1`. It contains negative tests and no exploit scripts.

It is a DRAFT, cut short by a write barrier. The "Not yet reviewed" section lists what is still open.

File hashes for packages/fixtures, grader, gate and deployment (65 files) are in the reviewer's scratch list `da8-hashes.txt`. They will be inlined in the final version.

No checks have been run yet.

## Findings so far

### DEMONSTRATED (static)

**D8-1 (MEDIUM): the final split is read by every gate run.**
- `runGate` calls `publicSplitCommitment(config.plan)` (gate.ts:108). That function reads `spec`, `seed` and `structuralHash` of every entry, including the `test` entries (splits.ts:118-129).
- The canary Proxy (campaign.test.ts:196-235) wraps only the plan passed to `selectGateWorlds` and `runCampaign`. It never covers `runGate`.
- It also traps only `get`, so `Object.getOwnPropertyDescriptor(entry, 'seed').value` and any read through the unguarded original `plan` bypass it.
- *Fix:* the fixture builder computes the commitment at freeze time and stores it. `runGate` receives a plan without test entries, or test entries as opaque `{fixtureId, split, commitment}` stubs.
- *NT-1:* wrap the test entries in a Proxy that traps `get`, `getOwnPropertyDescriptor` and `ownKeys`, then call `runGate`. Expected: `touched === []`.

**D8-2 (MEDIUM): the runtime-hash check compares a value with itself.**
- Both `frozen.runtimeHash` and `observedRuntimeHash` come from the `runGate` caller (gate.ts:49-50,106). So `runtime_hash_mismatch` can never fire on a swapped runtime.
- The header comment's "never copied from the frozen manifest" is false for the runtime hash.
- `frozen.*` (including `splitManifestCommitment`) is also caller-supplied, so `split_commitment_mismatch` is tautological in tests and in the evidence script.
- *Fix:*
  - the port reports the runtime adapter hash attested by the worker build, per episode, recorded in the job row;
  - the frozen values are read from a stored freeze row written by the fixture builder.
- *NT-2:* a port running runtime X while the frozen value is Y. Expected: `reject` with `runtime_hash_mismatch`, regardless of what the caller passes.

**D8-3 (MEDIUM-HIGH): run pinning does not ignore a caller-supplied hash everywhere.**
- `createPinnedJob` (promote.ts:103-127) and the domain `submitCleanup` (domain/src/service/jobs.ts:85-106) take the hash from the deployment pointer.
- But `JobRepository.create` (mongo/jobs.ts:70-104):
  - stores the caller's `binding.harnessHash` without checking;
  - lets 7 principals create any job kind (no `JOB_KIND_PRINCIPALS` check on create).
- The worker then runs any `readPermitted` artifact (runtime/session.ts:236-248). A cleanup job pinned to a non-promoted, proposer-inserted candidate therefore bypasses promotion.
- *Fix:*
  - enforce `JOB_KIND_PRINCIPALS` on create;
  - for `cleanup`, derive `harnessHash` from the active pointer inside `create` and record `deploymentRevision`;
  - the worker verifies this at start;
  - allow grader-owned `evaluate` jobs on campaign worlds only.
- *NT-3a:* as the observer, create a `cleanup` job. Expected: `PrincipalBoundary`.
- *NT-3b:* as domain_executor, create a cleanup job with `harnessHash` ≠ the active pointer. Expected: `HarnessNotDeployed`. The worker's start also refuses with `HarnessNotDeployed`.

**D8-4 (MEDIUM): a candidate can re-roll the gate until it is admitted.**
- `gate_reports` is indexed on `candidateId` but not uniquely (mongo/setup.ts:107).
- Promotion takes whatever `reportId` the caller names (promote.ts:29).
- So rejected campaigns for the same candidate and parent do not stay in the denominator (spec line 297).
- *Fix:* allow one admitting campaign per (candidateId, parentHash), using a unique index or a grader-written candidate→report pointer. Promotion requires the pointer.
- *NT-4:* the gate rejects the candidate, then admits it on a second campaign. Expected: promotion with the second report is refused with `CandidateGateRerun`.

**D8-5 (LOW-MEDIUM): the same-parent race is not proven to be a race.**
- The pre-check (promote.ts:39) and the in-transaction compare-and-set (mongo/deployment.ts:230) both throw `StaleParent`.
- The test (deployment.integration.test.ts:250-270) and the evidence log accept `StaleParent` from either. A sequenced loss is indistinguishable from a lost compare-and-set.
- *NT-5:* use a barrier in `validateAuthority` that releases only when both transactions have entered it. Expected: exactly one commit, and the loser fails inside the transaction (a distinct code, or an observed retry), with the entry count equal to 2.

### LIKELY

**D8-6 (MEDIUM): the held-out identity is recoverable from `runId`.**
- `runId = H({campaignId, pairId, arm, repeat})`, where `pairId = campaignId:fixtureId:repeat` and fixtureIds follow the fixed format `split-NN` (campaign.ts:189,295; splits.ts:92).
- The port receives `campaignId` and `runId` (types.ts:85-95).
- At most 18×3×2 hash trials therefore reveal the split, the fixture and parent-versus-candidate.
- *Fix:* HMAC the run and scope labels under the campaign key, or use random ids mapped privately.
- *NT-6:* enumerating plan-format fixtureIds, arms and repeats never reproduces a `runId` the port saw.

**D8-7 (MEDIUM): "failed runs are rows with no success" is not enforced.**
- `usefulCompletion` comes from the port-supplied `terminal.status` and the read-back world (grade.ts:270-310, campaign.ts:224-251), whatever `outcome` is.
- A port returning `outcome:'failed'` with `terminal:'complete'` and a correct world is credited as a success.
- *Fix:* force no success, in `runArm` or in admission, when `outcome` is failed, cancelled or timed out.
- *NT-7:* two extra candidate train arms with `outcome:'failed'` and `terminal:'complete'`. Expected: `trigger_gain_insufficient`.

**D8-8 (MEDIUM): the port self-attests what admission relies on.**
- These come from the port:
  - the receipt (`TrustedReceiptEvidence`, only internally consistent: the port computes `committedReceiptHash` itself);
  - `cost` and `retryFailures`, which drive `limits_exceeded`, the cost ceiling and `correct`;
  - the graded world (`port.read`).
- The FAKE sim also discovers with the grader's own `referenceSolve` (sim.ts:14,208). The "worker" therefore shares the reference algorithm (spec line 291).
- *Fix:* the real port reads the receipt, cost and retries from committed job rows using the grader principal. Admission refuses to admit from a port labelled fake (`hold: fake_port`).

**D8-9 (MEDIUM): there is no import boundary for worker or proposer code.**
- Nothing (no lint rule, no test, no worker image) stops `packages/{runtime,domain,evolution,observer}` or `apps/worker` from importing `@expunge/fixtures/sealed`, `@expunge/grader` or `@expunge/gate` through workspace links.
- Spec line 158 requires the images to exclude these modules.
- *NT-9:* a `no-restricted-imports` rule, plus a test that fails on such an import or relative path.

### SPECULATIVE

- **D8-10:** `GateStore.readReport` has no principal check (store.ts:78). The proposer role cannot read `gate_reports` today (roles.ts:124-133), so this depends on RBAC alone.
- **D8-11:** `loadAdmittedReport` checks only the compiler hash. A report admitted under an older evaluator or generator still promotes, and there is no report expiry (stored.ts:48-80).
- **D8-12:** admission does not check that fixtureIds or structural hashes are disjoint across splits (admission.ts:174-185). It relies on the caller's plan.
- **D8-13:** the final-split families and their generator are in clear in the source (splits.ts:85-87).
- **D8-14 (honesty):**
  - the evidence script's "decision ledger rows that prove which bundle decided" (c3-evidence.ts:3,182-222) is a row the script writes itself as setup, with fabricated facts, not a run;
  - "real campaigns (38 fresh paired runs each)" (c3-evidence.ts:112) runs on the FAKE sim;
  - the "unsafe candidate" is the same bundle with a port scripted on `bundleHash`.
  - The header and output do say FAKE.

## Answers so far

- **Approval descriptor:** it is rendered from stored rows, the class is recomputed from the stored artifacts, and a mismatch is refused (stored.ts:48-80; descriptor.ts). An edited row changes the digest, but nothing independent anchors the original digest; see D8-4 and D8-11.
- **Key reachability:** the key is reachable only by the fixture_builder, grader and setup roles (keys.ts:43,61). The proposer role has no grant on private collections, `gate_reports` or `public_trial_rows`. The boundary gap is D8-9.

## Pass 2 (2026-10-11, 13:05Z to 13:10Z real UTC, reviewer claude-opus-5-5)

**Stale-reference warning.** At 13:06Z all 65 files matched the draft's hash list (`da8-hashes.txt`, written 12:15Z). But the code mtimes (11:34Z to 12:04Z) are earlier than that list, and `campaign.ts` at those bytes already used HMAC run and scope labels and forced failed runs to no success. So the draft's D8-6 and D8-7 line references describe code that was edited before the hashes were taken. From 13:07Z, rsi-evolution's fix pass is changing `splits.ts`, `sealed.ts`, `gate.ts`, `campaign.ts`, `admission.ts`, `report.ts`, `sim.ts`, `types.ts`, `store.ts`, `index.ts`, `deployment/src/stored.ts` and four gate tests, and has added `gate/src/freeze.ts`. Twelve files changed between 13:07:45Z and 13:09:43Z. No D8-1..D8-9 disposition is given against moving bytes. Dispositions follow in "Closure re-read" once the owners report a settled tree.

### Reviewed in this pass (stable files)

**Second solver (`grader/src/reference2.ts` against `reference.ts`).**
- The code is independent: `reference2.ts` has its own `leaves` walker, value indexes and breadth-first levels, and imports neither `reference.ts` nor `paths.ts`. It shares `addressKey`, `COLLECTION_IDS` and the types.
- The specification is not independent. Both read only the visible registry edges and the same field-ID conventions. `reference.ts` takes bindings from `schema.identityFieldIds` and `aliasFieldId` (reference.ts:58-64). `reference2.ts` hard-codes `customers.identity_binding`, `customers.aliases`, `customers.identity_email` and `${collection}.identity_binding` (reference2.ts:97-106). These coincide for every generated schema (generator.ts:318,411-476).
- *Alternate hypothesis:* the second solver can catch an implementation bug in one traversal, but never a misreading of the world model that both share. The genuinely independent check is the reference poststate against the oracle manifest (grade.ts:481-483), which runs first.
- *Weak tests:* the "disagree when the world is ambiguous" test (solvers.test.ts:89-104) edits a solver's OUTPUT, so it is a unit test of `plansAgree`, not of ambiguity detection. `admission-solvers.test.ts` forces the disagreement with a module mock. No generated world, and no injected solver bug, has been shown to produce `solver_disagreement`.

**D8-15 (LOW, DEMONSTRATED static): the second solver's bytes are not in the evaluator commitment.**
- `admitWorld` in grade.ts runs `referenceSolveIndexed` (grade.ts:485).
- But the `EVALUATOR_HASH` sources are `grade.ts`, `faults.ts`, `sealed.ts`, `paths.ts` and contracts (grade.ts:41-47). They do not include `reference2.ts` or `INDEXED_SOLVER_HASH`.
- `INDEXED_SOLVER_HASH` is pinned only by `packages/adversary/src/admit.ts:26`.
- So a `reference2.ts` edit that makes `plansAgree` vacuous leaves `EVALUATOR_HASH`, and with it the gate's `evaluator_hash_mismatch`, unchanged. The grader README's "Grade reports and manifests pin these commitments" over-claims for this module.
- *Fix:* add `INDEXED_SOLVER_HASH` to the `EVALUATOR_HASH` payload.
- *NT-15:* changing one byte of `reference2.ts` changes `EVALUATOR_HASH`.

**Keyed derivation (`fixtures/src/derivation.ts`; generator, recipes and sealed call sites; `derivation.test.ts`).** No defect found.
- The HMAC-SHA256 is domain separated (`expunge:fixture:1:<domain>`) and runs over canonical JSON.
- The key is per campaign and at least 32 bytes, and degenerate keys are refused.
- `keyId` is bound into `worldIdFor`, so keyed and unkeyed worlds cannot collide.
- The test "a worker holding the visible world and the seed cannot recompute a target id" is the right negative test.
- Residual: `worldIdFor` is an unkeyed hash of (specHash, seed, scope, keyId). That is safe only while the seed stays private, which `buildSealedSplitPlan` and `isHighEntropySeed` provide.

**Grant issue and consumption (`mongo/src/deployment.ts:55-92,161-323`, `deployment/src/grant.ts`).** No defect found.
- Expiry is checked with `$$NOW` inside the transaction.
- The binding is re-derived from the stored report at issue and at consumption.
- Consumption is an insert-only unique row inside the same transaction as the pointer compare-and-set, so a `StaleParent` aborts consumption.
- Whether a grant is required is derived from the stored `computedClass` and the stored policy.
- Minor: issue bounds the lifetime with the app clock (`Date.now()`) while consumption uses the DB clock. Skew only moves the maximum lifetime.

**D8-16 (MEDIUM, LIKELY): one campaign per exact bundle bytes, not per behaviour.**
- The new claim (`gate/src/freeze.ts`, `candidateKey(parentHash, childHash)`, inserted before any episode) closes the "re-run the same candidate" path and the "abort early, retry" path.
- But `childHash = contentHash(bundle)`, and `HarnessBundle` carries non-executable `evidence: EvidenceReference[]` (contracts/src/index.ts:229). A proposer can resubmit a rejected candidate with its evidence list reordered, or with one more permitted citation. That gives a new `childHash`, a new claim and a fresh campaign on the same plan worlds. On a stochastic model this is a re-roll.
- The compiler has no executable-semantics hash (harness-compiler/src/hashes.ts; grep finds none).
- *Fix (either):*
  - key the claim on (parentHash, executable projection), where the projection is the compiled surfaces without `evidence`, with stable array order;
  - or record every campaign per parent and cap or account for attempts in admission. Spec line 297: failed attempts stay in the denominator.
- *NT-16:* child A is rejected; A' = A with `evidence` reversed. `claim` throws `CandidateGateRerun`.

**Rollback (`mongo/src/deployment.ts:349-406`). SPECULATIVE D8-17.**
- Rollback consumes no grant and derives no class for the transition from current to target.
- Checks present: the target was active before in this key, it is not tainted, the authority floor hash equals the current floor, authority is fenced, and the CAS runs on hash and revision. It does not CAS `scopeRevision`, which promotion does.
- Counterexample shape: an incident fix C restricts a tool grant of P, and is promoted without a grant because it is restricting. A promoter-only rollback from C to P then re-expands the grant with no approval issuer involved.
- Whether rollback to a previously approved state needs fresh approval is a policy decision for team-lead. It is recorded, not asserted as a defect.

**Admission catalog (`gate/test/admission-catalog.ts`).**
- It is complete by construction: a `Record` over the reason codes.
- But every case calls the pure `evaluateAdmission` with an edited `observed` block. That proves the rule, not that `runGate` can produce those inputs. `runtime_hash_mismatch` and `split_commitment_mismatch` are exactly the reasons D8-2 says cannot fire end to end.
- *Required with the D8-2 fix:* one `runGate`-level case per hash reason.

**READMEs.**
- `deployment/README.md`: "They use real campaigns on the labelled FAKE worker" mixes the words. Use "full campaigns on the labelled FAKE worker". "A decision-ledger proof" is a setup row (D8-14).
- `grader/README.md`: see D8-15.
- `gate/README.md`: "reading … hashes from the modules that actually ran, not from the frozen manifest" stays false for the runtime hash until D8-2 closes. The BLOCKED statement for the real port is accurate.
- `fixtures/README.md`: the keyed-derivation section matches the code.

**D8-3 state at 13:09Z:** `packages/mongo/src/jobs.ts` still has no `JOB_KIND_PRINCIPALS` check in `create` (jobs.ts:70) and no `HarnessNotDeployed` code anywhere. Not started, or not yet in the tree.

## Closure re-read (2026-10-11, 13:21Z to 13:30Z real UTC, claude-opus-5-5)

**Pin.** 70 files under fixtures, grader, gate and deployment were hashed at 13:21:49Z (`da8-closure-pin.txt`). Only `grader/src/private-ids.ts`, `grader/src/index.ts` and a test had changed in the three minutes before.

**Checks.**
- `npx vitest run packages/gate packages/grader/test/solvers.test.ts packages/grader/test/admission-solvers.test.ts packages/fixtures/test/derivation.test.ts` (node 24.13.1) exits 1: 10 files (8 passed, 1 failed, 1 skipped); 131 tests (119 passed, 1 failed, 11 skipped).
- The failure is the new D8-9 import-boundary test. It flags `apps/worker/src/episode-host.ts` and `episode-port.ts`, both untracked and created at 13:23Z, because they import `@expunge/fixtures`.
- The skipped file is `store.integration.test.ts` (no `MONGODB_TEST_URI` in my shell), so I did not reproduce the live freeze, claim or report tests.

| Item | Disposition | Basis |
|---|---|---|
| D8-1 | CLOSED | `runGate` takes a `GatePlanView` (gate.ts:41). `sealPlanForGate` drops the test entries. `verifyGatePlanView` re-derives the commitment from the held entries plus the stubs and refuses a test entry, a swapped spec or a forged hash (splits.ts:166-201). A tampered view throws before any seed (da8.test.ts:64-82). |
| D8-2 | CLOSED at the gate | The expected values come from the freeze row (gate.ts:64), and the observed runtime is the per-run attestation, which must also equal both bundles' `runtimeAdapterHash` (gate.ts:93-101). NT-2 passes for a swapped, missing or mixed runtime. *Residuals, tracked elsewhere:* the attestation is still the port's own report (D8-8); `freezeHash` is an unkeyed self-hash, so integrity rests on RBAC, which does not exist yet (C1). |
| D8-3 | NOT CLOSED | `PINNED_JOB_PRINCIPALS` in `createPinnedJob` is a first line only. `JobRepository.create` is still unchecked (mongodb-authority). |
| D8-4 | CLOSED for the exact pair | The claim is inserted before any episode (gate.ts:70), and the report ID is derived from (parent, child) on insert and on promotion (store.ts:69, stored.ts:63). The test covers a rename. *Open:* D8-16 (evidence reorder gives a new childHash), C1, and D8-18 (the claim makes holds terminal). |
| D8-5 | CLOSED | `afterPrecheck` releases only when both callers have passed the stale-parent pre-check on the same pointer state, and `inTransaction` counts at least 2, so the loser's `StaleParent` can only come from the CAS (deployment.integration.test.ts:292-315). The rollback race is the same. *Note:* the README still says "five rounds"; the test runs 3. |
| D8-6 | CLOSED | Run and scope labels are HMAC'd under the campaign key (campaign.ts:51-58,203). The test enumerates the plan-format guesses. |
| D8-7 | CLOSED | Failed, cancelled and timed-out runs get no success (campaign.ts:262-264). NT-7 passes with 38 rows kept. |
| D8-8 | NOT CLOSED | New: fake evidence is a hold (admission.ts:264, gate.ts:128). Still open: the real port does not exist, and the FAKE sim still discovers with `referenceSolve` (sim.ts:14,214). The fake label is self-declared by the port and the profile. |
| D8-9 | CLOSED (the control) | A source and manifest scan of every candidate-side workspace, with positive controls. **It is failing now** on runtime-raindrop's new worker files. They must take `COLLECTION_IDS` and `VisibleWorld` from contracts or another visible module, not from `@expunge/fixtures`, which ships `sealed.ts` in the same package. *SPECULATIVE gaps:* computed `import()` specifiers, `createRequire`, and reading private source as text through `new URL`. |
| D8-10, D8-11, D8-12 | Open, not claimed | SPECULATIVE; not blocking. |
| D8-14 | Open | The deployment README still says "real campaigns on the labelled FAKE worker". |
| D8-15 | Open | `EVALUATOR_HASH` sources still omit `reference2.ts` (grade.ts:33-47). |
| D8-16 | Open (LIKELY) | Unchanged. |

**D8-18 (MEDIUM, DEMONSTRATED by reading, and by the owner's own test `attest-none`): one unattested run, or any hold, permanently consumes the candidate.**
- `TrialArm.runtimeHash` is `result?.runtimeHash ?? null` (campaign.ts:266). A timed-out, cancelled or thrown arm, in **either** arm, therefore adds `null` to the attested set.
- That makes `observedRuntimeHash = 'unattested'`, and the rule rejects with `runtime_hash_mismatch` (gate.ts:93-101, admission.ts:150).
- The claim was inserted before the campaign and is never released. So a single infrastructure timeout, even on the parent arm, permanently rejects the candidate under a reason code that misstates the cause.
- Holds have the same effect: `fake_evidence`, `cost_unpriced`, `cost_ceiling_unset` and `trial_pair_incomplete` are documented as "not a decision", but the claim makes them terminal.
- *Fix:*
  - attest over runs that returned a result; runs without one stay failure rows in the denominator;
  - no attested run at all should give a hold `runtime_unattested`, not a reject;
  - a held campaign is resumed under its own claim and campaignId (resumable batches, spec line 436), never re-run as a fresh campaign.
- *NT-18:* one parent-arm `RunTimedOut` among 76 arms. Expected: no `runtime_hash_mismatch`; that row is a failure; the verdict follows the remaining rules.

**C1 (blocking for the Mongo-backed D8-2 and D8-4 claims, DEMONSTRATED static): the new collections have no role grants.**
- `campaign_freezes` and `gate_claims` appear nowhere in `packages/mongo/src/roles.ts` (grep): no role has FIND or INSERT on them.
- Under real RBAC, then, the fixture builder cannot write a freeze, and the grader can neither read it nor insert a claim. The `PrincipalBoundary` refusals in store.integration.test.ts are app-level `requirePrincipal`, not database denials.
- *Required (mongodb-authority):*
  - grants: fixture_builder INSERT on `campaign_freezes`; grader FIND on `campaign_freezes`; grader INSERT on `gate_claims`; no UPDATE or REMOVE for anyone;
  - validators and indexes;
  - raw-driver denial tests: grader UPDATE or INSERT on `campaign_freezes`, and proposer FIND or INSERT on `gate_claims`, are denied by the server.

## Not yet reviewed

- `report.ts`. It is under edit, so it moves to the closure re-read.
- Checks: none run. The tree is mid-edit. They run on the owners' settled checkpoint.

```
EFFECTIVE_MODEL: claude-opus-5-5
OWNED_PATHS: docs/review/DA-8-gate-deployment.md
CHECKS: none run (draft)
FINDINGS: demonstrated=6 likely=5 speculative=6 (pass 2 adds D8-15, D8-16, D8-17)
BLOCKED: closure waits for the rsi-evolution fix pass (active at 13:09Z) and the mongodb-authority D8-3 fix
STATUS: PARTIAL (closure re-read done; PKT-24/25 blocked on D8-3, D8-8, D8-18, C1 and the D8-9 failure)
```

## Pass-2 fix re-read (2026-10-11, about 13:55Z, checkpoint 20261011T133950Z-e041ccfe)

**Pin.** `npm run checkpoint:verify` on the checkpoint: pack MATCH=394, CHANGED=0. Six worktree changes, all outside rsi-evolution's files (domain controls and budget, four privacy tests). **Checks:** `npx vitest run packages/gate packages/grader` (node 24.13.1) exits 0: 16 files passed and 1 skipped; 200 tests passed and 11 skipped (store.integration, no `MONGODB_TEST_URI` in the reviewer shell). The D8-9 import boundary now passes: `apps/worker/src` has no `@expunge/fixtures` import (grep).

| Item | Disposition | Basis and notes |
|---|---|---|
| D8-15 | CLOSED | `EVALUATOR_HASH` includes `indexedSolverHash` and lists `reference2.ts` among its sources (grade.ts:41-45), so its bytes enter the hash by construction. |
| D8-16 | CLOSED, with a required note | The claim and report identity is (parent, `executableProjection(child)`), without `evidence` and the guardrails' `sourceEvidenceIds` (freeze.ts:97-112). Promotion recomputes it from the stored child (stored.ts:83). `maxAttemptsPerParent` counts every claim. *Residual:* renames that do not change behaviour (`ruleId`, workflow node ids, array order) still give a new projection; the attempt cap is what bounds them. *Required:* the gate report carries the parent's attempt count and this candidate's ordinal, so admission over k attempts is disclosed. *LOW:* the cap is count-then-insert (freeze.ts:196-199), so concurrent claims can exceed it by the concurrency. |
| D8-18 | CLOSED, with a note | Attestation covers only runs with `hadResult`. None gives a hold, `runtime_unattested` (admission.ts:157). Mixed attestations reject. A crashed campaign settles `failed`. A held campaign resumes only under its own claim and campaign ID. NT-18 is at da8.test.ts:232. *Note (LOW-MEDIUM):* a resume re-runs the whole campaign, and held reports and trials are not stored. Executed episodes are therefore dropped from the record (spec lines 297 and 436: record actual counts, keep failed attempts). Store the held outcome and its rows as a non-admitting record, or reuse its completed pairs on resume. |
| D8-17 | PARTIAL (not blocking; the lead did not require it) | `rollbackDeployment` requires `expectedScopeRevision` and refuses an `authority_expansion` reverse transition with `RollbackNeedsGrant`. *Gap:* it does not apply `approvalRequired(reverse.mutationClass, policy)`, so under `behavioralRequiresApproval` a behavioral rollback needs no grant. The in-transaction scopeRevision CAS and grant consumption are pending in `DeploymentRepository.rollback` (mongodb-authority). |
| D8-14 | CLOSED, with a note | The README now says the reports come from FAKE campaigns re-decided by a TEST-ONLY helper, and that the race runs 3 rounds in tests and 5 in the script. It still says "a decision-ledger proof that a new run is decided by the child bundle". State whether that row comes from a run or from setup. |
| D8-8 | Recorded open item (lead ruling) | Fail-safe through the `fake_evidence` hold. |

**Still blocking PKT-24 and PKT-25:** C1 (no role grants for `campaign_freezes` and `gate_claims`) and D8-3 (`JobRepository.create`), both mongodb-authority's. The D8-16 attempt-count disclosure is a small required addition.

## Post-disposition edits (2026-10-11, about 14:30Z)

`npx vitest run packages/gate` exits 0: 6 files passed and 1 skipped; 116 tests passed and 11 skipped.

- **D8-16 report field: CLOSED.** `admittedUnder.attempt = { ordinal, parentAttempts }` is in the digest (report.ts:83-84,121). The cap is now one atomic conditional upsert-increment on `gate_attempts`. Past the cap the upsert collides (E11000) and gives `AttemptCapReached`, and a failed claim insert is compensated (freeze.ts:216-245). A crash between the increment and the insert leaves one attempt consumed, which fails safe. `gate_attempts` is a third new collection, so it joins C1 (role grants).
- **D8-17 gate side: CLOSED.** `approvalRequired(reverse class, stored policy)` applies the same rule as promotion. `RollbackTargetIsActive` is checked before classifying (promote.ts:106-114). Grant consumption inside the transaction is still mongodb-authority's.
- **D8-14: CLOSED.** The decision-ledger phrase is reworded.
- **D8-18 held trials: OPEN (required by the lead's ruling, 14:15Z).** Executed episodes of a held campaign must be persisted as non-admitting rows and kept in the record.

## D8-18 and D8-16 follow-up (checkpoint 20261011T135423Z-180e62de, about 14:40Z)

`checkpoint:verify` gives pack MATCH=401, worktree MATCH=1107, CHANGED=0. `npx vitest run packages/gate` exits 0: 6 files passed and 1 skipped; 117 tests passed and 12 skipped.

- **D8-18: CLOSED.**
  - A held verdict saves its executed trials, freeze hash and reasons to `gate_held_runs`. That store is insert-only and keyed by claim, campaign and attempt (freeze.ts:268-330, gate.ts:175-183).
  - A resume lists them into the report as recorded-but-excluded `superseded_by_resume` entries, and their spend counts in `report.cost`.
  - *Notes:*
    - `gate_held_runs` is a FOURTH new collection for C1 grants, with grader insert and find only.
    - A campaign that crashes (claim `failed`) still loses the trials it had executed before the throw. That is LOW, and disclosure is enough.
    - The number of resumes is unbounded. That is acceptable: a hold has no reject reason, so a resume cannot fish for admission, and its cost is reported.
- **D8-16 README disclosure: CLOSED** (gate README:35).
- **D8-17 gate side: CLOSED** (as recorded above). Grant consumption inside the rollback transaction is still mongodb-authority's.

**Remaining DA-8 blockers for PKT-24 and PKT-25:**
- C1: grants, validators and raw-driver denials for `campaign_freezes`, `gate_claims`, `gate_attempts` and `gate_held_runs`.
- D8-3: `JobRepository.create`.
- Consumption of the rollback grant in `DeploymentRepository.rollback`.

All three are mongodb-authority's. Nothing in rsi-evolution's files blocks.

## D8-3 closure read, PKT-44 (2026-10-11, about 15:50Z)

This is a static read of `packages/mongo/src/jobs.ts`, `worlds.ts`, `roles.ts` and `validators.ts`. I did not run the replica-set tests; verifier-2 is running them.

| Criterion (from the D8-3 request) | Disposition | Basis |
|---|---|---|
| (a) creation restricted per job kind | CLOSED | `JOB_CREATOR_PRINCIPALS`: cleanup only by domain_executor or promoter (jobs.ts:59-71,116-117). |
| (b) a cleanup is pinned to the deployed harness | CLOSED | A non-setup cleanup must equal the scope's pointer, else `HarnessNotDeployed` (jobs.ts:124-126). |
| (d) the grader creates evaluation runs only on campaign worlds | CLOSED | `createCampaignJob` is grader-only and requires all of: the world binding names the campaign, a freeze row, an open claim, and the harness is the claim's parent or a child with the claimed projection (jobs.ts:136-160). The grader cannot use `create` for cleanup at all. |
| (c) the worker re-verifies the pin at start | **NOT CLOSED: not wired** | `assertHarnessDeployed` exists (jobs.ts:206-214), but nothing in `apps/worker` or `packages/runtime` calls it (grep: only jobs.ts and its test). The packet's statement "assertHarnessDeployed at worker start" is not true of the tree. Either the worker dispatcher calls it before it runs a cleanup (runtime-raindrop), or the lead records that a queued job keeps its pin (spec line 205: existing runs stay version-pinned; live revocation still applies) and the claim is removed from the packet. |

**The campaign-world skip: no hole for a single principal.**
- Only fixture_builder and setup can write `world_scope_bindings`, both in the app (`WorldRepository.create` and `rebind`) and in RBAC.
- `EXECUTOR_WORLD_WRITES` excludes it (roles.ts:13-22). The other runtime principals only FIND it (roles.ts:88,212).
- So no worker, grader, observer or proposer can mark a production world as a campaign world.

**Residual (LOW).** fixture_builder's raw UPDATE right on `world_scope_bindings` could add `campaignId` to an existing production world. Together with a grader holding a matching open claim, that would let a non-deployed harness run on a production world. It takes two trusted principals.
- *Hardening:* `createCampaignJob`, and the skip, also require the world to be outside any production scope (for example, the scope has no worker deployment pointer, or the env is the evaluation env). Alternatively, make `campaignId` settable only at `create` and verify it against the campaign's freeze row's scope.

**D8-3 overall: NOT CLOSED until (c) is wired or explicitly waived by the lead.**

**Lead ruling on D8-3 (about 16:00Z).**
- (c) stays NOT CLOSED and is not waived. runtime-raindrop's PKT-33 follow-up wires `assertHarnessDeployed` at run start: after the claim, before any model or tool call, for cleanup only. `HarnessNotDeployed` fails the run with a committed reason and no effects.
- The required test moves the pointer between create and claim.
- PKT-44 lands as the repository half, and its commit message will not claim worker-start enforcement.
- The campaign-world hardening (no production pointer, or the evaluation env) goes into mongodb-authority's collections packet.
- I re-read (c) when the follow-up arrives.

## D8-3 (c) re-read, PKT-54 (2026-10-11, about 16:30Z)

**Pin.** `followup-hashes.txt` (19 paths) matches the tree. `npx vitest run apps/worker` exits 0: 5 files passed and 5 skipped; 84 tests passed and 25 skipped. The replica-set suites, including `dispatch.integration.test.ts` with the pointer-moved case, are skipped in my shell; the verifier runs them.

- **D8-3 (c): CLOSED.**
  - The order is: claim (dispatch.ts:418), then `refuseIfNotDeployed` (:428), then `job_started` (:437), then execute, which is where context inputs are recorded (:539) and the model runs.
  - `HarnessNotDeployed` writes a terminal checkpoint (`refused_at_start`, the reason, zero calls), finishes the job `failed` with no effects, and projects `job_failed`. There is no `job_started` and no episode.
  - Any other error releases the job untouched (`deployment_check_failed`).
  - The check applies to cleanup only and skips campaign worlds (the repository rule from PKT-44).
  - `domain-tools.ts` is gone: the worker uses the real provider.
- **The attestation cannot be supplied by a caller.**
  - `attestedRuntimeHash` is `runtimeHash()`, computed in the worker process (index.ts:66) and passed in as a dependency.
  - The checkpoint writer seeds it and keeps it across `replace` (dispatch.ts:236-265). The `update` patches carry only meter or phase keys.
  - Neither the domain nor the mongo package writes the field (grep).
  - Residual (disclosed, not a defect): it is the worker build's self-attestation, at the same trust level as the worker. Any holder of the `domain_executor` lease could write the checkpoint, so it is not an external measurement.

D8-3 is now fully CLOSED: (a), (b) and (d) since PKT-44, and (c) here.
**PKT-24/25 remaining blockers:** C1 (grants for the four gate collections, with the campaign-world hardening) and consumption of the rollback grant inside the transaction.
