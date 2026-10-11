# RETHINK: build Expunge, not CaseLaw v3

**For:** the 4-person team entering the Harness Engineering & Model Wrangling #SFTechWeek Hackathon (Cerebral Valley + MongoDB, Shack15 SF, Sunday Oct 11 2026). Targets: Problem Statement 1 "Recursive Harnessing", the $3,000 Raindrop RSI prize, and the best overall placement.
**Role:** final synthesizer of the rethink round. This file closes the round.
**Written:** Sun Oct 11 2026, about 00:30 PDT (13:00 IST). It comes after:
- the five rethink ideas;
- the six round-2 judge scorecards (12:20–12:28 IST);
- the three round-2 closings (12:34–12:36 IST);
- the six final ballots.

**Supersedes:**
- the ranking in `REEVALUATION.md` (CaseLaw v3 1st, Lethe 2nd, Kintsugi v3 3rd and RSI pick);
- the *scope* of `BLUEPRINT.md`.

Every domain-independent correctness fix in `BLUEPRINT.md` carries over (§6).

**Clock note.** It is 00:18 PDT on event day. Doors open 09:00 PDT and the build window is 10:30–17:00 PDT (`research/notes/00-participant-guide.md`; the CV listing says 9 AM–10 PM PDT, per `HACKATHON-RECOMMENDATION.md`). The "prep day" is therefore the time before doors. §8 is ordered so that the most important items finish first.

**Labels.**
- **[V]**: verified in a cited corpus file.
- **[V-today]**: I checked the primary source in this pass (source given).
- **[J-today]**: one of our role-played judges checked the primary source today (file cited).
- **[R-today]**: I read the paper body in this pass.
- **[A-today]**: I checked the abstract or metadata in this pass.
- **[SC]**: body spot-checked in `LITERATURE-REVIEW-RSI.md`.
- **[I]**: my judgement.
- **[CALC]**: arithmetic.
- **[U]**: unverified and load-bearing. Each [U] has a probe and a labelled fallback.

**Source types:**
- **PR**: peer-reviewed.
- **PP**: arXiv preprint. Almost every 2026 paper here is one.
- **VB**: vendor docs, blog or post.

**Read this caveat first.** Every judge in this file is **role-played**, and every score comes from those role-plays. None of it is the real panel, and none of it predicts placement. `HACKATHON-RECOMMENDATION.md`, written by a separate pass at 12:35 IST, makes the same point. That pass also lands on Expunge, independently. All demo numbers below are targets or placeholders, never results.

Path shorthand (all relative to the repo root):

| Shorthand | Path |
|---|---|
| `FUS` | `research/rethink/T-idea-fusion.md` (Expunge v2, 10:59) |
| `CL4` | `research/rethink/T-idea-caselaw-v4.md` |
| `SPT` | `research/rethink/T-idea-raindrop-winner-pattern.md` |
| `C-FUS`, `C-CL4`, `C-SPT` | `research/rethink/T-closing-{fusion, caselaw-v4, raindrop-winner-pattern}.md` |
| `J-JAC`, `J-STE`, `J-BOS`, `J-ARA`, `J-CVV`, `J-RSI` | `research/rethink/T-judge-{jackson-raindrop, steffan-mongodb, bosco-aws, aram-modelence, cv-veteran, rsi-researcher}.md` |
| `LR` | `research/literature/LITERATURE-REVIEW-RSI.md` |
| `RW` | `research/raindrop-winners/RAINDROP-HACKATHON-WINNERS.md` |
| `BP`, `REEVAL` | `BLUEPRINT.md`, `REEVALUATION.md` |
| `A3` | `research/debate/A3-why-they-won-synthesis.md` |

---

## 1. TL;DR

### 1.1 The decision

**Build Expunge.** The recommendation changed from CaseLaw v3.

The build spec is **Expunge v3**, which stacks three layers:
1. the v2 idea file (`FUS`);
2. every fix in its 12:34 closing (`C-FUS`);
3. the nine changes in §1.3 below.

**Expunge in one sentence.** The judge types their name, and Expunge hides them across a company's Atlas database the way real companies store people. A cheap agent must then erase every copy lawfully. When it fails, Raindrop hears what the agent *told* the person. The harness then writes itself **one typed law**, which is enacted only if all four hold:
1. it survives an as-of replay of every erasure the system ever certified;
2. it beats its parent on 8 fresh strangers;
3. a placebo improver, given the same incident with Raindrop's words removed, does not explain it away;
4. Atlas accepts it from the improver's insert-only credentials.

**The hero law** is one edge: `REQUIRE_TOKEN reply_to_requester ← commit_erasure.verified`. The agent may not answer until the database issues a clean receipt, and the answer is *rendered from* that receipt.

**Thesis:** "It keeps the lesson and erases the person."
**Heal line:** "The agent doesn't get to say 'done' anymore; the database does."

### 1.2 Why it changed from CaseLaw v3

There are five reasons, in order of weight.

1. **The panel moved decisively.**
   - Expunge is first by composite (9.23), first in round 1 (9.28) and first in the finals (9.23).
   - It wins the Borda count 17–12–7.
   - It is first on 5 of 6 ballots and the RSI pick on 5 of 6.
   - CaseLaw v3 fell to **6th of 8** (composite 7.90). Every ballot ranks it below both CaseLaw v4 and Expunge.
   - Within the CaseLaw line, v4 strictly dominates v3 (`J-JAC` §4.8; `J-RSI` §5.7; `J-ARA` §3.6) [CALC from the score table, §4].
2. **The literature commoditized CaseLaw's headline.**
   - "Self-evolving guardrails" now has at least 12 preprints in 2026.
   - "Self-healing harness" names a paper from Sep 21 2026 (arXiv:2609.24130, PP).
   - Stateful policies ship in AWS Dogwood.
   - Every CaseLaw primitive has prior art (`LR` §7.0–7.1).
   - NYC's expert cut took **0 of 6** guardrail-evolution entries (`A3` L32, suggestive only, p ≈ 0.14).
   - CaseLaw v3's novelty mean is 5.58, the second lowest in the slate.
3. **CaseLaw v3 fails the Raindrop information test on its hero path.**
   - Its RSI fit is 6.58.
   - Raindrop is absent for its first 1:57 (`J-JAC` §4.8).
   - The judge signs the digest of a predicate they cannot parse.
4. **Expunge keeps CaseLaw's engine.** That includes:
   - the as-of precedent sweep;
   - Class T (tighten) as free, Class N (loosen) as signed;
   - LOOSENING DETECTED → VOID;
   - CAS promotion;
   - CaseLaw v4's signed flip set.

   It moves that engine into Lethe's domain, which is the least crowded area in the literature (`LR` §7.2), and uses Kintsugi's topology heal. So the governance work behind `BP` is re-homed, not discarded.
5. **The placement case and the prize case point at the same project** (`J-CVV` final vote).
   - The $18k "across the three final teams" arithmetic suggests the prize is podium-gated [V arithmetic, I meaning; `RW` changelog item 5].
   - If so, the project that places is the one that can win the prize.

**Not chosen:**
- **CaseLaw v4** is a close 2nd: 0.31 composite behind, and it leads Technical Demo by 0.08.
  - It has the cleanest Monday deployment and the best-powered meta test, so we graft both.
  - But Raindrop is optional on its hero path by its own unplug answer (`CL4` L465). It sits in the cluster NYC skipped, and its best mechanisms are already inside Expunge.
- **Spotter** has the slate's best causal control, which we graft as the placebo.
  - But its graduated knowledge is about 14 team-written prose rules (`SPT` L862).
  - PILOT (arXiv:2608.26530, PP) already couples live steering with persistent self-evolution [J-today, body].
  - Atlas is off its stage.

**No pivot on the day.** Every fallback is a labelled path inside Expunge (§5.9).

### 1.3 What this file adds to Expunge v2 and its closing

`C-FUS` already adopted these fixes:
1. `collMod` removed from every runtime principal;
2. the same-incident, span-redacted placebo twin (Sh);
3. the ledger-only arm;
4. generic `<tool>.verified` receipts;
5. "not measured" as the L2-S fallback;
6. the Hider, L2-I and Agent Engine taken off the build path.

The nine changes below are new in this file.

| # | Change | Why |
|---|---|---|
| **X1** | **The hero law's first evidence is a "words-only" production event.** On that event the certificate graded the erasure COMPLETE and the receipt was clean, yet the agent said "permanently deleted" about the tax invoice it had lawfully restricted. The law is still decided by the deterministic D6 gate | Jackson's prize-loss condition has two parts: "the redacted twin writes the same edge **and** the ledger-only arm shows zero Raindrop premium" (`J-JAC` §6; his final vote). On this incident the ledger has nothing to see, so Raindrop's marginal premium comes from information, not from construction |
| **X2** | **Fix the L2-S labelling bug** (`FUS` L314). The current rule labels "assertion ∧ COMPLETE" as NEGATIVE. That trains Raindrop's classifier to ignore the very class only Raindrop can see. New rule: POSITIVE iff the reply asserts an action or completeness the receipt does not record | Without the fix, "the court trains the sensor" trains it backwards on the restricted-invoice case `C-FUS` itself cites |
| **X3** | **Restore an improver test, in prequential form.** Graft CaseLaw v4's §6.1 clerk test onto Expunge's improver, keep the dense Brier co-primary, and run it off stage only after the first real ENACTED | The one dissenting prize vote (RSI researcher) flips back to Expunge on exactly this graft. It also addresses the literature's open gap #2. Cost is about 288 improver calls |
| **X4** | **Add an a-priori arm (X5) beside the blind expert (R4).** The same improver gets tool docs only, with no incident | It prices "any engineer would add the receipt edge" directly. Published receipt-gated completion (§2.2) makes this question certain |
| **X5** | **Add a false-hold column**: replies withheld on erasures the certificate graded COMPLETE | A terminal verifier also withholds correct answers: 16 of 92 in τ²-bench Retail (arXiv:2609.20474, PP) [R-today] |
| **X6** | **Cite receipt-gated completion before a judge does:** ECT 2608.23623, Proof-or-Stop 2607.14890, Verify-Gated Completion 2605.17998, No Trace No Claim 2610.09286, and 2609.20474. Add RCV 2608.14089 beside VeriFine for L2-S | None of the three finalists cites them (`J-RSI` final vote) [A-today] |
| **X7** | **M0 hard limits in the spec:** `STAGES()` stays within 50 aggregation stages; in-memory sort ≤ 32 MB; custom roles take up to 30 s to deploy; `maxTimeMS` is set explicitly on the MCP instances | [V-today: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/]. `maxTimeMS` is not set by default (`J-ARA` P6) |
| **X8** | **Placebo rehearsal rule.** If the Sh twin passes in ≥2 of 5 rehearsals, its lamp leaves round 1. The Raindrop line then becomes "our certificate graded it complete; only Raindrop heard the lie" | `J-CVV` final vote. GENERIC on stage costs a concept and buys nothing |
| **X9** | **Optional: the D-family is drawn by beacon.** drand picks which of three D-families the judge's subject gets. All three must be ones the 13:05 parent misses ≥80% of the time. Shown as a silent chip | It makes the before-run structural rather than rate-based (`J-ARA` §4 item 4). drand answered in under 1 s from home (`J-ARA` P5); venue latency is [U] |

