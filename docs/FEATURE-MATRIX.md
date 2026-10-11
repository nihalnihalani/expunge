# Expunge feature acceptance matrix

States: **NOT_STARTED** (no code), **IMPLEMENTED** (code exists, no independent verification), **LOCALLY_VERIFIED** (verifier ran deterministic or local-service checks on the current tree), **LIVE_VERIFIED** (verifier ran it against the invited Atlas sandbox, the real model provider or Raindrop and recorded run IDs), **BLOCKED** (cannot progress without an external input named in the row). A row moves state only when the verifier records the evidence in `VERIFICATION.md`; owners cannot self-promote a row.

Updated 2026-10-11 11:30 UTC by team-lead. Git HEAD: UNBORN (baseline commit pending A2-R and B2-1).

| # | Feature (spec section) | Owner | State | Evidence pointer | Blocker |
|---|---|---|---|---|---|
| 1 | Foundation repair: wildcard path grammar, provenance closure, revocation coverage, policy-derived approval (5) | mongodb-authority | NOT_STARTED → in progress (A2-R) | | |
| 2 | Foundation repair: ScopeKey hashing, default binding, canaries, bounds (5) | rsi-evolution | LOCALLY_VERIFIED | VERIFICATION.md 2026-10-11 10:23Z: fixtures+grader 116/116, tsc 0, eslint/prettier clean, DA repros fx-shape-shortcut and fx-commitments not reproduced | |
| 3 | Three-database Atlas layout, validators, indexes, principals (6) | mongodb-authority | IMPLEMENTED (local only) | packages/mongo/src/setup.ts, validators.ts, roles.ts | Invited Atlas sandbox and role rights: root `.env` missing |
| 4 | Fenced leases, logical effect keys, action and completion receipts (6, 7) | mongodb-authority | IMPLEMENTED (local only) | packages/mongo/src/jobs.ts, effects.ts | Local replica-set run pending in A2-R |
| 5 | Atomic promotion with grant consumption, CAS, rollback (6, 10) | mongodb-authority | IMPLEMENTED (approval derivation being fixed) | packages/mongo/src/deployment.ts | |
| 6 | Change-stream projection with resume tokens and backfill (6, 12) | mongodb-authority | IMPLEMENTED (local only) | packages/mongo/src/events.ts | |
| 7 | Exact and hybrid (Search/Vector) lesson retrieval with authoritative re-read (6) | mongodb-authority | NOT_STARTED | | Atlas Search/Vector availability on the invited sandbox |
| 8 | Synthetic worlds, structural families, sealed manifests, split commitments (10) | rsi-evolution | LOCALLY_VERIFIED | as row 2; isomorphic decoy chains, shape canary, instance-scoped ids, salted split commitments | |
| 9 | Independent grader and reference-solver admission (10) | rsi-evolution | LOCALLY_VERIFIED | as row 2; publicGradeReport withholds manifest hashes; shape_leak quarantine | second independent solver planned (C3) |
| 10 | Typed worker tools inspect/resolve/discover/preview/apply/verify/complete (7) | runtime-raindrop (domain gateway, B1) | NOT_STARTED | | |
| 11 | Durable worker, OpenMuse helper port, ExpungeExecutionAgent clone/cancel semantics (4, 7) | runtime-raindrop | NOT_STARTED → in progress (B2-1) | | Live provider smoke: provider key missing |
| 12 | OpenBot candidate sandbox: egress default-deny, broker transport, plugin execution (4, 9) | runtime-raindrop (+ infra overlay from A1) | IMPLEMENTED (overlay only; live isolation probe recorded in infra/opendots/BUILD-A1.md) | infra/opendots | Pinned image build and real candidate action pending |
| 13 | OpenDots operator: setup/readiness, cleanup, workbench, evidence, candidate, evaluation, approval, receipt, lineage, campaigns, privacy screens (13) | ui-ux-improver | NOT_STARTED → design in progress (U-0) | | CopilotKit Intelligence key for any real conversation |
| 14 | Review tool registered via client HITL hook and DotAgent allowlist; reconnect from snapshot plus sequence (12, 13) | ui-ux-improver | NOT_STARTED | | |
| 15 | Raindrop worker/improver tracing, outbox states, observer read-back, diagnostics dispatch (8) | runtime-raindrop | NOT_STARTED | | Raindrop write and query keys missing |
| 16 | Evidence-linked typed proposals across four surfaces; compiler rejects unsafe edits; as-of replay (9) | rsi-evolution | NOT_STARTED | | |
| 17 | Fresh paired admission, gate report, approval descriptor, promotion, rollback end to end (10) | rsi-evolution | NOT_STARTED | | |
| 18 | Hider curriculum with reference-solver admission (11) | rsi-evolution | NOT_STARTED | | |
| 19 | Fresh-base I0/I1 meta experiment with controls (11) | rsi-evolution | NOT_STARTED | | Model budget |
| 20 | Privacy lineage: retraction closure, artifact byte checks, external deletion lifecycle (12) | runtime-raindrop | NOT_STARTED | | Raindrop organization scope |
| 21 | Reliability: crash, takeover, race, containment tests (15) | verifier | NOT_STARTED | | |
| 22 | Preregistered benchmark and meta protocol executed and reported (16) | verifier + rsi-evolution | NOT_STARTED | | Provider budget, Atlas sandbox |
| 23 | Production packaging, runbooks, CI, deployment rehearsal (18) | team-lead + runtime-raindrop | NOT_STARTED | | Deployment target authorization |
| 24 | Continuity: checkpoint manifests, HANDOFF, restore verification (20) | verifier | LOCALLY_VERIFIED | checkpoints 20261011T101215Z-98d5f03d and 20261011T102508Z-e23be882 complete; test:continuity 27/27; stale-narrative and writer-lock scenarios | Claude to Codex handoff drill pending |
