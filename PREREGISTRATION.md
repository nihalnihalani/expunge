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
