# Expunge project state (sanitized, version-controlled)

Updated: 2026-10-11 ~19:20Z (real UTC) by team-lead (claude-opus-5-5) after the second-machine takeover in the Claude Code desktop app (2.1.295, agent teams enabled). Session brief: `docs/continuity/briefs/REAL-BUILD-2026-10-11.md`. The earlier 13:10Z content below is retained as history where not superseded.

## Objective

Build the full-scope Expunge project described in `EXPUNGE-CLAUDE-GOAL-SPEC.txt` (sections 1 to 20) in this workspace. Local commits are authorized. Second-machine sessions commit on branch `charlie`, push to `origin charlie` and merge to `main` only through pull requests (human steering 2026-10-11); the original team still pushes to `main`. Public publishing, visibility changes, production deployment changes, paid upgrades and external messaging require explicit human authorization.

## Engine and team

- Engine: Claude Code CLI 2.1.296, agent teams enabled. Named teammates in the session's implicit team, messaging via SendMessage. See `docs/continuity/OWNERSHIP.md`.
- Lead effective model: `claude-opus-5-5` (as requested). Teammates: devils-advocate on opus; mongodb-authority, gateway-controls, runtime-raindrop, rsi-evolution, ui-ux-improver, verifier and verifier-2 on sonnet; commit-steward on haiku. TASKS.json records the effective IDs that each teammate reports.

## Current constraints (facts, not narrative)

| Item | State |
|---|---|
| Git | branch `main`; HEAD a4af80c = origin/main at takeover (54 commits); remote `origin` is private; every commit passes the HEAD-green gate and is pushed |
| Working tree | about 101 dirty or untracked lane paths at takeover, identical to checkpoint 20261011T122853Z-81ef900a (pack MATCH 318, worktree MATCH 1011) |
| Root `.env` | MISSING. All Atlas, model-provider, Raindrop and CopilotKit Intelligence live checks are BLOCKED until it exists. Required names are in `.env.example` and `docs/ENVIRONMENT.md`. |
| Node / npm | 24.13.1 / 11.8.0 installed through nvm at takeover (the supported floor); machine default stays 25.2.1, and teammates prefix PATH with 24.13.1 |
| Docker | colima; local replica sets on 27018 (protocol), 27019 (RBAC), 27218 (verifier-2), 27418 (gateway-controls) |
| Typecheck at takeover | `npm run typecheck` exit 0 (node 25.2.1, working tree) |

## Phase progress

| Phase | Status | Evidence |
|---|---|---|
| P0 audit, tooling, continuity | done | checkpoint tooling; takeover reconciliation ALL MATCH |
| Wave A repair (mongo, fixtures/grader) | done | fe12b51, e165d48, ae59942 |
| Wave B | B2 worker done (191cbb4 and follow-ups); B1 governance done (c663bfd), domain gateway PKT-16 in progress (DA-5 must-fix); B3 operator S1 and S2 landed, S3 in progress (DA-7) | COMMIT-LEDGER.md |
| Wave C | C2 compiler/evolver done (PKT-5, PKT-9, PKT-19); C1a and C1c landed (PKT-14, PKT-21 217a55a), C1b held in tree; C3 fixtures/grader keyed derivation landed (PKT-23 22b015f), gate and deployment HELD (PKT-24/25, DA-8) | COMMIT-LEDGER.md |
| Wave D | D1 Hider and D3 privacy started (tree only); D2 briefed | TASKS.json |
| Wave E | E1, E2, E3 briefed; restore drill passed (V-3b) | VERIFICATION.md |

## Decisions

