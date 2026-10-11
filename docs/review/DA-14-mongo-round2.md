# DA-14: mongo round 2 (campaign authority, run attestations, guard exports, native sources on contracts) plus packets W and G

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. This is a static read of the working tree. The owner's
reported live results (mongo+contracts 443/443, domain+governance 178/178, rbac 71/71) were not re-run by me.

## Dispositions

| Item | Disposition |
|---|---|
| (1) `campaign_authority` (GB-1 redesign) | **ACCEPT-WITH-FOLLOWUP** (CA-1) |
| (2) `run_attestations` | **ACCEPT** (note RA-1 for the gate) |
| (3) `guard_exports` repository | **ACCEPT**. The flow that feeds it is G below. |
| (4) Native sources on the contracts' `source.ts` | **ACCEPT-WITH-FOLLOWUP** (NS-1). NA-1 is now documented correctly; NA-2 and NA-3 are recorded as OPEN. |
| W: worker writes `run_attestations` | **ACCEPT** |
| G: guard generation flow (observability, privacy, observer) | **ACCEPT-WITH-FOLLOWUP**. G-1 and G-2 must land before any live Raindrop lane. G-1 is material. |

## (1) `campaign_authority`

- **Can a non-evaluation scope ever be governed by it? No.**
  - `locate` consults `campaign_authority` only when no standing `authority_revisions` row exists AND `key.env ===
    'evaluation'`, and its filter carries `scopeFilter(key)` (`authority.ts`, `locate`).
  - The validator pins `env` to `'evaluation'` (`validators.ts:569-579`), so not even a raw insert or update can produce a
    campaign row for another environment.
  - A standing row always wins.
- **Can the UPDATE holders raise the floor? Within evaluation scopes, they can rewrite it.**
  - **CA-1 (LOW-MEDIUM, DEMONSTRATED by the manifest).** `domain_executor` and the promoter hold UPDATE on
    `campaign_authority` (`roles.ts:104`, promoter block). They need it for the fence's `$inc touches`.
  - The touch counter lives in the same document as `floorHash` and `authorizationRevision`. With the raw driver, the
    worker principal can therefore change the floor hash or the revision of its own evaluation scope.
  - The impact is bounded: only evaluation scopes, and the worker accepts only floors it knows (today just
    `DEFAULT_AUTHORITY_FLOOR`).
  - Fix: mirror the standing design. Keep `campaign_authority` insert-only, put the counter in a separate
    `campaign_authority_touches` with UPDATE, and drop UPDATE on `campaign_authority` for both principals.

## (2) `run_attestations` (`attestations.ts`)

- **Can a stale lease holder attest? No.** `record` runs inside a transaction that first calls `jobs.fence(actor, lease,
  session)`. That is a conditional `findOneAndUpdate` on the live lease filter with `$inc commitSeq`, so it fails with
  `LostLease` for a fenced-out holder and conflicts with a concurrent takeover. `runId` comes from the stored job.
- **Can anyone remove or replace a stamp? No principal except `setup`.**
  - Grants: `domain_executor` FIND and INSERT; grader and projection reader FIND only; no UPDATE or REMOVE.
  - An identical repeat returns the stored row, and a differing one throws `AttestationConflict`, in the transaction and in
    the duplicate-key path alike.
- **RA-1 (LOW, for the gate).** INSERT is collection-wide.
  - The worker principal, using the raw driver, could insert a row for another job or a future fence. The `_id` is
    deterministic, so a pre-inserted row would make the legitimate session fail closed with `AttestationConflict`, which is
    a denial of service, not a forgery that passes.
  - The gate must recompute `_id` from `(scope, jobId, fence)` and check `runId` against the job binding, rather than trust
    the row's own fields.

## (3) `guard_exports` (`guard-exports.ts`)

- Insert-only. `privacy_controller` has INSERT and FIND; the observer has FIND; nobody has UPDATE or REMOVE.
- A generation lower than the newest is refused inside a transaction. `latest` is by maximum generation, so the disclosed
  case of a concurrent lower insert cannot become "latest". Sound as a store. What it means depends on G.

## (4) Native sources rebased on contracts `source.ts`

