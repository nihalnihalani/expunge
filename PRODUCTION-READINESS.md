# Production readiness

Each check has a definition, a command or procedure, and the current status recorded by the verifier. Status values: PASS (verifier ran it on the current HEAD), FAIL (ran and failed; owner and fix listed), NOT_RUN, BLOCKED (external input named). This file never states PASS without a `VERIFICATION.md` entry.

Last updated: 2026-10-11 11:30 UTC. HEAD: UNBORN.

| Area | Check | Command or procedure | Status | Notes |
|---|---|---|---|---|
| Types | Root typecheck | `npm run typecheck` | PASS at 10:23Z (0 errors) | in-flight lanes may reintroduce; re-run at commit |
| Lint | Root lint | `npm run lint` | FAIL | 57 errors at baseline, mostly unused imports and formatting-era code; owners fixing per lane |
| Format | Prettier check | `npm run format:check` | FAIL | 49 files unformatted at baseline |
| Unit/protocol | Vitest | `npx vitest run` | PASS (92 passed, 41 skipped at 10:10Z) | skipped = Mongo integration suites without `MONGODB_TEST_URI`; lanes still adding tests |
| Mongo protocol | Local replica-set integration | `docker compose -f packages/mongo/test/docker-compose.yml up -d` then `MONGODB_TEST_URI=... npx vitest run packages/mongo/test` | NOT_RUN | A2-R |
| Operator | Typecheck, tests, build | `cd apps/operator && npm run typecheck && npm test && npm run build` | FAIL (typecheck 0 errors; tests 298 passed, 7 failed in tests/telemetry.test.ts) | root cause assigned to verifier V-2; fix owner ui-ux-improver |
| Candidate containment | Proxy fixture tests | `node --test infra/opendots/candidate-proxy.test.mjs` | PASS (5/5 at 10:10Z) | DNS exfiltration via 127.0.0.11 demonstrated by DA-1; fix pending in B2-1 |
| Security | Secret scan of staged files | commit-steward procedure (CS-1) | NOT_RUN | |
| Security | Dependency advisories | `npm audit --omit=dev` at root and in apps/operator | FAIL (advisories present, none critical, none reachable in current usage) | root: 7 (2 high, 5 moderate) in @copilotkit/runtime -> @ai-sdk/* -> undici 5.29.0 / @fastify/busboy, never loaded by our import graph; operator: 11 (4 high, 7 low) in graphql-yoga/@graphql-tools (not loaded by runtime/v2), source-map-js (build tooling shipped because @copilotkit/channels peer-requires vitest), katex (no math plugin used). Verifier V-2, 10:17Z |
| Accessibility | WCAG 2.2 AA on implemented flows | browser checks per docs/ui | NOT_RUN | no Expunge flows exist yet |
| Browser | Journeys: cleanup, approval, reconnect, rejection, privacy | verifier procedure | NOT_RUN | |
| Live: Atlas | Invited sandbox identity, tier, roles, transactions, change streams, Search/Vector | `npm run probe:mongo` | BLOCKED | root `.env` missing: MONGODB_*_URI |
| Live: model provider | One real worker episode | worker readiness output | BLOCKED | OPENAI_API_KEY or ANTHROPIC_API_KEY missing |
| Live: Raindrop | Interaction finish and Query read-back | observer probe | BLOCKED | RAINDROP_API_KEY, RAINDROP_QUERY_API_KEY, RAINDROP_PROJECT_ID missing |
| Live: Intelligence | Real operator conversation | operator readiness | BLOCKED | CPK_INTELLIGENCE_API_KEY missing |
| Recovery | Crash before effect, after commit, before projection; lease takeover; resume token expiry | tests/reliability | NOT_RUN | E1 |
| Deployment | Production build, server-only secrets, health, TLS/origin config | infra/deploy | NOT_RUN | E3; publication requires explicit authorization |
| Continuity | Checkpoint create, verify, restore | `npm run checkpoint`, `npm run checkpoint:verify -- latest`, `npm run test:continuity` | PASS (checkpoint 20261011T101215Z-98d5f03d complete; 23/23 tests) | verifier V-1, 2026-10-11 10:12Z |
