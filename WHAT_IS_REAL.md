# What is real

Maps every claim Expunge makes to the code path that implements it, the upstream pin it relies on, and the recorded evidence (command output, run ID or checkpoint). A claim with no evidence column entry is a plan, not a capability. This file is updated by team-lead only after the verifier records the evidence in `VERIFICATION.md`; see `docs/FEATURE-MATRIX.md` for state per feature.

Last updated: 2026-10-11 10:45 UTC. Git HEAD: UNBORN.

## Claims

| Claim | Code path | Upstream pin | Evidence | Real today? |
|---|---|---|---|---|
| Synthetic company worlds with nested, array, alias, cycle, namesake and mixed-eligibility structures, bounded to six collections and 500 documents | `packages/fixtures/src/generator.ts`, `recipes.ts` | none (new code) | `npx vitest run packages/fixtures/test` 2026-10-11: passed (counts in VERIFICATION.md once recorded) | Yes, locally |
| Hidden expected poststates and preservation hashes built independently of the reference solver | `packages/fixtures/src/sealed.ts`, `packages/grader/src/grade.ts` | none | fixtures/grader tests; DA-1 review pending | Yes, locally; independence under review |
| Fenced job leases and exactly-once logical effects in MongoDB transactions | `packages/mongo/src/jobs.ts`, `effects.ts` | mongodb driver 7.7.0 | integration suite skipped (no `MONGODB_TEST_URI`); A2-R will run it on a local replica set | Protocol code exists; not yet verified against a server |
| Atomic promotion that consumes a bound human grant and CAS-moves the active harness | `packages/mongo/src/deployment.ts` | mongodb driver 7.7.0 | same as above; approval derivation being moved server-side in A2-R | Partially |
| Candidate sandbox with default-deny egress | `infra/opendots/compose.candidates.yml`, `netguard.sh`, `candidate-proxy.mjs` | OpenBot computer image `b6932d31a8d6e7896c15139dfc27a6c6911deb27` | live namespace probe recorded in `infra/opendots/BUILD-A1.md` (temporary container, 403 and timeouts on all unintended targets) | Overlay yes; real candidate action not yet |
| Operator shell with owner auth, origin rules and read-only projection routes | `apps/operator/` | OpenDots `625452e06cde74cb25b0ce319e2c1be0488f5a5f` (MIT) | BUILD-A1.md: UI 200, unauth 401, evil origin 403, unconfigured domain 503 | Yes, setup-only (no Intelligence or provider key) |
| A fixed model's harness evolves from measured failures and the new version changes a subsequent run | not yet built (B1, B2, C1, C2, C3) | OpenMuse `1ac68f3909f2478ab6280883f1ab5ea65eb5719d`, AG-UI 0.0.59, CopilotKit 1.75.0, TanStack AI 0.63.0 | none | No |
| Raindrop traces are read back and cited by proposals | not yet built (C1) | raindrop-ai 1.0.1 | none | No |
| Hider, meta-improver, privacy lineage, benchmark | not yet built (D, E) | | none | No |

## Things that are explicitly not claimed

- Automatic legal compliance. Delete, redact, restrict and tombstone are product effects under owner policy.
- Model-weight improvement or unbounded recursive acceleration.
- Exactly-once delivery to external vendors (outbox is at-least-once with reconciliation).
- Document-level row security from Atlas roles (tenant binding is a trusted application boundary).
- Native Claude Code Agent Teams were used to build this: the build ran in the Claude desktop app with named subagents as a role-preserving adapter (see `docs/continuity/OWNERSHIP.md`).