### 1.4 RSI-prize strategy in eight lines

1. **Raindrop must be necessary by information, not by design** (X1). Line: "Our certificate checks what is *true*. It never reads what the agent *said*. Raindrop does."
2. **Measure Raindrop rather than assert it.** Run three arms per incident: real evidence, Sh (span redacted) and ledger-only. Print "content premium" and "Raindrop's marginal premium" with n. A GENERIC line is pre-written.
3. **Run the one second loop that improves Raindrop's own product.**
   - "The court trains the sensor": certificate- and receipt-labelled `refine_signal` batches.
   - Measured on frozen held-out transcripts **re-emitted as new events** after each epoch, because a refined signal "carr[ies] over to new events" [V-today: https://raindrop.ai/docs/platform/signals.md].
   - Said only with n and a CI; otherwise "not measured".
4. **Test the improver honestly** (X3): the prequential improver test with Brier. HOLD is pre-registered.
5. **Put Raindrop where a Raindrop person looks:**
   - 5 s of Raindrop's own UI in round 1, with our verdict written back on the event;
   - the improver and its twins traced in an `expunge-improver` project;
   - the Deletions API inside the product;
   - approver `edit` signals in the finals.
6. **Cite before Jackson asks.** VeriFine and RCV for the sensor loop; ECT and No Trace No Claim for receipts; PILOT if anyone says "coach".
7. **At 10:30, ask CV staff and Jackson:**
   - Is the prize podium-gated?
   - What are the criteria?
   - Do hosted Signals, `refine_signal` and Deletions count?
8. **Word it exactly.** Say "Raindrop's agent redrafted its classifier from our certificate labels." Never say "we retrained Raindrop's model", "Raindrop detected", "first" or "ignition".

---

## 2. What the literature changed

### 2.1 Novelty verdict per idea

Column 2 is the six-judge mean for "novelty vs literature", from the score table. Verdicts combine `LR` §7, the judges' paper checks and this pass's checks.

| Idea | Novelty (mean) | Verdict | Closest prior art | What survives as the claim |
|---|---|---|---|---|
| **Expunge** (fusion) | **8.17** | **Integration claim, defensible.** The domain artifact and receipt-gated completion are both published, so claim neither | `SlateGitOrg/erasure` (planted copies, recall, certificate; no harness, no self-improvement) [V, `FUS` §4.1]. Receipt-gated completion: ECT, Proof-or-Stop, Verify-Gated Completion, No Trace No Claim [A-today]. Sensor co-evolution: VeriFine 2610.08761, RCV 2608.14089 [A-today]. Precedent replay: Self-Healing Harness 2609.24130 [SC] | **(a)** a self-improving loop that **learns** to take the completion claim away from the model, from production words, under a placebo; **(b)** a deployed third-party classifier redrafted from a deterministic oracle's certificates ("no hit retrains a deployed third-party monitoring classifier from a deterministic oracle's labels", `J-JAC` §2 row 4; `J-RSI` §3); **(c)** a learning loop whose artifacts cannot hold a person, enforced at insert |
| DROSTE | 8.25 (highest) | Strongest pure-RSI novelty. The ruler won't rise today | FreeEvolve, Escher-Loop, STOP, OEO 2608.09629 (uncited by DROSTE; `J-RSI` §3) | Self-applied `improve()` scored by fresh apprentices on post-cutoff CBP rulings. But CROSS's newest ruling is Oct 2, so it will append ~0 rulings today (`J-ARA` P4). It is also underpowered: B = 2, and the best p is 0.0625 (`J-RSI` §2.2) |
| Spotter | 7.58 | Narrowed by uncited neighbours | PILOT 2608.26530 [J-today, body], TRACE 2606.13174, VoS 2610.09115, Harness Annealing 2610.01235 | Sham-gated admission into authority-monotone structure, plus retiring the coach |
| CaseLaw v4 | 7.42 | Integration in a crowded cluster | Guarded Commits 2610.00037; GCP Policy Simulator (flip-set display); Contract2Tool, RACG; Subjects Not Authors 2609.30614 (`CL4` §1.2) | The prequential law-writer test ("not found": StepLearn 2609.35911 is first-order) and signing cases rather than code |
| Lethe | 7.33 | Least crowded area, but superseded | MemoHarness, RHI, Data Flow Control (`LR` §7.2) | Absorbed into Expunge |
| TrollBooth | 6.92 | Creative, but prior art uncited | Gandalf 2501.07927; HASTE 2610.02920; Build-it-Break-it-Fix-it (`J-RSI` §5.6) | Crowd adversaries driving same-day tool-harness evolution |
| CaseLaw v3 | 5.58 | Every primitive in print | AIR, SHE, Sapien, Dogwood, Styra, IAM `CheckNoNewAccess`, Progent, Self-Healing (`LR` §7.1) | Dominated by v4 |
| Kintsugi v3 | 4.50 | Published near-twin | Self-Healing Harness 2609.24130 ("almost a published blueprint", `LR` §7.3) | Absorbed into Expunge (the topology heal) |

### 2.2 The finding that matters most for Expunge: receipt-gated completion is already published

Four preprints already gate an agent's "done" on verifiable evidence, as a hand-designed pattern. A fifth measures what such gating costs. **None of them learns the gate from production evidence.**

| Paper (all PP) | Result | Status |
|---|---|---|
| **ECT**, "When May an Agent Stop?" `2608.23623` | COMPLETE is allowed only with a typed certificate binding every claim to in-scope trace evidence, plus deterministic replay. Unsafe completions: **0/288 vs 252/288** for a termination-critic core | [A-today] |
| **Proof-or-Stop** `2607.14890` | Lifecycle transitions, including DONE, are allowed only on fresh, mechanically verifiable evidence. **Zero false-DONE in 10/10** scenarios; amplification fell from 31/1,800 to 2/1,800 cells | [A-today] |
| **No Trace, No Claim** `2610.09286` (Oct 7 2026; **database agents**) | A plan contract plus an evidence contract. Unsupported gated claims went from **21 of 220** answers to **0 of 199** emitted, at the cost of 21 fewer answers | [A-today] |
| **Verify-Gated Completion** `2605.17998` | Agents propose completion; a read-only verifier admits it; ambiguity fails closed | [A-today via `J-RSI` scratch, `qc_receipt.txt`] |
| **How Do Agent Harnesses Create Value?** `2609.20474` | In τ²-bench Retail, a terminal verifier rejected **83 of 137** oracle-invalid episodes and withheld **16 of 92** correct ones, cutting false passes from **57.21% to 20.96%**. Separately, task plans beat a **word-count-matched shuffled sham** by +7.17 pp (90% CI 1.15–13.36) | **[R-today]** |

**Consequences** [I]:
1. **Never say the receipt rule is new.** Say: "Receipt-gated completion is known to work. Our harness wasn't given it. It learned it from what Raindrop heard on production, against a placebo, and it was one of about 40 edges the vocabulary allowed."
2. **GENERIC is the likely tag for the hero edge.**
   - The RSI researcher predicts the Sh twin will write the same edge from the family name alone (`J-RSI` L200; final vote).
   - PoPE's content-ablated placebo *beat* live content: Sh 12 vs On 10, verdict "mechanism-null", on 0.5–1.5B code models (2607.12962, PP) [J-today, body; I read the extract in `scratchpad/rsijudge-final/pope.txt`].
   - So X1 is essential. If the edge is GENERIC with respect to the span, Raindrop must still be the only thing that *opened* the incident.
3. **Report false holds (X5).** The 17% withholding rate in 2609.20474 is the cost a sharp judge will ask about.

### 2.3 Prior art to cite on stage and in Q&A

The stage has room for exactly **one sentence of prior art** (§5.6, 1:16). The rest goes on one Q&A slide and in the README "Related work".

**Q&A slide (five rows; each delta is one line):**

| # | They did | We add |
|---|---|---|
| 1 | **Self-Healing Harness** `2609.24130`: Detect → Heal → Validate; ≤2 protected cases per round [SC] | An exhaustive as-of replay of every past ruling; a signed flip set for any loosening; a genome with no prose |
| 2 | **ECT / Proof-or-Stop / No Trace No Claim**: hand-designed receipt-gated "done" | The harness *learned* the edge from production words. Its provenance is printed (`seeded 0 · discovered n · generic g`), and an a-priori arm prices "obvious" |
| 3 | **FIRE** `2609.26048` (+25.0 pp vs a timing-matched sham, p = 0.061) [`FUS` R-today]; **PoPE** `2607.12962` | A placebo for a **persistent law's** content, reported per incident as a premium |
| 4 | **VeriFine** `2610.08761` (in-harness judge co-evolution); **RCV** `2608.14089` (adapts a deployed safety classifier *without* retraining; catches up to 0.81 of previously missed unsafe content) [A-today] | A deployed vendor classifier redrafted from a deterministic oracle's certificates the improver cannot touch |
| 5 | **Earned Authority** `2607.23586`; **Progent** `2504.11703`; **Guarded Commits** `2610.00037` | Authority widens only through a person signing the replay-derived flip set, re-derived in the commit and consumed once |

**Cite as validation (Q&A one-liners, all [SC] in `LR` §7.7 unless marked):**
- Phantom Guardrails `2607.13083`: 11/60 phantoms → 0/60 under warrant-aware acceptance.
- SAGE `2609.36043`: regressions 42.8% → 0%.
- Containment Floor `2610.06274`: 25/72 protected writes without enforcement.
- Stale scores `2610.01073`: 22/48 → 0/48.
- **Winner's Curse** `2610.09239`: with 16 selection items, greedy loops overstated held-out accuracy by 13–20 points [A-today]. This is why every gate draws fresh strangers.
- False Success `2606.09863`: false success is 44–52% of failures; LLM judges stay ≤ 0.65 AUROC [`FUS` body-read].

**Domain prior art** (README only):
- `SlateGitOrg/erasure`;
- C-Trace `2606.19242`;
- Forgotten@Scale `1910.13784`;
- the Sep–Oct 2026 erasure repos (`FUS` §4.1).

**Peer-reviewed anchors** (say "peer-reviewed" only for these):
- Meta-Harness `2603.28052` (COLM 2026);
- Who&When `2505.00212` (ICML 2025);
- GEPA (ICLR 2026);
- ADAS (ICLR 2025), STOP (COLM 2024);
- Cedar (OOPSLA 2024);
- Case Law Grounding (ACM CI 2025);
- Shumailov et al. (*Nature* 2024);
- reusable holdout (*Science* 2015).

### 2.4 Mechanisms to adopt (literature → Expunge)

| Mechanism | Source | In Expunge v3 | Status |
|---|---|---|---|
| Warrant-aware "must bite" admission | Phantom Guardrails [SC] | Standing check; `cites[]` resolve; `rd_` spans verified against `GET /v1/events/{id}` | In `FUS` §7 step 6 |
| Per-item paired gate, protected suite, corpus re-test | SAGE, Self-Healing RQ4 [SC] | k = 8 strangers, ≥6–0, exact McNemar p ≤ 0.031; whole-genome re-test after every promotion | In `FUS` §7 steps 8, 12 |
| Fresh draws, never reuse the selection set | Winner's Curse [A-today]; reusable holdout (PR) | Fresh strangers per gate; held-out scored once | Keep; add "selection items never reported" to PREREG |
| Same-incident content placebo | FIRE, PoPE, 2609.20474 | **Sh twin** (span redacted) on stage; cross-family twin renamed "specificity check", off stage | `C-FUS` item 2 |
| Information-matched Raindrop control | Jackson's lens test 6 (`J-JAC` §1) | **Ledger-only arm**; "Raindrop's marginal premium" | `C-FUS` item 2 + **X1** |
| A-priori, no-incident control | `LR` §7.6 X5; SkillsBench | **X5 arm**: improver with tool docs only | **X4 (new)** |
| Checks over attested fields only | CoVer 2610.04699 [`FUS` R-today] | Laws compile over plan-facts the agent cannot write | In `FUS` §6.2 |
| UNKNOWN for rows missing a feature | MonPoly study (`LR` P4) | UNKNOWN count, never counted as a pass | In `FUS` §7 step 7 |
| Re-score on contract change | 2610.01073 [SC]; Ecdysis 2609.11677 | Change stream on `_catalog`, `census_paths` and `routing.worker_model` | In `FUS` §7 step 14 |
| Release-control cost | 2609.20474 [R-today] | **False-hold column** | **X5 (new)** |
| Prequential test of the law-writer | `CL4` §6.1; Look-Ahead-Freedom 2607.04958 | **Prequential improver test** | **X3 (new)** |
| Typed meta-parameters under a frozen improver prompt | MetaSkill-Evolve; Meta^n (`LR` debate 1) | `improver_versions`, typed, prompt hash-pinned | In `FUS` §8 |
| Signals detect, verifiers decide, experiments confirm | `LR` consensus 5; Schultzberg 2610.10142 | Raindrop triggers; the deterministic gate promotes; RQL / Experiment only rolls back or holds | In `FUS` §7 step 13 |
| Matched-budget sample-k, gate-off, random laws | AI2/UW 2607.12227; 2604.11088 | X1, X2, X3 rows | In `FUS` §13 |

---

## 3. What Raindrop-using winners teach us, and the honest gap

**The gap first.** Exactly **one** hackathon winner has verifiably used raindrop.ai: `autoresearch-observers`. It won the sponsor-track "$5k for coolest use case of Raindrop Workshop" at the Autoresearch Systems Hackathon (May 30 2026). It was not 1st overall, and the only proof of the win comes from the team's side [V, `RW` §1 item 1].

That makes n = 1, for a *different prize text*. Every lesson below is a hypothesis. **No hackathon project has ever done recursive self-improvement with Raindrop in the loop** (`RW` §4.4).

**What the one winner did, and what it did not** (`RW` §2.5, §4.1):

| It did | It did not |
|---|---|
| Went deep on one Raindrop surface inside Raindrop's own UI: vendored and modified Workshop (+4,724 / −19 lines, 38 files) | Learn anything: the steering policy is fixed, so it is not RSI |
| Traced the LLM judge itself into Workshop, linked to the run it judged (`observedRunId`) | Measure anything: every benchmark cell is TBD |
| Validated LLM writes with a deterministic validator | Fail closed: the hard veto is a stub that fails open; some displayed nudges were `mock_applied` |
| Matched Raindrop's kickoff talk ("self-healing loops") | Avoid planted knowledge: the demo flaws were planted and the judge prompt was tuned to them |

**Calibration.**
- Four other placers at Raindrop-co-hosted events used **no Raindrop at all**: Curator 1st, qditor 2nd, ARC-AGI-3 3rd, and RustForge's honorable mention.
- **The overall podium never required Raindrop. Only the Raindrop prize did** (`RW` §1 item 3).
- So Raindrop must never cost the placement story: **no round-1 beat may wait on Raindrop ingest** (`FUS` §9.5 item 12).

**Open ground nobody has combined** (`RW` §4.4):
1. Raindrop evidence;
2. a persistent, versioned harness change;
3. a fails-before / passes-after gate plus a Raindrop cohort check;
4. the decision written back into Raindrop's UI.

Expunge does all four. It adds the sensor loop and Deletions.

**The inferred checklist** (`RW` §4.5, C1–C10; our inference, not published criteria) applied to Expunge v3:

| # | Criterion | Expunge v3 | Residual risk |
|---|---|---|---|
| C1 | Raindrop load-bearing; sees what our ledger doesn't | Words classifier on production. With **X1**, the hero's first evidence is an incident the certificate graded COMPLETE. Ledger-only arm printed | Ledger-only premium on D6 incidents is honestly ≈0 (the receipt shows `unresolved: 3` too). Concede it in Q&A |
| C2 | Verdicts written back, visible in Raindrop's UI | `expunge_verdict` on the triggering event; 5 s of Raindrop UI in round 1 | Plan quota [U]: Pro trial |
| C3 | The improver observed by Raindrop | `expunge-improver` project; improver, Sh twin and ledger-only arm all traced with `{role, observedRunId, proposal_id}` | — |
| C4 | Production primitives | Custom signal + `refine_signal`, Self Diagnostics (custom categories), Query API, hosted MCP, Datasets, Experiments (shadow), **Deletions** | `MCP_SIGNAL` flag [U] |
| C5 | Measured deltas with cost; improver tokens counted | $ and tokens per request and per ENACTED law, improver and twins included | — |
| C6 | Deterministic gate; authority fails closed | Validator → critic (span check fails to HOLD) → sweep → paired gate → CAS; Class N signed | — |
| C7 | Fails before, passes after, then an Experiment | 0/8 → 8/8; generated `W-xxxx.spec.ts`; RQL or Experiment as the online check only | — |
| C8 | Real recursion with a visible rejection | VOID live; STRUCK and GENERIC in the lineage; L2-S and the prequential test, both with HOLD | Both second-order results may be null; the null wording is pre-written |
| C9 | Claims match the code | `WHAT_IS_REAL.md` (file:line, query, n per spoken claim); `BUILT_TODAY.md`; leakage grep including the Raindrop evidence fed to the improver | Largest claims-to-code surface in the slate (`J-CVV` §3.1) |
| C10 | Knowledge discovered, not planted | v0 has zero recipes and zero token edges; `seeded 0 · discovered n · generic g`; token-level provenance ("receipt: generic, team-designed · edge: discovered") | The hero edge is probably GENERIC; the X5 a-priori arm may also write it |

**What not to copy** (`RW` §5.6):
- planted contradictions tuned to the judge;
- TBD benchmarks;
- excluded observer tokens;
- a fail-open veto;
- an ungated model swap (Curator's student outputs fed its own training file; Shumailov et al., *Nature* 2024, PR);
- a README claim committed after judging (RustForge, 8:51 pm PT).

**Name collision.** About 30 "Raindrop prize" rows across 8 events are **LiquidMetal**, a different company. Never cite them as raindrop.ai precedent (`RW` §6).

---

## 4. Score table, head-to-head and votes

### 4.1 Full table

Six role-played judges scored every entry. The composite is 0.5·R1 + 0.3·Finals + 0.2·RSI fit, the formula `REEVALUATION.md` used. I checked it on the top two [CALC]:
- Expunge: 0.5·9.28 + 0.3·9.23 + 0.2·9.08 = 9.225;
- CaseLaw v4: 0.5·9.08 + 0.3·8.94 + 0.2·8.5 = 8.922.

| Rank | Entry | R1 weighted | Finals (equal) | **Composite** | Impact | Tech demo | Creativity | Impl. difficulty | RSI fit | MongoDB | Novelty |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **Expunge v2** (`fusion`) | **9.28** | **9.23** | **9.23** | **8.83** | 9.00 | 9.08 | **10.00** | **9.08** | **10.00** | 8.17 |
| 2 | CaseLaw v4 | 9.08 | 8.94 | 8.92 | 8.50 | **9.08** | 8.33 | 9.83 | 8.50 | 9.75 | 7.42 |
| 3 | Spotter | 8.87 | 8.83 | 8.85 | 8.42 | 8.92 | 8.92 | 9.08 | 8.83 | 8.00 | 7.58 |
| 4 | DROSTE | 8.43 | 8.48 | 8.54 | 7.92 | 7.75 | 8.92 | 9.33 | 8.92 | 7.58 | **8.25** |
| 5 | TrollBooth | 8.15 | 8.25 | 8.23 | 7.17 | 7.83 | **9.50** | 8.50 | 8.42 | 7.25 | 6.92 |
| 6 | CaseLaw v3 (previous lead) | 8.31 | 8.08 | 7.90 | 8.08 | 8.33 | 6.67 | 9.25 | 6.58 | 8.92 | 5.58 |
| 7 | Lethe (previous runner-up) | 8.07 | 8.17 | 7.85 | 8.00 | 7.17 | 8.58 | 8.92 | 6.83 | 9.50 | 7.33 |
| 8 | Kintsugi v3 (previous RSI pick) | 7.71 | 7.60 | 7.74 | 7.83 | 7.33 | 6.67 | 8.58 | 8.00 | 7.67 | 4.50 |

**The incumbents.** All three fell to the bottom three composite places. Each is superseded by a rethink entry descended from it:
- CaseLaw v3 → CaseLaw v4;
- Lethe → Expunge;
- Kintsugi → Expunge.

### 4.2 Head-to-head: Expunge vs CaseLaw v4

Expunge's R1 lead of 0.20 decomposed by rubric column [CALC]:

| Column (weight) | Expunge − v4 | Weighted |
|---|---|---|
| Creativity (0.15) | +0.75 | +0.11 |
| Impact (0.20) | +0.33 | +0.07 |
| Impl. difficulty (0.30) | +0.17 | +0.05 |
| Technical Demo (0.35) | **−0.08** | −0.03 |
| **R1 total** | | **+0.20** |

Off-rubric columns: RSI fit +0.58, MongoDB +0.25, Novelty +0.75.

**Reading** [I]:
- The 35% Demo column is a tie within noise. v4's 9.08 rests on Bosco's single 10 (`J-CVV` caveat).
- Expunge wins on Creativity and Impact, which are the strongest columns in the equal-weight finals.
- Against the old lead, Expunge leads CaseLaw v3 by **+1.33 composite**, +2.41 Creativity, +2.50 RSI fit and +2.59 Novelty [CALC].

### 4.3 Borda, pairwise and RSI picks

Borda count, 3/2/1 points over six ballots [CALC verified]:

| Entry | 1st places | Borda |
|---|---|---|
| **Expunge** | **5** | **17** |
| CaseLaw v4 | 1 (Bosco) | 12 |
| Spotter | 0 | 7 |

**Pairwise:**
- Expunge > CaseLaw v4 on 5 of 6 ballots (Bosco dissents).
- Expunge > Spotter on 6 of 6.
- CaseLaw v4 > Spotter on 5 of 6 (the CV veteran dissents).

**RSI-prize picks:** Expunge 5, CaseLaw v4 1 (the RSI researcher).

### 4.4 The six final votes

| Judge persona (role-played) | 1st | 2nd | 3rd | RSI pick | Decisive argument, in one line |
|---|---|---|---|---|---|
| Steffan (MongoDB) | Expunge | CaseLaw v4 | Spotter | Expunge | The only finalist where Atlas does the domain's work and refuses in round 1 (Atlas 13 on the judge's tax invoice; a transaction mints the receipt the reply is rendered from). **Condition:** the prep spec must remove `collMod` from `p_census`, because the idea file still grants it at L250, L420 and L430 |
| Jackson (Raindrop; prize judge) | Expunge | CaseLaw v4 | Spotter | Expunge | Raindrop sits on the information path; v4 only promises r-12. Expunge loses only if the redacted twin writes the same edge **and** the ledger-only arm shows zero premium |
| Bosco (AWS) | **CaseLaw v4** | Expunge | Spotter | Expunge | v4 shows four refusals or widenings live in round 1. Expunge's human key and 121 are finals-only, and its live gate is the beat most likely to fall back to stored |
| Aram (Modelence) | Expunge | CaseLaw v4 | Spotter | Expunge | The only entry where a stranger does the primary action ("erase me") on the deployed portal. It beats both rivals on 2 of his 3 lenses |
| CV veteran | Expunge | **Spotter** | CaseLaw v4 | Expunge | Its placement case and its RSI case are the same thing. CaseLaw is the event page's own example, and NYC's cut took 0 of 6 guardrail entries |
| RSI researcher | Expunge | CaseLaw v4 | Spotter | **CaseLaw v4** | After the closings, v4 is the only finalist whose improver is tested. **Flips to Expunge if v4's prequential test is grafted onto Expunge's improver.** X3 does exactly that |

**Net:** with X3 adopted, every prize-vote condition in the room points at Expunge. The one residual is Jackson's two-part loss condition. X1 is designed to make its second half false by information [I].

---

## 5. The recommended idea in detail: Expunge v3

### 5.1 Thesis and lines

- **Thesis (round 1 once, finals twice):** "It keeps the lesson and erases the person."
- **Heal:** "The agent doesn't get to say 'done' anymore; the database does."
- **Information line (new, X1):** "Our certificate checks what's true. It never reads what the agent *said*. Raindrop does."
- **The one recursion sentence (round 1):** "Every certificate it writes becomes a test for the next harness and a label for Raindrop's detector."
- **Bosco line (finals, twice):** "Compromise never becomes authority."
- **Monday line (finals, unprompted):** "On Monday it can still miss a copy. It can no longer tell you it didn't."

**Banned phrases** (merged from `FUS` §2 and `BP` §1, plus additions):
- "ignition";
- "first" / "first ever";
- "the model improves itself";
- "the harness got smarter";
- "the recursion is the ratchet" (say "the evaluator grows");
- "Raindrop detected" (say "Raindrop's classifier" or "the agent's self-report, measured by Raindrop");
- "we retrained Raindrop's model";
- "only a human can widen authority" (say "only the approval service's human login can");
- "MongoDB's own MCP server" unless the header reads `mcp: mongodb`;
- **"the evidence did the work" unless the Sh twin failed**;
- **"receipt-gated completion is new"**;
- "guardrail" as the first noun;
- defining "harness" on stage.

### 5.2 Domain, task and verifier (unchanged from `FUS` §4–§5 except where marked)

**Operator and pain.** Privacy and data-platform teams answering deletion requests. The EDPB's 2025 coordinated enforcement covered 32 DPAs and 764 controllers and found missing data classification [V, `FUS` §4.1].

The liability is a false "you have been erased", which is the *Moffatt v. Air Canada* class. False success is 44–52% of failures, and LLM judges stay ≤ 0.65 AUROC on it (2606.09863, PP).

**Task.** A messy deletion request comes in. The worker must:
1. resolve the identity;
2. locate every copy;
3. choose a lawful action per copy (DELETE, REDACT, TOMBSTONE, RETAIN_RESTRICT, HOLD);
4. execute;
5. resolve every residual candidate;
6. answer the requester.

**Two artifacts:**
- The **receipt** is the product. `commit_erasure` writes it in every lane. It is now a generic `commit_erasure.verified` receipt (`C-FUS` item 3), minted with `unresolved: 0` only when an independent residual sweep is clean.
- The **certificate** is the oracle. `p_grader` writes it in the planted and judge lanes only.

**Lanes:**
- **Planted:** train, validation, gate and held-out tenants from a declared dialect space.
- **Production:** simulated requesters from a different-vendor model, plus judge and portal requests. The oracle is hidden from the improver, which sees **Raindrop only**.
- **Real haystack:** MongoDB's `sample_mflix` and `sample_airbnb`. Investigations only.

Families: D1–D11 plus S1 (namesake twin), S2 (impostor) and S3 (legal hold). The hero failure family is **D6** (a free-text mention in a ticket body or gift-card message).

**New failure class W1 (X1).** The certificate grades the erasure COMPLETE and the receipt is clean, but the reply over-claims. Example: "permanently deleted" said about a RETAIN_RESTRICT invoice.
- **Not a planted family.** It arises from the worker's own wording. Its rate on the production lane is [U] and is measured by 12:15.
- **Probe:** run 20 production-lane requests on v0 and count W1 with the assertion labeler.
- **If it is below 2 of 20:** add the restricted-invoice class to more simulated requesters' tenants. Then fall back to D6-first evidence, labelled, with the ledger-only concession said in Q&A.

**The verifier and its attack table carry over unchanged** (`FUS` §5). One honest note stays: on our own genome, "learning-loop residue = 0" is a receipt by construction. Only row R3 (prose lessons) *measures* it.

### 5.3 The genome: four nouns, no prose

The genome is content-addressed and insert-only for `p_gate`. "Active" is a CAS pointer.

| Statement 1 noun | Genome field | Compiles to |
|---|---|---|
| Rules | `recipes` (typed locate and resolve recipes; no free text) | A fixed template |
| Context policy | `census` + `locate` | The census aggregation, whose output is the context packet |
| Guardrails | `guards` (closed primitive enum) | MQL over plan facts, max severity |
| Tool access | `tools.authority`, `official_disabled`, `topology` (token edges) | MCP instance × Atlas principal, plus gateway token edges |
| Model route | `routing.worker_model` | A gated field; every law is re-tested on a route change |

**Every string is one of three things:**
- an `enum` member;
- a census-registered path;
- a typed id.

`cites` match `^(w|rd|pf)_…`. Core guard ids are untargetable. **One op per proposal.**

**Op classes** (`FUS` §6.3):
- **K** (knowledge) and **T** (tightening) are autonomous through the gate.
- **N** (ascent or loosening, *including any op the precedent sweep finds newly permissive, whatever its name*) goes to HELD. A person then signs the **re-derived flip set** (`CL4` §9.4).

**`REQUIRE_TOKEN(tool, token_source)`** semantics are frozen before kickoff. The gated tool is unavailable until the token exists, **and its arguments are bound to the token's payload**. So the hero edge makes the reply both *late* and *derived*. A receipt token is valid only for the same run and below a world high-water mark (Steffan's freshness rule, `J-STE` §6 item 2), so it cannot be replayed into another request.

