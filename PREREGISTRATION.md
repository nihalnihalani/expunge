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
| Worker execution caps | at most 12 model/tool phases, 120 s per episode, 24,000 tokens per episode |
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

## Freeze record

| When (UTC) | Who | What was frozen | Commit |
|---|---|---|---|
| (none yet) | | | |
