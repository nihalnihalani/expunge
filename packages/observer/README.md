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

**Sources wired by `main.ts` (`src/sources.ts`).**

- *Export suppression*: `ErasureSuppressionRepository.activeUserKeys` through the process's own `observer` principal (FIND on
  `erasure_suppressions`). A source that cannot be read HOLDS `event` intents (not sent, not dead-lettered), like a suppressed id.
- *Leak guard*: a file exported by the privacy controller (`node --import tsx packages/privacy/src/export-guard-cli.ts`), named by
  `EXPUNGE_LEAK_GUARD_FILE`. It carries scope, provider organization, count and digest; the process refuses a file that is
  group/other accessible, for another scope or organization (`RAINDROP_ORGANIZATION_ID`), truncated or edited, or has a malformed
  `privateIds` block. **The file holds subject literals in plaintext on this process's filesystem**: mode 0600, mounted read-only,
  never logged or committed. It is read once at start. Freshness: the file carries the export `generation`; the process compares generation and digest
  with the latest `guard_exports` row (`GuardExportRepository.latest`) at start (BLOCKED unless an exact match) and every 60 s while
  running, and a newer export, an older file, a digest mismatch or an unreadable record stops it (exit 3); the supervisor's restart
  re-reads the file. Still unproven: that the exported subject set is complete (that is the exporter's 5000-entry refusal).
- *Observer window*: `EXPUNGE_OBSERVER_WINDOW_START`/`_END` (UTC ISO, both or neither), `EXPUNGE_OBSERVER_VERSION` (default `v1`),
  optional `EXPUNGE_OBSERVER_EVENT_NAME`; without a window only the outbox dispatcher runs.

**Fail closed.** Anything missing or invalid leaves the process BLOCKED (`evidenceMain` prints the names and exits 3). Local replica
set plus FAKE Raindrop evidence only; live delivery is BLOCKED without Raindrop keys and the observer URI.

**Honest limits.** Everything Raindrop-shaped in the tests is a labeled FAKE server (`packages/observability/test/fake-raindrop.ts`):
it proves our protocol handling, not that bytes reached Raindrop; live delivery is BLOCKED without the root `.env`. The observer
window is fixed by configuration; moving to the next window is an explicit new identity, not automatic. `bundleForRun` builds the
bundle only from a run whose episode reached `evidence_ready`; tool inputs and outputs are not stored here, so it carries the
gateway's fixed-vocabulary summary, and the model narrative is a hash.
