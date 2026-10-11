# Environment reference (names only)

All values live in the root `.env` (ignored) or the deployment's secret store. The operator wrapper `apps/operator/scripts/run-from-root.mjs` loads the root `.env` in memory. Nothing here is a value.

## MongoDB principals (one URI per least-privilege user on the same Atlas deployment)

`MONGODB_SETUP_URI`, `MONGODB_DOMAIN_EXECUTOR_URI`, `MONGODB_OBSERVER_URI`, `MONGODB_PROPOSER_URI`, `MONGODB_GRADER_URI`, `MONGODB_APPROVAL_ISSUER_URI`, `MONGODB_PROMOTER_URI`, `MONGODB_PROJECTION_READER_URI`, `MONGODB_PRIVACY_CONTROLLER_URI`, `MONGODB_FIXTURE_BUILDER_URI`.

Optional local protocol testing: `MONGODB_TEST_URI` (unauthenticated local replica set; never an Atlas URI).

Database names: `EXPUNGE_WORLD_DB`, `EXPUNGE_CONTROL_DB`, `EXPUNGE_PRIVATE_DB`.

The setup principal is used only by `npm run setup:mongo` from an operator machine; it never enters a worker, candidate or UI process. Setup also reads `EXPUNGE_AUTHORITY_FLOOR_HASH` (the owner authority floor the promoter fences on) and `EXPUNGE_BEHAVIORAL_REQUIRES_APPROVAL` (default approval-gated) to seed `authority_revisions` and `authority_policies`.

## Expunge service binding

`EXPUNGE_TENANT_ID`, `EXPUNGE_ENV` (`dev` | `evaluation` | `demo`), `EXPUNGE_SCOPE_ID`, `EXPUNGE_AUTH_SECRET`, `EXPUNGE_INTERNAL_SECRET`, `EXPUNGE_INTERNAL_TOKEN` (operator to domain read-projection principal only), `EXPUNGE_WAKE_TOKEN` (operator to worker wake commands only; a wake carries just `{jobId, commandId}`), `EXPUNGE_JOB_WRITE_TOKEN` (submit and cancel jobs, operator previews), `EXPUNGE_APPROVAL_TOKEN` (review decisions to the approval issuer), `EXPUNGE_ALLOW_TELEMETRY` (operator telemetry is off by default in Expunge builds; set `1` to allow the upstream CopilotKit telemetry), `EXPUNGE_DOMAIN_URL`, `EXPUNGE_OWNER_EMAIL`, `EXPUNGE_ALLOWED_ORIGINS`.

## Model provider (frozen per scientific arm)

`EXPUNGE_MODEL_PROVIDER` (`openai` | `anthropic`; the Gemini adapter from upstream OpenMuse was dropped in the port, see packages/vendor-openmuse/THIRD_PARTY.md M1), `EXPUNGE_MODEL_ID`, `EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION`, `EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION`, and the provider key: `OPENAI_API_KEY` (+ `OPENAI_MODEL`, optional `OPENAI_BASE_URL`), `ANTHROPIC_API_KEY`. Missing prices are reported as unpriced calls, never as zero cost.

## Durable worker (apps/worker)

`EXPUNGE_WORKER_ID`, `EXPUNGE_WORKER_LEASE_MS`, `EXPUNGE_WORKER_MAX_CONCURRENT`, `EXPUNGE_WORKER_MAX_QUEUED`, `EXPUNGE_WORKER_PHASE_TIMEOUT_MS`, `EXPUNGE_WORKER_HOST`, `EXPUNGE_WORKER_PORT`; `EXPUNGE_LIVE_PROVIDER_SMOKE=1` runs the live provider smoke test; `EXPUNGE_REQUIRE_LIVE_TESTS=1` turns missing-credential skips into failures (the lane the verifier and CI use for required live suites). The worker reports `BLOCKED: <reason>` on readiness and refuses wakes with 503 until credentials and domain tools exist.

## OpenDots operator (upstream names)

`CPK_INTELLIGENCE_API_KEY` (legacy alias `INTELLIGENCE_API_KEY`), `CPK_TELEMETRY_ID`, `OWNER_ID`, `OWNER_TOKEN` (at least 24 characters for non-loopback binds), `APP_ORIGIN` (exact origin with scheme and port), `DATABASE_PATH` (incidental SQLite; never authority).

## Raindrop

`RAINDROP_API_KEY` (write), `RAINDROP_QUERY_API_KEY` (read, separate key), `RAINDROP_PROJECT_ID`, `RAINDROP_ORGANIZATION_ID` (user deletion is organization-wide).

## Docker computer host and candidate sandbox (server-only)

`COMPUTER_SUPERVISOR_URL`, `COMPUTER_SUPERVISOR_TOKEN`, `COMPUTER_TOKEN`, `COMPUTER_NAMESPACE`, `EXPUNGE_SANDBOX_BROKER_URL`, `EXPUNGE_SANDBOX_ARTIFACT_URL`, `EXPUNGE_CANDIDATE_BROKER_TOKEN` (proxy to broker; the proxy refuses to start if the operator principal token is present) and optional `EXPUNGE_OPERATOR_TOKEN_SHA256`. Candidate containers receive only a derived child computer token; see `infra/opendots/README.md`.

## Rules

- No principal falls back to the setup URI when its own is missing; the process reports BLOCKED.
- Worker and candidate images must not contain `MONGODB_GRADER_URI`, `MONGODB_SETUP_URI`, private manifests or held-out seeds.
- Readiness output distinguishes configured, reachable, authorized and evidence-ready; a configured name is not a connectivity check.
