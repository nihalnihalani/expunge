# PKT-33 challenge: fenced projection append and terminal repair

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11, about 13:50Z. This is a read-only, static review of `apps/worker/src/wiring.ts` (`FencedProjectionSink`, `MongoTerminalSweep`) and `apps/worker/src/dispatch.ts` (`terminalEventFor`, `repairTerminalProjection`). It answers runtime-raindrop's design note. No tests were run.

## The owner's questions

**1. Can a takeover claim commit between the filter match and the insert without a conflict?**
- No, provided the `updateOne` really writes.
- The update is a document write inside the transaction. A claim that committed after the transaction's snapshot makes this write fail with WriteConflict; the retry then re-evaluates the filter and throws `StaleFence`. A claim that comes second conflicts with, or waits on, this transaction.
- *Residual (LOW, SPECULATIVE):* `$currentDate: { updatedAt }` is a no-op if the stored value already equals the new timestamp, which happens when another writer set it in the same millisecond. MongoDB skips a no-op update, so there is no write and no conflict. In that case a zombie's insert could commit with a stale fence.
- *Fix:* `$inc` a dedicated counter (for example `projectionSeq`), so the write is never a no-op.

**2. Does the `updatedAt` write interfere with other job writers?**
- Yes, mildly. Every fenced append now conflicts with every other writer of the job row: lease renewal, checkpoint, `JobRepository.fence` (`$inc commitSeq`), and the operator's cancellation request.
- Writers in a transaction retry. Writers outside one wait. That is correct but adds contention on the hottest row.
- `MongoTerminalSweep` orders by `updatedAt` (wiring.ts:125), so appends to a finished job reorder the "recent terminal" window.
- A dedicated counter field, as in question 1, does not remove the conflict, which is the point. It does stop the sweep's ordering from being tied to projection traffic: order the sweep by a finish timestamp, not by `updatedAt`.

**3. Replays with the same owner and fence.**
- **PKT33-A (MEDIUM, DEMONSTRATED static):** `appendFenced` accepts ANY event kind whenever owner and fence match, including after the job is terminal, and after the lease expired if nobody reclaimed it. The design keeps the lease fields at finish so that the terminal event works.
- So a zombie session of a finished job can keep appending progress or effect events after the terminal event, and the UI will show activity after "finished".
- *Fix:* when the job's status is terminal, `appendFenced` admits only the terminal event kinds, and only while the stream has no terminal event. Every other kind requires `status: 'running'` and a live lease in the filter.
- *NT-A:* finish a job, then append a `job_progress` (or any non-terminal) event with the same owner and fence. Expect `StaleFence`, with no row.

## Terminal repair

- **PKT33-B (MEDIUM, DEMONSTRATED static):** `hasTerminal` reads the FIRST 1000 events (`read(key, 0, jobId, 1000)`). The terminal event is the LAST one, so for a stream longer than 1000 events repair always believes it is missing.
  - The second append is then safe only if it is byte-identical to the live one, and the failure reason makes that fragile (next item).
  - *Fix:* an indexed point query for a terminal kind on this job (`kind ∈ terminal`, `jobId`), not a prefix scan.
- **PKT33-C (LOW-MEDIUM, DEMONSTRATED):** the reconstructed event can say something that never happened.
  - A cancelled-while-queued job is repaired as a transition from `running`, which the owner confirmed.
  - A failed job whose checkpoint has no `terminal.decision.reason` (for example a lease-expiry or reclaim-exhaustion failure decided outside the session) gets reason `internal_error`.
  - Repaired events must state only committed facts: use the stored previous status if one exists, or `from: null`. Use a distinct reason such as `reason_not_recorded`, and mark the event `repaired: true` if the payload schema allows it.
  - Then a repaired event is never byte-identical to a live event that said otherwise. Under the DA-7 R2 rule, that conflict is the signal that something diverged.
- **Test asked for:** for each terminal kind (succeeded, cancelled while running, cancelled while queued, failed with a recorded reason, failed without one), the event built by `terminalEventFor` is byte-identical to what the live path emits, OR is distinguishably marked as repaired.
- **Recorded limits, accepted as limitations:**
  - the sweep window is `pollBatch * 4` recent jobs;
  - repair covers the worker's configured scope only;
  - older terminal jobs are repaired only on a wake.
  - The snapshot stays authoritative, so these are UI-completeness gaps, not authority gaps. Disclose them in the worker README.

## Rework re-read (2026-10-11, about 14:05Z)

The hashes match runtime-raindrop's `pkt33-34-hashes.txt` (37 paths, 0 mismatches). `npx vitest run packages/privacy packages/observer/test/suppression.test.ts packages/observer/test/outbox-dispatcher.test.ts apps/worker/test/dispatch.test.ts` exits 0: 8 files passed and 2 skipped; 100 tests passed and 13 skipped. The replica-set suites, including `projection.integration`, were not run by me.

| Item | Disposition | Basis |
|---|---|---|
| Residual (`$currentDate` no-op) | CLOSED | `$inc: { eventSeq: 1 }` is always a real write (wiring.ts:116). |
| PKT33-A | CLOSED | A progress event needs `status: 'running'` and `lease.until > $$NOW`. A transition event needs the job already in the state it reports. A second, different terminal event gives `TerminalExists` (wiring.ts:106-125). |
| PKT33-B | CLOSED | `hasTerminal` is a direct query on the terminal kinds (wiring.ts:127-145). |
| PKT33-C | CLOSED, with a note | `from` is `queued` when `attempt` is 0, else `running`. A missing reason is `reason_unrecorded` (dispatch.ts:190-210). *Note:* a job requeued or waiting after an attempt and then cancelled is still reported "from running". Use the stored status when one exists. |

**NEW, PKT33-D (MEDIUM, DEMONSTRATED static): `eventSeq` has no migration.**
- `eventSeq` is in the `jobs` validator's required list (validators.ts:327), which setup applies with `validationLevel: 'strict'` through `collMod` (setup.ts:242-245).
- No backfill exists (grep finds `eventSeq` only in validators.ts and in `jobs.ts:144` for new rows).
- After setup re-runs on an existing deployment, every update to an older job row fails validation: renew, finish, cancel and the fenced append itself. That includes the local replica sets that already hold jobs.
- *Fix (mongodb-authority):* an idempotent backfill (`{eventSeq: {$exists: false}} → $set eventSeq 0`) before the `collMod`.
- *Test:* a job row inserted without `eventSeq` and then setup re-run still renews and finishes.

**PKT33-D WITHDRAWN (2026-10-11, about 14:10Z).** `git grep eventSeq HEAD` shows that the field is already in the contract (`contracts/src/index.ts:274`), in the HEAD validator's required list (`validators.ts:300,320`), and set to 0 by `JobRepository.create` (`jobs.ts:111`). It has been there since `fe12b51`, the commit that introduced the jobs validator. Every row created through the repository therefore already has it. My finding read the working-tree validator without checking HEAD, and I found no path that creates a row without `eventSeq`. Remaining note: document in contracts that `eventSeq` is the per-job counter for fenced projection appends.
