# DA-11: from-scratch review of the rebuilt `packages/gate`

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. The old DA-8 closures are void: they bound to lost bytes.

**Pin.** The gate was being edited and re-staged while I read it. While I reviewed, `gate.ts` changed (the V-2 fix) and
the package went from staged to untracked. This review binds to the bytes I snapshotted at 12:54 PDT: 24 files, list at
`<scratchpad>/da11-pin.txt`, for example `gate.ts 3f941f9c5736`, `admission.ts aab6e722d44c`, `mongo-port.ts
bcdfe0710df0`, `claims.ts 395518501a16`, `da8.integration.test.ts c0034c34d9a3`. If the committed bytes differ, re-pin.

**Execution.** `MONGODB_TEST_URI=<my own replica set, project expunge-da, port 27618> npx vitest run packages/gate`
gives exit 0: **5 files, 65 tests passed**. This run used the gate snapshot. It also used the working-tree fixtures
change, which drops the vacuous overlap checks (DA-10 V-1).

The finding-to-test table from rsi-evolution was not available to me, so I checked each DA-8-named test by reading what
it actually asserts (§4).

## Dispositions

| Area | Disposition | Class |
|---|---|---|
| A. Can any path admit without real committed evidence? | **BLOCK for any consumer of `gate_reports`** (promotion, grant issuer, operator "admitted" state) until F-1 is fixed. Committing the code is acceptable only if it is labelled "admission rule verified with a scripted port; real admission not enabled". | DEMONSTRATED |
| B. Holds versus rejects | **ACCEPT-WITH-FOLLOWUP.** F-3 (configuration mismatches permanently reject a candidate) should be fixed before any real campaign. F-6 (no limit on resumes) can be capped or disclosed. | DEMONSTRATED / LIKELY |
| C. Attempt cap and rerun refusal races | **ACCEPT-WITH-FOLLOWUP** (F-4, F-5) | DEMONSTRATED / LIKELY |
| D. Report digest and class derivation | **ACCEPT**, with notes N-1 and N-2 (one for the deployment rebuild) | — |
| E. Principal use (no `setup` in src) | **ACCEPT-WITH-FOLLOWUP.** Src is grader and fixture-builder only, except one allowance (F-8). The real composition still needs `setup` (F-9). | DEMONSTRATED |
| F. Leakage of held-out or final-split data | **ACCEPT-WITH-FOLLOWUP.** No final-split leak found. Per-pair protected and validation rows sit in the report (F-10), and held-out world instances are kept (F-11). | DEMONSTRATED / LIKELY |
| G. `LocalLaneHost` shim is test-only | **ACCEPT.** It is defined only in `test/real-path.integration.test.ts:74`, not exported, and nothing in src uses it. But the scripted port ships in `src/testing` behind a package export (F-7). | DEMONSTRATED |
| Fix in this packet (one line) | F-2: the `sourcesIneligible` hook can switch off the eligibility check | DEMONSTRATED |

## Findings

### DEMONSTRATED

**F-1 (HIGH): admission rests entirely on what the port says about itself.**

`evaluateAdmission` decides that evidence is real from three values the port supplies:
- `config.port.kind`;
- `config.port.profile.modelKind`;
- each arm's `evidence === 'committed'` (`admission.ts:231-236`).

`MongoEpisodePort`, the production port, hard-codes all three:
- `readonly kind = 'worker'` (`mongo-port.ts:127`);
- `modelKind` is a constructor argument (`mongo-port.ts:130-136`);
- `evidence: 'committed'` is a literal on every return path (`mongo-port.ts:200, 212, 236`), including `setupFailure`.

The runtime attestation does not cover the model either. The worker writes `checkpoint.attestedRuntimeHash` from a value
handed to the `Dispatcher` constructor: `runtimeHash: RT` in `test/real-path.integration.test.ts:175`, and
`runtimeHash()` in `apps/worker/src/index.ts`. A Dispatcher wired with `FakeChatModel` therefore attests the genuine
runtime hash. Nothing the gate reads tells a fake model from a provider model.

The gate also does not read the job row itself. The arm's runtime hash, outcome, receipt and cost come back through the
port from the injected `WorkerRunner` (`mongo-port.ts:166-214`). Only the world read-back (`readWorld`, grader
principal, majority read) is independent.

Demonstration in the packet's own tests:
- `test/gate.integration.test.ts:18-38` stores an `admit` report produced by `ScriptedEpisodePort`, which solves worlds
  with the grader's reference solver, when it declares `{kind: 'worker', modelKind: 'provider', evidence: 'committed'}`.
- `GateStore(promoter).readReport` then returns `verdict: 'admit'`, `computedClass: 'behavioral'`.
- The only trace of what happened is the free-text `admittedUnder.evidence.portLabel` inside `causalControls`.

