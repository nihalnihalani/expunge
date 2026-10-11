# Preregistration (frozen scientific protocol)

Status: **DRAFT, not yet frozen.** Hashes below are `TBD` until the verifier records them from the committed tree. Once frozen, any change to an executable, evaluator, generator, split or profile named here creates a new campaign hash and invalidates results produced under the old one. Reducing conditions, controls or episode counts requires explicit owner authorization recorded in `docs/continuity/PROJECT-STATE.md` and cannot be described as full protocol completion.

Protocol source: `docs/expunge/ACCEPTANCE.md` "Scientific protocol" and spec section 16.

## Frozen artifacts (to be filled)

| Artifact | Identity | Hash |
|---|---|---|
| Worker profile W0 (initial harness bundle) | `packages/baselines` (pending) | TBD |
| Expert-static bundle | `packages/baselines` (pending) | TBD |
| Improver profile I0 | pending | TBD |
| Runtime adapter | `packages/runtime` | TBD |
| Compiler and vocabulary | `packages/harness-compiler` | TBD |
| Authority floor and eligibility policy | `packages/governance` | TBD |
| Fixture generator source bytes | `packages/fixtures` (`fixtureSourceCommitment`) | TBD (rsi-evolution reports after A3-R) |
| Reference solver source bytes | `packages/grader/src/reference.ts` | TBD |
| Evaluator source bytes | `packages/grader/src/grade.ts` | TBD |
| Split commitment | `buildSealedSplitPlan(masterSeed)` public commitment | TBD |
| Model provider and model ID per arm | from `EXPUNGE_MODEL_PROVIDER` / `EXPUNGE_MODEL_ID` | TBD (not frozen until credentials exist) |
| Sampling parameters | default sampling for the worker; structured output for the improver | TBD |


## Provisional commitments (NOT frozen; recorded 2026-10-11 12:15Z real UTC)

Measured by rsi-evolution on the working tree with the C3 packets overlaid (PKT-23 to PKT-25, under verification). Every value is bound to the bytes of `packages/contracts`, which still has uncommitted additive edits from packet C1c, so every hash below will change and must be recomputed by a verifier from the committed tree at freeze time. They are listed so the freeze has a known starting point, not as evidence.

| Artifact | Provisional hash (working tree) |
|---|---|
| Fixture generator | cc14f03fc3876653bc5127370ac5dc350a08a1cd105f3c02a4ea986e46e216d0 |
| Evaluator | a635114926c20c925d7190c0c2421707c91ae54ec4e40e2fe9485b79ac52f213 |
| Reference solver | c6ab13ff0fd0ada6727704c5239d9093941017b0acf2f247b2a4479b2ba0f49b |
| Second (indexed) reference solver | f83aa008bcff332d01cae46c2fb755c4d5106de14cba1205abaf6631b16b9725 |
| Compiler | 5a16cb5067a97c87aa381c754e560472feadb1fe78d497d8d2716597c37b8174 |
| Vocabulary | eb43509a836eb428991227692bffd612503e678e727bc82cc2378072070946f4 |
| Split builder | 7eb34124fb5f14fde7036f49a398d4e667b15acee42dacce1444f9339c9172c9 |

No real campaign master seed has been minted; the split commitments in tests come from a test master seed. The gate report format persists `admittedUnder { compilerHash, parentCompilerHash, childCompilerHash }` inside its digest, and admission refuses `compiler_hash_mismatch` and `bundle_compiler_mismatch`, so a compiler change after the freeze is visible rather than silent.

## Conditions and counts (planned, from ACCEPTANCE.md)

| Item | Value |
|---|---|
| Controlled world | at most 500 documents, six collections, five reference hops |
| Worker execution caps | at most 16 model calls and 16 tool calls (amendment A-1; ACCEPTANCE.md stated 12 phases), 120 s per episode, 24,000 tokens per episode |
| Parallel episodes | 4 initially; 8 only after rate probes |
| Candidate mutation | at most 3 independently justified edits |
| Training trigger evidence | 2 structural failure worlds, 3 repeats each per parent/candidate |
| Protected gate | 8 worlds, 2 repeats each per parent/candidate |
| Validation gate | 8 worlds, 2 repeats each per parent/candidate; raw answers withheld from proposer |
| Promotion utility rule | at least 2 additional successes among the 6 paired trigger runs; no preservation or retention violation; no protected-case success below paired parent; validation aggregate does not fall |
| Final test | 24 structurally held-out worlds, 3 repeats, 5 conditions (initial, expert-static, evolved, score-only, wrong-incident): 360 episodes |
| Meta comparison | 8 new incidents; reset W0 for I0 and I1; at most 3 proposals and equal token budget per improver; each produced worker tested on 3 further worlds with 2 repeats; I0/I0 noise and no-data rewrite controls |
| Hider | 12 admitted new WorldSpecs across frozen families; quarantines retained |
| Cost admission | measured ceiling set after baseline probes; token and call ceilings always enforced; unknown pricing reported, never zero |

