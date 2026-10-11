# Expunge project state (sanitized, version-controlled)

Updated: 2026-10-11 18:22 IST (12:52 UTC) by team-lead. This file holds no credentials. Checkpoint packs live in the ignored `.expunge/checkpoints/` directory; the local briefing is the ignored `HANDOFF.md`.

## Objective

Build the full-scope Expunge project described in `EXPUNGE-CLAUDE-GOAL-SPEC.txt` (sections 1 to 20) in this workspace. Local commits are authorized. Public publishing, production deployment changes, paid upgrades and external messaging require explicit human authorization.

## Engine and team

- Engine: Claude Code inside the Claude desktop app. Native Agent Teams are CLI-only per the official docs; this build uses named subagents with per-agent model selection and direct messaging as a role-preserving adapter. See `docs/continuity/OWNERSHIP.md`.
- Lead effective model: `claude-fable-5-1` (session model). Spec requested `claude-opus-5-5`.
- Teammates: spawned with `opus` / `sonnet` / `haiku` aliases; effective IDs are recorded in TASKS.json when each teammate reports.

## Current constraints (facts, not narrative)

| Item | State |
|---|---|
| Git | branch `main`; HEAD ba41d7b = origin/main, 30 commits (baseline fe12b51; per-lane packets PKT-2 to PKT-18 each followed by a COMMIT-LEDGER row commit); remote `origin` = https://github.com/nihalnihalani/expunge (private); every commit is pushed immediately (human instruction); workspace-adding packets get a lock regenerated from the staged tree; every packet passes the HEAD-green gate (npm ci + typecheck on a scratch export of the staged index) |
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
| Wave A repair (A2-R mongo, A3-R fixtures/grader) | done | commits fe12b51, e165d48, ae59942 |
| Wave B (gateway, worker/OpenMuse, operator UX) | B2 done (191cbb4); B1 governance half done (c663bfd), domain gateway in progress; B3 S1 under verification (PKT-10), S2 in progress | commits 191cbb4, c663bfd; VERIFICATION.md |
| Wave C (Raindrop, compiler/evolver, admission/promotion) | C2 done (4eb6d5d, cd821d6; DA-5a fixes PKT-19 in verification); C1a verified and approved (PKT-14), C1c fixes and C1b integration next; C3 in progress | checkpoints 0f466519, cf40f999, 86e41ce5 |
| Wave D (Hider, meta, privacy) | briefed (docs/continuity/briefs/D1, D2, D3) | |
| Wave E (reliability, benchmark, deployment) | briefed (E1, E2, E3); restore drill passed | VERIFICATION.md verifier-2 section |

## Decisions

1. Work continues on `main` (repository is unborn; no user history to protect). Worktrees are not used because teammates share one checkout under one-owner-per-file.
2. Root lint/format tooling added (prettier, eslint, typescript-eslint) so the dense one-line foundation code can be made reviewable; owners reformat their packages when they touch them.
3. Approval requirement for promotion is derived server-side from the computed mutation class and stored policy; the `requiresApproval` input field is to be removed (A2-R).
4. The field-path wildcard grammar is frozen in OWNERSHIP.md item 2 and moves into `@expunge/contracts`.
5. Baseline commit CS-1 is deferred until the Wave A repairs and B2-1 land, then staged as one full snapshot with verifier evidence on that exact tree (committing a root manifest whose workspaces are excluded would be incoherent).
6. `research/` (prepared research, 7.2 MB, 153 files) is excluded from every commit pending a human decision: two notes contain third-party email addresses and 22 files contain the author's home-directory paths. Publishing it is the owner's call.
9. Lead decisions for C1c (2026-10-11 12:58 UTC): raindrop-ai 1.0.1 accepted with its 126-package transitive tree and 38 advisories, rationale and production options in PRODUCTION-READINESS.md; optional `delivery` labels on EvidenceReference and EvidenceReadyPayload; `selectWrongIncident` and `privateIdHash` ('expunge-private-id:v1', NFKC) live in packages/contracts as pure functions shared by observer, evolution and grader; free text without a subject-literal list is reduced to hash and length (fail closed) instead of refusing to trace; poisoned remote events are quarantined as structure-only rows, never refused inside the cursor transaction; runtime-raindrop holds a one-time additive edit grant on packages/contracts for these fields.
8. A commit packet that adds a workspace never carries the working-tree package-lock.json: the steward stages the packet, exports the index to a scratch directory, regenerates the lock there with `npm install --package-lock-only --ignore-scripts`, diffs it structurally against HEAD, proves `npm ci --ignore-scripts`, stages the regenerated lock and restores the working-tree lock byte for byte (first used for PKT-8).
7. Native Agent Teams are unavailable in the Desktop app; the roster runs as named subagents (adapter recorded in OWNERSHIP.md). Lead model is claude-fable-5-1, not the requested claude-opus-5-5; this is reported, not hidden.

## Blocked acceptance items (need human input)

- Root `.env` with the principal URIs, provider key(s), CopilotKit Intelligence key and Raindrop keys. Names only in `.env.example`.
- Confirmation that the Atlas deployment is the email-invitation Hackathon Sandbox, and whether the account can create custom roles.
- Raindrop plan entitlement (Issues/Experiments are Pro-only per research notes).
- Node runtime: the machine has 22.23.2, 24.11.1 and 25.2.1 under nvm; none is in the fixed range `>=24.13.1 <25.0.0 || >=25.4.0` (util.inspect regression nodejs/node#60717 breaks error logging in the operator runtime and anything that logs a ZodError). Installing Node 24.13.1 is a download that needs the human: `nvm install 24.13.1 && nvm use 24.13.1`. Until then tests run on 25.2.1 with the operator's never-throwing console wrapper as mitigation.

## Next actions

1. Land PKT-9 (evolution) and PKT-10 (operator S1); unfreeze owners.
2. B1 domain gateway packet (mongodb-authority), then DA-5 gateway review by reading.
3. C1 Raindrop packet (runtime-raindrop) with the offline-replayable outbox; live sender BLOCKED on root .env.
4. C3 gate and deployment (rsi-evolution); DA-5a governance and evolution review (devils-advocate).
5. B3 S2 to S8 operator slices; V-3 probes and the Claude-to-Codex handoff drill.
