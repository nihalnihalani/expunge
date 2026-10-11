# @expunge/observer

Raindrop evidence path: the telemetry outbox dispatcher (delivery ladder), the Query observer with durable cursor pages, and the
sanitized `EvidenceBundle` assembly the evolver may cite.

## The running process (`src/process.ts`, `src/main.ts`)

`createEvidenceProcess(env, sources, options)` builds one process from the environment: its own `observer` Mongo principal (no
fallback to another URI), the ingestion key for sending and the SEPARATE read key for the Query API, one scope, a REQUIRED
export-suppression source and a REQUIRED leak guard. `drain()` walks due outbox rows
`pending -> sdk_enqueued -> ingest_accepted -> query_visible -> evidence_ready` (with retry, HOLD, dead letter and blocked
states); `scan()` pages the Query API under a fixed project/filter/window identity with the cursor committed together with each page.
A failure in either is contained and logged by class name; durable state carries on.

**Readiness** (`evidenceReadiness`) is stated from configuration alone and never says ready without everything:

- `BLOCKED` lists the missing NAMES (variables or sources, never values): `RAINDROP_API_KEY`, `RAINDROP_QUERY_API_KEY`,
  `RAINDROP_PROJECT_ID`, `RAINDROP_ORGANIZATION_ID`, `MONGODB_OBSERVER_URI`, the scope variables, the export-suppression
  source and the leak-guard source.
- `READY (configured)`: everything present, endpoints not overridden. Configured is not delivered.
- `READY (LOCAL FAKE)`: `RAINDROP_INGEST_URL` or `RAINDROP_QUERY_URL` is overridden, so it talks to a stand-in, not Raindrop.

**Fail closed.** Until the privacy controller's `erasure_suppressions` read (PKT-62) and a leak-guard source exist, the process is
BLOCKED (`evidenceMain` prints the lines and exits 3); a suppression source that cannot be read HOLDS `event` intents (not sent,
not dead-lettered), exactly like a suppressed id.

**Honest limits.** Everything Raindrop-shaped in the tests is a labeled FAKE server (`packages/observability/test/fake-raindrop.ts`):
it proves our protocol handling, not that bytes reached Raindrop; live delivery is BLOCKED without the root `.env`. The observer
window is fixed by configuration; moving to the next window is an explicit new identity, not automatic. `bundleForRun` builds the
bundle only from a run whose episode reached `evidence_ready`; tool inputs and outputs are not stored here, so it carries the
gateway's fixed-vocabulary summary, and the model narrative is a hash.