## Primary outcome and analysis

Primary: paired per-world success (correct target effects AND preservation AND truthful terminal status) on the 24 final worlds, evolved versus expert-static, reported as raw paired counts with an exact binomial or sign-test interval appropriate to n. Secondary: residuals, collateral changes, retention violations, false refusals, retry failures, tokens, dollars, Mongo operations, wall time, configuration effort and adaptation latency. A tie with expert-static is reported as a tie. Negative, null and rejected candidates are retained and reported.

## Analysis decisions (recorded 2026-10-11 15:40Z, before the freeze, from docs/review/PREREG-pre-freeze.md)

- **Primary unit and test (R4).** For each of the 24 final worlds, an arm's per-world outcome is SUCCESS when at least 2 of its 3 repeats succeed (majority). The primary comparison is evolved vs expert-static: a two-sided exact sign test over worlds whose per-world outcomes differ. Worlds with equal outcomes are ties and are dropped from the test but reported. Failed, cancelled and timed-out runs count as non-successes.
- **Multiplicity (R5).** Confirmatory: evolved vs expert-static (primary), plus evolved vs score-only and evolved vs wrong-incident (secondary), with the Holm correction across the two secondaries. Evolved vs initial W0 is descriptive only. No causal claim about evidence use is made unless both secondaries survive Holm.
- **Meta unit (R1, R2).** The unit is the incident: per incident, compare the success counts of the two produced workers over its 3 withheld worlds x 2 repeats. win, loss or tie per incident. Sign test over the 8 incidents' non-tied outcomes. The noise control is computed on the same unit: noiseNet = wins - losses of the I0-vs-I0 arm over the 8 incidents, compared to net on the same scale. With n = 8, p < .05 requires 8-0 or 7-0 plus a tie, so TIE is the expected outcome and the study is reported as underpowered for small effects. The noise control is a single I0-vs-I0 sample, so noiseNet can be 0 by chance; a GAIN is reported together with this limitation. The draw commitment (seed and pools, with I0's hash only) is stored before I1 is produced, and the draw verifies that order.
- **Selection (R3, R6).** The 8 meta incidents and each incident's 3 further worlds are drawn by a committed seed from the meta split commitment before I1 exists. The evolved worker used in the final test is the worker deployment's active hash at the moment the final campaign is frozen, recorded with its selection basis (gate admission on training, protected and validation splits; in-sample selection over at most 3 attempts per arm is disclosed).
- **Dollar ceiling (R7).** maxCostMicrousd = 1.5 x the largest per-episode cost of expert-static over 10 probe-only worlds (disjoint from every split), measured with the frozen provider and model. If pricing is unknown the dollar gate cannot pass and the cost is reported as unpriced.
- **Infrastructure failures (R9).** A provider 5xx, 429 or outage that persists after the runtime's bounded retries makes that episode a failed run, which stays in the denominator. If more than 10% of either arm's episodes in a campaign end in infrastructure failure, the campaign is reported INVALID-INFRA with all its rows retained, and may be re-run only as a new campaign with new commitments. Harness defects (recorded 16:49Z, from the PKT-47 review): a fault-plan attestation that differs from the trial's committed plan (`FaultPlanMismatch`), or a planned fault that was never injected (`FaultPlanNotInjected`), is a defect in the harness, not behaviour of either arm. It invalidates the whole PAIR. The pair is kept as a recorded exclusion with its code and both arms' rows, and is never scored as one arm's failure. The INVALID-INFRA threshold is computed per arm: (that arm's episodes that ended in an infrastructure failure under the predeclared provider-side codes exported as `INFRA_FAILURE_CODES` in packages/gate. These are provider 5xx, 429, network or credential unavailability, plus `CommittedStateUnreadable`. A provider 4xx caused by the request, and the runtime's catch-all `ModelRunFailed`, are behaviour and never count as infrastructure. Plus the excluded pairs it took part in) divided by that arm's episodes. Above 10% for either arm, the campaign is INVALID-INFRA. Stricter than this rule, any excluded pair holds the gate decision (`harness_defect_pair`), so a defect-free re-run under new commitments is needed before any admission. Exclusion is keyed on a dedicated field that only the port sets, from the attestation comparison, never on a free-text failure code. The meta comparison skips excluded pairs in the same way. A meta row is invalid only when its infrastructure failures plus 2 per excluded pair, per worker, exceed 10% of that worker's runs. Behaviour failures stay non-successes in the win/loss comparison and never make a row invalid. A timeout is not an infrastructure failure: a slow worker is behaviour, so it stays a failed run for that arm. An INVALID-INFRA result ends that campaign's claim and counts as an attempt. It is never resumed under the same claim. The gate implements this in PKT-72 before any campaign. Until then the arm-level failure code is a placeholder that no campaign may run under. A run that never reached an apply has no attestation, because no fault could have fired, and is scored normally.
- **Token and wall-time profile (R10).** The A-1 profile on probe-only worlds runs before ANY gate campaign, not just before the final test.
- **Still to be filled AT freeze (R8).** Provider and model ID per arm (worker, evolver, improver, Hider) and the returned model version logged per episode; the sampling policy (temperature, top-p, max tokens, seed handling) as explicit numbers; the master seed commitment and split commitment; the hashes of W0, expert-static, I0, runtime (runtimeHash()), compiler, evaluator (including the indexed second solver), generator and reference solver; the improver token budget as a number; the fault plans per family. The fault layer on the domain path (DA-5 P2-1) must be in place; until then partial_retry is fault-free on the real path.
- **Disclosures.** Low power, so TIE is likely and is reported as such. In-sample selection over up to 3 attempts per arm. Possible provider model drift (the returned version is logged per episode). FAKE rehearsal outputs are not results. The expert-static baseline was authored by the same team. Some fault families may exercise structure only.