1. Work continues on `main` (repository is unborn; no user history to protect). Worktrees are not used because teammates share one checkout under one-owner-per-file.
2. Root lint/format tooling added (prettier, eslint, typescript-eslint) so the dense one-line foundation code can be made reviewable; owners reformat their packages when they touch them.
3. Approval requirement for promotion is derived server-side from the computed mutation class and stored policy; the `requiresApproval` input field is to be removed (A2-R).
4. The field-path wildcard grammar is frozen in OWNERSHIP.md item 2 and moves into `@expunge/contracts`.
5. Baseline commit CS-1 is deferred until the Wave A repairs and B2-1 land, then staged as one full snapshot with verifier evidence on that exact tree (committing a root manifest whose workspaces are excluded would be incoherent).
6. `research/` (prepared research, 7.2 MB, 153 files) is excluded from every commit pending a human decision: two notes contain third-party email addresses and 22 files contain the author's home-directory paths. Publishing it is the owner's call.
10. DA-5 on the domain gateway (2026-10-11, real UTC about 11:55Z): DG1, DG2, DG3, DG4, DG5, DG6, DG7, DG8 and DG11 are must-fix before the domain packet is accepted (runtime workflow enforcement, ownership-scoped discovery, identity only from identity-role fields, per-job budgets, lease-fenced control rows, inputs digest verified on replay, typed references as residuals, closure truncation never silent, error-name alignment); DG9, DG10, DG12 may follow as PKT-16b. A second implementer under mongodb-authority's direction was offered to split the work by file.
9. Lead decisions for C1c (2026-10-11 12:58 UTC): raindrop-ai 1.0.1 accepted with its 126-package transitive tree and 38 advisories, rationale and production options in PRODUCTION-READINESS.md; optional `delivery` labels on EvidenceReference and EvidenceReadyPayload; `selectWrongIncident` and `privateIdHash` ('expunge-private-id:v1', NFKC) live in packages/contracts as pure functions shared by observer, evolution and grader; free text without a subject-literal list is reduced to hash and length (fail closed) instead of refusing to trace; poisoned remote events are quarantined as structure-only rows, never refused inside the cursor transaction; runtime-raindrop holds a one-time additive edit grant on packages/contracts for these fields.
8. A commit packet that adds a workspace never carries the working-tree package-lock.json: the steward stages the packet, exports the index to a scratch directory, regenerates the lock there with `npm install --package-lock-only --ignore-scripts`, diffs it structurally against HEAD, proves `npm ci --ignore-scripts`, stages the regenerated lock and restores the working-tree lock byte for byte (first used for PKT-8).
7. Native Agent Teams are unavailable in the Desktop app; the roster runs as named subagents (adapter recorded in OWNERSHIP.md). Lead model is claude-fable-5-1, not the requested claude-opus-5-5; this is reported, not hidden.

11. Amendment A-1 (2026-10-11 13:20Z): model and tool call ceilings rise from 12 to 16 for every arm, and a new workflow outcome `batches_remaining` is added. Plans apply one batch per effect kind (2 to 4 apply calls on the ten families), and with workflow enforcement a 12-call ceiling made the expert verification-failure round impossible. The amendment is recorded in PREREGISTRATION.md before any result and lands inside PKT-16. PKT-32 was withdrawn.

12. PKT-16 lands (14:45Z decision) with two recorded OPEN items, against devils-advocate's blocking recommendation. P2-1: the WorldSpec fault plan is not injected on the domain path; a fault layer driven by a stored grader-written campaign row follows the collections packet. P2-2 / DG1: discovery still reaches shared parents (NT-1b); PKT-16b adds per-edge ownership. Both are pinned by KNOWN GAP tests or labels, and both block the scientific freeze. No real cleanup campaign runs before PKT-16b.
13. Bounded overlap (GC-a): calls that overlap within one lease are judged from the same settled position. A node may repeat without a self edge, bounded by visits reserved at begin, toolCalls and the tool's own guards. A call_in_flight serialization was rejected because one abandoned tool would wedge the run.
14. Evaluation runs never use the setup principal. The grader creates candidate- or parent-pinned cleanup jobs only on campaign worlds; fixture_builder seeds and resets.

15. Runtime attestation (DA-8 D8-2/D8-3, 15:43Z): the worker computes runtimeHash() in-process from its loaded runtime, vendored OpenMuse and contracts bytes and writes it to the job checkpoint at claim. The gate compares that value against the stored campaign freeze. This is accepted as trusted-infrastructure attestation: the worker is a separate identity that no candidate or caller can supply or alter. It is disclosed as a self-measurement of the worker build, not an external measurement such as a TPM or signed image digest. Candidate- and port-supplied attestations are never admitted.

16. Campaign result artifacts (16:10Z): campaign artifacts live in insert-only `campaign_artifacts` (_id `campaign:<campaignId>`) and `campaign_artifact_rows`. The grader can INSERT and FIND, projection_reader can FIND, and nobody can UPDATE or REMOVE. A summary is refused until all of its rows are committed. A row commit emits `campaign_row_committed` in the same transaction. The job references the artifact by its deterministic id. Lands in PKT-62; projection serving in PKT-63.
17. Meta draw commitment (16:11Z, DA-8 R3 gap): `meta_draw_commitments` is INSERT-only. It is written with `forceServerObjectId`, its time is `_id.getTimestamp()` (server time to 1 s), and each row must be at least 2 s (META_DRAW_MIN_GAP_MS) after the previous one (commitment, I1, freeze, draw). I1's creation time is server-stamped the same way. No `$currentDate` upsert, so there is no UPDATE grant. Lands in PKT-62 (grants) and PKT-43 (use).
18. PKT-24/25 must carry the `packages/fixtures/src/sealed.ts` and `splits.ts` changes. The gate imports their sealed-plan exports, and HEAD typecheck fails without them (verifier pre-run, 16:09Z).

