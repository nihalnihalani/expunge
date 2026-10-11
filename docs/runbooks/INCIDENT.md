# Incident runbook

Describes only what the code supports. Where a tool does not exist, that is stated; do not improvise writes to collections by hand
(fences, receipts and hashes are verified together).

## Triage

| Signal | Where | Meaning |
|---|---|---|
| `GET :4330/healthz` not 200, container unhealthy | worker | process hung or dead; restart it |
| `GET :4330/readyz` 503 | worker | configuration BLOCKED; the body lists blockers by name; wakes answer 503; no job is claimed |
| Container exit code 3 | worker `--readiness` / evidence process | BLOCKED by configuration or missing sources (names printed) |
| JSON log lines on stdout (`{"at":..,"level":..,"message":..}`) | worker, evidence process | read with `docker compose logs`; errors are logged by class name, never as raw Error objects |
| Jobs `queued` for long, or `running` with expired lease | `jobs` collection | worker down or stalled (lease takeover below) |
| `telemetry_outbox.status` `retrying` (a HOLD is `retrying` with `lastErrorCode` starting `hold:`) or `dead_letter` | `telemetry_outbox` | Raindrop delivery trouble |

There is no metrics endpoint and no alerting integration in the repository. Monitoring today is: container health, the log stream,
and periodic read-only counts of the collections above from a read principal. Wiring an alerting service is not done.

## Worker crash or restart (lease takeover) (SUPPORTED)

A job holds a lease (`EXPUNGE_WORKER_LEASE_MS`, default 30s) renewed every third of it. If the worker dies, the lease expires and any
worker bound to the same scope claims the job with a higher fence (`JobRepository.claim` accepts `running` jobs whose lease has
expired); the recovery poll (`EXPUNGE_WORKER_POLL_MS`, default 5s, batch 25) does this without a wake. The old process, if it
survives, is fenced out: its writes fail as `LostLease`. Steps: restart the worker; wait one lease period; confirm the job reaches
a terminal state. Do not start a second worker with the same `EXPUNGE_WORKER_ID`. A terminal projection event lost to a crash is
rebuilt by the startup sweep from committed state. A job pinned to a harness that is no longer deployed ends as a committed
`HarnessNotDeployed` failure.

## Outbox dead letter (Raindrop delivery) (PARTIAL)

`OutboxDispatcher` retries with backoff up to its attempt bound, HOLDS on an authentication failure (retried after
`authBlockDelayMs`, default 15 minutes, never dead-lettered), re-reads visible-but-incomplete evidence until `holdTimeoutMs`, then
dead-letters. **There is no requeue operation**: `OutboxRepository` exposes enqueue, claim, advance and retry only, and a
`dead_letter` row is terminal. What you can do: read the rows (`telemetry_outbox` with `lastErrorCode`) with a read principal,
fix the cause (key, project id, endpoint), and re-run the affected episode if the evidence is needed. A requeue tool needs a new
repository method and an owner decision (mongodb-authority). The evidence process is BLOCKED (exit 3) until the guard file, observer URI and Raindrop keys are supplied (DEPLOY.md section 8); a
suppression source that cannot be read HOLDS event intents rather than sending them.

## Observer cursor (PARTIAL)

Cursors (`observer_cursors`) advance only in the same transaction as the evidence they page, using a revision check
(`StaleObserverCursor`). There is no reset command. Moving the window is a new query identity (`observerVersion` and the window
fields hash into the row id); reusing the same project and version with a different identity throws
`ObserverQueryIdentityChanged`. So "reset" means starting a new `observerVersion`, which is a code/config change in the process
that builds the window. The observer scan runs only when `EXPUNGE_OBSERVER_WINDOW_START`/`_END` are set; the version is `EXPUNGE_OBSERVER_VERSION`, so a new window is a new version in configuration.

## Database unreachable or credentials rejected

The worker's readiness is configuration-only, so `/readyz` stays 200 while Atlas is down; failures appear as logged class names
and unclaimed jobs. Check `npm run probe:mongo` from the operator machine, then rotate or fix the credential (SECRET-ROTATION.md).

## Data loss or corruption

Stop services holding runtime principals, restore per BACKUP-RESTORE.md, run `npm run setup:mongo`, restart. Record the backup
manifest hash used.

## Candidate containment alert

If a candidate computer shows unexpected egress, stop its Compose project (`docker compose -p <candidate project> down`) on the Docker
host, keep the container logs, and run `node infra/opendots/verify-candidate.mjs <env-file>` against a fresh stack before reuse.
