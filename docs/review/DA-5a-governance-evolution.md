# DA-5a: governance and evolution review (devils-advocate)

Reviewer: devils-advocate, effective model `claude-opus-5-5`. Date 2026-10-11. This is a reading-based review with
negative-test specifications. I wrote no exploit scripts and edited no product code. Findings go to the coordinator
only; the owners are frozen on packet paths until commits land.

Base: HEAD c45be9b at the time of reading (governance from c663bfd, evolution from cd821d6).

Read-only commands run:
- `env -u MONGODB_TEST_URI npx vitest run packages/harness-compiler packages/evolution packages/governance` -> exit 0.
  10 files passed, 2 skipped (the replica-set lanes); 182 tests passed, 4 skipped.
- `npx tsx packages/evolution/scripts/c2-evidence.ts` -> exit 0 ("61/61 categories rejected").
- One inline check of `PolicyEvaluator.decide`, run from my scratchpad and not committed, used to confirm G1 and G2.

## 1. Files reviewed (sha256 prefix)

```
6e00701a50e9dc56 packages/governance/src/evaluator.ts     9b8651ea0272976e packages/governance/src/facts.ts
b8d13fcda49be67d packages/governance/src/floor.ts         93637b484f90e9b0 packages/governance/src/ledger.ts
a02a94bff5b6a935 packages/governance/src/owner-policy.ts  7a715ca206a39bbf packages/governance/src/revocation.ts
a265858f8e6b6636 packages/governance/src/index.ts         fe5fa034f4a99d59 packages/governance/test/governance.test.ts
e0c23ba6ede14f64 packages/governance/test/ledger.integration.test.ts
18e15388620d5881 packages/evolution/src/critic.ts         52f1cb3558452ac9 packages/evolution/src/evidence.ts
b9764f7a64328363 packages/evolution/src/fake-model.ts     ae591a622e81017b packages/evolution/src/model.ts
1dfff9312b73bfe3 packages/evolution/src/propose.ts        57796a7a841fffef packages/evolution/src/replay.ts
71108c88eef0d1c8 packages/evolution/src/search.ts         0c712de0bf055461 packages/evolution/src/index.ts
f729c35d75579e32 packages/evolution/scripts/c2-evidence.ts ab73cc6ee2be3b8f packages/evolution/test/helpers.ts
43678301bfc33514 packages/evolution/test/propose.test.ts  6a4fdaa058dda05d packages/evolution/test/replay.test.ts
7cbcd8c7720e18f3 packages/evolution/test/search.test.ts   a275c7989c77a593 packages/evolution/test/evidence.test.ts
ed7d82aa15833516 packages/evolution/README.md             16f3e02aa8085a07 packages/harness-compiler/test/rejection-catalog.ts
273d8f5921a535a9 packages/mongo/src/effects.ts            10c248b2cd1b9216 packages/mongo/src/decisions.ts
1828a4af8f5288cd packages/mongo/src/scope.ts              0cb07ef6d3776561 packages/mongo/src/worldkey.ts
a1eb46ce0c612e87 packages/domain/src/env.ts
```

## 2. Findings, ranked (each with the negative test the owner should add)

### HIGH

**G1. The gateway's floor is not bound to the stored owner floor.** Owner: governance (evaluator) and the domain
env.
- `PolicyEvaluator` (`governance/src/evaluator.ts:34-63`) checks tools and effects against the `floor` it was
  constructed with. It never compares `bundle.authorityFloorHash`, or the stored `authority_revisions.floorHash`,
  with `floor.hash`.
- `createDomainEnv` defaults that floor to `DEFAULT_AUTHORITY_FLOOR` (`domain/src/env.ts:43`).
- Inline check: a bundle naming a floor without `delete`, evaluated with the default floor, gets `allow` for a
  `delete` batch.
- Consequence: an owner who tightens the floor (`AuthorityRepository.bump(key, newFloorHash)`) is enforced at
  promotion, at compile time and by `liveFloorValidator`'s identity check. The per-call tool and effect allowance,
  however, still uses whatever floor the worker process was configured with.

Negative tests:
1. `governance/test/governance.test.ts`: construct `new PolicyEvaluator(bundle{authorityFloorHash: F2.hash}, F1)`
   with `F1.hash !== F2.hash`. Expect the constructor to throw `FloorMismatch`, or every `decide()` to return
   `deny` with `gateway:floor_mismatch`.
2. Domain env test: the stored authority row names floor hash H. `createDomainEnv` must resolve the floor object
   whose hash is H from a registry of known floors and refuse any other with `AuthorityFloorUnknown`. The default
   floor must never silently stand in.

