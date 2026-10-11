# DA-12: worker-side model stamp (DA-11 F-1, worker half)

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. This is a static read of the working-tree diff in
`packages/runtime/src/{ports.ts,models.ts,session.ts}`, `apps/worker/src/dispatch.ts` and the two test files.
`npx vitest run packages/runtime/test/models.test.ts apps/worker/test/dispatch.test.ts` exits 0: 2 files, 45 tests passed.

## Disposition: BLOCK

Three small fixes are needed before commit. Each is a few lines, and none changes the design.

| # | Required fix | Why |
|---|---|---|
| M-1 | **Fail closed.** If the stamp cannot be computed or written, end the session before the first model call (for example `RuntimeError('ModelAttestationFailed')`, retryable). The stamp is taken before any model call, so failing costs nothing. | Today the failure is swallowed twice. `dispatch.ts` `onModelSelected` catches the `writer.update` error and only logs it, so `onHookError` never even fires. `session.ts:172-176` also catches and continues. The run then proceeds **unstamped**, which the gate can treat as fake only if it remembers to. Worse is the takeover case (M-2). |
| M-2 | **Bind the stamp to its session.** Put the claiming lease `fence` (or a session id) in the stamp. Better, keep one stamp per session, e.g. `attestedModels: [{fence, ...}]`, appended rather than replaced. The gate then requires one stamp per claiming fence, all identical, all equal to the frozen profile. | "A takeover overwrites it with its own" is last-writer-wins. If two sessions used different models, the earlier session's model calls, and any effects it committed, are attributed to the later model. A mixed arm is invisible. If the takeover's stamp write fails (M-1), the checkpoint **keeps the previous session's stamp**, so the gate sees a valid-looking stamp for a session that never wrote one. Treating a missing stamp as fake cannot catch this. |
| M-3 | **Record whether the endpoint is overridden.** Add `endpoint: 'default' \| 'overridden'`, optionally with a hash of the base-URL host, set from `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`. The gate treats `overridden` as non-provider unless the freeze allowlists that host hash. | `attestModel` labels every non-injected selection `provider` (`models.ts`, new function). The vendor adapter honours `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` (`vendor-openmuse/src/provider.ts:57,70`). A worker pointed at a local OpenAI-compatible stand-in (like the fake SSE server in the observability tests) is stamped `source: 'provider'`. |

The gate half, which is not in this packet, must treat a missing stamp, an unknown `source`, or any stamp other than
`provider` as `fake_evidence` (HOLD), and must never default to provider.

## Answers to the lead's questions

**Can a caller, profile or candidate influence the stamp? Not through the job or bundle.**
- `EnvModelResolver.select(_job, _bundle)` ignores both and builds the spec from the process environment
  (`models.ts:46-50`).
- An injected adapter is always `fake`, whatever spec the profile declares; this is tested.
- The remaining influence is the worker's own environment: the base URL (M-3) and `EXPUNGE_MODEL_ID`, which is free text.
  That is an operator, not a candidate.
- Another composition with a custom `ModelResolver` could return a selection without `textAdapter`. The runtime would then
  build a real adapter from the environment, so the stamp stays truthful apart from M-3.

**If the hook throws, does the run proceed unstamped? Yes.** See M-1. Even without the takeover case, an unstamped
run's evidence must be HOLD at the gate.

**Is the takeover overwrite safe with mixed models? No.** See M-2.

**Does `spec` leak anything sensitive? No.** It is `provider/model` built from `EXPUNGE_MODEL_PROVIDER` and
`EXPUNGE_MODEL_ID`, or the injected adapter's own name and model. No key and no URL. (M-3 should store a host hash, not
the URL, because gateway URLs can carry tenant tokens in their path.)

**Is it written by the worker principal only? By the worker, through the fenced `jobs.checkpoint(actor, lease, ...)`,
yes. But it is not the only principal able to write it.**
- The `grader` and `promoter` roles both hold UPDATE on `jobs` (`packages/mongo/src/roles.ts`, grader and promoter
  blocks). Collection-level RBAC cannot narrow that to fields.