`sim.ts:5-8` says outright that this declaration "is the same self-attestation the real rule must not trust". The rule
does trust it. DA-8 D8-8 ("the port self-attests what admission relies on") is therefore still open, and no test covers
it.

Required before anything consumes a report:
- (a) The worker records the resolved model (provider, model id, adapter class, with `FakeChatModel` and
  `FixedModelResolver` stamping `fake`) in the job checkpoint at claim, next to the runtime attestation.
- (b) For every arm, the gate reads the job row with its own grader principal (it has FIND on `jobs`). It checks:
  - `jobId` exists;
  - the job is a campaign job on this instance's world;
  - `binding.harnessHash` equals the arm's bundle hash;
  - the terminal status is consistent with the reported outcome;
  - the checkpoint's attested runtime and model match the freeze.
  Completion receipts need a grader FIND grant, or a check through `completion_receipts` by the reader principal.
- (c) `fake_evidence` is derived from (b), never from `port.kind` or the profile.
- (d) A test proves that a real runner with a `FakeChatModel` and a profile declaring `provider` is HELD.

**F-2 (MEDIUM): a caller can switch off the source-eligibility check.**

`gate.ts:118`: `(await config.sourcesIneligible?.(child)) ?? evidenceIneligible(child)`. A hook that returns `false`
replaces the built-in check, because `??` only falls through on null or undefined. A child whose evidence is `revoked`
or `display_only` is then admissible.

Separately, the built-in check reads the child bundle's own self-declared `permittedUse` labels (`gate.ts:83-86`). It
does not consult `artifact_eligibility` or `provenance_edges`, and the grader has FIND on both.

Fix:
- Combine the two with OR, so the hook can only add ineligibility.
- Make the built-in check read the stored eligibility of every evidence reference.

**F-3 (MEDIUM): configuration and deployment mismatches permanently reject the candidate.**

The claim is taken (`gate.ts:138`) before `evaluateIntegrity` (`gate.ts:180`). An integrity failure becomes a stored
`reject` report with a permanent `_id` and spends one of the parent's attempts. This applies to
`evaluator_hash_mismatch`, `fixture_generator_hash_mismatch`, `compiler_hash_mismatch`, `worker_profile_mismatch` and
`budget_mismatch`. Those describe the campaign's configuration (a wrong freeze, a redeployed evaluator, the caller's
`budget` argument), not the candidate.

`test/da8.integration.test.ts:80-98` asserts exactly this: six freeze mismatches each yield `verdict: 'reject'`. A
fixture-builder mistake, or an evaluator update after the freeze, burns every candidate it touches. An insider holding
the fixture-builder and grader principals can burn a chosen candidate.

Fix: refuse these mismatches before the claim and write no record, the same treatment the view mismatch now gets (V-2).
Keep `reject` for causes intrinsic to the candidate:
- `bundle_compiler_mismatch`;
- `authority_boundary_mismatch`;
- `no_executable_change`;
- `source_ineligible`;
- `limits_exceed_budget`;
- `parent_child_mismatch`;
- the bundle's `runtime_hash_mismatch`.

Also take `budget` from the freeze, by storing the budget rather than only its hash, instead of from the caller.

**F-4 (MEDIUM): saving the report and settling the claim are two separate writes.**

`finish` inserts the report (`gate.ts:307`) and only then settles the claim (`gate.ts:317`). After a crash between the
two, `recover()` plus a later campaign runs the full 76 episodes again, then hits `GateReportExists` and throws
`DecisionAlreadyRecorded`. The catch skips `settleAfterCrash` (`gate.ts:236`), so those episodes are not kept anywhere.
The test asserts it: `heldRunsOf(claimKey)` has length 0 (`da8.integration.test.ts:404-432`). The grader cannot check
for an existing report beforehand, because it has no FIND on `gate_reports` (`mongo/src/roles.ts:157-203`).

Fix: insert the report and settle the claim in one transaction (the grader holds INSERT on `gate_reports` and UPDATE on
`gate_claims`). That removes the window entirely. Failing that, keep the extra episodes as held rows.

**F-7 (LOW-MEDIUM): the scripted port is shipped as product code.**

`ScriptedEpisodePort` lives in `src/testing/sim.ts`, and `package.json` exports it as `./testing`. It imports the
grader's `runReference`, and it can declare committed evidence (F-1). `test/import-boundary.test.ts` only stops
candidate-side workspaces from importing `@expunge/gate`. Nothing stops a privileged service, such as a future campaign
host, from importing `@expunge/gate/testing`.

Fix:
- Move it under `test/`, or add a boundary test that no non-test src imports `@expunge/gate/testing`.
- Have `runGate` refuse any port whose label is one of the `SCRIPTED_*` labels, as a cheap tripwire until F-1 lands.