**G2. An effect call with an unknown batch skips the effect-kind floor check (fails open).**
- `evaluator.ts:51` checks `if (snapshot.batch && !floor.allowedEffects.includes(...))`.
- Inline check: `toolId: 'apply_cleanup_batch'`, `batch: null`, a current preview plan, and a floor excluding
  `delete` returns `allow` with no rule IDs.
- `facts.ts:20` says only apply decisions carry a batch, so a gateway that decides apply before it has computed the
  batch is allowed.

Negative test (`governance.test.ts`): `decide()` for any effect tool (`apply_cleanup_batch`) with `batch: null`
must return `deny` with a gateway rule such as `gateway:batch_unknown`.

### MEDIUM

**G3. Expected document versions are never enforced, and partial batches commit silently.** Owner:
mongodb-authority (effects).
- `ActionIntent.expectedDocumentVersions` is not referenced anywhere in `packages/mongo/src`, `packages/domain/src`
  or `packages/governance/src` (grep). Spec 6(e) asks for exact target, preimage and version binding.
- `commitEffect` refuses more applied effects than targets (`effects.ts`, "UnboundedEffectResult") but accepts
  fewer, so a batch where some targets matched nothing commits with no per-target outcome.

Negative tests (`packages/mongo/test/integration.test.ts`):
1. An intent with `expectedDocumentVersions: [{A, 1}]` while A has `_rev` 2 must be refused with
   `StaleDocumentVersion` before `apply`.
2. An `apply` returning fewer effects than `targetAddresses` must be refused with `PartialEffect`, unless every
   missing target carries an explicit typed outcome (e.g. `retained`/`absent`) recorded on the receipt.

**G4. `liveFloorValidator` trusts a caller-supplied bundle.**
- `revocation.ts:11-19` compares the stored floor with a `bundle` argument that nothing ties to the job's pinned
  `binding.harnessHash`.
- The repository's own integration test (`ledger.integration.test.ts:121-131`) passes the same job with a
  different floor hash, and that commit succeeds.

Negative test: build the validator from the job, loading the artifact named by `job.binding.harnessHash` inside
the session. A validator given a bundle whose hash differs from the job's pinned hash must throw
`BundleBindingMismatch`.

**G5. `ScopeRepository.writeField` can change the world outside an effect transaction.** Owner: mongodb-authority.
- `scope.ts:347-377`: `session` is optional.
- A standalone call changes a domain record with no ledger decision, no job fence and no world-revision advance.

Negative test: `writeField` without a session (or without an effect-context token that only `commitEffect` issues
to `apply`) must throw `EffectTransactionRequired`.

**E1. Candidate selection is measured on the incident's own ledger (in-sample).** Owner: evolution.
- `W0_LEDGER` is documented as "The W0 run behind incident A" (`evolution/test/helpers.ts:195`).
- The guardrail candidate's "2 fixes, 0 regressions" (`propose.test.ts:73`) are that run's two
  `complete_unverified` rows.
- `runEvolutionRound` stops on, and ranks by, those fixes (`search.ts:31-40`, `80-89`).
- Replay is honestly labelled diagnostic, but candidate selection still uses this in-sample signal.

Negative test (`search.test.ts`): make the replay report split flips into `inSample` (rows whose `runId` is the
`binding.runId` of an incident bundle in the packet) and `heldOut`. With a corpus whose only fixes are in-sample,
the round must not report `stopped: 'good_candidate'`, and selection must use held-out fixes or flag
`in_sample_only`.

**E2. A rule's standing is not attributed to the evidence it cites.** Owner: evolution and harness-compiler.
- Citation existence is checked against a global catalog with no job or run binding (`compile.ts:38-59`,
  `331-347`).
- The critic grants standing for any flipped corpus row (`critic.ts:17-55`).
- So a rule citing incident C earns standing by flipping rows of incident A's run. The spec asks for "individual
  evidence and attributable effect".

Negative test: a corpus containing only `run_a01` rows, and a trace-informed rule citing incident C evidence. The
replay report must show `attributedFlips: 0`, and trace-informed admission must require at least one attributed
flip. Control arms should be reported with their attributed and unattributed counts, not rejected, so the
wrong-incident comparison stays meaningful.

### LOW

**G6. Decision records are insert-only by privilege, not tamper-evident, and a re-record hides a mismatch.**
- `decisionId` hashes the identity and decision body. `inputsDigest` is stored but not bound into the ID, and
  there is no hash chain or HMAC.
- Only `domain_executor` has FIND and INSERT on `decisions` (role manifest); no runtime principal has UPDATE or
  REMOVE.
- `DecisionRepository.record` swallows a duplicate key and returns the caller's new object, not the stored row. A
  re-decision with different inputs therefore keeps the first inputs while the caller believes the second were
  recorded.
- The docs make no tamper-evidence claim, which is honest.

Negative test (`packages/mongo/test`): record the same identity and decision twice with different `inputs`. Expect
either `DecisionInputsConflict`, or a returned record equal to the stored row (first `inputsDigest`).