**Constitution enforcement, after `C-FUS` item 1** (binding; `J-STE` and `J-BOS` condition):
- **No runtime principal holds `collMod`.**
- The one-shot `p_setup` rebuilds the path `enum` once per **frozen census epoch** (frozen after 15:00).
- The promotion transaction re-checks every path against `census_paths`.
- The `person_name` detector scans **keys** as well as values. A key registers only if it recurs across ≥ 20 subjects [I].
- `p_audit` re-reads the `listCollections` options (validator hash, `validationLevel`, `validationAction`) on every commit, and CAS-rolls back on drift.
- If `buildInfo` reports 9.0, the immutable collections use `validationLevel: "constraint"` [J-today: `collMod` docs, "New in version 9.0"]. NYC's sandbox was 8.0.32, so this is probably unavailable [U].

**Provenance (C10).**
- v0 holds the 3-item constitution (labelled "constitution, ours"), census defaults, zero recipes and zero token edges.
- The lineage strip prints `seeded 0 · discovered n · generic g`.
- **New (Jackson must-change 2):** every law card prints two things:
  - its affordance provenance, e.g. "`commit_erasure.verified`: generic receipt, team-designed 11:xx · edge: discovered from rd_7f30";
  - `first evidence: raindrop | planted | haystack`.

### 5.4 The loop (one generation; `FUS` §7 with changes in bold)

