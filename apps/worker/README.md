# apps/worker

Durable cleanup-job worker: claims a job under a fence, runs the model loop with the typed gateway tools, checkpoints
between phases and finalizes the job from committed state only.

## Projection events (what is guaranteed, what is not)

- Appends are **fenced** (`FencedProjectionSink`, `src/wiring.ts`). One transaction updates the job row (owner, fence and
  required state) with an `eventSeq` increment, then inserts the event. A progress event needs a running job with a lease
  unexpired by database time; a transition event (`job_failed`, `job_status_changed`) needs the job to already be in the
  state it reports; a second, different terminal event is refused. A resumed zombie writes nothing.
- A terminal event lost to a crash is **repaired** from committed state: when a wake meets an already-terminal job, and in
  a startup sweep. The rebuilt event is identical to the live one, uses the stored reason (`reason_unrecorded` when there is
  none) and the prior status the row supports (`running` if the job was ever claimed, else `queued`).
- Disclosed limits of the sweep: a bounded window of recent terminal jobs (`pollBatch * 4`, newest first by `updatedAt`) and
  only the scope the worker is configured for. Older or out-of-scope jobs are repaired when a wake for them arrives.
- Fenced appends are Mongo protocol evidence on a local replica set, not Atlas.

## Tools, deployment check and runtime attestation

- **Tools.** The worker's tool provider is the domain gateway's nine typed, job-bound tools (`createDomainToolWiring`, built from
  the worker's own `domain_executor` client and the shipped authority floor). A bundle that names another floor cannot start a
  run. There is no empty-provider fallback; readiness blocks only on configuration.
- **Deployed-harness check.** After the claim and before any model or tool call, `jobs.assertHarnessDeployed` must pass: the
  scope's deployment pointer has to name the job's pinned harness now. `HarnessNotDeployed` (a rollback or promotion between
  creating and claiming the job) is a committed failure with the reason in the terminal checkpoint, `job_failed` with code
  `policy_denied`, no context inputs, no effects, and no telemetry episode (nothing ran). Any other error from the check hands
  the job back untouched. The repository skips campaign worlds and non-cleanup jobs itself.
- **Runtime attestation.** The worker hashes the bytes of the runtime it loaded (`runtimeHash()` in `@expunge/runtime`) and
  writes it as `checkpoint.attestedRuntimeHash` when it claims a run; every later snapshot keeps it, the terminal one included.
  A takeover by another build records its own. A campaign compares this committed value with its stored freeze; nothing a caller
  supplies stands in for it. Disclosed: it states what this process loaded, not what a compromised process would claim.

## Session restarts and model failures

- **Takeover and restart.** A session that ends `lost_lease` is the only thing that starts another one in the episode port
  (`WorkerEpisodeRunner`): the domain gateway spends a stored fault plan's interruption by releasing the lease, and a real
  takeover by another worker also surfaces as `lost_lease`. Either way the job is claimed again under a new fence, bounded by
  `maxSessions`; exhausting it with the job still not terminal is a recorded `SessionsExhausted` failure, never a silent stop.
  The worker injects no faults of its own.
- **Model failures.** `ModelUnavailable` is provider-side or worker-side (5xx, 429 after retries, 401/403/404 for the worker's own
  key or model configuration, connection-level errors, a missing credential). `ModelRunFailed` is everything else: other 4xx, any
  timeout (HTTP 408, a timeout code or name), and any failure with no structured field. The verdict reads status, code and error
  name only, never message text.
- **Retry and timeout policy** (`MODEL_RETRY_POLICY`, `PROVIDER_CLIENT_TIMEOUT_MS` in `@expunge/vendor-openmuse`). Each provider call is
  3 attempts: the SDK's own retries (`MODEL_MAX_RETRIES` = 2) are the whole budget, and the runtime adds none. Backoff is the SDK's:
  0.5 s doubling per retry, capped at 8 s, up to 25% jitter off, with a `retry-after` header overriding it. A 429 that is retried and then
  succeeds is not a failure; one that fails on the last attempt is `ModelUnavailable`. The SDK client timeout (600 s) is above every phase
  timeout the runtime allows, so a slow call is ended by the phase watchdog as `PhaseTimeout` (behaviour); an SDK-side timeout that still
  arrives is classified `ModelRunFailed`.
- **Retries are recorded; a timeout in a window with provider backoff is infrastructure.** A counting `fetch` on the provider client
  records, per job, the HTTP attempts and the retriable statuses seen (numbers only) into the run stats, the terminal checkpoint
  (`terminal.providerAttempts`), the episode result (`providerRetries`) and the job's meter carry (`checkpoint.meter.provider`), so a
  takeover continues the totals instead of restarting them. A per-watchdog-window flag is set by a 429, a 5xx or a connection error
  (never by 408 or 409, which stay behaviour) and cleared whenever the runtime re-arms its phase watchdog (every model event and every
  tool phase). If the watchdog fires while the flag is set, the run ends as `ModelUnavailable` with
  `failureDetail: 'phase_timeout_during_provider_backoff'`, not `PhaseTimeout`: retry-after backoff plus the retried call is the provider's
  delay. A call the provider never answers within the window, or a stall after a reply that re-armed the watchdog, stays `PhaseTimeout`.
  Disclosed: the recorder decides from the HTTP status alone, so it ignores an `x-should-retry` response header the SDK may honour to
  override its own retry decision; a provider that sets it can make the recorded attempts differ from what the SDK did.
