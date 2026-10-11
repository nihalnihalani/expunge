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