**G7. The approval-grant binding is hard-wired to null.** `facts.ts:71` sets `approval_grant: null`, so any
prerequisite on `approval_grant` always denies. That fails closed, but no workflow that needs approval can ever
proceed. Negative test: keep a test asserting today's deny, and add the positive case when grants are wired.

**E3. The evidence script's "61/61 rejected" is weaker than the test.** `c2-evidence.ts:97-101` counts any
rejection, whereas `rejection-catalog.test.ts:14` requires the specific code. Make the script require
`rejection.codes.includes(code)`.

**E4. The fake model's control-arm separation is constructed.** The fake picks surfaces with keyword regexes over
the packet text (`fake-model.ts:19-24`, `182-186`), so the score-only arm, which carries no text, differs by
construction. It is labelled as a fake in its README. Negative test: records with `modelKind === 'fake'` must be
refused by whatever exports campaign evidence.

## 3. Answers to the coordinator's questions

- **Can a caller reach an effect without a ledger decision ID?** Not through `commitEffect`: it requires the
  derived `decisionId` and `DecisionRepository.verify` (allow, same scope, identical identity and decision body)
  inside the transaction. Yes through `ScopeRepository.writeField` used standalone (G5), and through raw
  `domain_executor` writes, which are collection-level RBAC (DA-1 S2). `complete()` takes no decision, by design.
- **Can a candidate lower the floor through an evolvable surface?** Not through the bundle: the compiler requires
  `authorityFloorHash` to equal the floor it was given (`compile.ts` infrastructure checks), limits are validated
  against `maxLimits`, and promotion requires the child's floor to equal the stored floor. The gap is at the
  gateway (G1): the floor actually enforced per call is configuration, not the stored floor.
- **Can an owner-policy effect apply twice or partially?** The same logical effect cannot apply twice: the effect
  key is derived and replays (DA-4 L7). Two batches naming the same record are not refused at plan level, and
  partial batches are accepted (G3). No apply tool exists yet in `packages/domain`, so there is no single-update
  claim to review.
- **Does revocation affect an in-flight job?**
  - Effects: yes. Each effect fences `authority_revisions`/`authority_touches`, `record()` refuses a stale
    revision, and a floor change always bumps the revision.
  - The floor-identity validator: caveat G4.
  - Reads: nothing cancels the job on `bump`. Whether read tools stop is for DA-5 (domain tool surface not wired).
- **Is unknown ever collapsed to allow?** Not in guardrails. In the strong Kleene semantics an unknown predicate
  fires deny/ask rules (`semantics.ts` `ruleFires`), and a missing prerequisite binding denies. Yes in the gateway
  for an unknown batch (G2).
- **Are decision records tamper-evident?** No hash chain and no HMAC. Integrity rests on insert-only privilege plus
  a content-derived `_id`; the docs do not claim more (G6).
- **Can a proposal cite a nonexistent or foreign event and pass?** A nonexistent ID is rejected twice:
  `citation_rejected` against the packet, and `evidence_not_found` against the catalog. A foreign ID cannot be
  cited by the trace-informed arm, because the packet holds only the incident's IDs. But standing is not tied to
  the cited incident (E2), and the catalog has no job or world binding.
- **Does as-of replay read newer state?** Evaluation does not: `asOfInput` nulls inputs observed after
  `decidedAt`. Note that the gateway stamps every input with the decision time (`ledger.ts:41-46`), so clipping
  never fires on real rows. Flip labels do use later outcomes (`row.outcome`), as documented, and search selection
  uses those labels (E1).
- **Is "2 fixes, 0 regressions" measured on the mining ledger?** Yes (E1).
- **Does the catalog match the codes the compiler emits?** Yes for rejections. `Issue.code` is typed
  `RejectionCode`, the catalog keys equal `REJECTION_CODES` (61), and each case asserts its own code.
  `claimed_class_mismatch` is a diagnostic, deliberately not a rejection. The script summary is weaker than the
  test (E3).
- **Does the fake share code with the provider path?** It shares everything from `proposalSchema` onward:
  citation check, compile, replay, search. It does not share prompt building or structured output. So a
  control-arm result from the fake does not transfer to a real model (E4).

## 4. Carried to DA-5 (domain gateway), reading only

- `worldKeyOf(job)` (`mongo/src/worldkey.ts:38-40`) brands any job-shaped object, so the `WorldKey` capability
  shows a key was minted by the module, not that its job was read from storage. Negative test: there is no public
  minting from a caller object; `JobRepository.worldKey(actor, jobId)` reads the stored job and mints from it.
- The domain read tools (`packages/domain/src/tools/*`) show no authority-revision check yet; revocation mid-run
  must stop reads too. To be re-checked when the tool surface is exported.
