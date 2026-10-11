# PKT-47 (campaign-host) and PKT-51 (rehearsal) challenge

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11, about 15:45Z. This is a static read.

**Pin.** I pinned the bytes myself (`pkt47-51-reviewer-pin.txt` in the scratchpad, 15:30:54Z; 17 files) because rsi-evolution's own list had not arrived. The dispositions bind to those bytes. No tests were run.

**Disposition: NOT ACCEPTED until CH-1, CH-2 and RH-1 are resolved.** RH-2 to RH-4 are required notes.

## Questions asked

- **Can a FAKE artifact reach a deployment?** No path found.
  - Fake evidence always holds (`fake_evidence`), and reject outranks hold, so a stored report is never `admit`.
  - The rejection's reason codes include `fake_evidence` (admission.ts:276-278), so a stored reject is labelled.
  - `RehearsalVerdict` carries no report or digest. `honestStop` asserts that promotion throws.
- **Is the "real worker path" claim true?** In the test harness, yes: `support.ts` wires `CampaignEpisodePort` to `WorkerEpisodeRunner`, the result comes from committed rows, and `attestedRuntimeHash` is read from the job checkpoint. But see RH-2.
- **Is there a budget-laundering path through the limits split?** No, because the run fails closed. But the rule as documented is not what executes (CH-2).
- **Instance isolation.** Each instance has its own worldId, scope and derived `_id`s. Reads filter by `worldId`, and dispose removes by `worldId` and by the instance's own scope. Within these files I found no cross-instance path.
- **Does the grader read committed rows only?** Yes: the episode result comes from `evidence.read` (job row, receipt, batch counts), and the world is read back with majority read concern.
- **Is `in_sample_only` disclosed?** In the evolution round and in the rehearsal script output, yes. Not in the gate report (RH-3).

## Findings

**CH-1 (HIGH, DEMONSTRATED static): campaign jobs and pins run as `setup`, bypassing the PKT-44 rule.**
- `GraderJobHost` creates cleanup jobs through `JobRepository.create` with a `jobCreator` service. The ADAPTER note says that is `setup` today (job-host.ts:20-31,92-96).
- `setup` is exempt from the deployment-pointer check, so the only guard is the in-process `allowed` set, which the caller fills (`allow(...)`). Nothing reads the stored freeze or claim.
- The host also writes `artifact_eligibility: permitted` for the pinned bundle as `setup` (job-host.ts:59-82).
- PKT-44 provides `createCampaignJob` (grader-only; it checks the world binding, the freeze, the open claim, and parent or child projection).
- *Required:* the host uses the grader principal and `createCampaignJob`. Pinning goes through a grant that limits the eligibility write to the campaign's own instance scope. No `setup` credential remains in the campaign host process.

**CH-2 (MEDIUM, DEMONSTRATED static): the paired-limits rule contradicts the worker.**
- `CampaignEpisodePort.run` passes limits made of campaign budget keys plus bundle structural keys (port.ts:44-52).
- `WorkerEpisodeRunner.run` refuses any request whose limits differ from `bundle.limits` (`LimitsMismatch`, episode-port.ts:176). The gateway controls and the runtime enforce `bundle.limits` in any case (controls.ts:97, session.ts:103-104,331).
- So whenever a bundle's budget differs from the campaign's, every run of that arm becomes a failed row. The "budget from conditions" rule never executes: equality is enforced, by failure. That fails safe, so there is no laundering, but the campaign can be wasted silently.
- *Required:* either the run binding carries the run limits and the gateway and runtime enforce those (preferred), or admission and the compiler refuse a candidate whose budget keys differ from the frozen conditions, with a named reason, before a campaign runs. Document whichever holds.

**RH-1 (MEDIUM, LIKELY): a rehearsal can consume a real candidate's only campaign.**
- `honestStop` calls the real `GateStore.insertReport` (run.ts:194), and `runGate` inserts the claim.
- Claims and report IDs are keyed by (parent, child projection), not by campaign or database purpose. A rehearsal pointed at a shared or production control database, with the real W0 parent and a real candidate, would store a fake-evidence rejection under that candidate's single report ID, and the real gate would then refuse it with `CandidateGateRerun`.
- *Required:* the rehearsal refuses to run unless its control database is a rehearsal-only one (name prefix or a marker row), or its claims and reports live in rehearsal-only collections.

**RH-2 (LOW-MEDIUM, DEMONSTRATED static): the provenance text is hard-coded.**
- `honestStop` always reports "both arms through the real worker path" (loop.ts:375-380), whatever `EpisodePort` was injected (run.ts:42).
- *Fix:* derive that line from the port actually used (`port.kind === 'worker'` and the concrete class), and say FAKE otherwise.

**RH-3 (LOW-MEDIUM): `in_sample_only` is not carried into the gate report.**
- The selected candidate's `selectionBasis` exists only in the evolution round output. A stored gate report, and any export built from it, does not say that the candidate was chosen in sample.
- *Fix:* put `selectionBasis` in `admittedUnder` (inside the digest).

**RH-4 (LOW): `retryFailures` is defined as planned minus committed batches.**
- That counts unfinished batches, not failed retries (episode-port.ts, `committed.plannedBatches - committed.committedBatches`). Either rename it or document that meaning wherever the metric is reported.

**Notes.**
- `CampaignWorldHost.installAuthority` is a `setup` adapter by design. It goes with CH-1.
- The campaign-world hardening that the lead accepted for D8-3 (a campaign scope has no production deployment pointer, or is the evaluation env) also guards these worlds.

**Owner list check (about 15:55Z).** `pkt47-51-hashes.txt` has 19 paths and matches the tree. It equals my 15:30Z pin plus `packages/gate/README.md` and `packages/gate/test/import-boundary.test.ts`. `npx vitest run packages/gate/test/import-boundary.test.ts` passes all 34 tests (exit 0); `campaign-host` and `rehearsal` are listed as private and trusted. The findings stand. The owner lists CH-1 (the setup adapters) and the `LimitsMismatch` behaviour as known gaps. They remain REQUIRED before landing, not merely pending.
