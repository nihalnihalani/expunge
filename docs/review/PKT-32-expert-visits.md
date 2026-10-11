# PKT-32 challenge: expert-static workflow visits

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11 ~13:20Z. Read-only review of the working-tree diff to `packages/baselines/src/index.ts` and `test/baselines.test.ts`, plus one measurement script run.

**Disposition: REJECT as a scientific-control fix.** The diff is harmless as a stopgap. But it does not make expert-static a functioning control, and it hides a defect that also breaks W0.

## DEMONSTRATED

- **One batch per round.** Under gateway enforcement, an apply that leaves batches remaining still ends `success`.
  - `gateway.ts:151-154` maps only discover (`more_references`) and verify (`verification_failed`) to non-success outcomes.
  - `apply-cleanup-batch.ts:230` reports `batchesRemaining`, but the outcome ignores it.
  - Neither graph has `apply -> apply` on `success`; that edge exists only on `retryable_error`.
  - So expert goes to `verify` after batch 0, and W0 goes to `complete`.
  - Batches are split by effect kind and by 25 documents (`plan.ts:23-35`).
- **Batches per world, measured.** Script: `scratchpad/effects-per-world.ts`, `npx tsx`, exit 0. Counts use the batching rule on the generator manifests (a test master seed for the split plan).
  - **Every** world has at least 2 batches.
  - 4 batches: mixed_eligibility, composed_holdout and archive_bridge (2 of 8 protected, 2 of 8 validation, 12 of 24 final).
  - 2 batches: everything else.
- **Consequences under enforcement:**
  - **W0** applies batch 0 and must complete. It fails 100% of worlds for a mechanical reason, not a discovery reason. Trigger gains against W0, and protected non-regression against W0, become trivial.
  - **Expert, old graph** (preview 1): it cannot start round 2, so it completes 0 worlds.
  - **Expert, new graph** (preview 2, apply 2, as job-wide totals): at most 2 batches, one per round. It can never complete a 4-batch world: 12 of 24 final worlds are impossible by construction. A single `retryable_error` on any apply also exhausts apply visits, so partial_retry worlds (transientFailures 1, interrupts 2) are lost as well. Under the old value (apply 3) one retry was possible.
- **The visit budget cannot absorb this.** The compiler bounds the summed maxVisits by `limits.toolCalls` = 12 (`harness-compiler/src/workflow.ts:192-198`). Four batches through rounds needs 4 previews, 4 applies and 4 verifies plus discover, which exceeds 12.

## Effect on the comparison

The arms are not equally handicapped. The evolved arm can learn the `apply -> apply` edge, or extra visits, as a workflow mutation, and W0 and expert-static cannot. A primary-endpoint win "evolved vs expert-static" on the final split would then be largely a harness-plumbing artifact. Spec lines 406 and 440 require the controls to be genuine, and a tie to be reportable.

## Required fix (before PREREGISTRATION freeze; it is DRAFT, so allowed with an amendment note)

1. Outcome vocabulary (frozen contract, lead decision): add `more_batches` (or equivalent).
   - `outcomeOf` returns it for apply when `batchesRemaining > 0`.
   - Both baselines get `apply -> apply` on `more_batches`, with apply maxVisits of at least max batches (4) plus one retry.
2. Re-fit both baselines inside `toolCalls` 12, or raise `toolCalls` equally for every arm before the freeze.
   - Example for expert: inspect 1, resolve 1, discover 2, preview 2, apply 4, verify 1, complete 1 = 12. This keeps one verification-failure re-entry but no retry if all 4 batches are used. Raising `toolCalls` is cleaner.
3. Test at runtime, not by walking the graph:
   - each baseline completes a 4-batch mixed_eligibility world and a partial_retry world through `admitTransition` / `advance` with real tool outcomes;
   - W0 still fails because it has no verification, not because it is blocked after batch 0.
4. Old graphs: do not run them as conditions (they are non-functional under enforcement). Record their bundle hashes and this reason in the PREREGISTRATION amendment log. Invalidate any gate or campaign row produced under them.

## Superseded: amendment A-1 (2026-10-11 ~13:30Z)

PKT-32 was withdrawn. Amendment A-1 (PREREGISTRATION.md "Amendments", the ACCEPTANCE.md Worker execution row, `packages/baselines/src/index.ts`) does three things:
- adds a `batches_remaining` outcome;
- raises the call ceilings 12 to 16 for every arm;
- sets visits: expert discover 3, preview 2, apply 6, verify 2 (sum 16); W0 apply 5.

**Disposition: ACCEPT-WITH-NOTE.**

1. **Legitimate, not scope tampering.**
   - The spec (line 426) allows recorded, justified amendments to measured ceilings before results. Only reductions need owner authorization.
   - The measured basis checks out. On my count, all 42 split worlds need at least 2 apply batches and 16 of 42 need 4; that is 12 of 24 final worlds.
   - Note to add: the FAKE c3-evidence and test gate reports were produced under the pre-A-1 baseline bundle hashes. State in A-1 that they are not results and are invalid for any campaign.
2. **Fairness (LIKELY): the binding constraint moves to the unchanged token and wall-time caps.**
   - Expert `maxContextTokens` is 12,000 and W0's is 6,000, against a 24,000 total per episode (meter.ts:104,140 counts input plus output across calls).
   - With up to 16 model calls, the token cap, not the call cap, will end expert episodes first. 120 s for up to 16 model and 16 tool calls is similarly tight on a real provider.
   - Required before the freeze: a measured token and wall-time profile per baseline on a 4-batch world. If either cap binds, raise it equally under A-2 before any result.
3. **Merging batches: not recommended.** Effect kind is a per-batch guardrail and approval fact, and the per-batch logical effect identity is what DG6 deduplicates. Residual (SPECULATIVE): more than 25 same-kind targets adds batches, so a Hider world with 5 or more batches exceeds every baseline's apply visits. Hider admission should bound batches per plan, or this should be disclosed.
4. **Not fakeable by the model.**
   - `batchesRemaining` is computed from the stored plan and `committedBatchCount` over committed receipts (apply-cleanup-batch.ts:58-66,230). The model supplies only an ordinal.
   - An out-of-order ordinal is refused (line 145).
   - Replaying a committed batch returns `batches_remaining` until every batch is committed, so `success` cannot come early.
   - Residual: the prefix read is not lease-fenced (DG5, DA-5).
   - Test gap: the baselines test walks the graph. A JobGateway test on the replica set is needed: a 4-batch plan gives outcomes batches_remaining x3 then success; a replay of ordinal 0 mid-plan is not success; a skipped ordinal gives BatchOutOfOrder and no visit is used. This goes into the DA-5/PKT-16 re-read.
5. **Disclosed limitation.** Expert visits sum to exactly the cap. One apply retry in a 4-batch first round leaves one apply for the second round.
