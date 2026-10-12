# Model-generated proposal: one real evolver step on alias_two_hop

**MODEL-GENERATED PROPOSAL. PILOT ONLY, NOT ADMISSION.** A real provider model wrote the proposal through the evolver's
proposer port, and the real harness-compiler judged it. Nothing here is a gate decision. No frozen split was checked, no
held-out instance was used and nothing was promoted. Three pairs prove nothing statistically.

## What ran

- **Proposer:** `createProviderEvolverModel` (`packages/evolution/src/provider-model.ts`). It selects the model the same
  way the worker does (`EXPUNGE_MODEL_PROVIDER`, `EXPUNGE_MODEL_ID`, `EXPUNGE_MODEL_PRICE_*` via `@expunge/runtime`) and
  builds the adapter with `@expunge/vendor-openmuse`. It makes one strict structured-output call with no tool choice and
  meters it with the runtime `UsageMeter`, against a proposer budget of 80k tokens and $0.02. It also records the model
  stamp (attestation, prices, usage) on the proposal as `modelStamp`. It fails closed before any call when the model
  selection, the credential or the price profile is missing.
- **Model:** openai/gpt-6-luna. The stamp says `source: provider`, endpoint `default`.
- **Parent:** the improved child from `scripts/demo/candidate.ts`, bundle `40bd9bb84218…`. It keeps `schemaMode:
  all_registered_fields`, nested arrays on and `traversalDepth` 5. Its hash differs from the `f1eb5184…` in
  `docs/demo/pilot.md` because this checkout's runtime hash (`c9a01faf926c…`) differs from that run's.
- **Evidence:** two failed `alias_two_hop` episodes reproduced with `scripts/demo/pilot.ts --families alias_two_hop --pairs 1`
  on the local replica set at port 27218. W0 and the improved child each failed with **6 targeted residuals**. Both ended
  `ModelRunFailed` in this run, not the `NoCompletionReceipt` / `TokenBudgetExceeded` seen earlier, and two of their calls
  were unpriced. `scripts/demo/evolve.ts` read each episode's stored `jobs` row (binding) and its `tool_decided` projection
  events. It joined those with the grader's reason codes and residual count to build one `EvidenceBundle` per episode. The
  bundles carry only ids, tool ids, decisions, rule ids, target counts and grader codes; tool summaries, model text and
  record values are withheld. The packet came to 2,688 characters and was not truncated.
  - **Operator label:** these bundles are marked `split: train`, because the pilot worlds are fresh seeds of a training
    family. A pilot database has no stored split row; the observer would have marked them gate-only.

## The proposals (three real calls, all kept)

| attempt | outcome | proposal | tokens in/out | cost |
|---|---|---|---|---|
| 1 | **compile_rejected** (`evidence_not_in_bundle`) | `contextPolicy.referenceDepth` 1 → 2, claimed `authority_expansion`, citing the two bundle evidenceIds | 3550/662 | $0.000686 |
| 2 | **abstained** | "The evidence shows the same failure outcome for both runs and does not establish that a specific harness change would address it." | 3722/316 | $0.000531 |
| 3 | **compiled**, computed class **behavioral** (claimed behavioral) | `contextPolicy.referenceDepth` 1 → 2: "Allowing one additional reference hop may help resolve the residuals observed in the two-hop case." Child `d132d5092f96…` | 3722/443 | $0.000595 |

Attempt 1 exposed a real evolver bug. The packet listed each bundle's `evidenceId` as citable, but the compiler accepts a
citation only when a reference appended to the child mentions it. References carry source ids, never the evidenceId, so a
model that cited the evidenceId was always rejected. The fix lives in the evolver, not the compiler: the packet now maps
each evidenceId to its source ids (`sourceIdsByEvidenceId`), and `proposeCandidate` expands such a citation before it
compiles. Attempts 2 and 3 ran after the fix, with the same prompt and evidence. The model is not deterministic: one run
abstained and one proposed.

## Pilot: improved child vs model-generated grandchild, 3 alias_two_hop worlds per arm

`scripts/demo/pilot.ts --parent child.bundle.json --candidate evolved.bundle.json --families alias_two_hop --pairs 3`, run on
the local replica set at port 27318 through the real worker and domain gateway (campaign `pilot-02c21466`).

| pair | arm | outcome | useful | residuals | receipt | collateral | calls | tokens in/out | cost |
|---|---|---|---|---|---|---|---|---|---|
| 0 | parent (improved child) | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 5 | 13937/211 | $0.0015 |
| 0 | candidate (model-generated) | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 5 | 13954/199 | $0.0015 |
| 1 | parent | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 5 | 13883/191 | $0.0015 |
| 1 | candidate | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 5 | 14060/237 | $0.0015 |
| 2 | parent | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 5 | 14014/250 | $0.0015 |
| 2 | candidate | failed (NoCompletionReceipt) | no | 6 | verified | 0 | 5 | 13891/193 | $0.0015 |

Parent: 0/3 useful, 18 residuals. Candidate: 0/3 useful, 18 residuals. There was no collateral on either arm, and every
receipt verified against the committed job and its attestation rows.

## Reading

- **The proposal does not improve alias_two_hop.** The grandchild fails exactly like its parent: 6 residuals, no completion
  receipt, the same call count and the same cost. Raising `referenceDepth` from 1 to 2 is a plausible edit (the family is
  two hops), but in these episodes the run stops before reference depth matters. The evidence the model saw holds no
  signal finer than "6 residuals, same failure", which the abstaining attempt said in its own words.
- This is a valid negative result. The pipeline is now real end to end: stored job rows, evidence packet, real model,
  compiler, pilot. What it lacks is evidence rich enough to direct a fix, such as which residual kinds remain or where the
  run stops.

## Spend

| step | cost |
|---|---|
| evidence reproduction (2 episodes) | $0.0022 (some calls unpriced) |
| three proposer calls | $0.0018 |
| pilot (6 episodes) | $0.0090 |
| **total** | **about $0.013** |

## Not verified

- The evidence reproduction ran before this worktree's `node_modules` was fixed to resolve `@expunge/*` to the worktree. That
  pilot therefore ran against the shared checkout's package sources. The runtime hash matched (`c9a01faf926c…`), but the
  sources were not proven identical. The evolve run and the three-pair pilot ran with the worktree's own packages.
- Attempt 1 ran before the citation fix, and attempts 2 and 3 after it. No proposal was replayed against a decision ledger,
  because a pilot database has none, so the record's `evidenceLevel` is absent.
- `split: train` is an operator label, not a stored split.

**MODEL-GENERATED PROPOSAL. PILOT ONLY, NOT ADMISSION.**
