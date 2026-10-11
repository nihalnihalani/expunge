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

From the team-lead session onward (this file will be extended per commit):

| Commit | Task IDs | New functionality |
|---|---|---|
| (pending CS-1) | P0-2, P0-3 | root lint/format tooling, continuity skeleton, report-gate hook |

## How to read the repository

`git log --stat` plus `COMMIT-LEDGER.md` gives the per-commit inventory. `WHAT_IS_REAL.md` says which claims have evidence. `THIRD_PARTY.md` lists every copied file.
