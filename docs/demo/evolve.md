# Model-generated proposal: one real evolver step on alias_two_hop

**MODEL-GENERATED PROPOSAL. PILOT ONLY, NOT ADMISSION.** A real provider model wrote the proposal through the evolver's
proposer port, and the real harness-compiler judged it. Nothing here is a gate decision. No frozen split was checked, no
held-out instance was used and nothing was promoted. Twelve alias_two_hop pairs are a pilot, not a statistical claim.

## What ran

- **Proposer:** `createProviderEvolverModel` (`packages/evolution/src/provider-model.ts`). It selects the model the same
  way the worker does (`EXPUNGE_MODEL_PROVIDER`, `EXPUNGE_MODEL_ID`, `EXPUNGE_MODEL_PRICE_*` via `@expunge/runtime`) and
  builds the adapter with `@expunge/vendor-openmuse`. It makes one strict structured-output call with no tool choice and
  meters it with the runtime `UsageMeter`, against a proposer budget of 80k tokens and $0.02. It also records the model
  stamp (attestation, prices, usage) on the proposal as `modelStamp`. It fails closed before any call when the model
  selection, the credential or the price profile is missing.
- **Model:** openai/gpt-6-luna. Every stamp says `source: provider`, endpoint `default`.
- **Code:** origin/main at `88a8233` (runtime hash `1a5445de9269…`).
- **Parent:** the improved child from `scripts/demo/candidate.ts`, bundle `bbd1486d63f4…`. It keeps `schemaMode:
  all_registered_fields`, nested arrays on and `traversalDepth` 5. Its hash differs from the `f1eb5184…` in
  `docs/demo/pilot.md` only because the runtime hash differs.
- **Evidence:** four failed `alias_two_hop` episodes. They were reproduced with `scripts/demo/pilot.ts --families
  alias_two_hop --pairs 2` (W0 against the improved child) on the local replica set at port 27218:

  | pair | arm | outcome | residuals |
  |---|---|---|---|
  | 0 | W0 | NoCompletionReceipt (`retry_failure` too) | 6 |
  | 0 | improved child | NoCompletionReceipt | 6 |
  | 1 | W0 | incomplete_receipt | 4 |
  | 1 | improved child | TokenBudgetExceeded | 2 |

  `scripts/demo/evolve.ts` read each episode's stored `jobs` row (binding) and its `tool_decided` projection events. It
  joined those with the grader's reason codes and residual count to build one `EvidenceBundle` per episode. The bundles
  carry only ids, tool ids, decisions, rule ids, target counts and grader codes; tool summaries, model text and record
  values are withheld. The packet came to 6,314 characters and was not truncated.
  - **Operator label:** these bundles are marked `split: train`, because the pilot worlds are fresh seeds of a training
    family. A pilot database has no stored split row; the observer would have marked them gate-only.

## The proposals (three real calls on the same packet, all kept)

| attempt | outcome | proposal | tokens in/out | cost |
|---|---|---|---|---|
| A | compile_rejected (`hidden_test_shortcut`) | `contextPolicy.referenceDepth` 1 → 2, plus a workflow edit: `discover` gets `maxVisits` 2 and a new edge `discover → discover when more_references` | 5590/1779 | $0.001449 |
| B | **compiled**, computed class **behavioral** (claimed `authority_expansion`) | `contextPolicy.referenceDepth` 1 → 2: "Allow discovery to reach one additional reference hop, potentially reducing residuals in the observed incomplete runs." Child `3c65b630765e…` | 5590/625 | $0.000872 |
| C | compile_rejected (`hidden_test_shortcut`) | the same workflow edit as A (second `discover` visit, `more_references` loop) | 5590/1215 | $0.001167 |

- **Why A and C were rejected:** the compiler's shortcut check refused them because the hypothesis text contained a record
  identifier. The model copied the evidence ids (job ids) into the prose as well as into `sourceEvidenceIds`. The
  workflow edit itself was never judged. Telling the proposer to keep identifiers out of hypothesis text is an open
  follow-up.
- **Classification:** the model claimed `authority_expansion` for B, and the compiler computed `behavioral`. The
  compiler's class is the one that counts.

