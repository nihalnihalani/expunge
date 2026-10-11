# Evolution

The proposer side of the harness loop. A model proposes one bounded change; trusted code decides everything else.

- `buildEvidencePacket`: only sanitized, training-split, training-permitted evidence reaches the proposer
  (`EvidenceNotPermitted` otherwise). Three arms share a schema and a size budget: `trace_informed` (the incident),
  `score_only` (the permitted score and identifiers, no trace content) and `wrong_incident` (an unrelated permitted
  trace). Every candidate stores the arm that produced it.
- `proposeCandidate`: asks an `EvolverModel` (structured output, no tool-choice parameter), validates the shape,
  checks every cited identifier against the packet **before compilation**, reads `before` from the parent, rebuilds the
  child from the parent and exactly the patches, appends the cited evidence references, compiles it with
  `@expunge/harness-compiler` and replays it. Statuses: `abstained`, `schema_rejected`, `citation_rejected`,
  `compile_rejected`, `replay_rejected`, `compiled`. The proposal row carries no `computedClass` or lifecycle state
  (the gate writes those); the compiler's class is on the record beside it.
- `replayCandidate`: as-of **decision replay** over a ledger of recorded decisions. Facts observed after a decision
  are withheld (unknown); outcomes label flips and never feed evaluation. Reports flips, known authority flips (the
  candidate permits what the record blocked) and regressions, labelled "decision replay" with
  `behavioralProof: false`. Each row is decided by both the TypeScript evaluator and the compiled Mongo expressions;
  disagreement throws `ReplayParityViolation`. A candidate with a regression in either sample is `replay_rejected`.
  - **In-sample vs out-of-sample.** The scope names the incident run(s) the proposal addresses. Rows from those runs
    are **in-sample** (`inSample`, `inSampleFixes`); rows from any other run are **held out** (`heldOut`,
    `heldOutFixes`). There is no aggregate `fixes` field. Only held-out fixes are fixes: a candidate that repairs just
    its own incident's run has shown that it addresses the incident and nothing more. `ProposalRecord.evidenceLevel`
    is `out_of_sample_fix`, `in_sample_only` or `no_replay_signal`; the last two are a **candidate for gate**, never
    "fixes". `replayCandidate` throws `ReplayScopeMissing` for an empty scope, so no row can be mistaken for held out.
  - **Attribution.** Evidence catalog entries are bound to the job and run of their bundle
    (`buildEvidenceCatalog`). A flip is *attributed* only when the changed rule that fired on it (or, for a loosening by
    removal, the evidence the patches cite) cites evidence bound to that row's job and run. A rule citing an unrelated
    incident earns no attribution however many rows it flips. A trace-informed guardrail edit with no attributed flip
    is `replay_rejected` (`no_attributed_effect`); the control arms are reported with their attributed and
    unattributed counts instead of rejected, so the wrong-incident comparison stays meaningful.
- `retestAccumulated` / `pruneRules`: the critic retests the whole accumulated rule set, finds rules covered by
  others, and prunes rules without standing one at a time. Pass the evidence catalog and standing is *attributed*
  (`attributedFlips`, reason `no_attributed_standing`); without it any flipped row counts.
- `runEvolutionRound` / `runControlledRounds`: bounded branching, pruning retries, backtracking from rejected
  candidates, ranking of compiled survivors and retention of every loser with reason codes. **Ranking and stopping use
  out-of-sample evidence only**: held-out fixes minus twice the regressions, then attributed flips, fewer edits, lower
  authority. The search stops on `good_candidate` only for a compiled candidate with a held-out fix, no regression and
  (for guardrail edits) an attributed flip. `RoundResult.selectionBasis` is `held_out`, or `in_sample_only` when the
  selection cannot rest on a held-out fix. The control arms run the same budget.

`createLabeledFakeEvolverModel` is a deterministic **fake** (keyword rules over the packet text) used only in tests and
the evidence script; it is never evidence of model behaviour. Its separation of the three arms is constructed by those
keyword rules, so it demonstrates the plumbing only: transfer to a real model is untested until credentials exist. The ledger rows in `test/helpers.ts` are labelled
fixtures shaped like mongodb-authority's `DecisionRecord` plus the as-of inputs the gateway used (`toolId`, `inputs`);
B1 will produce real rows. Candidates are never admitted here: fresh paired trials (gate) decide admission.

Evidence: `npx tsx packages/evolution/scripts/c2-evidence.ts` (its output labels in-sample and out-of-sample counts
separately, and its rejection log counts a category only when it was rejected with that category's own code). Verification: `npx vitest run packages/evolution`.
