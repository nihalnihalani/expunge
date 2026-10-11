# Real-build session brief (2026-10-11, second machine)

Lead: team-lead, claude-opus-5-5, Claude Code desktop app 2.1.295, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
Every teammate reads this file, `EXPUNGE-CLAUDE-GOAL-SPEC.txt`, `docs/continuity/OWNERSHIP.md`, `docs/continuity/PROJECT-STATE.md`
and its own lane brief before editing, and states its effective model ID in its first report.

## The human's goal for this session (summary of the /goal text)

Finish Expunge as a real-data production application. `EXPUNGE-REAL-BUILD-SPEC.txt` is the named primary specification
and supersedes synthetic/mock instructions in the original spec; the original spec still defines remaining scope. Key
conditions from the goal text:

- Native owner-source registration and adapters over the owner's actual collections and exact identities, reference
  ownership and retention; original-source conditional effects with readback; external-writer consistency;
  production/staging configuration and role-scoped secrets.
- Replace synthetic-only policies, `data.*` envelope/collection assumptions, fake providers/readbacks, generated worlds and
  fixture-backed demos/tests with real services and authentic records. Deterministic fakes stay only for labeled
  protocol/fault tests.
- Operator endpoints/HITL, real OpenMuse/provider worker, broker/plugin execution with durable attestation, Atlas
  RBAC/fences/receipts/transactions/change streams/Search/Vector eligibility, real Raindrop tracing/outbox/query with leak
  guards and suppression, privacy purge/erasure runners, real provider evolver/Hider/improver and durable campaigns
  (interfaces or test-only callers do not count).
- Hider selects authentic cases and never invents records. The real-data protocol (360 task episodes, eight-incident
  I0/I1 plus I0/I0 and no-data controls) is amended and frozen before any run; insufficient genuine cases or budget stays
  BLOCKED with no generated substitutes.
- Mandatory working loop: source preview/approval/cleanup/receipt, real Raindrop ingest and Query readback,
  evidence-linked generated mutation, independent fresh admission, exact grant and atomic promotion, a subsequent real
  run on the new harness, rollback, recovery and privacy proof.
- Production: non-root pinned service images, CI, TLS/auth/origins, monitoring, durable recovery, tested backup/restore,
  runbooks. Required live lanes use `EXPUNGE_REQUIRE_LIVE_TESTS=1`.
- Never fabricate missing sources, rights, keys or budget.

## Facts at takeover (verified by the lead)

| Item | State |
|---|---|
| HEAD | 5b49dfe = origin/main, clean tree, empty index |
| `EXPUNGE-REAL-BUILD-SPEC.txt`, `EXPUNGE-DOTS-PROVISIONING-TASK.txt` | ABSENT on this machine (filesystem and Spotlight). Work from the goal summary above; anything only those files define is BLOCKED. Do not invent their contents. |
| Root `.env` | Absent at takeover; created by the human at 12:12 local. Only `MONGODB_SETUP_URI` (an Atlas `mongodb+srv` host, not yet confirmed as the invited Sandbox), the database/scope names, origins, floor hash and `EXPUNGE_MODEL_PROVIDER` are set. All nine least-privilege principal URIs, provider keys, `EXPUNGE_MODEL_ID`, Raindrop and CopilotKit keys are empty. No write to that cluster (including `setup:mongo`) until the human confirms it. |
| Lost WIP | Six packages were never committed and did not travel: `packages/gate` (PKT-24), `packages/deployment` (PKT-25), `packages/plugin-sandbox`, `packages/campaign-host`, `packages/rehearsal`, `packages/meta-evolution` (OWNERSHIP.md line 25; DA-9). `docs/review/DA-8-gate-deployment.md` and `docs/continuity/briefs/C3-admission-promotion.md` describe the first two. |
| Toolchain | node 25.8.0, npm 11.11.0 (engines allow >=25.4.0). Docker through colima. No host mongod/mongosh. |
| Baseline | `npm run typecheck` 0. `npx vitest run` 0: 998 passed / 557 skipped. Live lane (local replica sets, `EXPUNGE_REQUIRE_LIVE_TESTS=1`): 1532 passed / 14 failed / 1 skipped. The failures: 4 correct BLOCKED (provider, Raindrop x2, erasure), 2 netguard (candidate stack not running), 8 `tests/reliability/e1-worker-faults.live.test.ts` (REGRESSION: the fixture deploys no harness, so PKT-54's start-time `HarnessNotDeployed` refusal fires). |

## Local replica sets

The committed compose files share the compose project name `test` and run out of file descriptors under the full suite.
Run your own copy under a distinct project name with `ulimits: nofile: {soft: 64000, hard: 64000}` and your lane port:

| Owner | Port | Compose project |
|---|---|---|
| lead (shared baseline) | 27018 | expunge-local |
| local auth set (RBAC, shared, documented local-only credential) | 27019 | expunge-auth |
| mongodb-authority | 27118 | expunge-ma |
| rsi-evolution | 27218 | expunge-rsi |
| runtime-raindrop | 27318 | expunge-rr |
| verifier | 27418 | expunge-ver |

URI form: `mongodb://127.0.0.1:<port>/?replicaSet=expunge-local&directConnection=true`.

## Rules

- Git (human steering, 2026-10-11): all of this session's commits go on branch `charlie`, are pushed to `origin charlie`, and reach `main` only through pull requests. Nobody pushes to `main`; the original team still commits to `main` concurrently, and their commits are never reverted.

- One owner per path (OWNERSHIP.md). No teammate except commit-steward runs `git add`, `commit`, `stash`, `reset`,
  `checkout` or `push`. Submit a commit packet to team-lead: task ID, exact paths, sha256 of each file, commands with exit
  codes and counts, known gaps.
- Never print or commit secrets. Never write `.env`.
- Labeled deterministic fakes only for protocol/fault tests; never call a fake a live integration.
- A BLOCKED live condition is reported as BLOCKED, with the exact missing input.