- So the principal that will verify the stamp, the grader running the gate, can also rewrite it.
- Follow-up, not blocking: move run attestations into an insert-only collection (for example `run_attestations`, unique
  per `(jobId, fence)`) where only `domain_executor` may insert and the grader may only read. That also implements M-2
  naturally.

## Tests missing

Add these alongside the fixes:
- a stamp write that fails ends the session before any model call;
- a takeover by a second session with a different model yields two stamps, or a refusal, and never one silently
  replaced stamp;
- an overridden base URL is recorded as such.

The existing tests prove the happy path only: the stamp lands before any phase, survives the terminal replace, and a
fake stays fake.

## Re-read of the fix packet (2026-10-11, working tree, 8 files, +165/-27 against HEAD)

The original stamp had already been committed as 020004b before my BLOCK arrived. The team chose to fix forward. I read
the diff of `packages/runtime/src/{ports,models,session,errors}.ts`, `apps/worker/src/dispatch.ts` and the tests.
`npx vitest run packages/runtime apps/worker/test/dispatch.test.ts` exits 0: 11 files, 144 tests passed. The run includes
the four new cases: fail closed, takeover with a different model, a failed takeover stamp, and an overridden base URL.

**Disposition: ACCEPT-WITH-FOLLOWUP.** The BLOCK is lifted for the worker half.

- **M-1 fixed.** `session.ts` now rethrows a failure from `onModelSelected` as `RuntimeError('ModelAttestationFailed')`.
  It happens before `tanstackAgent` is built and before any model call. An error from `attestModel` itself (a bad spec) is
  inside the same try. `dispatch.ts` rethrows after logging, and the job-failed event marks the failure retryable. With
  `revertOnFailure`, a stamp that was never stored is removed from later snapshots. If the write was ambiguous (it
  committed but the acknowledgement was lost), the result is a stored stamp for a session that made no model call. That
  is harmless.
- **M-2 fixed in the worker.** `attestedModels[]` carries `fence` on each entry. A takeover reads the prior entries from
  the claimed checkpoint and appends its own. An entry for a fence that already has one is not duplicated. A failed
  takeover write leaves no entry and makes no model call.
- **M-3 fixed.** The stamp now records `endpoint: 'default' | 'overridden'` and a sha256 of the lower-cased host; the URL
  is never stored. Attestation and adapter read the same environment (`deps.env`, defaulting to `process.env`, in both
  `session.ts` and `vendor-openmuse/src/provider.ts:49`). The host hash is unsalted, so it can be matched against a list of
  known gateways. That is fine, because a host is not a secret.

**Is "append-only" enforced anywhere other than the worker's own code? No.**
- `JobRepository.checkpoint` replaces the whole field (`$set: { checkpoint }`, `packages/mongo/src/jobs.ts:386-389`).
  Any session holding the lease could drop earlier entries: a buggy build, an older build, or a mixed fleet.
  - An older build writing without `attestedModels` would also have a different attested runtime hash, so the gate's
    `runtime_hash_mismatch` check would catch that case.
- The `grader` and `promoter` roles also hold UPDATE on `jobs`, so the principal that will verify the stamps can rewrite
  them.
- Fences rise by 1 on every claim or takeover (`jobs.ts:346,424`). But a claim that ends before its session starts (for
  example `HarnessNotDeployed`) leaves no stamp, so "one stamp per fence" cannot be required strictly. Without an
  independent claim history, the gate cannot detect a removed middle entry.

**Follow-ups, required before the gate half consumes stamps:**
1. Move run attestations into an insert-only collection, for example `run_attestations` with `_id` set to
   `(jobId, fence)`. Only `domain_executor` may INSERT; the grader may only FIND; nobody may UPDATE or REMOVE. That makes
   append-only a database property. A checkpoint copy can stay for display.
2. Gate rule: HOLD (`fake_evidence`) in each of these cases:
   - there are no stamps;
   - the job's final fence has no stamp;
   - entries disagree with each other or with the freeze;
   - any `source` other than `provider`;
   - `endpoint: 'overridden'` with a host hash the freeze does not allowlist.
3. A runner composed without `onModelSelected` (anything that does not go through `Dispatcher` hooks) is silently
   unstamped. Rule 2 covers it. Optionally, make the hook mandatory in `ExecutionHooks` for worker sessions.
