# Brief E2: independent benchmark and scientific review

Owner: **verifier** (execution and exports) with **team-lead** owning PREREGISTRATION.md and **devils-advocate** reviewing design and results. Owned paths: `tests/evaluation/`, benchmark exports, report generation. Depends on: C3 gate runner, D1 and D2 campaign exports, fixtures split commitments, grader, operator table (B3) that reads exported rows.

Status: drafted 2026-10-11 11:55 UTC, not dispatched (freeze PREREGISTRATION.md after C3 contracts settle; run after D2).

## Objective

ACCEPTANCE "Evaluation" rows: run initial (W0), expert-static, evolved, score-only and wrong-incident conditions on frozen structural holdouts with repeated stochastic runs; publish raw pair data, cost and failures; independently inspect manifest isolation and reference solver independence; run the meta comparison summary; document uncertainty; never tune after inspecting the final held-out split. If expert-static ties evolved, report the tie.

## Scope

- Preregistration freeze: PREREGISTRATION.md gets the split commitments (`publicSplitCommitment`), fixture, grader, reference-solver, worker-profile and budget hashes, the admission rule, the sample sizes and the exact statistics to be reported, with a Git commit hash and a checkpoint id; recompute commitments only when contracts change and record the change.
- `tests/evaluation/run.ts`: drive the five conditions through the C3 gate runner on the frozen holdouts; equal budgets and model profile (FAKE model offline; real provider BLOCKED until credentials); keep failed, timed-out and refused runs in the denominator; export raw rows, per-condition aggregates, paired differences, cost and wall time as JSON with every hash.
- Independence inspection: a read-only check that the gate never opened the final split before the freeze (fixture canary), that the two reference solvers disagree on nothing admitted, and that the evaluator principal cannot be reached from worker code (RBAC residual table in docs/MONGO.md).
- Report generation: one markdown report and one JSON for the operator table; numbers appear with sample size and a plain uncertainty statement (paired counts, sign test or bootstrap interval; no percentages from tiny samples presented as certainty).

## Evidence to report

Commands and exit codes; the hash table matching the displayed UI table; the raw export path and its sha256; the tie/gain/loss statement; the independence check results; the BLOCKED line for real-provider conditions.
