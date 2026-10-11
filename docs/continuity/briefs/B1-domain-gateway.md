# Brief B1: domain gateway, typed worker tools and completion receipts

Owner: **mongodb-authority** after A2-R lands (reassigned from runtime-raindrop so the Mongo expert builds the Mongo-facing gateway; runtime-raindrop keeps the worker runtime and will consume these tools). Owned paths: `packages/domain/`, `packages/governance/`. Frozen interfaces: OWNERSHIP.md items 2, 4, 5, 6; `JobRepository`, `EffectRepository`, `ScopeRepository` APIs as repaired in A2-R; `@expunge/baselines` tool IDs.

Status: drafted 2026-10-11 11:05 UTC, not yet dispatched (waits for A2-R report and verifier evidence).

## Objective

Implement the nine typed, job-bound worker tools behind a trusted asynchronous gateway, following OpenBot's ordering: authoritative target resolution → policy decision (compiled guardrails + tool prerequisites + owner floor) → decision ledger row → action → outcome. The model receives typed capabilities and a job handle; it never receives connection strings, raw filters, collection names outside the registry, or the private database.

## Tools (packages/domain)

| Tool | Reads | Writes | Authority checks |
|---|---|---|---|
| inspect_scope | schema_registry at the job's scopeRevision; eligibility metadata; allowed field IDs | none | job binding |
| resolve_subject | customers via exact registered identity fields; aliases via identity_edges | none | exact identity evidence only; display-name similarity never authorizes |
| discover_references | bounded `$lookup`/`$graphLookup` over identity_edges with maxDepth from ContextPolicy, scan budget from ResourceLimits | none | registry-admitted fields only; returns frontier + `truncated` flag |
| preview_cleanup | resolved targets, owner eligibility policy | immutable `preview_plans` row (planHash = contentHash of exact targets, versions, effects) | plan binds job, run, harnessHash, worldRevision |
| apply_cleanup_batch | plan row | one `EffectRepository.commitEffect` per batch with effectKey = hash(planHash, batchOrdinal); targeted writes via A2-R `compileWritePlan` (never whole-array removal) | prerequisites: preview_plan same job/plan/current revision; guardrails; live owner floor re-read on every effect |
| verify_registered_scope | all registered collections and discovered fields at a stable world revision | `verification_sweeps` row and operational receipt draft | revision captured before and after; mismatch → retry |
| complete_cleanup | receipt draft | `EffectRepository.complete` (conditional revision write + job finish) | receipt binding; `verified_receipt` policy renders terminal text from the committed receipt only |
| inspect_harness | pinned bundle, provenance of its evidence refs | none | read-only; no private manifest |
| report_diagnostic | none | Raindrop Self Diagnostics adapter stub that records the diagnostic in `diagnostics` and enqueues an outbox intent (actual SDK dispatch belongs to C1) | labeled `agent_self_report` origin |

## Governance (packages/governance)

- `AuthorityFloor`: immutable owner ceiling (allowed tools, effects, collections, max limits) with a hash; a bundle can only tighten.
- `PolicyEvaluator`: evaluates compiled guardrail predicates with facts built by the gateway (receipt validity, prior effect counts, bindings); unknown fact IDs fail closed; severity deny > ask > allow.
- `DecisionLedger`: `decisions` collection row per tool call before action, with inputs digest, decision, rule IDs, authorization revision; as-of replay (C2) reads these rows.
- Live revocation: every effect re-reads `authority_policies`/owner floor revision inside the effect transaction's validate callback; a revoked floor denies the next action even on a pinned run.

## Tests required

Deterministic protocol tests with labeled fakes for the model, plus local replica-set integration: stale target versions and receipts, wrong actor/world, duplicate logical actions (same effectKey, same digest → saved receipt; different digest → IdempotencyConflict), partial batch interruption and resume without repeated effects, completion rejects changed world/scope revision, retained records under owner policy are never removed, mixed-array targeted write preserves other elements, model-supplied collection or field outside the registry is rejected, private database is unreachable from the domain_executor principal, unregistered-path copy survives operational completion and is caught by the grader (fixtures A3 world with a trusted partial observation).

## Evidence to report

Commands and exit codes; integration run against `MONGODB_TEST_URI`; the exact decision/intent/effect/receipt rows for one full W0 run and one expert-static run on the same fixture world (W0 must miss the nested copy and still produce a model narrative; expert must produce a committed receipt).
