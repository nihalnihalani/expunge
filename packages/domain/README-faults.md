# Fault injection on the domain path (DA-5 P2-1, PKT-59)

What this is: the WorldSpec fault plan (`partialAcknowledgements`, `interruptAfterEffects`, `transientFailures`) realized
on the REAL gateway path, so the retry, replay and takeover behaviour of `apply_cleanup_batch` is exercised by the same
code that runs outside a campaign. What it is not: a model result. The tests drive it with a labeled scripted driver.

## Trusted inputs

- The plan comes from one stored row in the control collection `world_faults`, keyed by the job's world id:
  `{ _id: worldId, tenantId, env, scopeId, worldId, plan, planHash, createdAt }`.
- `planHash = contentHash({ tenantId, env, scopeId, worldId, plan }, 'world-fault-plan')`. A row whose hash does not match
  its content is refused (`FaultPlanTampered`), so a tampered plan fails closed: the apply call fails and writes nothing.
- Writers are the fixture builder and setup (campaign host under `fixture_builder`); readers are the domain executor,
  grader and setup. The model has no tool that reads or writes it, and nothing in the job or the arguments names it.
- A world with no row never sees a fault. Non-campaign worlds have no row.

## Semantics (all in `src/faults.ts`; the hooks are two lines in `tools/apply-cleanup-batch.ts`)

- Hooks run only for a FRESH commit attempt (`ordinal >= committedPrefix`). A replay of a committed batch never faults.
- Transient failure (`injectBeforeCommit`): while fewer than `transientFailures` have been spent, the call throws
  `TransientFault` BEFORE the commit. Nothing is written. The call ends `retryable_error`, which rides the apply
  self-edge of the workflow.
- Lost acknowledgement (`injectAfterCommit`): after a batch commits, while fewer than `partialAcknowledgements` have been
  spent and that batch has not lost one, the call throws `AcknowledgementLost`. The effect IS committed. A retry of that
  batch finds the committed effect and returns the saved receipt, so each effect happens exactly once. The controls
  treat that retry as a new attempt (the earlier call ended in an error, so it is the one that delivers the receipt);
  without that, a lost acknowledgement on the last batch would strand the run at `apply/retryable_error`.
- Interruption: once `interruptAfterEffects` effects have committed, the call releases the lease and fails with
  `LostLease`. A takeover claims the job (new fence) and resumes from committed state; the interrupted call row is
  resumed under its own number.
- Every fault is recorded as spent BEFORE it takes effect, in the fenced step log (`domain_steps`, kind `fault`, payload
  `{ kind, batchOrdinal }`). A takeover therefore never spends the same fault twice, and a session without the lease
  cannot spend one.

## Disclosed limits

- Faults are per job. Two jobs on one world each spend the full plan.
- The interruption needs `interruptAfterEffects` batches to commit. A run that plans fewer batches (W0's shallow
  context plans one on `partial_retry`) never reaches it, and at most one acknowledgement can be lost per batch. The tests
  assert the counts that follow from the plan, not the plan's nominal numbers.
- The `replayed` flag of the apply result is decided before the commit, so the losing call of an overlap can report
  `replayed: false` while returning the saved receipt. The receipt id is the truth.
- The plan is read once per run context. A plan changed mid-run is seen by the next run, not the current one.
- Evidence level: local single-node replica set, scripted driver. No model, Atlas or deployed-database claim.
