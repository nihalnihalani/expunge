# What is real

Maps every claim Expunge makes to the code path that implements it, the upstream pin it relies on, and the recorded evidence (command output, run ID or checkpoint). A claim with no evidence column entry is a plan, not a capability. This file is updated by team-lead only after the verifier records the evidence in `VERIFICATION.md`; see `docs/FEATURE-MATRIX.md` for state per feature.

Last updated: 2026-10-11 12:05 UTC. Git HEAD: c45be9b (20 commits, pushed). Rows marked "commit pending" are verified on a checkpoint and in the steward's queue; rows marked "owner-reported" have no verifier row yet.

## Claims

| Claim | Code path | Upstream pin | Evidence | Real today? |
|---|---|---|---|---|
| Synthetic company worlds with nested, array, alias, cycle, namesake and mixed-eligibility structures, bounded to six collections and 500 documents | `packages/fixtures/src/generator.ts`, `recipes.ts` | none (new code) | `npx vitest run packages/fixtures/test` 2026-10-11: passed (counts in VERIFICATION.md once recorded) | Yes, locally |
| Hidden expected poststates and preservation hashes built independently of the reference solver | `packages/fixtures/src/sealed.ts`, `packages/grader/src/grade.ts` | none | fixtures/grader tests; DA-1 review pending | Yes, locally; independence under review |
| Fenced job leases and exactly-once logical effects in MongoDB transactions | `packages/mongo/src/jobs.ts`, `effects.ts`, `worldkey.ts` | mongodb driver 7.7.0 | live lane on the local replica set plus the authenticated RBAC set: 306 passed / 0 skipped at checkpoint 67b789d4 (commit ae59942); 329 passed / 0 skipped on the PKT-12 tree (owner-reported, verifier-2 running) | Yes against a local replica set; Atlas BLOCKED (no root `.env`) |
| Atomic promotion that consumes a bound human grant and CAS-moves the active harness | `packages/mongo/src/deployment.ts`, `grants.ts` | mongodb driver 7.7.0 | promotion and authority suites in the same live lane; approval requirement derived server-side from the gate report (K8) | Yes locally; the gate that produces the report is C3, in progress |
| Owner authority floor, owner policy, decision ledger written before every action, live floor fence | `packages/governance/` (commit c663bfd) | none | 18/18 live at checkpoint e6f7526f | Yes locally, with open DA-5a findings G1 to G7 (floor not bound to the stored floor; null batch passes) assigned for fix before the gateway packet |
| Trusted harness compiler: three-valued guardrails, Mongo/TypeScript parity, 61-code rejection catalog | `packages/harness-compiler/` (commits 4eb6d5d, cd821d6) | none | 204 passed / 2 skipped; live parity 74/74 then 135/135; catalog 62/62 | Yes locally |
| Evidence-cited proposals, as-of decision replay, score-only and wrong-incident controls | `packages/evolution/` (commit cd821d6) | none | 298 passed / 2 skipped at checkpoint cf40f999 with the FAKE model | Yes with the FAKE model; DA-5a E1: the reported fix counts are in-sample, out-of-sample selection is a required follow-up (C2-3); no real-provider proposal yet |
| Durable worker with OpenMuse helper port, run provenance, metering, wake dedupe, crash-recovery polling | `apps/worker/`, `packages/runtime/`, `packages/vendor-openmuse/` (commit 191cbb4) | OpenMuse `1ac68f3909f2478ab6280883f1ab5ea65eb5719d` (M1 to M14 in THIRD_PARTY.md), AG-UI 0.0.59, TanStack AI 0.63.0 | 155 passed / 12 skipped; 166 with the replica set; live provider smoke BLOCKED | Yes with the FAKE chat model; no real provider call has been made |
| Candidate sandbox with default-deny egress and DNS drop on all interfaces | `infra/opendots/` (commit 191cbb4) | OpenBot computer image `b6932d31a8d6e7896c15139dfc27a6c6911deb27` | verify-candidate exit 0 after re-provision with the broker token; `cand-dns.repro.sh` exit 1 (escape not reproduced) | Overlay yes; a real candidate plugin run inside it is not yet exercised |
| Operator shell: owner auth, origin rules, telemetry off by default, readiness view, lazy Expunge client, model-free projection agent | `apps/operator/src/server/expunge/`, `src/client/expunge/` (commit pending, PKT-10) | OpenDots `625452e06cde74cb25b0ce319e2c1be0488f5a5f` (MIT), CopilotKit 1.75.0 | verifier checkpoint d9f6feba: 390/390 tests, build 0, browser e2e 108/0 against a labeled fixture backend; 16 screenshots in `docs/ui/screens/s1/` | Yes against the fixture backend; no live domain, no Intelligence key |
| Raindrop tracing, telemetry outbox with distinct delivery states, observer read-back, evidence bundles | `packages/observability/`, `packages/observer/` (verification in progress, PKT-14) | raindrop-ai 1.0.1, @opentelemetry/api 1.9.1 | owner-reported: 95 passed + 1 skipped with the replica set; Mongo protocol 13/13; the live Raindrop suite has never executed and fails by name under `EXPUNGE_REQUIRE_LIVE_TESTS=1` | Protocol yes; nothing has reached Raindrop; model spans verified only against a fake OpenAI SSE server and a fake OTLP endpoint |
| A fixed model's harness evolves from measured failures and the new version changes a subsequent run | needs B1 gateway (3 of 9 tools written) + C3 gate (in progress) + the pieces above | as above | none end to end | No, not yet end to end |
| Hider, meta-improver, privacy lineage, reliability, benchmark, deployment | briefs only: `docs/continuity/briefs/D1..E3` | | none | No |

## Things that are explicitly not claimed

- Automatic legal compliance. Delete, redact, restrict and tombstone are product effects under owner policy.
- Model-weight improvement or unbounded recursive acceleration.
- Exactly-once delivery to external vendors (outbox is at-least-once with reconciliation).
- Document-level row security from Atlas roles (tenant binding is a trusted application boundary).
- Native Claude Code Agent Teams were used to build this: the build ran in the Claude desktop app with named subagents as a role-preserving adapter (see `docs/continuity/OWNERSHIP.md`).
