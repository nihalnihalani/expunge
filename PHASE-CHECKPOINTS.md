# Phase checkpoints

Append-only. Each entry: UTC time, checkpoint ID (from `.expunge/checkpoints/<ts>-<nonce>/manifest.json` once tooling exists), Git HEAD or UNBORN, what was verified, what is unverified, next action.

## 2026-10-11T10:10Z P0 audit complete

- Git: UNBORN main, all files untracked.
- Verified: `npx vitest run` 55 passed / 17 skipped (exit 0); `npm run typecheck` 1 error in `packages/mongo/test/integration.test.ts`; Docker 28.4.0 reachable; Node v25.2.1.
- Unverified: everything live (no root `.env`).
- Checkpoint pack: not yet created (tooling V-1 pending).
- Next: tooling, continuity skeleton, spawn roster, baseline commit.

## 2026-10-11T10:58Z P0 setup complete; Wave A repair and B2-1 in flight

- Git: UNBORN main. Baseline commit packet CS-1 in preparation by commit-steward.
- Engine note recorded: Desktop app, named subagents (no native Agent Teams); lead claude-fable-5-1; teammates confirmed claude-sonnet-5-5 x5, claude-opus-5-5 (devils-advocate), claude-haiku-5-5 (commit-steward).
- Verified this checkpoint: `npx vitest run packages/baselines` 6 passed; `node scripts/hooks/subagent-report-gate.mjs` pipe-tests (exit 2 on missing footer, 0 on complete footer, 0 on exempt type and stop_hook_active); `jq -e` on .claude/settings.json exit 0; root-owned files eslint exit 0.
- Known failing at this checkpoint: root `npm run typecheck` (1 error, mongo test, under repair), `npm run lint` (57 baseline errors, owners fixing), `npm run format:check` (49 files, owners fixing).
- Unverified: everything live (no root `.env`).
- Checkpoint pack: pending V-1 tooling.
- Active lanes: A2-R mongodb-authority, A3-R rsi-evolution, B2-1 runtime-raindrop, V-1 verifier, DA-1 devils-advocate, CS-1 commit-steward, U-0 ui-ux-improver.

## 2026-10-11T10:12Z first real checkpoint pack (verifier V-1)

- Checkpoint `20261011T101215Z-98d5f03d`, complete=true, base UNBORN, 534 files; `npm run checkpoint:verify -- latest` MATCH immediately after capture; later CHANGED on 3 files edited by lanes (expected). Disposable restore into an empty scratch repo: READY, APPLIED (486 files MATCH), ALREADY_APPLIED on rerun.
- Matrix at 10:10Z (VERIFICATION.md): root vitest 92 passed / 41 skipped (Mongo integration, no MONGODB_TEST_URI); `npm run test:continuity` 23/23; candidate proxy 5/5; operator typecheck 0 errors; operator tests 298 passed / 7 failed (tests/telemetry.test.ts, upstream runtime console.error on ZodError throws in util.inspect; root cause assigned to V-2); root typecheck 2 errors and lint 16 errors in in-flight lane files.
- Live checks: all BLOCKED (root .env missing).

## 2026-10-11T10:25Z A3-R verified; checkpoint 20261011T102508Z-e23be882

- Checkpoint `20261011T102508Z-e23be882`, complete=true, 572 files, verify ALL MATCH at capture.
- Verifier independent run (10:23Z): fixtures+grader 116/116; tsc 0 errors; eslint/prettier clean; DA repros fx-shape-shortcut and fx-commitments exit 1 (not reproduced). contracts/src/index.ts sha256 at that moment 5337c37af865663f...; later edited by A2-R (323ae3b5...), so A3-R commitments are provisional.
- test:continuity 27/27 (stale-narrative and active-writer-lock scenarios added; restore exit 6 STALE_CHECKPOINT, exit 7 lock).
- npm audit: no critical advisories; none reachable in current usage (details in PRODUCTION-READINESS.md).
- Operator telemetry: Node util.inspect regression nodejs/node#60717; pristine upstream fails identically on 24.11.1 and 25.2.1; fixed in 24.13.1 / 25.4.0 (human to install); never-throwing console wrapper approved for B3.
- Lanes: A2-R (with DA items) and B2-1 still in flight; C2 and DA-2 started; U-0 in flight; verifier holding the full matrix for A2-R/B2-1.

## 2026-10-11T10:54Z first commits pushed: fe12b51 (baseline, 470 files) and 506b73e (ledger)