1. **Serve.** The cheapest Claude route runs with a frozen, hash-pinned prompt and the bundle pinned by hash.
   - The gateway relays MongoDB MCP `listTools` from the authority-level instance, narrowed by override headers.
   - **`maxTimeMS` is set explicitly** (X7).
   - Every call goes through `govern()`: canonicalize → decide in Atlas → record → act on the previewed `_id` set → record the outcome.
2. **Grade** (planted lanes): certificate, shape witnesses, plan facts.
3. **Trigger.** Raindrop `false_erasure_claim` or Self Diagnostics on production, a planted-lane incident, or a haystack investigation (which never promotes alone). **The stage lineage's trigger is a W1 production event (X1).**
4. **Evidence.**
   - The observer is the sole holder of the Query key.
   - It mirrors the pseudonymized event and trace, plus shape witnesses and `search_precedents` (`$rankFusion` over laws and the graveyard).
   - The improver gets raw traces, not summaries (Meta-Harness, PR).
5. **Propose, three arms, same prompt, same budget** (`C-FUS` item 2):
   - **real**: the evidence as mirrored;
   - **Sh**: the same incident with the Raindrop span redacted, keeping the family label and the shape witness;
   - **ledger-only**: receipts and tool rows, with no Raindrop event at all.

   The cross-family twin becomes an off-stage "specificity check" (`J-RSI` §7). Each arm inserts **one** typed op plus a prediction (`family`, `target_flips`, `cost_delta`) plus cites, on its own credentials.
6. **Deterministic critic.**
   - Warrant: every cite resolves, and `rd_` cites pass a span match against `GET /v1/events/{id}`, failing closed to HOLD.
   - Standing: the proposal must name a confirmed miss it suppresses.
   - Compile bans apply.
7. **Precedent sweep.** One as-of aggregation over every past ruling, through the same `STAGES()` the live gateway runs over `$documents`. **The pipeline must stay within 50 stages (X7).** Output:
   - RED k/k;
   - STAYGREEN (0 lawful newly blocked, 0 namesakes newly touched);
   - the authority delta;
   - the UNKNOWN count.
8. **Paired fresh-stranger gate.**
   - k = 8 strangers of the **predicted** family, with parent and child on identical seeds. Promote iff ≥6 fail→pass and 0 pass→fail (exact McNemar p ≤ 0.031) [CALC, `LR` §7.6].
   - Also required: namesake twins untouched, impostor and hold honoured, tokens ≤ 1.1× unless COMPLETE rises, and replay/stored parity.
   - The Sh twin's law runs the same gate. If it passes, the real law is enacted as **GENERIC**.
   - The ledger-only arm's outcome (no proposal, STRUCK, or its own law) is logged for the premium.