## Paired-run limits (recorded 2026-10-11 15:50Z, before any campaign)

ResourceLimits split in two. Budget limits (modelCalls, toolCalls, totalTokens, wallTimeMs, maxCostMicrousd, scannedDocuments, changedDocuments): both arms of every pair run under exactly the campaign's conditions.limits. A bundle may only restate the parent's values: the compiler refuses any difference, so a candidate cannot buy budget. Budget limits are not an editable surface: the compiler rejects any child whose budget limits differ from its parent (budget_not_editable). Structural limits (traversalDepth, graphNodes, graphEdges) belong to the editable harness. Each arm runs under its own bundle's values, and the compiler refuses any value above the owner ceiling (limits_exceed_owner). The worker port also refuses a bundle whose structural limits exceed the campaign ceiling, recording a failed row that stays in the denominator.

## Resource plan (recorded 2026-10-11 15:12Z, before any campaign)

Computed by `packages/meta-evolution/src/resource-plan.ts` (`npx tsx packages/meta-evolution/scripts/resource-plan.ts`) from the protocol constants and ACCEPTANCE_LIMITS under amendment A-1. Per-episode caps: 16 model calls, 16 tool calls, 24,000 tokens, 120 s, 500 scanned and 500 changed documents, traversal depth 5. Dollar cost is UNPRICED until a provider and its pricing are configured. Unknown pricing is never counted as zero.

| Row | Episodes |
|---|---|
| Gate per candidate: (training 2x3 + protected 8x2 + validation 8x2) = 38 pairs x 2 arms | 76 |
| Evolution gates, worst case: 3 evidence arms (trace-informed, score-only, wrong-incident) x 3 attempts per parent x 76 | 684 |
| Final test: 24 worlds x 3 repeats x 5 conditions | 360 |
| Hider: 12 admitted worlds x 2 arms | 24 |
| Meta comparison: 8 incidents x 3 head-to-head arms x (3 worlds x 2 repeats x 2 workers); I0 is re-run per comparison for an independent noise sample | 288 |
| Baseline probes for the measured dollar ceiling: 2 baselines x 10 | 20 |

Lead decisions: `maxAttemptsPerParent` = 3 per evidence arm, and 10 probe episodes per baseline. Maximum totals at the caps: 1,452 worker episodes; 34,848,000 worker tokens; 23,232 model calls and 23,232 tool calls; 123 evolver and improver proposal calls (27 evolution + 96 meta). Assuming 24,000 tokens per proposal call (an assumption: the protocol fixes the count, not the size), that adds 2,952,000 tokens, for a maximum of 37,800,000 tokens. Wall time at full caps is about 12.1 h at concurrency 4, and concurrency 8 is allowed only after rate probes. Hider-model, critic and Raindrop observer calls are counted separately. The campaign does not start until the human confirms a spend limit for this volume.

## Meta comparison verdict rule (recorded 2026-10-11 14:50Z, before any meta run)

Implemented in `summarizeMeta` and `signTestP` (packages/meta-evolution/src/campaign.ts). The budget envelope covers proposals, edits, tokens, evaluation calls and wall time. It has one value for every arm. Improver strategy (knobs such as budgetChars, maxProposals, stopOnGood and maxEdits) may differ within the envelope.

