# Real admission: operator-authored child vs W0

A fresh paired admission through the gate's own `runGate` (packages/gate), with the real provider model, the real worker
(Dispatcher, domain gateway as `domain_executor`, insert-only `run_attestations`) and a throwaway local replica set. The
frozen rule decided: 38 pairs, 76 episodes. No test fixture, no scripted port.

**Verdict: HOLD.** Reason codes: `retention_violation`, `limits_exceeded`, `harness_defect_pair`, `infra_invalid`. Because
the verdict is a hold, the gate stored no report, so nothing was promoted. The demo's promotion step still uses the
labelled test-fixture admit ([promotion.md](promotion.md)).

Command (run on main at `88a8233`):

```
node --import tsx scripts/demo/candidate.ts --out .expunge/demo/candidate.json
node --import tsx --env-file=.env scripts/demo/admission.ts \
  --uri 'mongodb://127.0.0.1:27218/?replicaSet=expunge-local&directConnection=true'
```

## Identifiers

| | |
|---|---|
| Model | openai/gpt-6-luna (every stamp `provider`, default endpoint) |
| Parent W0 | `c42ba73bbe0298f8ab75efd840cf786cfa62cb2b6dfead2a7290a7bd21f48fa7` |
| Child | `bbd1486d63f416a68db85dfeae93b544249b7cb269e0b761375ee5b3c8871396` (schemaMode `all_registered_fields`, nested arrays on, traversalDepth 5; class `behavioral`) |
| Runtime hash (frozen and attested by all 76 arms) | `1a5445de9269bb38ea7b5c1fa8967328e60d46a46b7375b3e3f2a06cb506be94` |
| Campaign / freeze hash | `adm-e56c33f7` / `da045cdb89c9d171a5efe3f35ddb06f7a9ce93647b022ce48b4d1180dfb049dd` |
| Split manifest commitment | `39c66fbbeceb72ffa87aeed8c2dab72e6bbbd80283dc8d657b594858cde34b64` |
| Rule hash / gate hash | `6c7ae6a2fa81…` / `809968172aa4…` |
| Report id | `ddb92909e55c662ec14469447ac6c5374786943826d6e3cf1fdd9ad0eba9790d` (no digest: a hold stores no report; its trials are in `gate_held_runs`) |
| Wall time | 4.5 minutes at concurrency 4 |

## Totals

Every one of the 76 arms has committed evidence: a verified job row, a provider stamp, and the frozen runtime hash. No arm
was infrastructure (no provider, network or setup failure).

| split | pairs | scored pairs (no defect) | parent useful (scored) | candidate useful (scored) | parent useful (all) | candidate useful (all) |
|---|---|---|---|---|---|---|
| train | 6 | 3 | 0 | 3 | 0/6 | 3/6 |
| protected | 16 | 9 | 0 | 4 | 0/16 | 4/16 |
| validation | 16 | 8 | 0 | 4 | 0/16 | 4/16 |

- Train by family: `direct_nested` gave parent 0/3 and candidate 3/3. `alias_two_hop` gave parent 0/3 and candidate 0/3.
- Trigger gain 3 against a required 2, no protected world regressed, and validation did not decline. On the behavioural
  score alone the candidate passes.
- Outcomes. Parent: 37 `incomplete` (`incomplete_receipt`), 1 `failed` (`NoCompletionReceipt`). Candidate: 11 `completed`,
  19 `failed` (`TokenBudgetExceeded`), 7 `failed` (`NoCompletionReceipt`), 1 `incomplete`.
- Cost, all priced (0 unpriced calls). Parent $0.0374 (206 model calls, 339,548 tokens). Candidate $0.0920 (253 calls,
  851,419 tokens). Campaign total $0.1294.

## Why it holds, and why it would not admit anyway

- `limits_exceeded` (reject). 19 of 38 candidate arms used more than the bundle's 24,000-token limit: 24,030 to 28,182
  tokens, 7 to 8 model calls. The bigger visible context (all registered fields plus nested arrays) roughly doubles input
  tokens per call. The worker stops the run with `TokenBudgetExceeded`, but the meter has already passed the limit, and
  the rule counts any arm over its limit.
- `retention_violation` (reject). 8 candidate arms in protected and validation worlds broke 2 to 3 retention rules each.
  All 8 were failed runs (`TokenBudgetExceeded` or `NoCompletionReceipt`). W0 broke the same kind of rule in 8 arms of
  those splits (3 each). The rule judges the candidate only.
- `harness_defect_pair` and `infra_invalid` (hold_validity). 18 of 38 pairs have a fault-plan defect, which makes them
  more than the 10% infrastructure threshold.
  - 6 are `FaultPlanNotInjected` on the parent arm, all in the 6 pairs whose worlds have a planned fault. W0 ends
    `incomplete` before it reaches the batch the fault was planned for.
  - 15 arms are `FaultPlanMismatch` (14 candidate, 1 parent). Every one is a `failed` run, though not every failed run
    is flagged. 12 of the 15 are in worlds with no planned fault. The likely cause is that the gate's `defectOf` treats
    the fault attestation a failed run leaves (`readFaults` returns `attestedPlanHash: null` whenever a job exists) as a
    mismatch, even when the plan has no faults. Its own comment says that case is fine. **This is probably a gate
    classification defect, not candidate behaviour, but it has not been confirmed row by row.** It is not fixed here:
    changing it changes the gate hash and the rule's behaviour, and that needs its own review.
- A hold-validity code outranks every reject, so the verdict is hold. With the defect codes gone, `limits_exceeded` and
  `retention_violation` would still reject. **As it stands, the candidate does not earn an admit under the frozen rule.**

## Reading

- The candidate's gain is real and limited, as the pilot showed. It solves `direct_nested` (3/3 train) and does about as
  well in the held-out worlds it can handle (4/16 protected, 4/16 validation, against 0 for W0). It solves no
  `alias_two_hop` world.
- The candidate's own cost cap stops it: half its arms run out of tokens. A version of this candidate that stays under
  24,000 tokens (for example a smaller visible field set, or a raised and frozen token limit argued for on its own) is
  the next thing to try, not a re-run of this one.
- The fault-plan defect classification has to be settled before any campaign can produce an admit or reject on worlds
  where runs fail early.

## Demo setup (stated, not hidden)

1. Each instance's authority row is installed by `setup`, because no restricted campaign installer exists yet (MA-F2).
2. Operator-written eligibility rows permit both harnesses and their cited sources in every instance scope. The proposer
   and observer pipelines write these in a real deployment.
3. The per-episode cost ceiling in the freeze is the owner's provisional $0.10
   (`PROVISIONAL_COST_CEILING_MICROUSD`). No baseline probe measured it. It did not bind: the most expensive episode cost
   $0.0029.
4. The child cites its evidence through an operator transcription of the baseline run's ids ([candidate.md](candidate.md)).

## Earlier attempts in the same session (not results)

- Run 1 (main at `8564df0`) held with every arm `NoCompletionReceipt`. Cause: commit `15c68c3` made `registryHash` a
  required field of the `identity_edges` validator without updating the domain writer. So every `resolve_subject` failed
  ("Document failed validation", shown to the model as `ToolFailed`), and nothing after it ran. `pilot.ts` reproduced it.
  Fixed in `88a8233`. **Any real-model result recorded between `15c68c3` and `88a8233` is not evidence.**
- Run 2 was stopped after 11 episodes: the local replica set container exited (137) during the run.
