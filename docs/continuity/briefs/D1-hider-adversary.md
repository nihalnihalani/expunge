# Brief D1: Hider and adversarial curriculum

Owner: **rsi-evolution**. Owned paths: `packages/adversary/`, adversary campaign tools under that package. Depends on: A3-R (sealed fixtures, `generateWorld`, `structuralSignature`, `publicSplitCommitment`, shape detectors, `mintSeed`), grader (`referenceSolve`, second reference solver from C3, `runReferenceWithFaults`), C3 gate (paired runs, `TrialMetrics`), B2 worker runtime. Frozen interfaces: `WorldSpec`, `AdversaryTrial`, `TrialMetrics`, the fixture field-path grammar (OWNERSHIP.md item 2), `ScopeKey` hashing (item 3).

Status: drafted 2026-10-11 11:55 UTC, not dispatched (dispatch when C3 gate runner exists).

## Objective

Spec section 11 and ACCEPTANCE "Hider": a Hider proposes bounded `WorldSpec`s with harder relationships, nesting, identity aliases, eligibility and fault compositions; the FIXED generator and reference admission prove solvability and quarantine malformed, impossible, over-budget and duplicate worlds; admitted worlds are scored by the current admitted worker so a measured limitation becomes a training precedent. Target: twelve admitted new WorldSpecs across the frozen structural families; retain every quarantined proposal with its reason codes.

## Scope

- `packages/adversary/src/propose.ts`: a Hider that emits `WorldSpec` candidates from a bounded grammar (family, nesting depth within `resourceBounds`, alias count, eligibility rule mix, fault plan from the grader's `InjectedFault` catalogue). Two proposers: a deterministic enumerator (control) and a model-backed proposer behind the same `ChatModel` port as C2 (FAKE model in tests). Neither may read grader truth, held-out assignments, split files or `publicSplitCommitment` preimages; prove by import graph test and by a canary file that must never be opened.
- `packages/adversary/src/admit.ts`: admission pipeline: schema validate; `generateWorld(spec, seed)`; shape detectors at chance; both reference solvers must succeed under the same `ResourceLimits` and eligibility rules the worker gets; duplicate detection by `structuralSignature` against every admitted and quarantined spec; over-budget and malformed reasons as codes in `AdversaryTrial.reasonCodes`. Impossible worlds (a reference solver fails) are quarantined, never scored as worker failures.
- `packages/adversary/src/campaign.ts`: run the current admitted worker on each admitted world through the C3 gate runner (paired with the parent where one exists); store `AdversaryTrial` rows in `adversary_campaigns` and `adversary_trials` (DATA-MODEL `meta_campaigns and adversary_campaigns`); reward = admitted AND worker metric below the reference (measured limitation), not difficulty alone. Same-seed replay must reproduce the same spec, world and admission verdict byte for byte.
- Separation: novelty family labels are structural (`noveltyFamily`), never customer names or literal values; "changing names" is its own control family that must not count as novelty.

## Tests required

Impossible spec quarantined with the solver's reason; malformed and over-budget specs rejected by code; duplicate by structural signature rejected; Hider cannot write manifests, scorer, truth or split files (write attempts fail under the principal and under the import guard); same-seed determinism (two runs, identical hashes); at least one admitted world where the W0 worker records a residual or collateral change that the reference solver does not; protected cases from earlier gates are still present in the next gate's split; the canary file is unread (fs watch or hash of access log). All with the FAKE model; a real-provider run is BLOCKED until credentials exist and is reported as such.

## Evidence to report

Commands and exit codes; the twelve admitted specs with family and hashes; the quarantine table with reason codes; the measured-limitation row(s); the determinism proof; the import-guard and canary results.

## Guards

No goalpost moves (admission rules and resource bounds frozen per campaign hash); no leaking held-out specs to the worker (the worker sees only the admitted world instance); curriculum growth alone is not evidence of improved learning (say so in the report).