`GateConfig.betweenAttemptAndInsert` is also a test hook on the production API. Move it to a test-only seam.

**F-8 (LOW).** `GateStore.readReport` allows `setup` (`store.ts:36`), which goes against "no setup in src". It also
allows `projection_reader`, but the role manifest gives `projection_reader` no FIND on `gate_reports`
(`mongo/src/roles.ts` projection_reader block). On Atlas that read fails. The operator's Evaluation view, which is
built "from the stored gate report", has no permitted read path in production.

**F-9 (MEDIUM, a known gap the test labels): the real composition cannot run without `setup` today.**
- `installAuthority` is a callback, and the only implementation, in `test/real-path.integration.test.ts:189-192`, uses
  `setup` (MA-F2).
- `GraderEpisodeHost.pinBundle` is not enough, because `ProvenanceRepository.permitted` ignores campaign permits. That
  is why `LocalLaneHost` writes `artifact_eligibility` as `setup` (MA-F1).
- The same test builds `MongoEpisodeEvidence(env.service)`, which is also `setup`.
- `real-path.integration.test.ts` calls `port.run` per arm and **never calls `runGate`**. Every `runGate` test uses
  `ScriptedEpisodePort`. No end-to-end gate run over the real worker path exists yet, not even with a fake model.

**F-10 (LOW-MEDIUM): per-pair held-out results are in the report.** The report's `pairedTrials` carries one row per pair
for protected and validation pairs, with `family`, `seedCommitment`, `faultPlanHash` and full metrics
(`report.ts:87-100`), plus `pairSplits` (`report.ts:154`). That contradicts `public-rows.ts:6-7` ("Protected and
validation pairs exist only inside the report's aggregate").
- Current exposure: the approval issuer, the promoter and `setup`. The proposer has no grant.
- A human approver who relays these rows into a proposal would be tuning on validation results.
- Fix: correct the docstring, and decide whether the report should carry only per-world aggregates for withheld splits.

**F-12 (LOW): `candidateId` is unchecked free text** (`GateConfig.candidateId`, stored in the report). Nothing ties it to
a `candidates` row, so the report cannot prove that the gated child is the one a proposal produced. The grader also has
no FIND on `candidates`.

**F-13 (LOW): leftover debug output.** `test/real-path.integration.test.ts:226-233` still has a `console.log('DBG', ...)`
line. Remove it.

### LIKELY

**F-5: race and recovery edges.**
- `recover()` (`claims.ts:153-157`) turns any `open` claim into `held` without checking that no campaign is running.
  Claims carry no lease or heartbeat. Recovering during a live run lets a second campaign take the pair over. Whichever
  campaign inserts the report first decides, and the other gets `ClaimNotOpen` or `GateReportExists`. This is not a free
  re-roll, because the first insert wins regardless of verdict, but it spends a second full campaign.
  - Fix: add a claim lease with expiry, and let `recover` act only on expired leases.
- `takeAttempt` is followed by the claim insert. A crash between the two, or an ambiguous acknowledgement on the insert
  followed by the give-back `$inc: -1` (`claims.ts:86`), can leak or over-return one attempt. SPECULATIVE in effect.
- The concurrent first-attempt upsert depends on the server retrying duplicate-key upserts. The cap test
  (`da8.integration.test.ts:168-191`, 6 racers, cap 2, exactly 2 succeed) passes on mongo 8.0.15. Atlas runs 8.0.34
  (decision 21). Keep the test in the Atlas lane.

**F-6: a candidate can be re-gated after every hold, with no limit.** A hold consumes no attempt, and `takeHeld` allows
any later campaign to resume. The held trials are excluded from the decision (`excluded: 'superseded_by_resume'`). Three
hold reasons are under the caller's control:
- `campaign_cancelled`: the caller owns `signal`;
- `infra_invalid`: more than 10% infrastructure failures;
- `harness_defect_pair`.

A campaign process that can watch outcomes mid-run (the grader can read `jobs`) could cancel unfavourable campaigns
until a favourable one completes. The report does record `resumes` and `heldRuns`, which is good disclosure (the test at
`da8.integration.test.ts:305-342` shows a resume ending in admit).
- Fix: put `maxResumesPerCandidate` in the freeze. Alternatively, pool the executed trials of held campaigns into the
  decision when the hold reason is `campaign_cancelled`.

**F-11: held-out world instances stay in `expunge_world`.** `MongoEpisodePort` keeps each instance's world after the run
("Keep the instance's world after the run (default)", `mongo-port.ts:122`). Protected and validation world contents,
generated from held-out seeds, therefore stay readable by every principal with world read. The proposer has none today.
- Fix: delete withheld-split instances after grading, or document why they must be retained.

**N-2 (for the deployment rebuild): bind promotion to the gated bytes.** The report `_id` comes from (parent, child
*projection*), while `report.childHash` is the bytes that were gated. A variant with the same projection but different
(for example revoked) evidence cannot be gated again. Promotion must still require `report.childHash ===` the promoted
hash and re-check that hash's eligibility, or the variant could ride on the original's report.

### SPECULATIVE

- **The gate admits mutations that cite no evidence.** Children in the tests differ only in `limits.scannedDocuments`
  and carry no new evidence; they are admitted. The gate never recompiles the child with the frozen compiler. It
  compares only the self-declared `child.compilerHash` (`admission.ts:174-175`). An artifact inserted directly, without
  passing the compiler (whose checks cover literals, no-ops, hidden-test shortcuts and evidence per edit), is admissible
  if it behaves well.
  - Fix: either the gate re-runs `compile(parent, child)` under the frozen compiler, or it requires an accepted compile
    record tied to `candidateId` (F-12).
- **Misleading runtime hash on integrity rejects.** `report.runtimeHash` falls back to `freeze.runtimeHash` when no arm
  attested (`report.ts:175`). An integrity reject with no episodes therefore shows a runtime hash as if one had been
  observed. Use `null`, or label the field.

## Notes on D (digest and class)

- **N-1.** `computedClass` comes from `classifyMutation` over the two artifacts read by hash.
  `ArtifactRepository.read` verifies the content hash, so the class cannot be supplied by a caller. The digest is
  `contentHash(report)`, and the reader recomputes it from the stored body without `_id`, checking that `_id ===
  reportId` (`store.ts:34-41`). The round trip works in practice (`gate.integration.test.ts:30-33`). Sound.
- `knownAuthorityFlips` uses the same rule as the rollback binding. Good.

## Notes on F (final split)

- `verifyGatePlanView` now runs before the claim, against the frozen commitment (`gate.ts:113`). The D8-1 test dumps
  every collection after an admit and finds no seed or fixture id of any split (`da8.integration.test.ts:55-78`).
  Labels are HMACs under the campaign key, and the key is readable only by the grader and fixture builder.
- I found no path by which final-split seeds, specs or structure reach the gate or anything it writes.
- The working-tree fixtures change now states that the plan reuses structures across splits by design. If so, held-out
  "structural transfer" is transfer across seeds and layouts, not across structures. That should be stated in
  PREREGISTRATION wherever it claims structural holdouts.

## 4. DA-8-named tests, checked by reading what they assert

| Test | What it really proves | Verdict |
|---|---|---|
| D8-7 (`:39`) | blanket delete, blanket refuse and failed-but-correct yield reject; failed rows have no success; 38 rows | proves it |
| D8-1 (`:55`) | a final-split entry throws before episodes; no seed or fixture id in any collection after an admit | proves it (world contents of withheld instances do remain: F-11) |
| D8-2 (`:80`) | freeze values are read from the stored row; a mismatch rejects with 0 episodes | proves it, **and pins F-3 as intended behaviour** |
| D8-2/V-2 (`:100`) | a self-consistent foreign view throws before the claim; the candidate can still be gated afterwards | proves it (the fix landed while I reviewed) |
| D8-2 runtime (`:113`) | swapped runtime rejects, missing attestation holds, mixed rejects | proves the rule. The attestations come from a scripted port (F-1). |
| D8-4/D8-16 (`:135`) | rerun after reject refused; an evidence-only variant is the same candidate | proves it. Not covered: rerun after admit, or a variant while held. |
| D8-16 cap (`:168`) | 6 concurrent first claims with cap 2: exactly 2 succeed | proves it on `ClaimStore` directly, not through `runGate`; server-version dependent (F-5) |
| D8-5 (`:194`) | 6 concurrent runs of one child: one wins, the others get `CandidateGateRerun`, attempts +1, only one port ran | proves it |
| D8-6 (`:246`) | labels do not match common hash guesses | weak by construction (a guess list), but HMAC under a private key makes the property hold anyway |
| D8-18 (`:266`, `:292`, `:305`) | thrown, hung and timed-out arms are failure rows; fake evidence holds and keeps 76 trials; a later campaign resumes and admits | proves it. Also demonstrates F-6. |
| crash (`:404`) | report stored, claim open, then recover and rerun throws `DecisionAlreadyRecorded`; claim decided | proves "never decides twice", **and pins F-4's lost episodes** (`heldRunsOf` length 0) |
| D8-8 | — | **no test; still open** (F-1) |
| D8-9 (`import-boundary`) | candidate-side src and manifests do not import gate, grader, fixtures or deployment | proves it for candidate-side code only (F-7) |
