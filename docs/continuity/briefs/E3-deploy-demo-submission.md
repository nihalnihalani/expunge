# Brief E3: deployment, operator rehearsal and submission

Owner: **runtime-raindrop** (infra and runbook) with **ui-ux-improver** (demo flow and recording checklist) and **team-lead** (submission documents). Owned paths: `infra/deploy/`, deployment runbook, demo reset/prefill drivers, submission documentation under docs/. Depends on: all of B and C; D and E where landed. Human-blocked items are listed at the end and are never faked.

Status: drafted 2026-10-11 11:55 UTC, not dispatched.

## Objective

ACCEPTANCE "Deployed product" and the submission checklist: deploy the operator and domain workers with their actual host requirements (Node host for the operator, a separate Docker host for the candidate sandbox sidecars), HTTPS, auth, origin rules, server-only secrets, health endpoints; idempotent demo world reset that preserves benchmark data; a three-minute rehearsal recorded on site on 11 October; Cerebral Valley submission with public repository, accessible demo, one-minute video and a description of functionality built during the event.

## Scope

- `infra/deploy/`: compose or host manifests for operator, worker, candidate stack (netguard rules from infra/opendots), with env names only; health endpoints (`/healthz` readiness that reports BLOCKED dependencies by name); origin and auth configuration; a `RUNBOOK.md` with the exact commands, rollback, and the replay switch (`EXPUNGE_DEMO_MODE=replay` reads recorded evidence bundles; the UI labels it as replay).
- Demo reset: `scripts/demo-reset.ts` seeds the demo world from a sealed fixture with a fresh world id each time, never touches benchmark rows or admitted bundles, and prints the hashes it used.
- Recording checklist (docs/ui/DEMO-CHECKLIST.md): the 3:00 script from ACCEPTANCE with the proof each beat must show on screen (ledger row, Raindrop trace id or offline bundle hash, gate report, evaluation table with hashes, Hider and meta rows), plus the attendance and finalist-presence checklist and the human team size line (at most four).
- Submission documents (lead): WHAT_IS_REAL.md mapping every demo claim to a code path, pinned upstream contribution and a run or evaluation id; BUILT_DURING_EVENT.md; THIRD_PARTY.md; a one-minute video script; the repository description.

## Human-blocked (report as BLOCKED, never faked)

Atlas Hackathon Sandbox project and connection string (email invitation); provider keys; Raindrop keys; a public hostname and TLS certificate; making the repository public; the on-site recording itself; attendee and finalist presence confirmation. Deployment performs no invented service or account setup and the build agent does not certify eligibility.

## Evidence to report

Anonymous checks of the public repository and demo URL (when public); the deployed artifact hashes equal to the report's; one real run closing the loop on the deployed stack (or the replay switch clearly labeled); health endpoint output; the completed checklist with dates.
