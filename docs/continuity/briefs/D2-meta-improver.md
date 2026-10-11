# Brief D2: improver evolution and fresh-base meta comparison

Owner: **rsi-evolution**. Owned paths: `packages/meta-evolution/`, meta-campaign definitions and raw result export under that package. Depends on: C2 (`packages/evolution`: evidence selection, critic, propose, replay, three control arms), C3 gate runner, C1 observer evidence bundles (Raindrop read-back; offline bundle when BLOCKED), D1 optional. Frozen interfaces: `MetaTrial`, `TrialPair`, `GateReport`, `EvidenceBundle`, `HarnessBundle`.

Status: drafted 2026-10-11 11:55 UTC, not dispatched (dispatch after C3 lands).

## Objective

Spec section 11 and ACCEPTANCE "Improved improver" and "Meta comparison": version the improver's own evidence selection, diagnosis workflow, critic/pruning, proposal ordering and allocation strategy as an editable improver harness (I0); produce candidate I1 from permitted past improvement traces; evaluate I0 versus I1 only by the workers each produces from identical reset W0 instances on new incidents, with equal budgets, further withheld worker tests, an I0/I0 noise control and a no-data rewrite control. Null is an acceptable result; an unsupported gain is not.

## Scope

- `packages/meta-evolution/src/improver.ts`: the improver harness as a typed, content-addressed bundle: `evidenceSelection` (which event kinds and how many, from C2's evidence module), `diagnosisWorkflow` (ordered steps), `critic` (pruning thresholds), `proposalOrdering`, `allocation` (proposal/token/evaluation/wall budgets). Hash it; I0 = the C2 defaults frozen as a bundle.
- `packages/meta-evolution/src/propose-improver.ts`: build I1 from permitted improvement traces (C2 rejection catalog outcomes, gate reports, evidence bundles) through the same `ChatModel` port; I1 is frozen (hash recorded) BEFORE the new incidents are drawn.
- `packages/meta-evolution/src/campaign.ts`: for each of eight new incidents: reset two identical W0 instances (artifacts, world state, memory, lesson eligibility, campaign outputs all fresh; no evolved worker, no inherited campaign artifacts), run I0 and I1 with identical permitted incident evidence and equal budgets (at most three proposals each), gate each produced worker on three further withheld worlds with two repeats through the C3 gate runner; store `MetaTrial` rows with `noiseControl` for I0/I0 pairs and a `noData` arm where the improver gets no incident evidence (rewrite control). Compute amortized improvement cost (tokens, dollars when pricing is known, wall time) per produced-worker gain.
- Raw export: every per-pair row, including failed, timed-out and null results, exported as JSON with bundle, model profile, budget and split hashes; this feeds E2 and the UI table.

## Tests required

I0 and I1 cannot read evaluator truth (import guard + canary); fresh W0 instances share no `_id`, memory row or artifact with any earlier run (prove by querying the three databases); the comparison pins identical base, model profile and budgets (hash equality test); I0/I0 noise pairs produce the spread used for the uncertainty statement; the no-data arm is run with the same budget; null and negative results are retained (test that a losing I1 row survives); no field of `MetaTrial` scores improver prose. FAKE model throughout; a real-provider campaign is BLOCKED until credentials exist.

## Evidence to report

Commands and exit codes; the I0 and I1 hashes with the freeze timestamp preceding the incident draw; the eight-incident table with produced-worker results, noise and no-data rows; amortized cost; the explicit statement of gain, tie or loss with sample-size caveat.

## Guards

Never score the improver's explanation; never let inherited worker improvements masquerade as a better optimizer; never claim model-weight improvement or indefinite acceleration; a growing archive or regression suite alone is not improved improvement.