19. Second-machine takeover (2026-10-11 ~19:05Z): the checkout arrived by git only. HEAD 5b49dfe = origin/main, clean. Ignored state (HANDOFF.md, .expunge/checkpoints, scratchpad packet snapshots) did not travel, so the uncommitted packages/gate (PKT-24) and packages/deployment (PKT-25) are lost and are being rebuilt from the C3 brief and DA-8 (RSI-G1). The human's new goal names `EXPUNGE-REAL-BUILD-SPEC.txt` and `EXPUNGE-DOTS-PROVISIONING-TASK.txt`; neither exists on this machine, so the work follows the goal text and the original spec, and anything only those files define is BLOCKED. New baseline checkpoint 20261011T190419Z-31cd0151. Local replica sets need `ulimits nofile 64000` under the full suite (mongod died with EMFILE at the default); the committed compose files also share the project name `test`, so run each under its own `-p`.
20. Baseline at 5b49dfe on node 25.8.0: typecheck 0; lint 0 (0 errors, 43 warnings); format:check 0; continuity 42/42; default vitest 998 passed / 557 skipped; live lane (local replica sets, EXPUNGE_REQUIRE_LIVE_TESTS=1) 1532 passed / 14 failed / 1 skipped, of which 4 are correct BLOCKED (provider, Raindrop x2, erasure), 2 need the candidate netguard stack running, and 8 are a real regression in tests/reliability/e1-worker-faults (fixture deploys no harness since PKT-54). Operator (own lock): typecheck 0, 77 files / 586 tests passed, build 0.

21. Atlas Sandbox (2026-10-11 ~19:45Z): the human confirmed the root `.env` cluster is the invited Hackathon Sandbox and authorized writes. Read-only probe (committed code, setup principal): MongoDB 8.0.34, replica set, transactions supported, logical session timeout 30 min; setup user roles atlasAdmin, backup, clusterMonitor, dbAdminAnyDatabase, enableSharding, readWriteAnyDatabase. `setup:mongo` from a clean export of committed code (not working-tree WIP): exit 0, 72 collections, 77 indexes, 3 authority policies, 1 authority; a second run returned the same counts (idempotent). Validators strict/error: world 3 of 11 collections, control 40 of 54, private 1 of 7. `listSearchIndexes` succeeds on the cluster. Least-privilege principals are not created: Atlas custom roles need the Atlas Administration API (no API key in `.env`) or the Atlas UI; all nine principal URIs are empty, so Atlas RBAC denial proof stays BLOCKED.

## Blocked acceptance items (need human input)

- Root `.env` holds only the Atlas setup URI (confirmed Sandbox) and names; principal URIs, provider, Raindrop and CopilotKit keys are empty. Least-privilege Atlas principals need an Atlas Administration API key (`ATLAS_PUBLIC_KEY`, `ATLAS_PRIVATE_KEY`, `ATLAS_PROJECT_ID`) or manual creation in the Atlas UI.
- `EXPUNGE-REAL-BUILD-SPEC.txt` and `EXPUNGE-DOTS-PROVISIONING-TASK.txt` are absent on this machine.
- Authorized real owner data sources (rights, access, retention terms) for the real-data protocol, Hider case selection and the working-loop demonstration. None is available; no generated substitute will be used.
- Provider and campaign budget for 360 task episodes and the eight-incident meta controls.

- Root `.env` with the principal URIs, provider key(s), CopilotKit Intelligence key and Raindrop keys. Names only in `.env.example`.
- Confirmation that the Atlas deployment is the email-invitation Hackathon Sandbox, and whether the account can create custom roles.
- Raindrop plan entitlement (Issues/Experiments are Pro-only per research notes).
- `research/` publication decision and repository visibility.

## Next actions (19:20Z, second machine)

1. V-R1 (verifier): fix the E1 fixture regression; run the netguard stack; full live-lane table.
2. RSI-G1 (rsi-evolution): rebuild packages/gate against DA-8; then packages/deployment.
3. MA-R1 (mongodb-authority): audit synthetic-world assumptions; native owner-source registry, adapter, conditional effects with readback, external-writer conflicts; PKT-16b.
4. RR-P1 (runtime-raindrop): non-root pinned service images with private-file exclusion tests, production topology, backup/restore drill, runbooks, CI job list.
5. DA-9 (devils-advocate): real-data gap audit and overclaim review; then reviews of each packet.
6. commit-steward: gated commits pushed to the private origin after verifier and devils-advocate dispositions.
