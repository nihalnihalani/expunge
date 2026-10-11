# RSI requirements for the Expunge Claude Code prompt

Prepared 11 October 2026. Fact gathering only: no application code, installation, service action, Git action or implementation was performed in this lane.

## Verification result

The four newer load-bearing references in the previous report resolve to the expected titles on direct arXiv pages. Firecrawl canonical metadata was freshly inspected for FreeEvolve and Self-Healing Harness, and RRSI body passages were freshly retrieved. Direct manuscript reading independently verifies the relevant FreeEvolve, Self-Healing Harness and Phantom Guardrails mechanisms. These are paper-reported results, not reproduced experiments or production guarantees.

There is a source-version discrepancy: the directly retrieved RRSI abstract page identifies v3, revised 4 October 2026; the old report says 6 October. Its abstract and indexed body also expose different maximum-score wording. FreeEvolve's Firecrawl metadata reports an 8 October update, while its retrieved HTML identifies v1 from 6 October. Therefore pin a source version or hash and use the mechanism, rather than copying headline results into Expunge's claims.

## Primary sources and exact claim locations

| Source | Verified claim and location | Confidence and limit |
|---|---|---|
| [FreeEvolve](https://arxiv.org/html/2610.09197#S4.SS3) | Section 4.3 uses the same fresh worker and resource budget for seed, no-data rewrite and meta-evolved skills, with no inherited workers or campaign artifacts. Section 3.3 scores skills through workers and traces produced by complete campaigns. Appendix F distinguishes worker plays from meta-level evolution trajectories. | High for the retrieved method. The numerical gains are external benchmark results. Equal budgets are necessary, not sufficient to establish Expunge gains. |
| [Self-Healing Harness](https://arxiv.org/html/2609.24130) | “Validate: Evidence-Gated Self-Modification” gives provisional trial authority followed by outside persistence control; trigger improvement and protected-case non-regression are separate predicates. Results and Limitations explain sparse protected coverage and degradation of accumulated rules. | High for the retrieved method. At most two protected cases were sampled per round; its own authors do not guarantee unobserved safety or absence of regressions. |
| [RRSI](https://arxiv.org/abs/2609.24972v3) | Abstract: edit-budget regularization plus critic screening of benchmark-specific proposals and pruning of unnecessarily expensive/unhelpful changes. Indexed body Sections 1, 4.1–4.3 explains benchmark-specific fitting, noise chasing, complexity accumulation and evolve/held-out separation. | High for mechanisms, qualified on revision-sensitive metrics. Body and abstract numbers should not be blended. |
| [Phantom Guardrails](https://arxiv.org/html/2607.13083#S4.SS5) | Section 4.5 shows that strict improvement alone can admit a no-op guard inside a useful batch; per-edit warrant-aware acceptance excludes the fabricated guard in the deterministic lab. Section 5 and Appendix B warn that an incorrect payoff ledger can remove real fixes. | High for the narrow lab finding. This motivates evidence for each edit; it supplies no general-purpose safety theorem. |
| [VeRO](https://arxiv.org/html/2602.22480#S3.SS2) | Section 3.2 specifies versioning, enforced evaluation budget, permissions, reproducible execution, structured traces and a standardized observation interface. Section 3.1 keeps model checkpoints and access restrictions controlled. | High for method. Direct arXiv abstract identifies ICML 2026 acceptance. |
| [STOP](https://arxiv.org/abs/2310.02304) | Abstract and cached manuscript Introduction/Figure 3: improve a program improver with itself, measuring downstream program utility while leaving the LM unchanged. | Canonical title verified; previous body cache consulted. Restricted scaffold/code RSI, not model-weight improvement. |
| [ADAS](https://arxiv.org/abs/2408.08435) | Abstract: a meta-agent writes agentic systems as code, evaluates them and retains an archive for future proposals. | Canonical abstract verified. Useful precedent for agent-as-code design; archive growth itself is not evidence that the improver improved. |
| [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) | Abstract: an archive of self-modified agents supports open-ended exploration with empirical benchmark evaluation. | Canonical abstract verified. A lineage tree alone does not demonstrate higher optimization efficiency. |
| [Reflexion](https://arxiv.org/abs/2303.11366) | Abstract: agents use verbal reflection and episodic memory to improve behavior without updating weights. | Canonical abstract verified. A reflection note is weaker evidence than an executed, admitted harness change. |

Fresh Firecrawl citation expansion from STOP/ADAS/DGM found VeRO as the strongest additional neighbor. Unrelated artistic, policy and weight-training results were excluded from this domain design.

## Prompt-ready engineering requirements

### Editable surfaces and fixed boundaries

Implement four independently typed and executable harness surfaces: context construction, workflow/control graph, guardrails and tool-access policy. Demonstrate at least one actually executed mutation of each across recorded generations; displaying JSON or instructions is insufficient.

Use a trusted compiler with a bounded workflow AST, admitted field/tool IDs, finite loops/retries and typed arguments. Bind canonical artifact bytes to compiler, runtime adapter, vocabulary, owner authority ceiling and admission-policy hashes. Independently derive permission deltas instead of trusting the candidate's description. Each edit must cite authentic evidence and have a separately tested or otherwise attributable benefit. Reject no-op baggage bundled with a beneficial edit.

Keep the evaluator, reference solver, private manifests, owner authority, resource limits, service credentials, deployment authority and terminal-status authority outside the editable surfaces. Candidate discovery/context/critic source plugins execute in the OpenBot sandbox with a typed broker; never dynamically import them into privileged gateway, grader or promoter processes. Store source, compiled artifact, ABI and sandbox-policy hashes.

Support branching, comparison, critic/pruner selection, backtracking and bounded adaptive evaluation scheduling inside trusted campaign caps. Retain losing candidates and actual reasons. Retest the accumulated active harness, because individually useful rules may interact poorly.

### Experiments and genuine second-order improvement

Freeze worker W0, seed improver I0, candidate I1, provider/model settings, generator/reference/grader hashes, split commitments, fault definitions, admission thresholds and budgets before comparison. The worker model and the improver model may differ, but both identities/configurations remain fixed within their respective experimental arms.

For each new incident, launch I0 and I1 from the identical W0 artifact and independently reset world state, memory, lesson eligibility and campaign outputs. Give them the same permitted incident evidence, proposal ceiling, token/evaluation/wall-time budget and provider configuration. Carry no evolved worker, private answer or previous campaign artifact into either arm. Grade the workers they produce on further withheld structural worlds.

Include I0/I0 noise comparisons and a no-data rewrite control. Score the produced worker's usefulness, preservation, truthful completion and total improvement cost, rather than the improver's explanation. Freeze I1 before revealing these new incidents. Report null, negative or inconclusive meta results honestly; fully implementing the meta feature does not require inventing a positive gain.

For the task-agent comparison use initial, independently authored expert-static, evolved, score-only and wrong-incident conditions. Keep primitive tools, world seeds, worker model and resource budgets comparable. The score-only arm receives the permitted score but no incident trace content; wrong-incident receives an unrelated trace under the same evidence budget. Log the actual remote Raindrop evidence selected in each condition. The initial harness should have a documented realistic incomplete strategy, with functioning primitive tools and legitimate successes.

Separate development/train, protected regression, gate-validation and final test partitions. Commit split identities before evolution; hold out relationship structure and compositions, not only identifiers. Final results must not feed another tuned claim in the same campaign. When tuning after final exposure, start a new campaign with new held-out data.

The existing fullscope planned configuration is 24 final worlds × three repeats × five conditions = 360 episodes; meta uses eight new incidents and each produced worker is tested on three further worlds × two repeats. These are planned counts. Implement batch/resume scheduling and disclose actual completions, timeouts and failures; do not fabricate missing rows or quietly replace the full protocol with a smaller demonstration.

### Hider and independent truth

Hider outputs a bounded WorldSpec, not an editable scorer or target manifest. A fixed generator produces visible domain data and private expected outcomes. A fixed independent reference solver must solve the proposed layout within resource bounds before admission. Challenge novelty concerns relationships, nesting, eligibility and failure composition, rather than random identifiers. Impossible, malformed, too-large and duplicate proposals remain quarantined with reasons.

Worker tools, proposer evidence, error messages, telemetry and UI must not expose private expected target IDs, poststates or withholding assignments. Add hidden-data canaries and test both access denial and absence of answer-bearing side channels. Grader integrity is independently tested with deliberately incorrect final states, rather than only comparing a generator with its own expected output.

Task success requires correct eligible effects, preservation of unrelated/retained content and truthful terminal status. Blanket deletion fails preservation; blanket refusal fails useful completion. Operational coverage receipts remain explicitly scoped/as-of revision and never silently claim hidden or universal coverage.

### Testing requirements

1. Compiler: invalid graph/cycle/retry bounds, unknown field/tool IDs, argument injection, authority widening, subject/task literal shortcuts, unsupported ABI, source hash mismatch and immutable artifact semantics.
2. Evaluator: known missed target, namesake corruption, retained-record corruption, wrong cleanup effect, fabricated success, stale receipt and impossible-world rejection.
3. Causality: remove or substitute incident trace; verify observation-arm separation, incident references and evidence eligibility in the proposed artifact.
4. Meta reset: assert exact W0 equality and isolated world/memory/campaign state before I0/I1; test budget exhaustion and prevent inherited worker artifacts.
5. Hider: prove reference solvability, structural novelty calculation, fixed caps, hidden manifest isolation and quarantine of unsafe proposals.
6. Sandbox: deny hidden grader/control/metadata/network access and privileged imports; allow bounded authenticated artifact/broker access; test resource exhaustion and cleanup.
7. Admission: trigger repair with protected regression, no-op edit in useful batch, repeated noise winner, source retraction and accumulated-harness interaction.
8. Reporting: distinguish historical decision replay, fresh execution, deterministic protocol tests, live provider tests and unexecuted plans; preserve raw failed trials.
9. Cost: enforce model/tool/evaluation/token/wall caps outside model self-report, include worker/observer/improver/grader costs and failed calls, disclose unknown pricing, cache policy and amortization denominator.

## Artifacts and collection limits

Fresh files: .firecrawl/prompt-rsi-freeevolve-inspect.json, prompt-rsi-selfhealing-inspect.json, prompt-rsi-rrsi-read.json, prompt-rsi-related.json, prompt-rsi-direct-primary-pages.json. Consulted local research/fresh-rsi-literature.md, EXPUNGE-IMPLEMENTATION-BLUEPRINT.md and docs/expunge/ACCEPTANCE.md.

No external experiment was reproduced. Production engineering checks establish defined operational properties; finite synthetic trials do not establish complete erasure over every real company dataset or universal safe recursive improvement.

