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

## Quickstart (local, no credentials)

```bash
npm ci
npm run typecheck
npm run lint
npx vitest run
```

Mongo protocol tests against a local replica set:

```bash
docker compose -f packages/mongo/test/docker-compose.yml up -d
MONGODB_TEST_URI='mongodb://127.0.0.1:27018/?replicaSet=expunge-local&directConnection=true' npx vitest run packages/mongo/test
```

Operator (setup-only without keys):

```bash
npm ci --prefix apps/operator --workspaces=false
node apps/operator/scripts/run-from-root.mjs dev
```

## Configuration

Copy `.env.example` to `.env` at the repository root and fill the values locally. Names only are documented in `docs/ENVIRONMENT.md`. Credentials are never committed or printed.

## Attribution

OpenDots, OpenBot and OpenMuse are MIT-licensed CopilotKit projects used as attributed foundations; see `THIRD_PARTY.md` and `BUILT_DURING_EVENT.md`.