- Unit of analysis (amended 15:40Z per the pre-freeze review R1/R2, before any meta run): the INCIDENT. For each of the 8 incidents, the two produced workers' success counts over its 3 withheld worlds x 2 repeats give a win (I1 more), loss (I0 more) or tie.
- Two-sided exact sign test over the 8 incidents' non-tied outcomes gives p. net = wins - losses. noiseNet = wins - losses of the I0-vs-I0 arm on the same 8 incidents. noDataNet = net of the I0-vs-no-data arm on the same scale.
- GAIN if and only if p < 0.05 AND net > 0 AND net > |noiseNet| AND net > noDataNet. LOSS if and only if p < 0.05 AND net < 0. Otherwise TIE (expected at n = 8).
- Failed, cancelled and timed-out runs count as non-successes and are never dropped. A tie or null result is an acceptable outcome. Eight incidents is a small sample. No claim is made about model weights or indefinite acceleration.
- Draw ordering (recorded 16:25Z, DA-8 R3 residual). The draw commitment, I1's creation record and the improver freeze are separate insert-only rows. The database server assigns each row's ObjectId, and the row's time is read from that id. The incident draw is a fourth row of the same kind. Each row must be at least 2 s (`META_DRAW_MIN_GAP_MS`) after the one before it, in the order commitment, I1, freeze, draw. One constant is enforced by the repository and by the freeze checks, so campaign runbooks wait at least 2.1 s between steps. Disclosed limit: the database cannot detect an improver configuration designed offline before the commitment and then recorded after it. Mitigation: the commitment hash is committed to the Git repository, and that commit is pushed, before any improver work starts. The Git commit time and the stored row are then two independent records of the order.

## Amendments (recorded before any result)

| ID | When (UTC) | Who | Change | Justification |
|---|---|---|---|---|
| A-1 | 2026-10-11 13:20Z | team-lead | Worker phase ceiling raised from 12 to 16 model calls and 16 tool calls per episode, for every arm (W0, expert-static, evolved, score-only, wrong-incident). Wall time 120 s and the 24,000-token cap are unchanged. New workflow outcome `batches_remaining` added to the disclosed edge vocabulary. | A plan is applied one batch per effect kind, because effect kind is a per-batch policy fact for guardrails and approvals. The ten fixture families need 2 to 4 apply calls per plan (measured by mongodb-authority on the domain gateway at 13:15Z). Once the gateway enforced workflow visits, a 12-call ceiling made the expert verification-failure round impossible and left no room for four-batch plans. No episode has run and no result exists, so nothing is tuned on outcomes. The amendment raises a ceiling. It reduces no feature, condition, control or episode count. |
| A-1 (superseded graphs) | 2026-10-11 13:25Z | team-lead | The pre-A-1 W0 and expert-static workflow graphs (packages/baselines/src/index.ts at commit 2efd827, file sha256 82ba650d1ef669738228ef675012a2a989d6e015d271196f7b6d9733fa3f6970) are withdrawn as conditions and are not retained as a variant. | Under runtime workflow enforcement they cannot finish any generated world: W0 stopped after batch 0, and expert-static could not re-preview or apply past one batch (devils-advocate review docs/review/PKT-32-expert-visits.md). No campaign rows exist under them, so nothing is invalidated. Any row found later carrying their bundle hash is invalid. |
| A-1 (notes) | 2026-10-11 13:30Z | team-lead (from devils-advocate ACCEPT-WITH-NOTE) | (1) The FAKE c3-evidence and test gate reports were produced under the pre-A-1 W0 and expert bundle hashes. They are fixtures, not results, and are invalid for any campaign. (2) FREEZE-BLOCKING: a measured token and wall-time profile per baseline (W0, expert-static) on a four-batch world with the real frozen provider. Expert's 12,000-token context against W0's 6,000, over up to 16 model calls, may make the unchanged 24,000-token and 120-second caps the binding limit, and that would handicap expert-static. If either cap binds, it is raised equally for every arm under a new amendment before any result. Until a provider credential exists this is an UNMEASURED RISK and is reported as such. (3) Expert visits sum to exactly 16. One apply retry in a four-batch first round leaves one apply for round two (disclosed limitation). (4) Hider admission must bound batches per plan (at most 4 at 25 documents per effect kind) or disclose worlds that exceed every baseline's apply visits. | Keeps the amendment honest about which limit binds after the call ceilings rise. |

## Freeze record

| When (UTC) | Who | What was frozen | Commit |
|---|---|---|---|
| (none yet) | | | |