9. **Class N only:** production shadow, then HELD. The approval page shows the flip set; **all cases are scrollable, ordered nearest-to-harm, pre-registered** (`J-BOS` Q5).
10. **Promote.** One CAS transaction.
    - For Class N, the flip set is re-derived as of the grant's high-water mark, and the grant is consumed once through a unique index on `promotions.grantId`.
    - Fallback `flip-check: pre-txn` is printed in the header [U: in-transaction timing].
11. **After commit.**
    - The change stream feeds SSE and the worker swap.
    - Raindrop write-back: `expunge_verdict` on the triggering event, one NEGATIVE signal per gate trip, and a `twin_also_passed` signal.
    - Generated `tests/precedents/W-xxxx.spec.ts`.
12. **Corpus re-test and receipt auditor** (`p_audit` recomputes and CAS-rolls back on mismatch).
13. **Online check, never authority.** Parent vs child by `harness_version` in RQL or an Experiment. It may roll back or hold, never promote.
14. **Re-score on contract change** (`_catalog`, `census_paths`, route).
15. **Funnel log**: `suppressed | proposed | 121 | struck | void | held | enacted | generic`, per arm, with predicted vs observed flips.

### 5.5 What makes it recursive (claimed exactly as measured)

The ladder follows `J-RSI` §2.1.

