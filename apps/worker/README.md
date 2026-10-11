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