- Remote: https://github.com/nihalnihalani/expunge (private), origin/main = 506b73e.
- Evidence: VERIFICATION.md matrix at checkpoint 20261011T104052Z-d8708c42 plus runtime addendum at 20261011T104733Z-e126f3e6; commit staged against checkpoint 20261011T105339Z-588fbefd (ALL MATCH). typecheck 0; vitest 322 passed / 0 failed / 217 skipped; replica-set + RBAC lane 297 passed / 1 failed (live-provider smoke BLOCKED) / 1 skipped; runtime lanes 126 passed / 7 skipped (132 with replica set); test:continuity 35/35; candidate proxy 6/6; verify-candidate 0; operator typecheck 0, tests 328/328, build 0; all DA repros exit 1.
- Known failing, named in the commit message: lint 18 errors (docs/review/repro 4, contracts test 2, mongo src 9, mongo test 3); format 15 files (docs/review/repro, infra/opendots).
- Excluded: research/ (152 files) pending the human's publication decision.
- Lessons: a reviewer's direct message resumed an idle lane during the barrier (protocol added to OWNERSHIP.md); lead edits after a checkpoint cost two re-checkpoints (lead freezes during staging).
- Barrier lifted 10:58Z; lanes resumed: A2-R→B1 (mongodb-authority), C2 (rsi-evolution), B3 (ui-ux-improver), B2-2→C1 (runtime-raindrop), V-3 (verifier), DA-4 (devils-advocate). Commit cadence is now per lane packet.

## 2026-10-11T11:04Z to 11:09Z per-lane commits: e165d48 (mongo A2-R finish), d119446 (review DA-4)

- e165d48 + ledger 082d2e1: mongo hardening finish; evidence checkpoint 20261011T110113Z-7399111f (packet tsc 0, eslint 0, prettier 0, fast lane 67 passed / 227 skipped, live lane 294 passed / 0 skipped on local replica set + authenticated RBAC).
- d119446 + ledger 7cbb983: review corpus; evidence checkpoint 20261011T110624Z-c6c4193c (eslint 0, prettier 0, 11 reproductions exit 1 incl. mg-live 12/12 against a replica set).
- Approved and in the steward's queue: PKT-4 runtime B2-2 (checkpoint 20261011T110731Z-bf35d38f: 155 passed / 12 skipped, 166 with replica set; K1 to K4 closed). Under verification: PKT-5 compiler C2-1 (owner: 204 passed / 2 skipped; live parity 74 passed, 3,600 predicate evaluations).
- Lessons: packet text must be derived from the diff, not from the owner's path list (the steward caught four unchanged files I described as modified); package-lock.json changes belong to the lane that added a workspace, never to a lane that only edited an exports map.
- Live checks still BLOCKED (no root .env). Node floor still needs the human (nvm install 24.13.1).

## 2026-10-11T11:10Z to 11:24Z per-lane commits continued

- 191cbb4 worker B2-2 (checkpoint bf35d38f; 155 passed / 12 skipped, 166 with replica set; K1 to K4 closed).
- 4eb6d5d compiler C2-1 (checkpoint 0f466519; 204 passed / 2 skipped; live parity 74/74).
- ae59942 mongo B1-0 (checkpoint 67b789d4; live lane 306 passed / 0 skipped; WorldKey brand; K6 closed).
- f70d81f lead docs (checkpoint 948d66c0).
- In the steward's queue: PKT-8 governance B1-1 (checkpoint e6f7526f; 18/18 live) under the new lock-regeneration rule (lock derived from the staged tree, npm ci proven in a scratch export, working-tree lock restored); PKT-9 evolution C2-2 under verification (owner: 298 passed / 2 skipped; live parity 135/135; 61-code rejection catalog; three-arm control run: trace-informed candidate fixes 2 recorded harmful completions, score-only and wrong-incident fix 0).
- Lessons: a workspace manifest whose entry file does not exist yet is committed with its code, not before; the committed lock must reference only committed workspaces.

## 2026-10-11T11:26Z to 11:40Z

- c663bfd governance B1-1 (checkpoint e6f7526f; first lock regenerated from the staged tree: 2 entries added, npm ci exit 0 in the scratch export).
- cd821d6 evolution C2-2 (checkpoint cf40f999; 298 passed / 2 skipped; live parity 135/135; 61-code rejection catalog; lock 2 entries added, no new third-party).
- Defect: HEAD did not typecheck on its own (packages/mongo/src/index.ts exported './edges.js', a file that only ever existed untracked during PKT-6). Hotfix PKT-11 approved as a one-line commit with a new HEAD-green gate (npm ci + typecheck on a scratch export of the staged tree, before and after). Lesson: the working-tree matrix proves the working tree, not the commit.
- In flight: PKT-10 operator S1 (verifier), PKT-12 small mongo packet (campaign_keys, completeIncomplete), C1a observability+observer (82 tests offline; Mongo-backed tests next), C3 gate/deployment, DA-5a governance+evolution review by reading.

