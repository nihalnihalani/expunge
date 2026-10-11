# Expunge project state (sanitized, version-controlled)

Updated: 2026-10-11 16:30 IST (11:00 UTC) by team-lead. This file holds no credentials. Checkpoint packs live in the ignored `.expunge/checkpoints/` directory; the local briefing is the ignored `HANDOFF.md`.

## Objective

Build the full-scope Expunge project described in `EXPUNGE-CLAUDE-GOAL-SPEC.txt` (sections 1 to 20) in this workspace. Local commits are authorized. Public publishing, production deployment changes, paid upgrades and external messaging require explicit human authorization.

## Engine and team

- Engine: Claude Code inside the Claude desktop app. Native Agent Teams are CLI-only per the official docs; this build uses named subagents with per-agent model selection and direct messaging as a role-preserving adapter. See `docs/continuity/OWNERSHIP.md`.
- Lead effective model: `claude-fable-5-1` (session model). Spec requested `claude-opus-5-5`.
- Teammates: spawned with `opus` / `sonnet` / `haiku` aliases; effective IDs are recorded in TASKS.json when each teammate reports.

## Current constraints (facts, not narrative)

| Item | State |
|---|---|
| Git | branch `main`; commits so far: fe12b51 baseline (470 files), 506b73e ledger, e165d48 mongo A2-R finish, 082d2e1 ledger, d119446 review DA-4, 7cbb983 ledger; remote `origin` = https://github.com/nihalnihalani/expunge (private); every commit is pushed immediately (human instruction); per-lane commit packets with verifier evidence |
| Root `.env` | MISSING. All Atlas, model-provider, Raindrop and CopilotKit Intelligence live checks are BLOCKED until it exists. Required variable names are listed in `.env.example`. |
| `apps/operator/.env` | MISSING (operator loads root `.env` through `apps/operator/scripts/run-from-root.mjs`) |
| Node / npm | v25.2.1 / 11.6.2 (root engines `>=24`) |
| Docker | 28.4.0 server via colima; local replica-set tests use `packages/mongo/test/docker-compose.yml` |
| Baseline checks | `npx vitest run`: 55 passed, 17 skipped (Mongo integration suites skip without `MONGODB_TEST_URI`), exit 0. `npm run typecheck`: 1 error (`packages/mongo/test/integration.test.ts` Uint8Array.equals). |

## Phase progress

| Phase | Status | Evidence |
|---|---|---|
| P0 audit | done | see Baseline checks |
| P0 tooling / continuity skeleton | done | this file, OWNERSHIP.md, TASKS.json; checkpoint tooling 35/35 |
| Wave A repair (A2-R mongo, A3-R fixtures/grader) | A3-R done; A2-R nearly done (docs/MONGO.md, lint, K8 remaining) | VERIFICATION.md; commit fe12b51 |
| Wave B (gateway, worker/OpenMuse, operator UX) | B2-1 done, B2-2 in progress; B3 server half done; B1 starting | commit fe12b51 |
| Wave C (Raindrop, compiler/evolver, admission/promotion) | C2 vocabulary foundation only; C1 and C3 not started | |
| Wave D (Hider, meta, privacy) | not started | |
| Wave E (reliability, benchmark, deployment) | not started | |

## Decisions

1. Work continues on `main` (repository is unborn; no user history to protect). Worktrees are not used because teammates share one checkout under one-owner-per-file.
2. Root lint/format tooling added (prettier, eslint, typescript-eslint) so the dense one-line foundation code can be made reviewable; owners reformat their packages when they touch them.
3. Approval requirement for promotion is derived server-side from the computed mutation class and stored policy; the `requiresApproval` input field is to be removed (A2-R).
4. The field-path wildcard grammar is frozen in OWNERSHIP.md item 2 and moves into `@expunge/contracts`.
5. Baseline commit CS-1 is deferred until the Wave A repairs and B2-1 land, then staged as one full snapshot with verifier evidence on that exact tree (committing a root manifest whose workspaces are excluded would be incoherent).
6. `research/` (prepared research, 7.2 MB, 153 files) is excluded from every commit pending a human decision: two notes contain third-party email addresses and 22 files contain the author's home-directory paths. Publishing it is the owner's call.
7. Native Agent Teams are unavailable in the Desktop app; the roster runs as named subagents (adapter recorded in OWNERSHIP.md). Lead model is claude-fable-5-1, not the requested claude-opus-5-5; this is reported, not hidden.

## Blocked acceptance items (need human input)

- Root `.env` with the principal URIs, provider key(s), CopilotKit Intelligence key and Raindrop keys. Names only in `.env.example`.
- Confirmation that the Atlas deployment is the email-invitation Hackathon Sandbox, and whether the account can create custom roles.
- Raindrop plan entitlement (Issues/Experiments are Pro-only per research notes).
- Node runtime: the machine has 22.23.2, 24.11.1 and 25.2.1 under nvm; none is in the fixed range `>=24.13.1 <25.0.0 || >=25.4.0` (util.inspect regression nodejs/node#60717 breaks error logging in the operator runtime and anything that logs a ZodError). Installing Node 24.13.1 is a download that needs the human: `nvm install 24.13.1 && nvm use 24.13.1`. Until then tests run on 25.2.1 with the operator's never-throwing console wrapper as mitigation.

## Next actions

1. Spawn the roster and start A2-R, A3-R, B2-1, V-1, DA-1, CS-1 (see TASKS.json).
2. First commit packet: baseline foundation plus tooling and continuity files.
