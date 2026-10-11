# Expunge

A governed database-cleanup agent whose harness (context policy, workflow graph, guardrails and tool grants) evolves from measured failures. A fixed model cleans a synthetic customer out of a MongoDB company dataset; an independent grader catches what it missed; Raindrop evidence feeds a typed proposal; a fixed gate tests the candidate on fresh paired worlds; MongoDB Atlas promotes the passing version atomically; the next run uses it.

Statement One (Recursive Harnessing) of the Harness Engineering and Model Wrangling hackathon, 11 October 2026.

## Status

See `docs/FEATURE-MATRIX.md` for per-feature state, `WHAT_IS_REAL.md` for claims with evidence, and `VERIFICATION.md` for the latest check results. Nothing in this README asserts a capability the matrix does not.

## Layout

| Path | What |
|---|---|
| `apps/operator/` | OpenDots-derived operator workspace (own npm lock). Expunge screens live under `src/client/expunge` and `src/server/expunge`. |
| `apps/worker/` | Durable domain worker and dispatcher (root workspace). |
| `packages/contracts` | Frozen types, canonical hashing, bundle schema. |
| `packages/mongo` | Atlas protocols: principals, validators, leases, effects, promotion, projections, provenance. |
| `packages/fixtures`, `packages/grader` | Synthetic worlds, sealed manifests, reference solver, independent grader. |
| `packages/runtime`, `packages/vendor-openmuse` | ExpungeExecutionAgent and the attributed OpenMuse helper port. |
| `infra/opendots` | Computer host topology and the candidate egress-restricted overlay. |
| `docs/expunge` | Contracts, data model, acceptance protocol, source map. |
| `docs/continuity` | Project state, task export, ownership (for resuming the build on any engine). |
| `packages/governance` | Owner authority floor, owner policy, policy evaluator, decision ledger, live floor fence. |
| `packages/harness-compiler`, `packages/evolution` | Trusted compiler of typed harness bundles (three-valued guardrails, Mongo/TypeScript parity, rejection catalog); evidence-cited proposals, critic, as-of decision replay with score-only and wrong-incident controls. |
| `packages/observability`, `packages/observer` | Raindrop tracing with a transactional telemetry outbox; observer read-back, crash-safe cursor, evidence bundles with a leak guard (live calls need keys). |
| `packages/baselines` | W0 and expert-static harness bundles and the disclosed primitive vocabulary. |
| `docs/review` | Devil's-advocate findings and reproduction scripts (each repro exits 1 when the defect is fixed). |

## Quickstart (local, no credentials)

```bash
npm ci
npm run typecheck
npm run lint
npx vitest run
```

Every live-service suite skips without its connection string and fails under `EXPUNGE_REQUIRE_LIVE_TESTS=1`, so a skip can never pass as a success. Mongo protocol tests against a local replica set (protocol proof, not Atlas proof):

```bash
docker compose -f packages/mongo/test/docker-compose.yml up -d
MONGODB_TEST_URI='mongodb://127.0.0.1:27018/?replicaSet=expunge-local&directConnection=true' npx vitest run packages/mongo/test
```

Operator (setup-only without keys):

```bash
npm ci --prefix apps/operator --workspaces=false
node apps/operator/scripts/run-from-root.mjs dev
```

Authenticated RBAC lane (local, separate replica set with users):

```bash
docker compose -f packages/mongo/test/auth-docker-compose.yml up -d
```

then set `MONGODB_RBAC_TEST_URI` as described in `docs/MONGO.md` and run the same suites with `EXPUNGE_REQUIRE_LIVE_TESTS=1`.

Node: `>=24.13.1 <25.0.0 || >=25.4.0` (`.nvmrc` says 24.13.1). Earlier 24.x and 25.x builds throw inside `util.inspect` when a ZodError is logged (nodejs/node#60717); the operator carries a never-throwing console wrapper as mitigation.

## How the build is run

The repository is built by a lead with named role agents (Mongo authority, runtime and Raindrop, RSI evolution, UI/UX, two independent verifiers, a devil's advocate and a commit steward that is the only Git writer). Every commit is a reviewed packet: the owner freezes its paths, a verifier runs the matrix on a hash-pinned checkpoint, the steward stages exactly those paths, regenerates the lockfile from the staged tree when a workspace is added, proves `npm ci` and `npm run typecheck` on a scratch export of the staged index, commits, pushes and appends a row to `COMMIT-LEDGER.md`. See `docs/continuity/OWNERSHIP.md`.

## Configuration

Copy `.env.example` to `.env` at the repository root and fill the values locally. Names only are documented in `docs/ENVIRONMENT.md`. Credentials are never committed or printed.

## Attribution

OpenDots, OpenBot and OpenMuse are MIT-licensed CopilotKit projects used as attributed foundations; see `THIRD_PARTY.md` and `BUILT_DURING_EVENT.md`.