- **Tenant boundary.** `scoped(ns, f) = {$and: [tenant(ns), f]}` (`native-adapter.ts:188-193`) wraps every read and write:
  `findByField` (`:203`), `scanPage` (`:227`), `undeclaredIdCount` (`:261`), `read` (`:267`), closure neighbours (`:375`),
  residuals (`:488`), and in `applyEffect` `byId` is used for the pre-read, the conditional `updateOne`/`deleteOne` (`$and:
  [byId, guard]`), the replay re-read and the read-back (`:532-616`). It holds on every path except one:
  - **NS-1 (LOW, LIKELY).** The change stream (`source-revision.ts:102`) filters only on `ns.coll`. There is no tenant match.
    - It counts other tenants' changes into `observedSeq`. Insert events also bring full documents of other tenants into
      the process's memory, although nothing stores them.
    - It is advisory and never guards a write, so this is not a safety defect.
    - But on a busy shared collection `moved()` will almost always be true. If anything starts gating on it, that becomes a
      liveness problem.
    - Fix: add the tenant field to the `$match` (`fullDocument.<path>` for inserts and replaces; updates need
      `fullDocument: 'updateLookup'` or `fullDocumentBeforeChange`), or document it as cross-tenant noise.
- **NA-1** is now documented correctly ("Crash recovery is NOT an idempotent replay", MONGO.md).
- **NA-2** (write-ahead intent) and **NA-3** (targets pinned from `ownedClosure`) are recorded as **OPEN, required before the
  gateway uses the adapter**.
- `version_field` and `native_revision` caveats are documented: no per-value guard for delete and restrict; the revision is
  excluded from the read-back comparison.

## W: worker writes `run_attestations`

- **Can the fixed `at` let a different session's stamp collide? No.** The row `_id` includes the fence, so different
  sessions have different `_id`s.
- `attestedAt` is fixed for one claimed run (`dispatch.ts`). Session restarts inside the same claim send an identical stamp,
  which is idempotent.
- The authoritative row is inserted before the checkpoint copy. `AttestationConflict` and `LostLease` propagate, and the
  session fails closed before any model call (DA-12 M-1).
- `DispatcherDeps.attestations` is optional. Production wiring sets it (`wiring.ts`, `index.ts`). A composition without it
  writes no row, and the gate rule (HOLD on a missing row) covers that.

## G: guard generation flow

- **G-1 (MEDIUM, DEMONSTRATED by reading; required before live): "fresh" means "the latest export", not "the current
  subject set".**
  - `guard_exports` rows are written only by `exportGuardFile` (`privacy/src/export-guard.ts`).
  - `registerSubjectTokens` (`privacy/src/registry.ts`) records nothing.
  - A subject registered after the last export is therefore absent from the guard, and the observer keeps reporting the file
    `fresh` indefinitely, until someone runs the export CLI again.
  - The design asked for in DA-10 S-3 was a generation bumped *in the same transaction that registers subject tokens*.
  - Fix: `registerSubjectTokens` (and any purge of tokens) increments a per-scope subject-set generation row in the same
    transaction. The export records that subject-set generation with its digest. The observer HOLDs when the subject-set
    generation is ahead of the file's.
- **G-2 (MEDIUM; required before live): the stale window between checks.**
  - The observer checks freshness at start and then every 60 s. In between, the dispatcher drains every 5 s and can send
    events for up to about 60 s on a guard the controller has already superseded.
  - Given G-1, the real window today is unbounded. Even after G-1, 60 s of sends on a guard known to be stale is avoidable
    for the price of one indexed `findOne`.
  - Fix: call `guardFreshness` before each drain batch inside the evidence process, and HOLD the batch on anything but
    `fresh`. Keep the 60 s exit as the backstop.
  - The 60 s loop has no automated test (owner's note). Add one with a fake timer.
- **G-3: recording before writing opens no window where the observer accepts an old file.**
  - A file older than the recorded generation reads as `stale` and is HELD.
  - If the file write fails after the record, `latest` is ahead of every file, and the observer stays BLOCKED until a
    re-export. That is fail-closed.
- **G-4 (LOW-MEDIUM, LIKELY): concurrent exports can make an older subject snapshot the "latest".**
  - `exportGuardFile` reads the subject set (`guardFor`) before `latest()` and before recording.
  - Two exports racing can therefore record the *older* subject snapshot at the *higher* generation: A reads subjects, B
    reads newer subjects and records N, then A records N+1. The observer then accepts the guard that lacks the newest
    subject.
  - Fix: read the generation, read the subjects, and record conditionally on `latest` being unchanged (in one transaction,
    or by retrying on change). G-1's subject-set generation solves this directly.
- `guardFreshness` treats an unreadable record as HOLD, never as a pass. Good.