## Pilot: improved child vs model-generated grandchild (B)

Both runs used `scripts/demo/pilot.ts --parent child.bundle.json --candidate evolved.bundle.json --families alias_two_hop
--pairs 6`, on the local replica set at port 27218, through the real worker and domain gateway. Each pair runs both arms
on the same fresh world, and the two runs are separate campaigns with different seeds.

| run | arm | useful | targeted residuals | failures | verified receipts | collateral | model calls | cost |
|---|---|---|---|---|---|---|---|---|
| `pilot-a9201bbe` | parent (improved child) | 0/6 | 24 | 3 NoCompletionReceipt, 2 TokenBudgetExceeded, 1 incomplete_receipt | 6/6 | 0 | 42 | $0.0152 |
| `pilot-a9201bbe` | candidate (B) | **6/6** | **0** | none | 6/6 | 0 | 36 | $0.0119 |
| `pilot-824bd14b` | parent (improved child) | 0/6 | 20 | 3 TokenBudgetExceeded, 2 ModelRunFailed, 1 incomplete_receipt | 6/6 | 0 | 37 | $0.0118 |
| `pilot-824bd14b` | candidate (B) | **4/6** | 8 | 2 ModelRunFailed (unpriced calls: provider errors) | 6/6 | 0 | 33 | $0.0099 |

**Combined over 12 alias_two_hop pairs:** the candidate completed 10/12 with 8 residuals, and the parent completed 0/12
with 44 residuals. Both of the candidate's failures were `ModelRunFailed` with unpriced calls (provider-side errors), not
harness failures. Each completed candidate episode used 6 model calls and about 19k input tokens. The parent mostly ran out
of tokens or stopped without a receipt.

**Direct_nested regression check** (`pilot-ef420e70`, `--families direct_nested --pairs 3`): both arms completed 3/3, with 0
residuals, 18 calls and about $0.0058 each. No regression showed on the family the parent already solved.

## Reading

- On these pilot worlds, the one-line model-generated edit `referenceDepth` 1 → 2 turns alias_two_hop from always failing
  into mostly completing. The family's subject is reached through a two-hop alias chain, and depth 1 left the second hop
  unseen. The parent then spent its budget searching and ended with residuals, out of tokens or without a receipt.
- Treat this as a pilot only. It covers 12 pairs from one model, fresh training-family worlds and no held-out split, and
  the operator labelled the evidence split. Before any admission claim, the edit has to go through the gate on frozen
  held-out instances.

## Note: the first run hit a regression

An earlier run of this step, before `88a8233`, gave a different picture. Commit `15c68c3` made `identity_edges.registryHash`
required by the validator, but the edge writer never set it. As a result, `resolve_subject` failed with "Document failed
validation" (ToolFailed), and every alias_two_hop run ended `NoCompletionReceipt` or `ModelRunFailed` whatever the
harness.

That run's proposal was the same `referenceDepth` 1 → 2 (compiled, behavioral). Its 3-pair pilot showed no difference
(0/3 against 0/3, 18 residuals each), which was an artifact of the regression. It also surfaced one evolver bug, fixed in
the same change: a cited bundle `evidenceId` was always rejected as `evidence_not_in_bundle`. The packet now maps each
evidenceId to its source ids, and `proposeCandidate` expands such a citation before compiling. The first run cost about
$0.013.

## Spend (this run)

| step | cost |
|---|---|
| evidence reproduction (4 episodes) | $0.0087 |
| three proposer calls | $0.0035 |
| alias_two_hop pilots (24 episodes) | $0.0488 (some calls unpriced) |
| direct_nested check (6 episodes) | $0.0115 |
| **total** | **about $0.073** (about $0.086 including the first run) |

## Not verified

- No proposal was replayed against a decision ledger, because a pilot database has none, so the record's `evidenceLevel`
  is absent.
- `split: train` is an operator label, not a stored split.
- The workflow edit from attempts A and C was never compiled or piloted.
- Unpriced calls on `ModelRunFailed` episodes mean those episodes' costs are lower bounds.

**MODEL-GENERATED PROPOSAL. PILOT ONLY, NOT ADMISSION.**
