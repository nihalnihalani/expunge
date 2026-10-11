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
