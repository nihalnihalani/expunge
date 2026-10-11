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
  candidate permits what the record blocked), regressions and fixes, labelled "decision replay" with
  `behavioralProof: false`. Each row is decided by both the TypeScript evaluator and the compiled Mongo expressions;
  disagreement throws `ReplayParityViolation`. A candidate with regressions is `replay_rejected`.
- `retestAccumulated` / `pruneRules`: the critic retests the whole accumulated rule set, finds rules covered by
  others, and prunes rules without standing one at a time.
- `runEvolutionRound` / `runControlledRounds`: bounded branching, pruning retries, backtracking from rejected
  candidates, ranking of compiled survivors (recorded fixes minus twice the regressions, fewer edits, lower authority)
  and retention of every loser with reason codes. The control arms run the same budget.

`createLabeledFakeEvolverModel` is a deterministic **fake** (keyword rules over the packet text) used only in tests and
the evidence script; it is never evidence of model behaviour. The ledger rows in `test/helpers.ts` are labelled
fixtures shaped like mongodb-authority's `DecisionRecord` plus the as-of inputs the gateway used (`toolId`, `inputs`);
B1 will produce real rows. Candidates are never admitted here: fresh paired trials (gate) decide admission.

Evidence: `npx tsx packages/evolution/scripts/c2-evidence.ts`. Verification: `npx vitest run packages/evolution`.
