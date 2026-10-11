# Built during the event versus prepared beforehand

The team confirmed with the organizers that early work is permitted and that forking OpenDots, OpenBot and OpenMuse is allowed. This inventory still separates what was prepared, what was imported, and what was built in the build session so judges can see the new contribution. Timestamps are from file mtimes and the commit ledger; `COMMIT-LEDGER.md` is the authoritative record once commits exist.

## Prepared research (before the build session, 10 to 11 October 2026)

- `research/` (notes, debate, winner deep dives, literature), `RESEARCH-REPORT.md`, `RETHINK.md`, `REEVALUATION.md`, `BLUEPRINT.md` (superseded CaseLaw sketch), `HACKATHON-RECOMMENDATION.md`.
- `EXPUNGE-IMPLEMENTATION-BLUEPRINT.md`, `docs/expunge/*`, `docs/research/*`: the design the build follows.
- `EXPUNGE-CLAUDE-GOAL-SPEC.txt` and the launch/resume prompt files.

## Imported foundations (attributed, MIT)

- `apps/operator/`: CopilotKit OpenDots at `625452e06cde74cb25b0ce319e2c1be0488f5a5f`; see `apps/operator/THIRD_PARTY.md` and `LICENSE`.
- OpenBot computer and supervisor services at `b6932d31a8d6e7896c15139dfc27a6c6911deb27`, built by `apps/operator/compose.computers.yml`; license at `apps/operator/deployment/computers/LICENSE.openbot`.
- OpenMuse `tanstackAgent` helpers at `1ac68f3909f2478ab6280883f1ab5ea65eb5719d`: to be ported into `packages/vendor-openmuse/` with its own `THIRD_PARTY.md` (B2-1).

## Built during the build session (new Expunge code)

Wave A foundation written 11 October 2026 before the formal kickoff: `packages/contracts`, `packages/mongo`, `packages/fixtures`, `packages/grader`, `scripts/setup-mongo.ts`, `scripts/probe-mongo.ts`, `infra/opendots/` candidate overlay, and the Expunge additions inside the operator (`src/shared/expunge.ts`, `src/server/expunge/`, `src/client/expunge/`).

From the team-lead session onward (extended per commit; `COMMIT-LEDGER.md` is authoritative):

| Commit | Task IDs | New functionality |
|---|---|---|
| fe12b51 | CS-1 (P0, A2-R, A3-R, B2-1, U-0, V-1, DA-1 to DA-3) | Baseline of 470 files: tooling, continuity, contracts, mongo, fixtures, grader, baselines, worker, runtime, OpenMuse port, candidate overlay, operator server half, design docs |
| e165d48 | PKT-2 A2-R | Mongo hardening, scope-bound claim polling, grants re-derived from the gate report |
| d119446 | PKT-3 DA-4 | Authority re-review report, reseeded live fixtures, lint-clean reproductions |
| 191cbb4 | PKT-4 B2-2 | Worker testing subpath, run provenance, untrusted-narrative labels, metering, durable wake dedupe, crash-recovery polling, projection events; candidate proxy token |
| 4eb6d5d | PKT-5 C2-1 | Trusted harness compiler: three-valued guardrails, Mongo/TypeScript parity, workflow and policy analysis, patch-exact edits, mutation classes, shortcut scans |
| ae59942 | PKT-6 B1-0 | WorldKey-bound world access, single-update owner-policy effects, decision ledger inputs, gateway step-log collections |
| f70d81f | PKT-7 | Continuity and planning docs, environment reference, contract additions |
| c663bfd | PKT-8 B1-1 | Governance: authority floor, owner policy, policy evaluator on decide(), decision ledger, live floor fence |
| cd821d6 | PKT-9 C2-2 | As-of decision replay, evidence-cited evolver with score-only and wrong-incident controls, 61-code rejection catalog |
| 5e229c9 | PKT-11 | Hotfix for a dangling export that broke typecheck at HEAD; HEAD-green gate introduced |
| f17fd61 | PKT-10 B3-S1 | Operator readiness view, lazy Expunge client shell with hash routes, model-free projection agent, contract-parity and telemetry tests, screenshots |
| 7fe7762 | PKT-13 DA-5a | Governance and evolution review with negative test specifications |
| 88a75a3 | PKT-12 | Honest incomplete receipts (completeIncomplete), campaign_keys private collection with strict validator |
| 109e2dc | PKT-18 DA-6 | Observer and evidence-bundle review with negative test specifications |
| ba41d7b | PKT-14 C1a | Raindrop tracing with transactional telemetry outbox, observer read-back, crash-safe cursor, evidence bundles with leak guard, MCP capture (live calls need keys) |

Each row has a ledger commit after it (`docs: record PKT-n commit in COMMIT-LEDGER`) with the verifier checkpoint id and the gate exit codes.

## How to read the repository

`git log --stat` plus `COMMIT-LEDGER.md` gives the per-commit inventory. `WHAT_IS_REAL.md` says which claims have evidence. `THIRD_PARTY.md` lists every copied file.