| Level | Mechanism | Ruler | Rule | Where it shows |
|---|---|---|---|---|
| **R0: the evaluator grows** | Every certified erasure and every enacted law's witnesses become precedents that judge every later genome | The system's own history | Sweep + gate | Round 1: "every erasure it ever certified". **Never called RSI** |
| **R1: laws** | One typed op per law, from evidence, gated | Fresh strangers + Sh + precedent sweep | ≥6–0; GENERIC if Sh passes | Round 1, the hero law |
| **R2-S: the court trains the sensor** | Certificate- and receipt-labelled batches → `refine_signal` on the user-created `false_erasure_claim` JS signal (≤500 positive and ≤500 negative ids; background; "no polling" [J-today: https://raindrop.ai/docs/mcp/overview.md]) | Precision and recall on **frozen held-out transcripts re-emitted as new events** after each epoch (11:30 → 13:30 → 15:00), with Wilson CIs and n printed | Report only; never a gate input | Round 1, one number, **only if measured**; else "not measured" |
| **R2: the prequential improver test** (X3, grafted from `CL4` §6.1) | `improver_versions` (typed: `operator_priors`, `signal_trust`, `evidence_policy`, `edit_budget`, `investigation_topology`; prompt frozen). One meta-edit at 13:30, written from the funnel log | (a) **Brier** of predicted flips over every proposal of the day: dense, powered, no extra calls. (b) **Prequential test:** as of each past incident, v_k and v_0 each write M = 3 proposals from an as-of bundle (`seq ≤ t_i`, built by `p_meta`; the improver holds no DB credential; a canary future ruling is asserted absent). Each proposal is scored deterministically on rulings **after** t_i, **only on families the improver never drafted for** (held-out tenant families plus haystack) | Paired bootstrap CI, sign-flip permutation, A/A band. **HOLD unless the CI clears the band and p < 0.05** | Finals 5 s; Q&A |

**R2-S label rule, fixed (X2).** `FUS` L314 currently reads "negative = assertion ∧ COMPLETE". It is replaced by:
- **POSITIVE** iff the reply asserts any action or completeness the receipt does not record. That covers:
  - "deleted" for a copy the receipt lists as restricted, redacted, tombstoned or held;
  - "all" or "complete" while `unresolved > 0`;
  - any completeness claim when the certificate is INCOMPLETE.
- **NEGATIVE** iff every assertion is receipt-backed.
- **Labeler:** the deterministic assertion-phrase labeler (validated on 60 human-labelled replies). Batches are human-confirmed.
- **Pools:** the refine and held-out pools are split by subject hash, pre-registered.
- **Source:** free-text replies from ablation rows R0–R3 and the parent lineage. After 13:41 the main lineage cannot over-claim, so it produces no new positives (`J-JAC` §4.1 item 4).
- **Quota:** this needs Pro. Hobby's 1,000 events/month will not cover about 3 × 200 re-emitted events plus production [V: `notes/41`; `research/fresh-mongodb-raindrop-architecture.md`].

**Claim language, exact:** "The evaluator grows from every erasure it certifies. Those certificates also retrain Raindrop's detector: precision __ → __ on held-out events, n = __. The improver is tested separately on cases it never saw; today that reads ___, or HOLD. The model does not improve itself."

**On a null.** AIDE² (0.780 vs 0.782) and HSI were nulls (`LR` §B). No multi-seed, frozen-baseline recursion premium has been published (`LR` Open Question 2). A pre-registered HOLD is a credibility win.

**Gating the R2 build.** It is built only after G4 (the first real ENACTED) and never touches the round-1 path. If it has not run by 15:30, say nothing about it. Cost: about 2 × 24–48 × 3 = 144–288 improver calls plus 1–3 s of aggregation each [CALC, `CL4` §6.1].

### 5.6 Raindrop integration

**Information test, per source** (`FUS` §9.1, updated):

| Raindrop input | Type | In our ledger? | Measured by | Drives |
|---|---|---|---|---|
| `false_erasure_claim` (user-created signal, human-confirmed) | Classifier over free text the oracle never parses | **No.** On W1 incidents the certificate says COMPLETE and the receipt is clean | Precision/recall vs the fixed label rule, split by human vs simulated requester, n printed | The hero trigger (X1); `signal_trust`; R2-S |
| Self Diagnostics (custom categories `possible_missed_copy`, `identity_ambiguous`, `retention_conflict`, `insufficient_authority`) | Model self-report | No | Precision vs the planted ledger | Evidence ranking; investigations |
| Signals on the real-haystack lane | Traffic with no complete oracle | No | The only evidence on free-text residue there | Investigations only |
| Tool-error signals (Atlas 13) | Also in our ledger | Yes | Convenience, not information | Nothing load-bearing |

**Surfaces, one job each** (all carried from `FUS` §9.2):
- **TS SDK** with `featureFlags{harness_version, worker_model}`. `userId` is the pseudonymous `sbj_` token. The rendered prompt is logged as `input`.
- **Custom signal plus `refine_signal`.**
- **Query API** (observer only).
- **Hosted MCP**: `run_rql`, Issues, `create_experiment` as shadow, `update_dataset_members`.
- **Workshop** as the local eval room (`import_cloud_trace`, `ask_agent`); **no UI fork**.
- **`POST /v1/deletions/users`**: one job per COMPLETE certificate, with `due_by` printed [J-today: `J-ARA` P3].
- The **`expunge-improver` project**.
- **`expunge_verdict` write-back.**
- **Approver `edit` and `approver_accept` signals** (finals).

**Premiums (pre-registered).** Unit = incident, paired across the day, exact McNemar on discordant pairs:
- **Content premium** = P(ENACTED | real) − P(ENACTED | Sh).
- **Raindrop's marginal premium** = P(ENACTED | real) − P(ENACTED | ledger-only).
- Also reported: **time-to-first-evidence**, Raindrop vs ledger.

**Expected readings [I]:**
- The content premium on the hero edge is ≈0, so the edge is GENERIC. Say so.
- Raindrop's marginal premium is positive on W1 incidents and ≈0 on D6. Concede the D6 part in Q&A.
- n is about 24–48 incidents, so both are probably underpowered. Print the MDE.

**The unplug answer** (one sentence, true at 17:00): "Unplugged, we still learn from planted incidents. We lose the only witness to what the agent *tells people*, every incident our certificate graded complete but the agent misreported, the only evidence on data we didn't write, our promise to forget the person in our own observability, and the only loop that makes the detector better."

### 5.7 MongoDB: Atlas does the domain's work

**Databases split by trust** (`FUS` §10):

| Database | Holds | Access |
|---|---|---|
| `w_<tenant>` | Worlds; tenant validators double as the admissibility referee | — |
| `expunge_fixtures` | Fixtures and the `sample_*` copies | — |
| `expunge_priv` | The planted ledger | `p_grader` only |
| `expunge_pub` | Genomes, deployments, promotions, proposals, plan facts, precedents, receipts, certificates, the funnel and `improver_versions` | Per principal |
| `expunge_auth` | Grants | `p_human` only, from an isolated approval service |
| `expunge_vault` | Subject tokens, shredded in the commit | — |

**Principals after the fix:**
- `p_gateway_l0/l1/l2`: every level gets **13 on retained classes**.
- `p_census`: reads worlds; writes `census_paths` only; **no `collMod`**.
- `p_improver`: find, plus insert on `proposals` only.
- `p_gate`, `p_grader`, `p_stream` (sole `watch()`), `p_human`, `p_audit`, `p_observer`.
- **`p_meta`**: new. Builds as-of bundles for X3, read-only.
- `p_planter`, `p_reset`, and the one-shot `p_setup`.

Roles are created in the Atlas UI or Admin API, because drivers cannot `createRole` [V, `C-tech` #11]. On Free clusters they take up to 30 s to deploy [V-today].

**Green test** (committed before each round). Each of these must hold:
- `drop`, `renameCollection`, `dropIndex`, `bypassDocumentValidation`, `createSearchIndex` **and `collMod`** return 13 for **every runtime principal**;
- `p_improver` on `expunge_priv` returns 13;
- any non-human principal inserting into `grants` returns 13;
- a forged or stale flip set aborts;
- a replayed grant hits E11000;
- the worker host has no URI;
- the auditor's `listCollections` options hash matches;
- the 16-case red-team suite returns 121 (including `"Zoë Park"` and `zoe_park` as recipe scopes, and a name-keyed field path).

**Features with a domain job:**
- the census aggregation, which is the data classification the regulators found missing;
- Atlas Search custom analyzers (ASCII folding, name-initial tokens, phone normalization) for `mention_search` and the residual sweep;
- `$graphLookup` reference chasing and the lineage strip;
- the `$setWindowFields` as-of sweep plus `$documents` live evaluation through one `STAGES()`;
- the **multi-document erasure transaction** (writes by previewed `_id`, receipt, token mint, token shred, Raindrop-deletion outbox);
- the CAS promotion transaction;
- three change streams (deployments, the resurrection watch, re-score);
- TTL on grants and worlds;
- unique indexes for one active deployment and single-use grants.

**Exactly three MongoDB moments in round 1:**
1. Atlas 13 on the judge's invoice (a silent chip; `J-CVV` must-change 2).
2. The precedent sweep: "~1,900 rulings, each as of its own moment, one aggregation".
3. The erasure transaction that mints the receipt the reply is rendered from.

**Finals moments:** the 121 on a person's name, and MongoDB's MCP server re-listing tools after a signature.

**Agent Engine:** one sentence, "probed; not supported on Free clusters", unless the sandbox is Flex+ (`J-STE` §7 item 3).

**Tier.** Design for M0:
- 100 ops/s;
- 3 search indexes;
- 50 pipeline stages;
- 32 MB sort.

Ask for Flex. Meta work (premium arms, X3, the haystack lane) runs in `env: meta` windows from 13:30 to 15:00 under a 60 ops/s token bucket, never during rehearsals.

### 5.8 Round-1 demo, second by second (3:00)

**Setup.** P3 drives and P4 narrates. No slides. One judge interaction. At most 7 spoken numbers.

**Pre-state** (labelled on screen):
- `env r1` is cloned from the frozen stage state, with the hero lineage rewound to its real parent `hv_41aa` (active 13:05–13:41).
- About 1,900 precedents exist.
- The trigger `rd_7f30` is a **W1 production event** (13:2x). Its certificate grade is COMPLETE; it carries `false_erasure_claim`; and it already holds the 13:41 written-back verdict, so the Raindrop UI never waits on ingest.

**Rehearsal rules:**
- If the live gate (improver + Sh + 24 paired episodes) reaches a verdict by 0:56 in fewer than 4 of 5 rehearsals, round 1 uses the stored 15:xx gate, labelled.
- **X8:** if Sh passes in ≥2 of 5 rehearsals, the Sh lamp leaves round 1.

| Time | On screen | Said (P4; anchors, not prose) | Labelled fallback |
|---|---|---|---|
| 0:00–0:08 | Tablet to the judge: "Type any name. A fake one is fine." Header visible. P3 presses Run on the gate at 0:00 | "When you ask a company to erase you, it has one month to tell you what it did." | Pre-filled "Zoë Park", said aloud |
| 0:08–0:16 | Planter → **sealed map: 13 tiles in 8 collections + 2 namesake decoys** (optional X9 chip: `family drawn by drand #…`) | "You're now in 13 places in this store's database. The agent can't see this map. You can." | — |
| 0:16–0:34 | *Run · harness as of 13:05.* Ten tiles go green. Silent chip: **Atlas 13 · delete on `invoices` refused → restricted**. Receipt `unresolved: 3`. The agent replies "All of your personal data has been permanently deleted." Certificate **INCOMPLETE · 3 surviving**; a witness card shows the judge's name in a ticket body | "It told you you're gone. You're not: three copies survived, one with your name in a support ticket." | The chips appear only if they happen. If the run passes: "the parent misses this family 8x% of the time (n shown); here's the stored run", labelled |
| 0:34–0:44 | **Raindrop's own UI** (pre-opened tab): production event 13:2x, `false_erasure_claim`, our written-back verdict, and a chip `certificate: COMPLETE` | "This is Raindrop. Same sentence, on production traffic, on an erasure our certificate graded *complete*: the agent called a tax invoice we must keep 'permanently deleted'. Our certificate checks what's true. It never reads what the agent said. Raindrop does." | Screenshot from 13:45, labelled |
| 0:44–0:56 | Law bench. Evidence card: the span highlighted, verified against Raindrop's API, plus a nameless shape witness. **One op:** `REQUIRE_TOKEN reply_to_requester ← commit_erasure.verified`. Chips: `inserted as p_improver [find, insert]` · `first evidence: raindrop` · `receipt: generic, ours · edge: discovered` · `seeded laws today: 0` | "The improver read that trace (a shape, never a name) and wrote one law: no answer until the database issues a clean receipt, and the answer *is* the receipt." | Stored proposal, chipped |
| 0:56–1:16 | **Precedent strip sweeps ~1,900 dots: RED 4/4 · 0 lawful newly blocked · 0 namesakes · authority Δ 0.** Lamps: **law: parent 0/8 → child 8/8**; **same incident, Raindrop's words removed: _/8**. **ENACTED** (CAS). The tray re-lists `reply_to_requester 🔒 needs clean receipt` | "Atlas replays every erasure it ever certified, as of that moment: nothing lawful breaks. Eight fresh strangers: zero before, eight after." Then one of: **(Sh fails)** "Remove Raindrop's words and the same improver's law fails: the words did the work." **(Sh passes)** "Without the words it writes the same law, so we count it GENERIC. Receipt rules are published; ours was learned from a sentence only Raindrop heard." | If X8 has triggered, there is no Sh lamp and the second sentence is the "published / learned" line. If STRUCK: "Struck: it didn't beat its parent. That's the gate working", then the main lineage's law, labelled |
| 1:16–1:44 | *Run · current harness* on the **judge's** subject. Commit → `unresolved: 3` → the agent cannot reply → it redacts two ticket mentions and a gift-card message, dismisses a namesake with a cited mismatch, and re-commits. 13/13 green. The reply is **rendered from the receipt**: "13 copies: 9 deleted, 2 redacted, 1 restricted (kept for tax law), 1 tombstoned." **COMPLETE · 0 collateral · Raindrop deletion job filed · due Nov 10** | "Same model, a law written a minute ago. The agent doesn't get to say 'done' anymore; the database does. And our observability vendor is forgetting you too." | Stored 15:00 bundle, labelled |
| 1:44–2:02 | P3, from the attack card: "namesake check over-blocks; lower `min_identifier_evidence` to 1" → validator ✓ → one amber dot, W-0377 "would have deleted Zoe Parks's order" → **LOOSENING DETECTED → VOID** | "Assume the improver is compromised. This edit is legal, so the replay catches it: it would erase a different person. Loosening never happens without a signature." | Deterministic |
| 2:02–2:32 | Held-out card (saved aggregation, hash chip): **≈300 strangers, 3 unseen tenants + MongoDB's sample data.** Rows: stronger model + privacy policy in the prompt · blind expert · Expunge on the cheapest route. Columns: COMPLETE %, false "erased" replies, **false holds**, namesakes touched, $ per request. **One Raindrop line**, the R2-S result if measured, else Raindrop's marginal premium | "Held out, never trained on. A bigger model with a privacy policy still leaves people behind and still says 'done'. Expunge on the cheapest model leaves no one." Then: "Our certificates retrained Raindrop's detector: precision __ → __, n = __", **or** "__ laws today had first evidence only Raindrop held" | Frozen 15:00 card, rendered live |
| 2:32–2:52 | Lineage strip `seeded 0 · discovered n · generic g`. Footer: `BUILT_TODAY.md`, commits since 10:30, deployed URL | "Every certificate it writes becomes a test for the next harness and a label for Raindrop's detector. **It keeps the lesson and erases the person.** Every number on screen is a query. Built since 10:30." | — |
| 2:52–3:00 | Buffer | — | — |

**Spoken numbers (≤7):** one month · 13 · three · zero → eight of eight · ~300 held-out · one Raindrop number. The $ ratio replaces "three" only if it holds.

**Finals cut** (equal weights, so Impact + Creativity = 50%):
- **+10 s operator open and the Monday answer.**
- **Real haystack, 8 s:** "Ana&Gonçalo" vs "Ana & Goncalo" in `sample_airbnb`, only if held-out found it.
- **The signed flip set, 15 s:** the judge, as DPO, scrolls the full case list and signs. The commit re-derives the set and consumes the grant. MCP L2 then lists `delete-many` for erasable classes, and `delete-many` on `invoices` returns 13.
- **The 121 stamp, 3 s.**
- **The improver line, 5 s:** "Prequential improver test: __ [CI], or not significant; we kept v1."
- **Thesis twice; "Compromise never becomes authority" twice.**
- **Cut first if over time:** improver line → haystack → 121.

**One-minute video** (by 16:30), segments in seconds:

| Segment | Length |
|---|---|
| Name → map | 8 s |
| Miss + "permanently deleted" | 10 s |
| Raindrop UI | 6 s |
| One-op law → sweep → 0/8 → 8/8 | 14 s |
| Receipt-rendered reply | 12 s |
| VOID | 4 s |
| Held-out + "built today" | 6 s |

### 5.9 Metrics, ablation and fallbacks

**`PREREGISTRATION.md`** is committed at about 12:15 by someone who does not own the improver. It fixes:
- the rows;
- the units (subject; incident for the premiums; incident × M = 3 for X3);
- the tests;
- the single headline claim and the tie claim;
- the beacon and seed hash;
- the three-arm protocol;
- the R2-S epochs, label rule (X2) and held-out split;
- the X3 protocol and HOLD rule;
- "selection items never reported".

The scorer freezes at 15:00, and held-out is scored once.

**Rows.** Held-out is about 300 subjects × 2 replicates, one pinned worker model unless stated (`FUS` §13 rows R0–R9 and X1–X3, plus the new X5):

| Row | Arm | Why |
|---|---|---|
| R0 | Stronger model + privacy policy as prose | The "markdown file" condition and the model-wrangling baseline |
| R1 / R2 | Bare / v0 | Floor / start |
| R3 | v0 + free-text lessons | The only row where residue is *measured* |
| R4 / R5 | Blind expert, human / frontier | Strong static baselines; a tie is said aloud |
| **R6** | **Evolved lineage, cheapest route (headline)** | — |
| R7 | R6 minus GENERIC laws | Discovered laws only |
| R8 | R6 structure-only | "Is it the recipes?" |
| R9 | Human improver (30 min, same evidence) | Fair-human baseline |
| X1 / X2 / X3 | Matched-budget sample-k / gate off / count-matched random laws | AI2/UW; what the gate prevented; priming |
| **X5 (new)** | **A-priori improver: tool docs, no incidents, same gate** | Prices "any engineer would add the receipt edge" |

**Columns:**
- COMPLETE % (Wilson CI);
- surviving copies per request;
- false "erased" replies (the labeler; never a gate input);
- **false holds (new)**;
- namesakes touched per 100;
- Atlas refusals;
- learning-loop residue;
- $ and tokens per request, with improver and twin tokens amortized per ENACTED law;
- p50 latency.

**Statistics** (`LR` §7.6):
- paired designs;
- exact McNemar (≥6–0 gives p ≈ 0.031; 5–0 is not significant);
- an A/A band and the MDE printed;
- pass^k next to pass@1;
- a flip table per generation;
- per-op attribution.

Unpaired 95% half-widths at this n are about ±13–16 pp, so unpaired deltas prove nothing.

**Fallback ladder.** Decide at the clock times; there is no pivot.

| When | Trigger | Action |
|---|---|---|
| 10:35 probe | Custom roles or `$documents` denied | `decisions: mingo`, labelled; the spoken lines follow the header |
| 10:35 probe | Aggregation inside a transaction too slow | `flip-check: pre-txn`, on a quiesced env during signing |
| 10:35 probe | MCP narrowing fails | `mcp: gateway` |
| 12:15 | Parent misses D6 < 80% | Lure strength, then worker route, then X9's three-family draw |
| 12:15 | W1 rate below 2/20 | Enrich retained classes. Else D6-first evidence, labelled, with the ledger-only concession |
| 13:30 | No LLM verdict | Fix the input, not the prompt; hard stop 14:15 |
| 14:45 | No real ENACTED | Live failure + a real STRUCK or VOID + the human pipeline-test law **labelled as human-authored**. Never present it as evolved |
| Any time | `refine_signal` shows no effect | R2-S says "not measured"; the Raindrop line becomes the marginal premium |

### 5.10 Literature basis (by mechanism)

| Mechanism | Stands on (PP unless marked) |
|---|---|
| Raw-trace evidence | Meta-Harness 2603.28052 (**PR**, COLM 2026) |
| Warrant-aware admission; attested fields | Phantom Guardrails 2607.13083 [SC]; CoVer 2610.04699 |
| Paired gate; protected suite; corpus re-test; compounding | SAGE 2609.36043 [SC]; Self-Healing 2609.24130 [SC]; "Do Agent Optimizers Compound?" 2607.14004 (vendor-authored) |
| Fresh draws | Winner's Curse 2610.09239 [A-today]; reusable holdout (**PR**, *Science* 2015) |
| Placebo / sham | FIRE 2609.26048; PoPE 2607.12962; 2609.20474 [R-today] |
| Completion claim owned by the database | False Success 2606.09863; ECT 2608.23623; Proof-or-Stop 2607.14890; No Trace No Claim 2610.09286; Verify-Gated Completion 2605.17998; Stored Is Not Supported 2609.02127 |
| Authority asymmetry; signed effect sets | Earned Authority 2607.23586; Progent 2504.11703; Guarded Commits 2610.00037; Approval Laundering 2609.38983; Containment Floor 2610.06274 [SC]; Cedar (**PR**, OOPSLA 2024) |
| No prose | AHE 2604.25850; Guardrails Beat Guidance 2604.11088 |
| Sensor trained by verified outcomes | VeriFine 2610.08761; RCV 2608.14089 [A-today]; Self-Authored Verification Is Unreliable 2607.24300 |
| Bounded second order; HOLD | Meta^n 2608.24735; MetaSkill-Evolve 2607.05297; FreeEvolve 2610.09197; AIDE² 2609.26457 (null); HSI 2608.08466 (null); Look-Ahead-Freedom 2607.04958 |
| Privacy of the learning loop | Deployment-Time Memorization 2606.10062; P2Skill 2608.14094 |
| Re-score on contract change | 2610.01073 [SC]; Ecdysis 2609.11677 |

---

## 6. Changes to `BLUEPRINT.md`, in priority order

`BP` is the CaseLaw v3 blueprint (17 sections). Rewrite it on the prep day as **prose** (no code; new-work-only), as "BLUEPRINT v4: Expunge".

Tags:
- **[REPLACE]**: rewrite from the named source;
- **[CHANGE]**: edit in place;
- **[KEEP]**: retain;
- **[CUT]**: remove;
- **[ADD]**: new.

**P0: frame, constitution, stage**

1. **[REPLACE] BP header, TL;DR and §1** with §1 and §5.1 of this file.
   - Name, thesis, lines.
   - The merged banned-phrase list.
   - The 4-person lane table, re-mapped as in item 14.
   - Remove "CaseLaw: guardrails written from precedent" as the name.
2. **[REPLACE] BP §2 (DataOps domain, F1–F6)** with `FUS` §4 plus §5.2 here:
   - the three lanes;
   - D1–D11 and S1–S3;
   - D6 as the hero family;
   - W1 (X1);
   - the dialect space;
   - Shack Outfitters as the stage tenant.

   Keep BP §2.1's keyed tiny worlds and BP §2.5's headroom-test discipline; the 12:15 test becomes "parent misses D6 ≥ 80%" plus "W1 rate ≥ 2/20".
3. **[CHANGE] BP §9.3 principals.** Use the §5.7 table:
   - **no `collMod` for any runtime principal**;
   - `p_setup` rebuilds the enum per frozen epoch;
   - the promotion re-checks paths;
   - the auditor re-reads `listCollections` options;
   - the key-scan rule;
   - `p_meta`;
   - `constraint` if 9.0.

   This is Steffan's stated condition, and the idea file still grants `collMod` at `FUS` L250/L420/L430.
4. **[CHANGE] BP §7 green test → v4.** Add these rows:
   - `collMod` → 13 for every runtime principal;
   - `listCollections` options hash;
   - a name-keyed path → 121;
   - two-op proposal → 121.

   The red-team suite becomes the 16 cases in `FUS` §10.
5. **[REPLACE] BP §12 demo** with §5.8 here: the W1 trigger, the Sh lamp and its rehearsal rule X8, the information line, the silent Atlas-13 chip and one recursion sentence. Keep "the gate starts at 0:00 under narration" and "never open on an empty state".
6. **[REPLACE] BP §4 genome** with `FUS` §6, plus:
   - generic `<tool>.verified` receipts;
   - frozen `REQUIRE_TOKEN` semantics;
   - token-level provenance;
   - `first evidence` on every law card.

   Keep BP §4.3 (max-severity compile, monotone by construction) and BP §4.5 (knob-liveness test).

**P1: recursion and evidence**

7. **[REPLACE] BP §6 loop** with §5.4 here: three arms, the warrant span check, the 50-stage limit and the funnel log per arm.
8. **[REPLACE] BP §8 recursion** with §5.5 here:
   - R0 never called RSI;
   - R2-S with the **fixed label rule (X2)** and re-emission;
   - **R2 = the prequential improver test (X3)**, plus Brier;
   - HOLD wording.
9. **[REPLACE] BP §10 Raindrop** with §5.6 here: the information table, surfaces, premiums and the unplug answer. Add the Deletions API, the `expunge-improver` project and approver `edit` signals.
10. **[CHANGE] BP §13 metrics**:
    - rows R0–R9, X1–X3 and **X5**;
    - the **false-holds** column;
    - the premium definitions;
    - PREREG contents from §5.9.

    Keep BP §13.4 (freeze by hash).
11. **[KEEP] BP §5** (one `STAGES()` pipeline for live verdicts and replay, with parity by construction), **BP §9.4** (single stream owner, now `p_stream`) and **BP §9.5** (CAS promotion), extended with flip-set re-derivation and the unique `grantId` (`CL4` §9.4).
12. **[CHANGE] BP §14.3 probe G0.** Add these probes:
    - `collMod` denied for every runtime principal;
    - `listCollections` options readable by `p_audit`;
    - `$documents` and `$setWindowFields` under a custom role;
    - aggregation-in-transaction timing at stage scale;
    - Search custom analyzers;
    - `maxTimeMS` on the MCP instances;
    - the 50-stage count of `STAGES()`;
    - `refine_signal` on a throwaway signal (records `status: refining`);
    - a `POST /v1/deletions/users` dry run;
    - `buildInfo` (9.0?).

    Keep probes 7–12 (ops/s, CAS race, LLM call shapes, spend-cap 429s, Raindrop latency).

**P2: depth, build plan, docs**

13. **[REPLACE] BP §11 UI** with Erasure Theater (`FUS` §11): the provenance header (`decisions`, `flip-check`, `mcp`, hosts, approvals), the sealed map, the law bench (sliding in only while a gate runs), the certificate and receipt pair, and the Raindrop tab.
14. **[CHANGE] BP §14.1–14.2 build plan.** Same four lanes, re-scoped:

    | Lane | Scope |
    |---|---|
    | **P1 WORLD** | Planter, Planter Court, grader, census, families, held-out tenants, haystack lane |
    | **P2 RUNTIME** | Worker, gateway, `govern()`, MCP authority ladder, `commit_erasure`, receipt-rendered reply |
    | **P3 IMPROVER / GATE / RAINDROP** | Contracts owner, improver + Sh + ledger-only arms, critic, sweep, gate, CAS, the Raindrop pipeline, R2-S, X3 |
    | **P4 MONGO-OPS / STAGE** | Roles, validators, green test, approval service, header, round clones, script, video |

    Keep the gate clocks:
    - I1 11:45: one D6 erasure end to end, with certificate and receipt;
    - G1 12:15: headroom + W1 rate;
    - G2 12:45: a human-written law through the full pipeline, labelled;
    - G3 13:30: first LLM verdict;
    - G4 14:30: first real ENACTED;
    - hash freeze 15:00;
    - feature freeze 15:30;
    - two rehearsals, one with a stranger;
    - backup recording 16:30;
    - tag 17:00.

    **X3 starts only after G4.**
15. **[CHANGE] BP §15 risks** → `FUS` §17, plus four new rows:
    - the W1 rate;
    - the L2-S label rule;
    - X3 surface creep;
    - the 50-stage limit.
16. **[CHANGE] BP §16 Q&A** → `FUS` §18 plus §7 here.
17. **[CHANGE] BP §17 differentiation** → `FUS` §15, plus the receipt-gated-completion row (§2.2 here).
18. **[CUT]**:
    - CaseLaw's DataOps domain and F1–F6;
    - the Witness pivot;
    - the adaptive Hider (off the build path);
    - an Agent Engine job (one sentence instead);
    - the Workshop UI fork;
    - ElevenLabs;
    - kill -9;
    - forking OpenDots / OpenBot / OpenMuse. Copy patterns only, such as `govern()` and policy dry-run (`notes/01` §6). `HACKATHON-RECOMMENDATION.md` proposes OpenDots as a foundation and itself says a full fork "needs an organizer ruling". Ask CV at check-in; default is no fork.
19. **[KEEP]** every domain-independent BP correctness fix (`BP` Appendix A):
    - `.gitignore` and the pre-commit secret check as commit #1;
    - the LLM call shapes and API facts (BP §14.3);
    - the spend-cap 429 handling;
    - round clones from one tagged commit;
    - `BUILT_TODAY.md` and `WHAT_IS_REAL.md`;
    - "never present a human-authored pipeline-test law as evolved".

---

## 7. Q&A additions: literature-based questions, with answers

Each answer is one or two lines and points at something on screen.

| # | Likely question (and the paper behind it) | Answer |
|---|---|---|
| 1 | "Receipt-gated completion is already published: ECT, Proof-or-Stop, No Trace No Claim. What's new?" | "Agreed. It works, and we cite them. Ours wasn't given the rule. It learned it from a sentence only Raindrop heard, and this card says whether a placebo improver would have written it anyway (GENERIC or discovered)." |
| 2 | "Why wasn't the receipt edge in v0? Any engineer would add it." (`J-CVV` §3.1) | "v0 has zero token edges by design, and the vocabulary admits about 40. Row R4 (blind expert) and row X5 (the same improver given only tool docs) price 'obvious'. Here's the funnel: __ triggers, __ proposals, __ STRUCK, __ GENERIC." |
| 3 | "Give the improver the same incident with the Raindrop span redacted. Does it write the same edge?" (Jackson; PoPE) | "That's the Sh lamp. Today it read __/8. If it passes, the law is tagged GENERIC, and that's on the strip." |
| 4 | "Unplug Raindrop. Which laws would not exist?" (`J-JAC` §4.2) | "The hero law's first evidence was an erasure our certificate graded complete. The ledger-only arm opened nothing on it. Today: __ laws had first evidence only Raindrop held. On D6 incidents, our receipt sees the problem too, and we say so." |
| 5 | "Isn't the recursion just a growing regression suite?" (`J-RSI` §1.1) | "That part is: the evaluator grows. The recursive claims are separate: certificates retrain Raindrop's detector (measured per epoch), and the improver is tested prequentially on cases it never saw. Today: __ or HOLD." |
| 6 | "Self-Healing Harness (2609.24130) already does detect → heal → validate." | "Yes. It replays at most two protected cases per round. We replay every ruling as of its moment, a person signs any loosening's flip set, and the genome has no prose." |
| 7 | "Did `refine_signal` actually change anything?" (Raindrop docs: background, no polling) | "Refined signals apply to *new* events, so we re-emitted frozen held-out transcripts after each epoch: precision __ → __, n = __. Or: 'not measured'." |
| 8 | "AIDE² found no meta-level gain. Does your improver improve?" (2609.26457) | "Probably not detectably today. The prequential test has an A/A band, and HOLD is pre-registered. We kept v__." |
| 9 | "Random rule files help as much as curated ones. Is this priming?" (2604.11088) | "Our laws aren't read by the model. They're enforced as tool topology and MQL. Row X3 (random laws) is on the card." |
| 10 | "Evolution doesn't beat matched-budget sampling." (AI2/UW 2607.12227) | "Row X1 is matched-budget retry. It can't render a reply from a receipt, so it still says 'done'." |
| 11 | "Your gate selects on a small set: winner's curse." (2610.09239) | "Every gate draws fresh strangers, and held-out is scored once. The selection set is never reported." |
| 12 | "A terminal verifier also blocks correct answers." (2609.20474: 16/92) | "That's the false-holds column: __ of __ COMPLETE erasures were held, and why." |
| 13 | "Who holds `collMod`? What stops validation being switched off?" (`J-STE`) | "No runtime principal. Green test row 1 shows 13 for all of them, and the auditor hashes the `listCollections` options on every commit." |
| 14 | "Can Raindrop evidence ever widen authority?" (Earned Authority 2607.23586) | "No. Evidence orders the queue. Only the approval service's human login signs, and it signs the re-derived flip set, not a diff." |
| 15 | "Does the DPO really review what they sign?" (Approval Laundering 2609.38983) | "All cases scroll, nearest-to-harm first, and any case can be struck with one tap. A struck case becomes a Raindrop `edit` signal." |
| 16 | "Do your lessons keep the person?" (Deployment-Time Memorization 2606.10062) | "On our genome, residue is zero by construction; we say so. Row R3, a harness that learns in prose, kept __% findable. That row is the measurement." |
| 17 | "Stale scores keep unsafe incumbents." (2610.01073) | "A change stream on the catalog, census paths and model route re-replays every precedent." |
| 18 | "How do you know you found every copy on Monday?" (Aram) | "The Planter is our test bench. In production the residual sweep and the receipt are the check, and the reply can't claim more than the receipt. Measured miss rate on MongoDB's sample data: __." |
| 19 | "Why not guardrails, or CaseLaw?" | "We kept CaseLaw's court: precedent replay and signed loosening. We moved it to a domain where the database does the work, and gave it a heal that's structure, not another red light." |
| 20 | "Spotter-style live coaching? PILOT?" (2608.26530) | "PILOT couples live steering with harness evolution. We don't steer live. Our heal is persistent from the start, and we borrowed the sham principle." |

---

## 8. Prep checklist (non-code; before doors at 09:00 PDT)

Everything is prose, an account or a plan, timestamped in `BUILT_TODAY.md`. **No code before 10:30.** Items are ordered by priority within each block.

**Block A: decisions and accounts** (first; about 90 min)

| # | Owner | Item | Done when |
|---|---|---|---|
| A1 | All | Read §1, §5 and §6 of this file. Write a one-page decision log covering every [U] in §5.9 and its fallback | Log committed under `prep/` |
| A2 | P3 | **Raindrop:** account; **Pro trial** (Hobby is 1,000 events/month and 1 custom slot); email support@raindrop.ai with "HACKATHON", asking for `MCP_SIGNAL`, `refine_signal` on a user-created signal, Deletions on the trial, and quota for about 1,500 events today; a throwaway org for smoke tests | Trial active; email sent |
| A3 | P4 | **Atlas:** all 4 teammates have the sandbox link; **ask for Flex**; a second Project Owner; `0.0.0.0/0`; roles typed in only if allowed tonight [U] | Screenshot in `prep/` |
| A4 | P2 | **LLM keys:** tiers read; the worker key funded (≥$50); spend caps known; a second-vendor key for simulated requesters; a separate key per role | Keys in the secret store, never the repo |
| A5 | P2 | **Hosts:** an engine/MCP host and an isolated approval-service host provisioned, with no code; Modelence account for the portal | Hostnames in the header spec |

**Block B: specs in prose** (about 3 h, in parallel)

| # | Owner | Item |
|---|---|---|
| B1 | P3 | **Contract tables:** Genome, Proposal (one op + prediction + cites), PlanFacts, Receipt (`<tool>.verified`), Certificate, Grant (flip set), ImproverVersion, Evidence, FunnelRow, ArmResult. **The closed vocabulary is frozen, including the `REQUIRE_TOKEN` semantics**, timestamped first |
| B2 | P1 | Dialect space; D1–D11 and S1–S3 specs with lure strengths; **the W1 definition and its 12:15 rate probe**; Planter Court rules; held-out tenant spec with beacon source; haystack lane plan; the ai4privacy licence question |
| B3 | P4 | Role and validator tables **without `collMod`**; the green-test v4 list; the 16-case red-team list; the `listCollections` audit rule; the M0 limits (50 stages, 32 MB sort, 100 ops/s, 30 s role deploy) |
| B4 | P3 | `PREREGISTRATION.md` skeleton: rows R0–R9, X1–X3, X5; the three-arm protocol; premium definitions; **the R2-S label rule (X2)** and re-emission epochs; **the X3 prequential protocol** (as-of bundles, M = 3, never-drafted families, A/A, HOLD); "selection items never reported" |
| B5 | P3 | Improver, Sh and ledger-only prompt drafts as identical prose differing only in evidence; the observer's span-check rule; the meta-edit rule for `improver_versions` |
| B6 | P2 | Worker prompt draft (frozen at 11:30); the `govern()` sequence in English; the gateway's funnel tools; the MCP instance-per-level plan with `maxTimeMS` |

**Block C: stage** (about 2 h)

| # | Owner | Item |
|---|---|---|
| C1 | P4 | Print the §5.8 script; the switch lines (STRUCK, GENERIC, X8, stored-gate); the attack card; the finals cut; the video storyboard |
| C2 | P4 | The Q&A sheet: §7 here plus `FUS` §18. **The prior-art slide** (§2.3, five rows) |
| C3 | P4 | Tablet in kiosk mode, charged; phone hotspot; Raindrop UI tab plan (a throwaway project for rehearsal) |
| C4 | All | Spoken run-through of round 1, twice, timed, plus every fallback line said aloud once |

**Block D: kickoff question cards** (printed)

- **CV staff:**
  - Who judges the RSI prize, and when?
  - **Can a non-finalist win it?**
  - Are prep-day prose and a tablet prop acceptable?
  - Is forking an MIT app such as OpenDots eligible? (Default: no fork.)
  - May the judge sign on our tablet?
- **MongoDB staff:**
  - tier and Flex;
  - custom-role rights;
  - `$documents` and `$setWindowFields` under a custom role;
  - MCP override headers;
  - custom Search analyzers;
  - server version (9.0 `constraint`?);
  - Agent Engine on the sandbox.
- **Jackson:**
  - the RSI-prize criteria;
  - whether hosted Signals, `refine_signal` and Deletions count;
  - Pro trial or credits.

**Block E: templates, then sleep**

- `BUILT_TODAY.md` (with the third-party list: Workshop, the sample datasets, ai4privacy if licensed).
- `WHAT_IS_REAL.md` (one row per spoken claim).
- `MONGO.md`.
- The CV description.
- `.gitignore` text plus the pre-commit secret-check plan.
- Then sleep.

---

## Sources

**Checked in this pass** (`/private/tmp/claude-501/-Users-nihalnihalani/c994678c-f4a3-4b27-a192-ab82821c1191/scratchpad/rethink-final/`):

- `firecrawl research inspect-paper` [A-today], all PP:
  - 2608.23623 (ECT);
  - 2610.09286 (No Trace, No Claim);
  - 2610.09239 (Winner's Curse);
  - 2608.14089 (RCV);
  - 2607.14890 (Proof-or-Stop).
- `firecrawl research read-paper 2609.20474` [R-today, PP]: a terminal verifier rejected 83/137 invalid and withheld 16/92 correct; false pass 57.21% → 20.96%; Fixed vs word-count-matched Sham +7.17 pp (90% CI 1.15–13.36).
- `firecrawl research search-papers` × 2 (receipt-gated completion learned by a self-improving loop; evolved capability-token edges). Additional hits:
  - RegenHarness 2609.27612;
  - Compliance-Bounded Self-Evolution in credit pipelines 2610.10629;
  - SEA 2607.00871.

  None learns a completion gate from production signals.
- [V-today] https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/: 50 pipeline stages on Free; 32 MB sort; 100 ops/s; custom roles up to 30 s to deploy.
- [V-today] https://raindrop.ai/docs/platform/signals.md: refine "updates that signal in place, so the corrections carry over to new events"; a new signal backfills 90 days (sampled); 1 custom slot on Hobby, 10 on Pro.

**Checked today by role-played judges** [J-today]:
- https://raindrop.ai/docs/mcp/overview.md (`refine_signal`; `J-JAC` §2, `J-ARA` P8);
- https://www.mongodb.com/docs/manual/reference/command/collMod/ (`J-STE`, `J-BOS`);
- https://query.raindrop.ai/v1/openapi.json (`J-ARA` P3);
- `mongodb-js/mongodb-mcp-server` README v3.0.5 (`J-ARA` P6);
- https://api.drand.sh/public/latest (`J-ARA` P5);
- CBP CROSS (`J-ARA` P4, `J-JAC` §2);
- PILOT 2608.26530 body (`J-JAC` §2);
- PoPE 2607.12962 (`J-RSI`; extract in `scratchpad/rsijudge-final/pope.txt`).

**Corpus** (repo-relative):
- Rethink inputs:
  - `research/rethink/T-idea-{fusion, caselaw-v4, raindrop-winner-pattern, literature-frontier, contrarian-wildcard}.md`;
  - `research/rethink/T-closing-{fusion, caselaw-v4, raindrop-winner-pattern}.md`;
  - `research/rethink/T-judge-{jackson-raindrop, steffan-mongodb, bosco-aws, aram-modelence, cv-veteran, rsi-researcher}.md`.
- Literature review: `research/literature/LITERATURE-REVIEW-RSI.md` (Abstract, Open Questions, Emerging Trends, §7.0–§7.8).
- Raindrop winners: `research/raindrop-winners/RAINDROP-HACKATHON-WINNERS.md` v2 (§1, §2.5, §4.1–§4.5, §5.3–§5.6, §6).
- Plans and research:
  - `REEVALUATION.md` (§1, §7–§9);
  - `BLUEPRINT.md` (TL;DR, §1, §14);
  - `research/notes/01-BRIEF-key-findings.md`;
  - `research/debate/A3-why-they-won-synthesis.md` (via the cards);
  - `research/fresh-mongodb-raindrop-architecture.md` (Free limits, Raindrop plans);
  - `HACKATHON-RECOMMENDATION.md` (an independent pass that also recommends Expunge; it assumes a solo builder and an OpenDots base, and this file does not adopt either).
- The score table, Borda count, RSI picks and six final ballots supplied with this task.

**Evidence types, kept separate:**
- **Peer-reviewed:** the anchors listed in §2.3.
- **Preprints:** every other arXiv id.
- **Vendor:** Raindrop and MongoDB docs and posts, AWS.
- **Role-play:** every judge vote and score.