## 2026-10-11T11:40Z to 12:30Z

- 5e229c9 hotfix PKT-11 (HEAD-green gate before exit 2, after exit 0).
- f17fd61 operator S1 PKT-10 (checkpoint d9f6feba; 390/390, build 0, browser 108/0; 16 screenshots).
- 7fe7762 DA-5a review PKT-13 (governance G1 to G7, evolution E1 to E4; fixes assigned before the domain packet).
- 88a75a3 mongo PKT-12 (checkpoint 9b77b25b; live 329 passed / 0 skipped; completeIncomplete, campaign_keys). HEAD f9ee239 = origin/main, 29 commits.
- HEAD proof c45be9b by verifier-2: npm ci 0, typecheck 0, default vitest 537 passed / 0 failed / 254 skipped (recorded in COMMIT-LEDGER HEAD-proof history).
- verifier-2 added (append-only VERIFICATION.md section; replica set 27218). Wave D and E briefs written (D1, D2, D3, E1, E2, E3).
- In verification: PKT-14 C1a (observability + observer, 33 files). Queued: PKT-18 DA-6 review. Coming: PKT-15 mongo hardening, PKT-16 domain gateway (DA-5 reading started at the nine-tool export point), PKT-17 operator S2 (54 paths), C1c DA-6 fixes, C2-3 evolution fixes, C3 gate.

## 2026-10-11T12:30Z to 13:35Z

- ba41d7b C1a observability + observer (checkpoint 86e41ce5; lock +132 entries of which 126 third-party via raindrop-ai; audit 7 -> 38 accepted with rationale; verifier measured that OTEL_PROPAGATORS=jaeger switches propagation at this commit, closed by C1c).
- 7c74461 lead docs (checkpoint 8c9431de; Wave D/E briefs, HEAD-green gate, verifier-2, dependency assessment).
- 83980b9 evolution C2-3 (checkpoint 80a59605; out-of-sample selection, attributed standing; parity 136/136; tampered-catalog control exit 1).
- 96f7b89 mongo PKT-15 (checkpoint 5bf111d3; versions enforced, PartialEffect, writeField session, worldKey from stored jobs; export 335/335, whole repo 826/0/72 with replica set; one surviving mutation recorded as a test gap).
- HEAD proofs: e4f6b51 620/272 skipped; d9b42b2 638/278 skipped; audit 38 at both.
- Restore drill (verifier-2): 887/887 hashes in a scratch clone; npm ci + typecheck 0 in the restored tree; findings for the restore tool (no briefing copy, LATEST lag).
- DA-5 on the domain gateway: DG3 workflow graph unenforced at runtime (demonstrated), DG1 over-selection cascade, DG2 content strings as identity; nine must-fix items before PKT-16.
- In flight: PKT-17 operator S2 (verifier), PKT-21 C1c (verifier-2), PKT-22 DA-5 docs (steward); C1b held; D3 privacy started; C3 and fixtures/grader packets pending; second domain implementer offered.

## Clock erratum (recorded 2026-10-11 12:12Z real UTC)

- Clock erratum: lead-written times labelled UTC between 11:30 and 13:46 in these documents ran about 95 minutes ahead of real UTC (checked against `date -u` at 12:11Z); checkpoint ids and git commit dates carry the true times. Later entries use real UTC.

## 2026-10-11 12:21Z real UTC: usage-limit switch (spec section 20)

- Write barrier to all nine agents at 12:21Z. Pre-switch checkpoint 20261011T122117Z-85f4b535 (base abafe0b, complete). HEAD abafe0b = origin/main, 46 commits.
- Landed since the last entry: 1201525 operator S2; be26a69 DA-5 + mg-live; 0971283 DA-7; 5ae24ef lead docs 2; ledger rows between.
- In flight (frozen, uncommitted, in the pack): PKT-21 C1c, PKT-23/24/25 C3, PKT-26 continuity, PKT-16 domain gateway (DA-5 must-fix), C1b held, P1b, S3, D1, D3, DA-8 draft.
- PKT-29 commits the state documents; a final checkpoint follows and becomes LATEST. Resume prompt in HANDOFF.md and PROJECT-STATE.md.
