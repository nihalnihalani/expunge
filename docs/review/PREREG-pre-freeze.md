# PREREGISTRATION pre-freeze review

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11, about 16:05Z. Read: `PREREGISTRATION.md` (99 lines, working tree), `docs/expunge/ACCEPTANCE.md` ("Scientific protocol"), and `packages/meta-evolution/src/campaign.ts` (`summarizeMeta`, `signTestP`, the arm wiring). No campaign data exists, so this is a review of the protocol only.

## REQUIRED before the freeze (ordered by impact)

**R1. The meta unit of analysis contradicts ACCEPTANCE, and the test pseudo-replicates (DEMONSTRATED static).**
- ACCEPTANCE says "Treat the incident/produced-worker pair as the unit".
- The PREREGISTRATION and `summarizeMeta` instead count wins and losses per paired RUN, summed over incidents: 8 incidents x 3 worlds x 2 repeats = 48 run pairs (campaign.ts:162-169,254-264). The sign test is then run on those runs.
- Runs within one incident share one produced-worker pair, and the repeats share a world, so they are not independent. The p-value is anti-conservative.
- *Change:* the unit is the incident. Each incident's sign is the sign of that incident's net over its 6 run pairs; ties (net 0) are dropped. The exact sign test runs on those incident signs.
- *Consequence to disclose:* with n = 8, two-sided p < .05 needs 8-0, or 7-0 with one tie (p = .0078 and .0156); 7-1 gives p = .070. GAIN therefore needs a near-unanimous effect, and TIE is the expected verdict for anything smaller. The protocol must say so in advance.

**R2. The noise bar is on the wrong scale (DEMONSTRATED static).**
- `noiseMaxAbsNet` is the largest PER-INCIDENT |net| among the I0-vs-I0 rows, at most 6.
- It is compared with the main `net`, which is SUMMED over all 8 incidents, up to 48 (campaign.ts:269-276). A summed I1 gain can therefore clear a per-incident noise bar that never measured the variation in a sum, so the noise control barely constrains anything.
- *Change:* compare like with like. Either compare the summed I0-vs-I0 net over the same 8 incidents with the summed main net, or, under R1, compare the incident-sign counts of I0-vs-I0 with those of I1-vs-I0.
- (Checked and fine: the no-data control's orientation. `i0_vs_no_data` puts the no-data worker on the "second" side, so `net > noDataNet` means I1 beats I0 by more than no-data beats I0.)

**R3. Incident and world selection must be committed before I1 is frozen.**
- "8 new incidents" and "3 further worlds" per produced worker have no stated selection procedure. Choosing incidents or worlds after I1 exists is the easiest way to game the meta result.
- *Change:* commit a seeded generation procedure, the seeds or their commitments, and the families. Do this before I1 is produced, the same way the split plan is committed.

**R4. Define per-world success and "tie" for the primary analysis.**
- "Paired per-world success" on 24 worlds x 3 repeats leaves open how the 3 repeats become a world result (all, majority, or count) and what counts as a tie. That flexibility is enough to move the result.
- *Change:* declare that per-world success is the success count out of 3; the paired difference is evolved minus expert-static per world; the test is an exact sign test on worlds with a non-zero difference; ties are dropped and reported.
- *Disclose:* n = 24 worlds. With, say, 10 discordant worlds, two-sided p < .05 needs at least 9-1.

**R5. Declare confirmatory versus descriptive contrasts (multiplicity).**
- There are 5 conditions. Only evolved versus expert-static is named primary. The causal claim that trace information caused the gain needs evolved versus score-only and versus wrong-incident.
- *Change:* either name those two as secondary-confirmatory, with Holm correction across the three contrasts, or state that they are descriptive and support no causal claim. Initial versus evolved is descriptive.

**R6. Freeze the rule that picks the evolved version for the final test.**
- "Scored after the frozen version is chosen" does not say HOW it is chosen. Evolution can promote several candidates per arm under 3 attempts per parent.
- *Change:* a predeclared rule, for example "the last promoted bundle of each evidence arm at budget exhaustion". The rule must not use any final-split information, and the selection basis (`in_sample_only` or validation-gated) must be recorded in the gate report (see PKT-47/51 RH-3).

**R7. The dollar ceiling must be a formula, set on probe-only worlds.**
- "Measured ceiling set after baseline probes" lets someone see each baseline's cost and then place the ceiling where it helps or hurts an arm.
- *Change:* predeclare the formula (for example k x the maximum per-episode cost across both baselines' probes, with k fixed now). Run the probes on a probe-only split that is never used by the gate or the final test. Apply the ceiling identically to every arm.

**R8. Fill the missing freeze items.**
- Provider and exact model ID per arm, for the worker and the improver.
- An explicit sampling policy: temperature, top-p, max output tokens, and a seed if the provider supports one. "Default sampling" is not a policy, because provider defaults change.
- The provider-error policy (see R9).
- The minted master seed and the split commitment, which are still TBD; also custody of the campaign HMAC keys.
- The evaluator hash (now including the indexed solver), the generator, compiler, vocabulary and runtime-adapter hashes, and the W0, expert-static and I0 bundle hashes.
- The per-improver token budget as a NUMBER. "Equal token budget" has no value yet.
- The fault plans. P2-1 is still open: faults are not injected on the real path. So `partial_retry` cannot be part of a frozen protocol until the fault layer lands, or it must be declared fault-free.

**R9. Predeclare how infrastructure failures are handled.**
- "Failed runs count as non-successes" is right for model failures. A provider 5xx, a rate-limit timeout or a Mongo outage that hits one arm of a pair is noise that can bias the comparison.
- *Change:* define infrastructure failures (by failure code), and say whether such a pair is re-run once under its own campaign record or kept as a failure in both arms. Report the counts either way.

**R10. Resolve the A-1 open risk before any gate run, not only before the final test.**
- The measured token and wall-time profile per baseline must run on probe worlds, before any gate or final episode.
- If a cap binds, the amendment that raises it is recorded before the first gate run. Otherwise gate results under different caps are not comparable with the final test.

## LIKELY weaknesses to disclose (no change required)

- **D1.** n = 8 incidents and n = 24 worlds can detect only large effects. TIE is the most likely verdict, and it must be reported as "underpowered", not "no effect".
- **D2.** Evolution selects on gate (validation) outcomes over up to 3 attempts per parent per arm. Promoted versions are optimistically biased on validation, which is why the final split exists. State it.
- **D3.** The worker model is fixed, but provider-side model updates during a 12-hour campaign could shift both arms. Record the provider's returned model-version string on every episode and flag drift.
- **D4.** The FAKE rehearsal and the test reports were produced under pre-freeze bytes. Nothing from them may be cited as a result. The A-1 notes already say so; repeat it in the final report.
- **D5.** Expert-static is authored by this team and is the primary comparator. Disclose that the same team built both.
- **D6.** `partial_retry` and the fault families may be fault-free in the real path if P2-1 is not fixed before the freeze. If so, disclose that family's results as structural-only.
