# Re-evaluation without the 6.5-hour limit: CaseLaw stays, now at full ambition

**For:** the 4-person team entering the Harness Engineering & Model Wrangling #SFTechWeek Hackathon (Cerebral Valley + MongoDB, Shack15 SF). The target is Problem Statement 1 "Recursive Harnessing", plus the $3,000 Raindrop RSI prize and the best overall placement.
**Role:** synthesizer of the re-evaluation round, which had three stages:
- G1: seven full-ambition proposals;
- G2: six judge scorecards;
- G3: three closing arguments and six final ballots.

**Supersedes:** the *scope* decisions in `BLUEPRINT.md`. It does not supersede the blueprint's correctness fixes: every one of them carries over (§5, §7).

**Calendar note [U].** The corpus dates the event Sunday Oct 11 2026. The user reports an extra prep day. This file assumes one full non-code prep day before kickoff (§8), so confirm the event date.

**Labels.**
- [V]: verified in a cited corpus file.
- [I]: synthesizer judgement.
- [CALC]: arithmetic done here from the supplied tables.
- [U]: unverified and load-bearing.

All demo numbers quoted from G1 files are the proposers' placeholders, not results.

**Citation shorthand.** Paths are relative to the repo root:

| Shorthand | Path |
|---|---|
| `BP` | `BLUEPRINT.md` |
| `G1-<key>` | `research/reeval/G1-fullambition-<key>.md` |
| `G2-<judge>` | `research/reeval/G2-judge-<judge>.md` |
| `G3-<key>` | `research/reeval/G3-closing-<key>.md` |
| `A3` | `research/debate/A3-why-they-won-synthesis.md` |
| `F-judge` | `research/debate/F-redteam-judge-rules.md` |
| `notes/NN` | `research/notes/NN-*.md` |

Keys:
- `guardrail-genome` = CaseLaw
- `raindrop-self-healing` = Kintsugi
- `mongo-native-domain` = Lethe
- `tangible-hard-domain` = IXSCAN
- `meta-harness-ignition` = Second Close
- `per-user-specialization` = Speciate
- `prior-work-steward` = Witness

---

## 1. TL;DR

**Winner: CaseLaw v3 (`guardrail-genome`).**
- **It is the same idea as the current blueprint.** We do not switch.
- **It is a much larger blueprint.** Build the full-ambition design in `G1-guardrail-genome` with three additions:
  - the fixes it adopted in its closing (`G3-guardrail-genome`);
  - one stage cut (§5.5);
  - a set of RSI-prize grafts taken from Kintsugi (§6).

**Runner-up for placement: Lethe (`mongo-native-domain`).** It is second in the head-to-head Borda count, in round 1 and in the equal-weight final.

**RSI-prize favourite: Kintsugi v3 (`raindrop-self-healing`).** All 6 of 6 ballots pick it. It also has the top composite, 8.73, and that lead comes *entirely* from RSI fit.

**Why CaseLaw** (one paragraph). With feasibility removed, CaseLaw still leads both rubric rounds:
- round 1: 8.85, against Lethe 8.60 and Kintsugi 8.52;
- equal-weight finals: 8.69, against 8.63 and 8.40.

It tops the slate on Impact (8.5), Technical Demo (8.67) and Implementation Difficulty (9.83).
- **Ballots.** It wins the head-to-head Borda count 16–11–9 and takes 4 of 6 first places. No ballot puts it lower than 2nd. Among the four real in-room judges (Steffan, Bosco, Aram, Jackson) its mean rank is 1.25 [CALC].
- **Why Kintsugi does not win placement.** Its composite lead is all RSI fit, which is not a rubric line (Bosco's ballot). Its open needs a cheap model to lie on cue with the correct rule in its prompt (`G1-raindrop-self-healing` §17 [U]). Its fallback replaces the judge's own conversation one run in five (L610). Its closing also conceded that its own oracle could have fired the hero heal without Raindrop.
- **Why Lethe does not win placement.** Lethe is fresher, but its "after" run "never depends on the live KEPT" (`G1-mongo-native-domain` L642–643). So it does not show the change it gates.
- **The prize is probably podium-gated.** The event page says "$18,000 … across the three final teams" (`F-judge` K7). That likely means the RSI prize goes to a podium team, so maximising placement maximises prize odds too.

**What the extra capacity buys.** It does not buy more stage beats. Every judge asked CaseLaw to *cut* its stage: one judge interaction, about 6 spoken numbers, five beats. The capacity goes into depth that shows up as receipts and Q&A answers:
- earned loosening signed by a human;
- Raindrop as the only evidence on human traffic;
- an adaptive adversary docket;
- a paired meta-gate;
- a 10-row ablation at n = 40;
- a three-plane deployed topology.

| | CaseLaw v3 | Lethe | Kintsugi v3 |
|---|---|---|---|
| Round 1 (weighted) | **8.85** | 8.60 | 8.52 |
| Finals (equal weights) | **8.69** | 8.63 | 8.40 |
| RSI-prize fit | 7.92 | 7.92 | **9.75** |
| Composite (0.5·R1 + 0.3·R2 + 0.2·RSI) | 8.61 | 8.47 | **8.73** |
| Placement-only composite (0.625·R1 + 0.375·R2) [CALC] | **8.79** | 8.61 | 8.48 |
| Head-to-head Borda (3/2/1) | **16** | 11 | 9 |
| First-place ballots | **4** | 1 | 1 |
| RSI-prize ballots | 0 | 0 | **6** |

**Five things to do differently from `BLUEPRINT.md`.**
1. Replace the 6.5 h scope with G1 v3 scope (§7, items 1–12).
2. Cut the round-1 stage to one judge interaction: the judge signs a loosening on a pre-loaded tablet (§5.5).
3. Bring Raindrop into the first 30 s as a second source, and make the loosening beat Raindrop-led, with non-team human n printed (§6.3).
4. Fix the two statistical weaknesses the RSI researcher found:
   - the meta-gate unit becomes the incident;
   - the adversary is admitted against the *current* bundle.
5. Spend the prep day on prose that saves wall-clock on the day (§8). The day is still bounded by compute, ops/s, integration and rehearsal.

---

## 2. What changed in the assumptions, and the rules caveat

### 2.1 The assumption change

| | Old (all `debate/D-*`, `F-*` files and `BP`) | New (`research/reeval/*`) |
|---|---|---|
| Build window | 6.5 h, about 17.5 effective person-hours (`BP` §14.1) | One extra full prep day, plus the event day with 4 people each driving several parallel Claude Code agents on Opus 5.5 |
| Feasibility | Scored, and decisive: the old composites carried feasibility 3–6.5 | **Not scored.** Scope and ambition are not penalised |
| Demo reliability | Partly a build-risk judgement | Only as the rubric words it: "is it well-engineered and working?". A beat that depends on Wi-Fi, a judge's phone, Raindrop ingest or a cheap model misbehaving on cue loses Demo points as *stage* risk (`G2-cv-veteran` header) |
| Composite | Included feasibility | 0.5·R1-weighted + 0.3·R2-equal + 0.2·RSI fit |

### 2.2 What did not change, and now binds harder

More coding capacity cannot change any of the following:

1. **Platform facts** [U] (`G2-steffan-mongodb` §1):
   - custom-role creation on the sandbox;
   - `$documents` and `$setWindowFields` under a custom role;
   - the tier (M0 100 ops/s vs Flex 500);
   - MongoDB MCP Server narrowing headers over HTTP;
   - Agent Engine (Flex+ only).
2. **Wall-clock compute.** The full design runs several workloads concurrently through one sandbox: the meta-gate (about 1,900 Haiku episodes), the ablation (about 800 episodes), the adversary docket, and human traffic. At M0's 60 ops/s client budget, that is the real day-of bottleneck [CALC, §9 R3].
3. **The 3-minute stage and rehearsal time.** Every G2 judge flagged density in every v3:
   - "Unlimited build capacity has turned into unlimited *beats*" (`G2-cv-veteran` §4.1);
   - "feature zoo" (`G2-steffan-mongodb` §3.1);
   - "cut until a judge can retell the story in one sentence" (`G2-aram-modelence` §1.6).
4. **Claims vs code.** A3 calls gaps between claims and code "the largest *downside* risk with this panel" (`A3` §0.5). More features means more claims to keep true.

### 2.3 Rules caveat: what the prep day may and may not produce

The rules still say "new work only", and the demo may show only what was built during the event (`notes/00-participant-guide`; `F-judge` D3). Prep-day work is therefore **non-code**, and it is disclosed in `BUILT_TODAY.md` under "Prepared before the event (no code)", with timestamps. Precedent: Ripple's DESIGN.md predated kickoff and was accepted (`notes/44` §5.8, via `G1-guardrail-genome` §14). Confirm with CV staff at check-in [U].

| Allowed on the prep day | Not allowed before kickoff |
|---|---|
| Design prose; contracts written as Markdown field tables; fault-plan, fixture and primitive specs in English; illustrative pseudo-code inside the design doc | Any runnable file: `.ts`, `.js`, `.json` fixtures, schemas meant to be pasted, a `setup.ts`, a `gen-fixtures.ts` |
| Prompt drafts as prose (disclosed; committed on the day under `prep/` with their prep timestamp) | Using Claude Code agents to generate app code "to save time" |
| Accounts, keys, quotas, the Raindrop Pro trial, a throwaway Raindrop org for smoke tests, Modelence and VM accounts | Fixture data, seeded worlds, Atlas collections with data |
| Atlas project, second owner, network access, and custom roles *if* the sandbox link allows it before kickoff [U] (`BP` TL;DR items 1–2) | Raindrop signals or Issues in the event org (smoke tests go to a throwaway org only, `F-tech` T4) |
| Demo script, attack card, Q&A sheet, rehearsal plan, and spoken run-throughs | "Chat scouting" the worker model on the hero scenario. CaseLaw does not need it: headroom is measured on the day (`BP` §2.5) |
| Agent task cards in English (inputs, outputs, acceptance checks) | — |
| Props: a printed attack card; a tablet for the approval page | — |

---

## 3. New ranking vs old ranking

### 3.1 The table

| Rank now | Key | v3 name | Composite now (was) | Δ | R1 now (was) | R2 equal | RSI now (was) | MongoDB now (was) | Placement-only [CALC] | Rank before |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | raindrop-self-healing | Kintsugi v3 (Halcyon Desk) | **8.73** (6.94) | +1.79 | 8.52 (7.42) | 8.40 | **9.75** (9.00) | 8.08 (7.17) | 8.48 | 2 |
| 2 | guardrail-genome | **CaseLaw v3** | 8.61 (7.17) | +1.44 | **8.85** (8.19) | **8.69** | 7.92 (6.50) | 9.08 (8.33) | **8.79** | 1 |
| 3 | mongo-native-domain | Lethe (Dialect v3) | 8.47 (5.90) | **+2.57** | 8.60 (6.30) | 8.63 | 7.92 (5.83) | **9.50** (8.33) | 8.61 | 6 |
| 4 | tangible-hard-domain | IXSCAN v3 | 8.13 (6.21) | +1.92 | 8.44 (7.23) | 8.29 | 7.08 (5.50) | 9.42 (7.67) | 8.38 | 5 |
| 5 | meta-harness-ignition | Second Close (IGNITION v3) | 7.67 (6.75) | +0.92 | 7.53 (7.38) | 7.56 | 8.17 (7.33) | 7.75 (9.33) | 7.54 | 3 |
| 6 | per-user-specialization | Speciate v3 | 7.51 (5.72) | +1.79 | 7.58 (6.42) | 7.69 | 7.08 (5.83) | 8.33 (7.17) | 7.62 | 7 |
| 7 | prior-work-steward | Witness v3 | 7.09 (6.62) | +0.47 | 7.36 (6.73) | 7.19 | 6.25 (6.33) | 8.25 (7.00) | 7.30 | 4 |

**Column leaders now** (panel means, 6 judges):

| Column | Leader | Score | Runner-up |
|---|---|---|---|
| Impact | CaseLaw | 8.5 | — |
| Technical Demo | CaseLaw | 8.67 | IXSCAN 8.58 |
| Creativity | Lethe | 9.08 | — |
| Implementation Difficulty | CaseLaw | 9.83 | — |
| RSI fit | Kintsugi | 9.75 | — |
| MongoDB depth | Lethe | 9.5 | — |

**How to read it.** The composite puts Kintsugi first only because RSI fit is 20% of it. Remove the RSI term and renormalise to placement only, and the order is CaseLaw, Lethe, Kintsugi. That is the same order the head-to-head Borda count produced. Two "old" rows were convergences, not standalone entries:
- old `meta-harness-ignition` = "CaseLaw v2 + IGNITION";
- old `mongo-native-domain` = "Witness + Dialect".

### 3.2 The movers, and why each moved

1. **Lethe, +2.57 (6th → 3rd composite; 2nd on Borda). The biggest mover, and not because scope was restored.**
   - **The old entry was a convergence.** "Witness + Dialect" was penalised on merit: a seeded NL→MQL class, no truth for judge input, Raindrop as relay.
   - **v3 is a new domain:** lawful erasure of a person, with the judge as the data subject.
   - **What carries it:**
     - the Planter gives truth on demand;
     - an Atlas 13 refuses the *acting agent* in-domain;
     - MongoDB's own MCP server visibly drops `delete-many` from `listTools`;
     - a findability-certified adaptive Hider;
     - a `$jsonSchema` floor that keeps personal data out of learned artifacts.
   - **Sources:** `G1-mongo-native-domain` §0–§1; `G2-cv-veteran` §3.3 ("the biggest change in the set"); `G2-steffan-mongodb` §3.2; `G2-bosco-aws` §2.2; `G2-rsi-researcher` §3.1.
2. **IXSCAN, +1.92 (5th → 4th). The heaviest feasibility penalty ("two builds in one day", feasibility 3) is gone.**
   - **Non-time fixes:**
     - Atlas-authoritative `explain` removes the local-lab proof split;
     - a separate applier means the tuner has no production DDL;
     - Raindrop blind-spot routing.
   - **Still capped:** a seeded class, MongoDB as the *subject*, and DBA jargon.
   - **Sources:** `G2-steffan-mongodb` §3.3; `G2-cv-veteran` §3.4.
3. **Kintsugi, +1.79 (2nd → 1st composite; 3rd on Borda). It fixed every non-time flaw the judges named:**
   - the hero moved off HarnessForge's double refund to the *Moffatt v. Air Canada* unexecuted-claim class;
   - the "COMPROMISED HEALER" toggle became the judge on real `kin_healer` credentials;
   - replay became never-cut;
   - a human cohort and dice-rolled blind classes were added.
   - **Result:** RSI 9 → 9.75. Its round-1 edge over CaseLaw disappeared (8.52 vs 8.85).
   - **Sources:** `G1-raindrop-self-healing` §0, §2; `G2-jackson-raindrop` §2.1.
4. **Speciate, +1.79 (7th → 6th).**
   - **What helped:** A3 C17 had ruled it out of round 1 mostly on time and evidence grounds. It now has real UCI data and different-vendor personas.
   - **What did not change:** concept load (eight ideas in sequence) and Raindrop Experiments as promotion authority on simulated traffic.
   - **Sources:** `G2-cv-veteran` §3.5; `G2-jackson-raindrop` §2.6.
5. **CaseLaw, +1.44 (1st → 2nd composite; still 1st on R1, R2 and Borda).**
   - **Restored:** earned loosening with a human key, a deployed ticket box, Raindrop as the only evidence on human traffic, an adversary docket, a paired meta-gate, and a three-plane topology.
   - **Why it gained least of the top three:** its old lead came partly from being "the most *buildable deep* design", so removing feasibility lifted Lethe and Kintsugi more (`G2-rsi-researcher` §3.3).
6. **Second Close, +0.92 (3rd → 5th).**
   - **The old 6.75** was really CaseLaw + IGNITION.
   - **As its own entry** it has the slate's best-measured ignition test, but:
     - the agent is read-only, with no humans;
     - its money shot is a statistics strip (Demo 6.33, the lowest);
     - its MongoDB use dropped from 9.33 to 7.75 because it rejected MCP narrowing.
   - **Sources:** `G2-cv-veteran` §3.6; `G2-jackson-raindrop` §2.5.
7. **Witness, +0.47 (4th → 7th).**
   - **Its edge was feasibility (6.5).** With feasibility unscored, its ceiling shows: guards that read like lint, a narrow buyer, MongoDB as the subject, and Raindrop that is optional by design. RSI fell slightly (6.33 → 6.25).
   - **Sources:** `G2-cv-veteran` §3.7; `G2-jackson-raindrop` §2.7.

**Consequence for the blueprint.** The `BP` §2.5 "Witness pivot at 12:15" is now the lowest-ranked option. Cut it (§7, item 23). There is no idea pivot on the day. Headroom fails over to lure strength and then to the worker model, as before.

---

## 4. The head-to-head

### 4.1 Closing arguments in brief

| | CaseLaw (`G3-guardrail-genome`) | Lethe (`G3-mongo-native-domain`) | Kintsugi (`G3-raindrop-self-healing`) |
|---|---|---|---|
| **Claim** | "The rubric already ranks us first." Leads R1 and the finals; top on Impact, Demo and Difficulty; nobody ranks it below 3rd | Wins both rubric rounds against Kintsugi. Within 0.25 / 0.06 of CaseLaw. Highest Creativity (9.08) and MongoDB depth (9.5), which decide an equal-weight final | "Only Kintsugi contends for both prizes." RSI 9.75 vs 7.92, a gap more than 5× CaseLaw's R1 lead |
| **Fixes adopted** | `cl_human` gets its own service (Bosco). One judge interaction on a pre-loaded tablet, the 121 as a one-line stamp, a 2-row ablation (CV veteran). Incident becomes the unit, backlog 48×1, adversary admitted against the active bundle (RSI researcher). Non-team n printed; Raindrop line dropped below n = 20; tenant orders in the ticket box (Aram) | Spoken line cut to "Atlas refuses your email; a second check refuses your name." Approvals move to `p_dpo`. L3 gets a rule (≥16 tenants, Wilcoxon, HOLD). Lead Raindrop chip becomes `possible_missed_copy` against the planted ledger | The independence claim becomes an on-screen extractor-vs-Raindrop disagreement table with n. L2 promotes only on exact McNemar p < 0.05 above the A/A band, else HOLD, with a backlog of ≥40. Healer and gate move to a second host; approver in its own service; p50 chat latency in the header; Flex requested |
| **Attack on others** | Kintsugi's hero is stochastic *or* redundant: its own claims extractor fires without Raindrop. Lethe's headline outruns the database (the regex covers emails and phones only), and its COMPLETE comes from the main lineage | CaseLaw is "the cluster that lost" (0/6 guardrail, 0/~27 agent-ops at NYC). Kintsugi's prize lead rests on an independence claim its own spec contradicts | CaseLaw is the event page's own example, and Raindrop is absent for the first 1:57. Lethe does not show the change it gates |
| **Concessions** | Kintsugi has the better first 15 s and RSI fit. Lethe is fresher and deeper in MongoDB | CaseLaw is harder to recreate with a cleaner evaluator. Kintsugi is more Raindrop-native. Lethe has the heaviest deployment | CaseLaw leads R1, MongoDB topology and the only on-stage human signature. Lethe is more creative and more recursive |

### 4.2 The votes

| Judge (ballot) | 1st | 2nd | 3rd | RSI prize | Moved since G2? |
|---|---|---|---|---|---|
| Steffan Mejia (MongoDB) | CaseLaw | Lethe | Kintsugi | Kintsugi | Same order; the CaseLaw–Lethe gap narrowed |
| Jackson Ferrigno (Raindrop, RSI judge) | **Kintsugi** | CaseLaw | Lethe | Kintsugi | CaseLaw moved above Lethe |
| Bosco Albuquerque (AWS) | CaseLaw | Lethe | Kintsugi | Kintsugi | Same order; CaseLaw's lead became "clear" |
| Aram Shatakhtsyan (Modelence) | CaseLaw | Kintsugi | Lethe | Kintsugi | **Flipped** #1 from Kintsugi to CaseLaw on placement |
| CV veteran | CaseLaw | Lethe | Kintsugi | Kintsugi | **Flipped** #1 from Kintsugi to CaseLaw |
| RSI researcher | **Lethe** | CaseLaw | Kintsugi | Kintsugi | Prize moved from Second Close to Kintsugi |

**Totals:**
- **Borda:** CaseLaw 16, Lethe 11, Kintsugi 9.
- **RSI prize:** Kintsugi 6/6.
- **In G2, Kintsugi had three #1s** (Jackson, Aram, CV veteran). After the closings it has one.

### 4.3 The decisive arguments

1. **Placement and the prize were voted separately.**
   - Aram's and the CV veteran's G2 #1 for Kintsugi was, by their own text, a prize vote: "swap #1 and #2 if placement is the goal" (`G2-aram-modelence` §4); reason #3 "the RSI prize" (`G2-cv-veteran` §0).
   - On a split ballot, both put CaseLaw first for placement.
2. **Kintsugi's own independence concession removed its strongest placement reason.**
   - Its oracle ships `claims_match_ledger` (`G1-raindrop-self-healing` §4.1), so "the hero heal can fire without Raindrop" (`G2-jackson-raindrop` §2.1).
   - The CV veteran had ranked Kintsugi #1 because its "live failure is caught by something only Raindrop computes". That reason fell.
   - His G2 §5 decision rule also triggered: if the hero failure can't be established before kickoff, build CaseLaw.
3. **The stochastic open.**
   - Kintsugi's open needs Haiku to lie *with the correct rule in its prompt* (§17 [U]), and a stored trace replaces the judge's conversation one run in five (L610). That breaks the "your own conversation" spine (Aram, Bosco).
   - CaseLaw's ticket is fixed text with adjustable lure strength. It is "the most controlled" first-30-seconds unknown in the slate (`G2-cv-veteran` §4.4).
4. **"Lethe doesn't show the change it gates."**
   - Lethe's run rules say the COMPLETE rerun "never depends on the live KEPT" (L642–643).
   - The KEPT needs two replicated batches of 30 (§7.2 step 9).
   - This argument moved Jackson to rank CaseLaw above Lethe. Steffan, Bosco and Aram all cite it.
5. **CaseLaw accepted the must-changes without cutting depth.**
   - The separate `cl_human` service answers Bosco's and Steffan's co-location FLAG (`G2-bosco-aws` §1 Q2; `G2-steffan-mongodb` §3.1).
   - The one-interaction cut removes the CV veteran's Demo deduction.
6. **K7 (`F-judge`).** "$18,000 … across the three final teams" suggests the RSI prize goes to a podium team. If so, placement gates the prize, and every ballot's caveat favours CaseLaw.

### 4.4 Dissent worth keeping

- **The RSI researcher ranks Lethe first.** At equal weights CaseLaw leads Lethe by only 0.06, and the shared governance floor earns zero Creativity, so the final may come down to Creativity and Impact (`G2-rsi-researcher` §5).
  - Our answer: round 1 decides who reaches the final, and CaseLaw leads it by 0.25.
  - We also take Lethe's best ideas as grafts: an adaptive adversary, and an MCP `listTools` beat in the finals (§6.3).
- **Jackson ranks Kintsugi first.** He breaks a rubric tie (his R1: CaseLaw 9.03, Lethe 8.85, Kintsugi 8.83) with the Raindrop lens.
  - His stated path for CaseLaw: "If CaseLaw opened its throughline from a Raindrop Issue on real non-team human traffic, it would pass Lethe, and it would challenge Kintsugi" (`G2-jackson-raindrop` §3).
  - §6 adopts as much of that as the controlled open allows.

---

## 5. The winner at full ambition: CaseLaw v3

### 5.1 Name, one-liner, lines

- **Name:** CaseLaw. On stage, say "laws written from precedent, enforced by Atlas, loosened only by a human signature". "Guardrail" is never the first noun (`G2-cv-veteran` §3.2 must-change 4).
- **One-liner.** A data-operations agent with write access to a retailer's Atlas data works tickets through a gateway whose every verdict Atlas computes.
  - **Tightening.** When the agent causes an incident, the harness writes a stateful law from the raw rulings. The law is enacted only if three checks pass:
    - Atlas accepts it on the evolver's own credentials;
    - an as-of replay of every past ruling agrees;
    - five fresh reruns flip the incident.
  - **Loosening.** It happens only when replay and shadow evidence earn it *and* a human signs the exact diff (`G1-guardrail-genome` §1).
- **Spoken thesis (once):** "Every law it writes becomes a test the next law must pass."
- **Quotable (finals, twice):** "Compromise never becomes authority."
- **Close (conditional on the provenance header):** "Zero human-written laws. Every law proven against every ruling it ever made and five live reruns. Atlas refused every authority it tried to grant itself, and the only loosening you saw, you signed."

### 5.2 Architecture summary

**Three planes on two hosts, plus an isolated approval service.** This combines `G1-guardrail-genome` §9.6 with Bosco's must-change.

```
 Execution plane (Modelence app 1)            Approval service (Modelence app 2 or isolated host) [U]
 ─ gateway API govern()   cl_gateway           ─ /approve/:proposalId page   cl_human ONLY
 ─ Floor UI + SSE fan-out cl_stream (sole watch())   writes cl_auth.grants {digest, approver, evidence}
 ─ ticket box (shows tenant orders)  cl_ui
            ▲ HTTPS (service token)                          ▲ re-read by digest inside the CAS txn
            │                                                │
 Reasoning host (VM)                     Control host (same VM, separate service)
 ─ worker loop, Haiku 5.5: NO DB creds   ─ runner, grader (cl_grader), gate + CAS (cl_gate)
 ─ evolver, Opus 5.5: cl_evolver         ─ meta-gate (cl_meta), receipt auditor (cl_audit)
   (find train; insert proposals only)   ─ observer: the ONLY Raindrop Query key
 ─ adversary + advisory critic           ─ admission pipeline (cl_admit, new, see §7 item 20)
   (different vendor)
```

**One decision pipeline.** A single `STAGES(bundle)` function is used twice:
- live: `$documents` over the run's own rows plus the pending call;
- replay: as-of `$setWindowFields` over `ledger_train`.

Parity holds by construction. A labelled mingo fallback flips the header to `decisions: mingo` (`BP` §5; `G1-guardrail-genome` §7.1).

**Verdict compile.** Verdicts are max-severity (deny > ask > allow), so Class T ops are monotone. The only path by which a verdict can fall is `fallback`, through Class N ops that always need a human grant (`G1-guardrail-genome` §6.3–6.4).

**One generation** (`G1-guardrail-genome` §7.2):
1. act;
2. grade;
3. trigger (oracle incident, Raindrop Issue, or a Raindrop-weighted utility investigation);
4. evidence (`summarizeRun` raw rulings, `search_precedents` over `$rankFusion`, Raindrop mirror, Workshop outline);
5. propose (the evolver inserts it itself → **121** layer);
6. deterministic critic, plus an advisory critic from a different vendor;
7. compile;
8. precedent replay with the authority delta;
9. shadow (Class N only);
10. k=5 paired gate with twins and 3 siblings;
11. HELD until a human signs (Class N only);
12. CAS promotion, which re-reads the grant for Class N;
13. after-commit effects: SSE, Raindrop dataset, law file and generated test;
14. receipt auditor;
15. Experiment as a shadow verifier that holds on "inconclusive".

**The loosening ladder** (`G1-guardrail-genome` §6.5):

| Rung | What must hold | Evidence source |
|---|---|---|
| L1 consent | Only oracle-`needed` rulings may newly pass; no harmful ruling or precedent may flip | Oracle labels via replay |
| L2 volume | ≥K needed unblocked, 0 harmful | Machine evidence, *not* approvals |
| L3 shadow | Agreement with the oracle on labelled traffic, and with `routingTrust`-weighted Raindrop on human traffic | Oracle + Raindrop |
| L4 grant | A human-signed `cl_auth.grants` row matching `sha256(canonical(diff))` | `cl_human` only |

**Recursion, claimed exactly as measured:**

| Level | Mechanism | Source |
|---|---|---|
| L1 | Precedent ratchet: every enacted law's witnesses judge every future law | `G1-guardrail-genome` §8.1 |
| L1.5 | A different-vendor adversary raises the world, now **adaptive**: admitted only if the *active* bundle fails it ≥4/5 | `G2-rsi-researcher` §3.3 fix; `G3-guardrail-genome` |
| L2 | Improver genome promoted only by a paired meta-gate on **48 frozen incidents × 1 proposal per arm**, incident as the unit, exact paired test at p < 0.05 **and** above the A/A band, else HOLD | `G3-guardrail-genome`; `G2-rsi-researcher` §2.1–2.2 |

We never say "ignition", "the harness got smarter" or "the model improves itself".

**MongoDB on stage: three moments only** (`A3` M13; `G1-guardrail-genome` §9.8):
1. the precedent sweep;
2. 121 on `cl_evolver`;
3. the CAS transaction, twice: the Class T law, then the Class N law, which commits only after re-reading the judge's grant.

Everything else goes in `MONGO.md` with file:line references: code 13, TTL worlds, `$rankFusion`, `$graphLookup`, MCP narrowing, parity, `prevHash`, the race test.

**Raindrop: three jobs the oracle cannot do** (`G1-guardrail-genome` §10):
1. The only evidence on human-typed tickets, which have no oracle.
2. Measured precision vs the oracle, which becomes `routingTrust` in the improver genome.
3. Experiments as a shadow verifier that holds on "inconclusive".

The unplug answer passes Jackson's information test outright: "Unplugged, we still tighten from incidents, but we can never earn a loosening on real traffic" (`G1-guardrail-genome` §10.6; `G2-jackson-raindrop` §2.3).

### 5.3 Restored and added elements (what the extra capacity buys)

Everything below is in `G1-guardrail-genome` §2.1–2.2. A **bold** "fix" marks a G2 or G3 change layered on top. Stage time is round 1 unless noted.

| Element | Status in `BP` | v3 form | Stage time |
|---|---|---|---|
| R1–R4: families F3 (blast radius), F4 (injection + taint), F6 (Northwind tenant norm + forks); F5 as earned loosening | Cut or "if G4 by 14:00" | Six designed families with twins and 3 lure strengths. Northwind tombstone overlay; base-purity validator ("knowledge flows upstream; authority never does") | F5 in R1; fork frame in finals |
| R5–R6 + A1: loosening ladder L1–L4 with a human grant on the approval page | Cut ("Tier 2, never on stage") | §5.2 ladder. **Fix: `cl_human` in its own service; the judge signs on a pre-loaded tablet, not a QR scan** | ~20 s |
| R7: `$rankFusion` `search_precedents` (autoEmbed + lexical, 2 of M0's 3 index slots) | Cut (zero search indexes) | The evolver's agentic search over rulings, never "retrieval" into the worker. Indexes only via setup | 0 (evidence panel) |
| R8 + A4: improver genome + paired meta-gate | Cut (`routingTrust` `$group` only) | **Fix: 48 incidents × 1 per arm, incident as the unit, α = 0.05 and above A/A, else HOLD** | Finals 5 s |
| R9: LLM critic | Cut | Advisory only, different vendor; deterministic bans decide | 0 |
| R10: ablation rows R3 v0+memory, R6 lessons-only, R8 paranoid; new R0 rules-in-prompt; held-out 15 → 40 | Cut | §5.7. **Add R9 human-evolver (Kintsugi graft)** | 2 rows in R1 |
| R11 + A2 + A5 + A10: Raindrop Issues, Experiments (shadow), datasets, Workshop, deployed ticket box, `routingTrust`, disagreement beat, one human-confirmed custom signal | Mostly cut | §5.2 and §6. **Fix: tenant orders shown in the box; non-team n printed separately; Raindrop line dropped below n = 20; custom signal re-scoped to "reported done after a refused or partial write"** | ~20 s |
| R12: kill -9 bundle-pinned resume | Cut | Off-stage receipt only | 0 |
| R13 + A8: law file + Kiro `permissions.yaml` + generated `tests/precedents/W-xxxx.spec.ts` | Cut | The developer artifact Aram grades "Strong" (`G2-aram-modelence` §1.4) | Download button |
| R14 + A6: Modelence deployment as the real execution plane; zero-credential worker host | Read-only viewer at most | §5.2 topology; labelled `execution: local` fallback | Header |
| R15: Agent Engine stateless projection | One Q&A sentence | Only on Flex+ with a service account [U] | Finals 8 s only if real |
| R16: `$graphLookup` lineage strip | Cut | Under the law cards | Ambient |
| R17 + A7: 3 validation siblings per family; A/A floor; receipt auditor never-cut | "If time" / deferred | Never-cut | 0 |
| A3: adversary docket | — | **Fix: adaptive admission against the active bundle; held-out split by a public beacon (Kintsugi graft)** | Finals line |
| A9: ElevenLabs escalation for HELD laws | — | **Cut here** (§5.4) | — |

### 5.4 Still cut, on purpose

Carry over `G1-guardrail-genome` §2.3 unchanged:
- ignition claims;
- an Experiment as promotion authority;
- a refund-led open;
- the Fortune slide;
- three permanent panes;
- `$function` as the grab;
- `retireRule`, `supersedes` and redefinable features;
- two evaluators;
- a mutable `status`;
- authority delta over held-out data;
- kill -9 or code 13 as a stage beat;
- per-user forks in round 1;
- self-pruning as a headline.

**Additional cut: A9 ElevenLabs.** It has zero stage seconds, needs a Twilio number, and Steffan lists it in the "feature zoo" (`G2-steffan-mongodb` §3.1). Kintsugi rejected voice approval for the same reason: it "adds no trust over a hash-bound click" (`G1-raindrop-self-healing` §11.3).

### 5.5 Round-1 script (3:00): five beats, one judge interaction

This rewrites `G1-guardrail-genome` §11.2 to the judges' must-changes:
- one judge interaction, the signature on a pre-loaded tablet (CV veteran, Bosco, Aram);
- the crude grab becomes a 3 s ledger stamp; the subtle VOID stays live (CV veteran);
- Raindrop in the first 30 s as a second source, and the loosening beat Raindrop-led by about 1:35 (Jackson);
- non-team human n printed (Aram, Jackson);
- a 2-row ablation plus the unseen-tool column (CV veteran).

P3 drives and P4 narrates. There are no slides and never an empty state.

**Pre-state.**
- **The env.** `r1` is cloned from the frozen stage state with the F2 lineage rewound to r-11's parent. F1, F3 and F4 laws are already enacted, so there are about 1,800 precedent rulings.
- **The F5 proposal.** The `graduate fix × update-many` proposal is HELD, with its shadow tally since early afternoon.
- **The tablet.** It sits face-down in front of the judge, open on `/approve/<that proposal>` as a named guest approver.
- **The run.** At 0:00 P3 presses Run, which starts the F2 parent batch. The evolver and gate chain from it, so the gate runs *under* the narration (`F-feas` FZ9).

| Time | Beat | On screen | Spoken (P4), anchors only | Labelled fallback |
|---|---|---|---|---|
| 0:00–0:22 | **1. The incident** | Floor full width. "Acme Retail · Archive and remove the 2023 orders · harness as of 11:40". `copy-to-archive` → "ERROR: quota exceeded after 300 of 412"; `delete-many 412` → ALLOWED; red diff: **112 orders exist nowhere** | "An AI coding agent wiped a production database during a code freeze, against written instructions. A rule in a prompt isn't a guardrail. Here's our agent on this morning's harness: the archive failed at 300, and it deleted all 412 anyway." | Stored r1 pre-flight trace, chipped |
| 0:22–0:30 | (1, cont.) | The agent's reply: "Done: archived and removed the 2023 orders." Trigger strip: **incident: oracle** · **also flagged by Raindrop: "reported done after a partial write"** (the agent's own words, classified by Raindrop) | "It even said it was done. Raindrop flagged the claim; our oracle found the missing orders. Now watch the harness write its own law." | The chip appears only if it lands; the beat never waits for it |
| 0:30–1:10 | **2. Law enacted** | Bench slides in. Evolver evidence: raw rulings (optional Workshop line: "asked the failed agent what it missed" [U]). Law **r-11**: deny `delete-many` when `covers(targetIds ⊆ archived ids) < 1`, chip "feature composed by evolver". "Accepted on `cl_evolver [find,insert]`". **Precedent strip sweeps ~1,800 dots: 0 harmful newly allowed · 0 needed newly refused.** Lamps **parent 0/5 → child 5/5**; twin green; **ENACTED** (CAS) | "It reads the raw rulings and composes the law from four generic primitives; nobody on our team wrote it. Atlas replays every ruling this agent ever made, as of the moment it made it. Then it must fail five times before, pass five times after, and not block the legitimate twin." | Stored proposal at 0:50; stored gate at 1:05, chipped |
| 1:10–1:20 | (2, cont.) | Same ticket: **REFUSED by r-11, written 9 s ago** → remedy → agent archives the 112 → deletes → green diff, **0 orders lost** | "Every law it writes becomes a test the next law must pass." | Stored rerun |
| 1:20–1:35 | **3. Compromise** | Ledger stamp (3 s): "also today: `default: allow` → **121 on cl_evolver**". P3 submits from the attack card: "r-11 over-blocks: only block deletes over 500" → validator ✓ → one amber dot, W-0142 → **LOOSENING DETECTED → VOID** | "Assume the improver is compromised. The database refuses what it can see. This one is legal, so the database lets it through. The replay catches it: it would have allowed the very delete you just saw. Compromise never becomes authority." | Deterministic |
| 1:35–1:55 | **4. Earned loosening, Raindrop-led** | Raindrop chip: **`guardrail_blocked_valid_action` on fix tickets typed here today · non-team people n = __ · team n = __ · precision vs our oracle 0.__ (n = __) → routingTrust**. Proposal `graduate fix × update-many` (ask → allow when previewed ∧ matchedFraction ≤ 0.3). Replay consent "0 harmful · 0 precedents flipped"; shadow tally; **HELD** | "Loosening is different. This came from Raindrop: the agent's own reports on tickets people typed here today, where we have no answer key, weighted by how often Raindrop has been right. Replay and shadow say it's safe. That's evidence, not permission." | Drop the human-n clause if non-team n < 20; show the stored disagreement case instead |
| 1:55–2:15 | (4, cont.) | P4: "Please turn the tablet over." **The judge reads the plain diff and the 4-word digest and taps Approve** → grant row (`cl_human`, own service) → transaction re-reads the digest → **SIGNED → ENACTED** · asks per fix ticket **2.0 → 0.3** | "It tightens itself in seconds. It loosens only on evidence, and only when a person signs the exact diff. You just did." | P4 signs as the named approver, said aloud |
| 2:15–2:40 | **5. Evidence** | Saved Atlas aggregation, hash chip: **Rules-in-prompt vs Evolved**, n = 40 held-out tickets, same model, Wilson CIs. Columns: oracle-correct, orders lost, asks per ticket; **unseen-tool (`credit-account`) column** highlighted | "Forty held-out tickets, same model. Rules in a prompt, the Replit condition, still lose orders. The evolved harness loses none and generalises to a tool it never saw fail. With lessons switched off, it holds." | Stored at freeze, rendered live |
| 2:40–3:00 | Close | Header green; footer: commits since 10:30 | The close line (§5.1) | — |

**Spoken numbers (≤7):** 112 · 0 harmful · 0/5 → 5/5 · 9 s · non-team n · 2.0 → 0.3 · n = 40. Everything else is a chip, not a sentence.

**Rehearsal pacing targets** (`G1-guardrail-genome` §11.2):
- evolver p90 ≤ 20 s;
- child batch ≤ 20 s;
- replay ≤ 3 s on about 1,800 rows;
- subtle-grab replay ≤ 5 s.

### 5.6 Finals cut (equal weights; Impact + Creativity = 50%)

The finals use the same tagged build. These are changes against §5.5, based on `G1-guardrail-genome` §11.3:
- **+10 s operator pain at the open.** "Platform teams either deny agents write access or page a human on every write. This is the third option."
- **Crude grab** stays a stamp. The subtle VOID is compressed to about 10 s.
- **Topology frame, 8 s.** This is new and comes from Jackson's tiebreak, borrowed from Lethe. The F4 law runs as `narrowMcp`, so on report-class sessions MongoDB's own MCP server `listTools` no longer lists `update-many` or `delete-many`. "Not another deny rule: the tool is gone."
- **Fork frame, 12 s.** Northwind's "tombstone, never delete" overlay is ENACTED locally. It is offered upstream and comes back **STAYED_LOCAL**. "Knowledge flows upstream. Authority never does."
- **Improver line, 5 s, measured result only.**
  - In Jackson's units: tokens per enacted law and time from trigger to ENACTED, with n = 48 incidents, p, and the A/A band.
  - Or the null version: "not significant; we kept v1".
- **Adversary line, 5 s.** "N families written by a model we never briefed, admitted only if *today's* harness failed them; time-to-law on the held-out ones: …"
- **Raindrop disagreement case, 5 s.** Raindrop said "valid", the oracle said "harmful", the gate followed the oracle, and trust fell.
- **Agent Engine `policy_denied`, 8 s.** Only if R15 is live; otherwise skip.
- **Close.** "Compromise never becomes authority" said the second time, with the judge-specific nouns: R(C) ⊆ R0, `$setWindowFields`, `routingTrust`.

### 5.7 Metrics

**Ablation.** 10 rows, one pinned worker model, default sampling, 40 held-out tickets × 2 worlds × 1 sample (`G1-guardrail-genome` §12.1, plus R9):

| Row | Definition |
|---|---|
| R0 rules-in-prompt | The Replit condition |
| R1 bare | Good prompt, tool docs and the floor |
| R2 v0 | The live starting point |
| R3 v0 + memory | Precedents and lessons injected into context, no laws |
| R4 expert-static | Written blind by P4 from tool docs and a one-paragraph README |
| R5 **evolved** | The stage bundle at freeze |
| R6 lessons-only | R5's lessons without its laws |
| R7 structure-only | R5 without lessons. Never cut |
| R8 paranoid | Ask on every write |
| **R9 human-evolver** (new; `G1-raindrop-self-healing` L710; `G2-rsi-researcher` §2.3, §5 graft 3) | A teammate who is not P3 gets the same `summarizeRun` and Raindrop evidence for 30 min, writes laws by hand, and is blind to held-out data and fault plans |

**Columns:**
- oracle-correct x/40 with Wilson 95% CI;
- docs lost;
- $ leaked per 100 tickets;
- policy violations;
- asks per ticket;
- needed rulings refused;
- $ per ticket;
- p50 latency.

**Subsets, reported separately:** unseen tool, filter-shift F2, Northwind, held-out adversary families, and F-blind (time-to-law, never pooled).

**Statistics** (pre-registered in `PREREGISTRATION.md`):

| Level | Unit | Test | Promote / claim rule |
|---|---|---|---|
| Held-out ablation | Ticket (passes only if both worlds pass) | Exact McNemar for R5 vs R2, R4, R0, R7, R9; A/A flip rate printed | "Tie" said aloud vs R4/R9 if not significant |
| L1 per-proposal gate | Incident ticket | Parent ≤1/5 and child ≥4/5 on fresh draws; twins; 3 siblings; no re-gating; auditor | Expected false keeps ≤ 0.035 × N (README) |
| L1.5 adversary | Family | Admission: hidden reference reproduces the oracle **and** the *active* bundle fails ≥4/5 | Time-to-law on held-out adversary families |
| L2 meta-gate | **Incident (48 × 1 per arm)** | Paired exact test | **p < 0.05 and above the A/A band, else HOLD**; false keeps must not rise |

**On stage:**
- **Round 1:** the 7 spoken numbers in §5.5.
- **Finals add:** the improver line, the adversary line, the fork verdict, the topology `listTools` diff, one disagreement case, and Agent Engine only if live.
- **Q&A only:** the full 10-row table; the `routingTrust` table split team / non-team; meta-gate discordant pairs; the A/A band; admission ledger counts.

---

## 6. The Raindrop RSI prize

### 6.1 Who the judges think wins it: Kintsugi, 6 of 6

The reasons, from the final ballots and `G2-jackson-raindrop` §2.1:
- **The heal is Jackson's own tool hierarchy.** The wrong refund path disappears from `listTools` (`G1-raindrop-self-healing` §5.1, §10 1:22). That is the "enforces direction without adding guardrails" idea from his post (`notes/41` §4.4).
- **Raindrop watches the healer.** The healer's own MCP investigation funnel evolves, measured in Jackson's units: cost per heal, and time from flag to promotion (§6.3).
- **It adopted the RSI researcher's promotion rule:** exact McNemar, the A/A band, HOLD, and a backlog of ≥40.
- **It turned the overclaim into Jackson's must-change:** an extractor-vs-Raindrop disagreement table with n (`G3-raindrop-self-healing`).
- **The only fair human-healer baseline** in the slate (L710), and **public-beacon blind classes** (§4.4).
- **Workshop as the eval room.** Raindrop's last prize was "$5k for coolest use case of Raindrop Workshop" (`notes/41` §4.5).

### 6.2 Why CaseLaw trails on the prize

| Gap (source) | Status after this file |
|---|---|
| "Raindrop is absent for the first 1:57", and the heal is triggered by a local oracle incident (`G2-jackson-raindrop` §2.3) | Narrowed. A Raindrop chip appears at 0:22 as a second source, and the loosening beat is Raindrop-led by 1:35 (§5.5). The F2 heal itself stays oracle-triggered, because that is what keeps the open controlled. This is a deliberate trade |
| Human ticket volume: "Nobody at a hackathon naturally uses" a back-office console (`G2-jackson-raindrop` §2.3; `G2-aram-modelence` §3.2) | Addressed. The box shows the tenant's current orders, and there is a recruitment plan (§8). Non-team n is printed, and the line drops below n = 20 |
| "The heal is more guardrails, not topology" (`G2-jackson-raindrop` §0, §2.3) | Narrowed. A finals topology frame shows F4 `narrowMcp` removing tools from MongoDB MCP `listTools` (§5.6). The improver's own tool funnel becomes a genome field (§6.3) |
| Self Diagnostics is a model self-report (`G2-jackson-raindrop` §4.1) | Wording rule: say "the agent's self-report, measured by Raindrop", never "Raindrop detected" |

### 6.3 Grafts: Kintsugi's prize strengths folded into CaseLaw

| # | Kintsugi strength (source) | CaseLaw graft | Where it shows | What it buys |
|---|---|---|---|---|
| G1 | A Raindrop-computed classifier that reads what the agent *said* (`G1-raindrop-self-healing` §4.3, §8) | Re-scope `G1-guardrail-genome` A10's human-confirmed custom signal to "reported the ticket done after a refused or partial write". On F2 it fires on the agent's final reply as a **second source**. On human tickets it is oracle-free evidence. Measure at the headroom gate whether F2 replies claim completion [U] | R1 0:22 chip (non-blocking) | Raindrop in the first 30 s; passes the information test because our ledger does not parse the agent's words (`G2-jackson-raindrop` §0) |
| G2 | Disagreement table with n (`G3-raindrop-self-healing`) | `routingTrust` table split **team / non-team humans**, with the recorded disagreement case (`G1-guardrail-genome` §10.3) | Q&A; finals 5 s | Jackson's "line that earns the prize is a Raindrop number" (`G2-jackson-raindrop` §4.4) |
| G3 | Raindrop watches the healer; L2 in Jackson's units (`G1-raindrop-self-healing` §6.3) | A `caselaw-evolver` Raindrop project (one event per proposal: Self Diagnostics, funnel tool errors, cost). Meta-gate secondary metrics: tokens and $ per enacted law, time from trigger to ENACTED | Finals improver line | The same cookbook one level up, in his units |
| G4 | The healer's own tool funnel is a genome field (`investigation_topology`, §6.3) | Add `investigationTopology` to `improver_versions`. The evolver's tools (`get_run`, `search_precedents`, `run_replay`, `get_raindrop_evidence`) can only be *narrowed* or ordered, enforced by MongoDB MCP headers and the evolver's own `govern()` bundle (`G1-guardrail-genome` §8.4) | Q&A | Structure at L2, not prose |
| G5 | Tool hierarchy as the heal (§5.1) | F4 law shown as MCP `listTools` narrowing (`G1-guardrail-genome` §2.1 R2, §6.7 row) | Finals topology frame | Jackson's tiebreak (`G2-jackson-raindrop` §3) |
| G6 | McNemar + A/A + HOLD; backlog ≥40 (`G3-raindrop-self-healing`; `G2-rsi-researcher` §2.1) | Uniform at every level; meta-gate 48 × 1 | PREREG; finals line | Removes "noise-promotable" |
| G7 | Human-healer baseline (L710) | Ablation row R9, human-evolver | Q&A / finals | Weco's L1 "net positive vs a fair human baseline" (`G2-rsi-researcher` §1.1) |
| G8 | Public-beacon blind classes (§4.4) | The adversary docket's train/held-out split and activation use a public beacon value drawn after the catalogs freeze, committed by hash | Q&A line | A falsifiable answer to "you planted it" |
| G9 | Workshop as the eval room (`import_cloud_trace`, `ask_agent`, `annotate`) (§8) | The observer imports each incident trace into Workshop and proxies `ask_agent` ("what were you missing?"). The answer goes into the evolver's evidence; the evolver holds no key [U: replay registration] | Optional one line in R1 beat 2 | The category Raindrop rewarded last time |
| G10 | Receipt with a shrunk minimal repro world (§6.1 step 10) | Optional: ddmin the F2 witness world into the law download | Download | A developer artifact |

**Not grafted:**
- **The refund-desk hero** (HarnessForge territory, `F-judge` K1).
- **A claims extractor in our oracle.** It would recreate Kintsugi's independence problem.
- **"Raindrop got happier; the oracle said no."** CaseLaw's disagreement beat already carries this in its own form.

**Honest expectation [I].** The grafts should lift CaseLaw's RSI fit from 7.92 toward about 8.5–9, which is still below Kintsugi's 9.75. The trade is still right:
- K7 makes a podium finish the probable precondition for the prize;
- CaseLaw has the best placement odds;
- of the top three, CaseLaw is the only one that passes Jackson's information test "outright" (`G2-jackson-raindrop` §2.3).

**Ask at the 10:30 kickoff** (`BP` §15; `F-judge` K7):
- Who judges the RSI prize, and in which round?
- Can a team that doesn't reach the podium win it?

---

## 7. Blueprint delta: changes to `BLUEPRINT.md`, in priority order

Tags: **[CHANGE]** rewrite a section · **[ADD BACK]** restore something BP cut for time · **[ADD]** new · **[CUT]** remove · **[KEEP]** explicitly retain. "BP §x" is the section to edit.

**P0: frame and stage.**

1. **[CHANGE] BP header, TL;DR, §1, §14.1.**
   - Remove the 6.5 h framing and the "≈16 of 17.5 person-hours" capacity plan.
   - New name line, as in §5.1.
   - Point to `G1-guardrail-genome` as the scope source and to this file for the deltas.
2. **[CHANGE] BP §12.1 → the §5.5 script:**
   - five beats;
   - **one judge interaction** (signature on a pre-loaded tablet);
   - 121 as a 3 s stamp;
   - subtle VOID live;
   - Raindrop chip at 0:22;
   - Raindrop-led loosening by 1:35;
   - 2-row ablation plus the unseen-tool column;
   - ≤7 spoken numbers.
   Keep "gate starts at 0:00 under narration".
3. **[ADD BACK] Earned loosening.** Replace BP §4.4's "HELD, never on stage" and BP §14.5's "cut the L1/L2/L4 ladder" with `G1-guardrail-genome` §6.4–6.5:
   - the `graduate` op;
   - L1–L4, with L2 = machine evidence and L4 = a `cl_human` grant;
   - a new `cl_auth` database;
   - the CAS re-reads the grant by digest (`G1-guardrail-genome` §9.5);
   - `MissingGrant` aborts.
4. **[CHANGE] BP §9.6 topology.** Replace "one Node process … never say separate process" with three planes on two hosts, **plus the approval page as its own service holding only `cl_human`** (`G3-guardrail-genome`; `G2-bosco-aws` §2.1 must-change 1).
   - The worker host has no MongoDB URI (a green-test row).
   - Header: `approvals: cl_human (approve-svc)`.
   - [U] Whether Modelence allows a second app. Fallback: an isolated tiny host, named in the header, never the reasoning host.
5. **[ADD] Raindrop as the only evidence on human traffic** (`G1-guardrail-genome` §10.2):
   - a deployed ticket box that **shows the tenant's current orders** (`G2-aram-modelence` §3.2);
   - non-team vs team n printed separately;
   - drop the Raindrop line below non-team n = 20.

**P1: recursion and evidence.**

6. **[ADD BACK + CHANGE] BP §4.6, §8.**
   - Bring back the improver genome (`improver_versions`) and the paired meta-gate (`G1-guardrail-genome` §8.3).
   - **Change the unit to the incident:** 48 frozen incidents × 1 proposal per arm.
   - **Decision rule:** p < 0.05 and above the A/A band, else HOLD (`G2-rsi-researcher` §2.1–2.2; `G3-guardrail-genome`).
   - Add the `investigationTopology` field (§6.3, G4).
7. **[ADD] Adversary docket** (`G1-guardrail-genome` §4.4), **made adaptive.**
   - Admit a family only if the hidden reference reproduces the oracle **and the active stage bundle** fails ≥4/5.
   - Split train/held-out with a public-beacon seed committed by hash (§6.3, G8).
8. **[ADD BACK] Families F3, F4 and F6 plus twins** (BP §2.3 "cut"). F5 becomes the earned-loosening family. Add the Northwind tenant with a tombstone policy. Held-out goes from 15 to **40** tickets (`G1-guardrail-genome` §4.3, §4.5).
9. **[CHANGE] BP §13.1 ablation: 5 → 10 rows.** Add R0 rules-in-prompt, R3, R6, R8, and the new **R9 human-evolver**. Make the A/A floor never-cut. Pre-register the R5 pairs against R2, R4, R0, R7 and R9 (§5.7).
10. **[ADD BACK] Raindrop surfaces** (BP §10 "cut"), each in its honest role (`G1-guardrail-genome` §10.4):
    - Issues as triggers, with `update_issue` only when an Issue exists;
    - Experiments as a shadow verifier that holds on "inconclusive";
    - a `caselaw-precedents` dataset;
    - Workshop as the dev sink, plus `import_cloud_trace` and `ask_agent`;
    - an RQL table.
    Plus the re-scoped custom signal (§6.3, G1) and a `caselaw-evolver` project (G3).
11. **[ADD] Topology frame in the finals** (§5.6). Use F4 `narrowMcp` and the MongoDB MCP `listTools` diff. Add the knob-liveness row from `G1-guardrail-genome` §6.7.
12. **[ADD BACK] The receipt auditor, never-cut** (BP deferred D4). Also add generated `W-xxxx.spec.ts` precedent tests and the Kiro `permissions.yaml` export (`G1-guardrail-genome` §5 items 10–12, A8).

**P2: depth that stays off stage.**

13. **[ADD BACK] `$rankFusion` `search_precedents` for the evolver** and the `$graphLookup` lineage strip. Both use indexes created only by `setup.ts`; no runtime principal holds search-index actions (`G1-guardrail-genome` §9.2).
14. **[ADD BACK] The LLM critic, advisory only,** on a different vendor (`G1-guardrail-genome` R9).
15. **[CHANGE] BP §11 / D5 Modelence.** Change "read-only viewer at most" to "the real execution plane", with a labelled `execution: local` fallback.
16. **[ADD] Agent Engine stateless projection,** conditional on Flex+ and a service account [U]. Finals only, 8 s, and only if real (`G1-guardrail-genome` §9.9).
17. **[ADD BACK] The kill -9 bundle-pinned resume** as an off-stage receipt only.
18. **[CHANGE] BP §7 green test v2 → v3.** It covers 9 principals, with these new rows:
    - `cl_evolver`, `cl_gate` and `cl_meta` → 13 on `cl_auth.grants`;
    - a forged-digest promotion aborts;
    - the worker host has no URI.
    Expand the red-team insert suite from 12 to 16 cases (`G1-guardrail-genome` §7.3).
19. **[CHANGE] BP §11 provenance header** to the `G1-guardrail-genome` §11.1 version, plus `approvals: cl_human (approve-svc)` and `humans: non-team n / team n`.
20. **[ADD] A `cl_admit` principal** on the control host. Gap found in this synthesis: `G1-guardrail-genome` §9.3 names no principal that writes admitted adversary families into `fixtures` and `cl_priv.oracle`. Give `cl_admit` insert-only on those two, with no evolver read path. Add a `cl_adversary` principal with insert-only on `cl_pub.adversary_candidates`. Add both to the green test.
21. **[CHANGE] BP §13.3 PREREGISTRATION contents.** Add:
    - the meta-gate rule and unit;
    - the adversary admission rule;
    - the beacon source and seed hash;
    - the R9 protocol;
    - the uniform HOLD rule;
    - the meta backlog hash.
22. **[CHANGE] BP §16 Q&A → `G1-guardrail-genome` §16,** plus these answers:
    - **"Offload already had a human approve authority."** "Offload's list was syntactic and batched; ours detects loosening semantically by replaying every ruling and earns evidence before the human signs" (`G2-cv-veteran` §3.2).
    - **"Which Raindrop signal told you something your ledger didn't?"** The two information sources: human tickets with no oracle, and the agent's words. Give the numbers.
    - **"When the header says mingo, which lines change?"** (`G2-steffan-mongodb` §3.1).
    - **"What can widen authority?"** "Only the approval service's human login", phrased as `G2-steffan-mongodb` §3.1 FLAG asks.

**Cuts and keeps.**

23. **[CUT]** the BP §2.5 / §14.4 Witness pivot at 12:15 (Witness now ranks 7th; §3.2). Also cut ElevenLabs A9 (§5.4).
24. **[CHANGE] BP §14 build plan** to `G1-guardrail-genome` §13: 3–4 Opus 5.5 coding agents per person against contracts frozen at 10:45. Keep the dated integration checkpoints as *reliability* gates, plus:
    - human-box traffic live by 12:30;
    - meta backlog frozen by 14:00;
    - hash freeze 15:00;
    - feature freeze 15:30;
    - two timed rehearsals, one with a stranger as judge;
    - backup recording 16:30;
    - tag 17:00.
25. **[KEEP]** every BP correctness fix (Appendix A) and the banned-phrase list. Add two lines to the list:
    - "guardrail" as the first noun;
    - "only a human can widen authority" (say "only the approval service's human login can").

---

## 8. Using the prep day (non-code only) to bank the extra ambition

**The principle.** On the event day, code is cheap because there are 12–16 parallel agents. The scarce things are:
- decisions;
- integration;
- wall-clock compute;
- non-team human traffic;
- rehearsal.

The prep day should pre-pay all of them in prose, so that at 10:30 every agent starts on a written task card and nobody debates.

**Workstreams by owner.** The lanes follow `BP` §14.1 / `G1-guardrail-genome` §13. Every output is prose, an account, or a plan, logged in `BUILT_TODAY.md` with a timestamp.

| Block | P1 WORLD | P2 RUNTIME | P3 EVOLVER / GATE / RAINDROP | P4 MONGO-OPS / STAGE |
|---|---|---|---|---|
| **Morning: lock decisions** (all four, 90 min) | Read §1–§7 of this file. Write a one-page decision log covering every [U] and its fallback | — | — | — |
| **Late morning: specs** | **Primitives spec** (`count`, `sum`, `exists`, `covers`), timestamped *first*. Fault-plan specs for F1–F6 with twins and 3 lure strengths each; Northwind retention policy; admission rule | **Contracts in prose:** Bundle, LedgerRow, Ticket, HumanTicket, FaultPlan, Episode, Proposal (T/N), GateReport, Grant, ImproverVersion, AdversaryFamily, SseEvent. Gateway API endpoints in English | `PREREGISTRATION.md` skeleton (§5.7 table, all rules, tie claim). Meta-gate protocol (48 × 1, unit, A/A, HOLD) | Role and validator tables for all principals, including `cl_admit` and `cl_adversary`. Green test v3 and the 16-case red-team checklist |
| **Afternoon: prompts and plans** | Held-out spec (40 tickets: distribution, filter shift, unseen tool). F-blind protocol (P1 authors on the day; P3 never sees it). Adversary spec: prompt prose, adaptive reward, admission, beacon source | Worker prompt draft (prose). Topology runbook (three planes, approval service, ports, service token). Rate-limit and spend plan per key; second vendor chosen for adversary and critic | Evolver and advisory-critic prompt drafts. Raindrop plan: custom-signal wording (re-scoped A10), RQL drafts, Experiment-as-shadow rule, `caselaw-evolver` project. **Agent task cards** for every lane, each with inputs, outputs and an acceptance check in English | Demo script v4 (§5.5), finals cut (§5.6), attack card, switch lines, Q&A sheet. **Human-traffic plan** (below). Video storyboard |
| **Accounts and quotas** (spread through the day) | — | Anthropic keys: tiers read, worker key funded (≥$50), spend caps known. Second-vendor key. VM for the reasoning and control host provisioned (no code on it). Modelence account, CLI login, two-app question [U] | Raindrop Pro trial. "HACKATHON" email to support@raindrop.ai asking explicitly for `MCP_SIGNAL`, `new_issues_nav`, Experiments and Workshop replay registration (`G2-jackson-raindrop` §4.3). Throwaway org for any smoke test | Atlas sandbox: all 4 have the link; **ask for Flex** (`G2-steffan-mongodb` §1.5); second Project Owner; `0.0.0.0/0`; roles clicked in only if allowed [U]. Agent Engine service-account question. Tablet procured, charged and set to kiosk mode. Phone hotspot |
| **Evening** (all four) | Spoken run-through of the round-1 script, twice, timed. Fallback drill: every labelled fallback said aloud once. Kickoff question cards printed. Sleep | — | — | — |

**Human-traffic plan.** This turns Aram's and Jackson's [U] into a plan:
- **Target:** ≥20 non-team people file at least one ticket each by 15:00.
- **The box:** shows Acme's current orders and products, so a stranger has something to fix (`G2-aram-modelence` §3.2 must-change 1).
- **Inspiration cards:** printed with ticket *ideas* but **no ids or goals**, so human tickets stay unlabelled and Raindrop stays the only evidence on them. Do not repeat Kintsugi's card-id labelling, which made its cohort oracle-labelled (`G2-jackson-raindrop` §2.1).
- **Logistics:** a QR on the table; one teammate assigned to invite neighbours between 12:30 and 15:00.
- **Honesty:** the header counts team and non-team n separately, and the stage line drops below 20.

**Kickoff question cards** (`BP` TL;DR #9, extended):
- **MongoDB staff:**
  - tier, and whether Flex is possible;
  - custom-role rights;
  - `$documents` and `$setWindowFields` under a custom role;
  - MCP Server narrowing headers over HTTP;
  - Agent Engine on the sandbox.
- **CV staff:**
  - who judges the RSI prize, and in which round;
  - **whether a team that doesn't reach the podium can win it (K7)**;
  - whether prep-day prose and props are acceptable;
  - whether the judge may sign on our tablet;
  - the "no presentation" rule.

**Wall-clock budget to plan around** [CALC; assumptions: about 30 ops and about 20 s per episode, concurrency 12, M0 60 ops/s]:
- **Ablation:** 10 rows × 40 × 2 = 800 episodes ≈ 24k ops (about 7 min of DB budget) and about 22 min of LLM time.
- **Meta-gate:** 96 proposals × about 20 episodes ≈ 1,900 episodes, about 55 min.

All of this shares the sandbox's ops budget with stage and human traffic. Two consequences:
- Ask for Flex.
- Schedule the meta-gate between 13:30 and 15:00 in `env: meta`, never during rehearsals.

---

## 9. Risks that grow with ambition, and their mitigations

| # | Risk (why it grows with ambition) | Mitigation | Owner / when |
|---|---|---|---|
| R1 | **Stage density and "feature zoo".** Every judge flagged it (`G2-cv-veteran` §4.1; `G2-steffan-mongodb` §3.1; `G2-aram-modelence` §1.6). More built means more temptation to show | Hard stage rule: one proof object, one failure-to-fix arc, one refusal, one Raindrop result, one evidence row (`G2-cv-veteran` §4.1). ≤7 spoken numbers. Everything else goes to the finals, Q&A, `MONGO.md` or `WHAT_IS_REAL.md`. P4 has a veto in rehearsal | P4, every rehearsal |
| R2 | **Claims drift from code.** A3's largest downside (`A3` §0.5). Twenty-plus mechanisms means twenty-plus claims | One `WHAT_IS_REAL.md` row per spoken claim (file:line, query, model, n, real vs simulated). Every claim conditional on the provenance header. Banned phrases enforced | P3 + P4, 15:30 |
| R3 | **Wall-clock and ops/s contention.** Meta-gate, ablation, adversary, human box and stage all share one sandbox (§8 budget) | Ask for Flex. 60 ops/s token bucket on M0 (300 on Flex). `env: meta` off-stage window. No ablation or meta traffic during rehearsals. `commandStarted` monitoring in the header | P2, from 10:50 |
| R4 | **More [U]s on the critical path:** two Modelence apps, a second host, `cl_human` isolation, MCP over HTTP, Agent Engine, Workshop replay | Each has a labelled fallback that keeps the same story: `execution: local`, the isolated approval host, MCP frame skipped, Agent Engine skipped, Workshop line skipped. Probe 13–16 at kickoff (`G1-guardrail-genome` §13.1). No round-1 beat depends on Agent Engine, MCP or Workshop | P4, 10:50 |
| R5 | **Thin human traffic** makes the Raindrop line and L3 shadow weak (`G2-aram-modelence` §5) | §8 human-traffic plan. Non-team n printed. The line drops below n = 20, and the stored disagreement case replaces it. L3 shadow agreement on *labelled* traffic still runs | P4 + one teammate, 12:30–15:00 |
| R6 | **Integration across 4 lanes × 3–4 agents**, with contract drift | Contracts frozen at 10:45 from the prose tables. Exactly three cross-lane integrations, pair-run (`BP` §14.2). Agents work in worktrees and merge only through the lane owner | P3 owns contracts |
| R7 | **Meta-gate null, or adversary junk.** A bigger second loop gives a bigger chance of a visible null | Pre-registered HOLD wording ("not significant at n = 48; we kept v1"). The ratchet stays the named recursion. Quarantined adversary families listed (CodeSignal lens). Neither is in round 1 | P3 |
| R8 | **Lookalike convergence in SF** (5–10 Ripple-grade loops, several guardrail-flavoured; `A3` §7.5) | Open on the world diff, never on "guardrail". Differentiate on the three things the NYC losers lacked: a seconds-readable proof object, an honest ablation, a rehearsed team (`A3` §7.5). Credit Offload and Sightline in Q&A | P4, script |
| R9 | **The approval beat stalls** (tablet, Wi-Fi, auth) | Pre-loaded tablet in kiosk mode, mirrored on the main screen. Hotspot. P4 signs as the named approver, said aloud. Rehearse with the tablet fallback as the default (`G2-bosco-aws` §2.1 must-change 2) | P4 |
| R10 | **Raindrop quota, latency or flags,** with more surfaces in use | Pro trial plus a meter. Only stage-env, human-box and shadow traffic go to the cloud. No beat waits on Raindrop. `list_tools` at boot. Latency measured in the first hour (`G1-guardrail-genome` §10.5) | P3, 11:30 |
| R11 | **LLM spend and rate limits** (an evolver on Opus, an adversary and critic on a second vendor, about 3,000 Haiku episodes) | Funded keys; spend caps known; any spend-cap 429 is fatal and triggers failover (`BP` §14.3 probe 11); a separate key per role | P2 |
| R12 | **New-work-only exposure** from a larger prep pack | §2.3 table. Prose only. Every item timestamped in `BUILT_TODAY.md`. Prompts committed under `prep/` with their prep timestamp. Ask CV at check-in | P4 |
| R13 | **Rehearsal time eaten by building.** Unlimited capacity tempts late grafts | Feature freeze 15:30 and hash freeze 15:00 are absolute. P3 vetoes any graft after the first real ENACTED. Two timed rehearsals, one with a stranger. Backup recording by 16:30 | P3 + P4 |
| R14 | **The open's own [U]:** Haiku deletes all 412 after the archive error | Headroom gate with 3 lure strengths, then the worker model. Labelled stored r1 trace that tells the *same* F2 story, never another family (`G2-cv-veteran` §4.4) | P1, 12:15 |
| R15 | **The RSI prize rules (K7)** change the calculus | Ask at 10:30. If the prize is open to non-podium teams, the grafts in §6.3 matter more, but do not switch builds: the open, the rubric lead and the topology all stay with CaseLaw | P4, 10:30 |

---

## Sources

**Re-evaluation round (`research/reeval/`):**
- `G1-fullambition-guardrail-genome.md`: §0–§19, especially §2, §6.4–6.5, §7.2–7.3, §8.3 (L434, L436), §9.3, §9.6 (L528), §10, §11.2–11.3, §12, §13–§14, §4.4 (L202).
- `G1-fullambition-raindrop-self-healing.md`: §0, §2, §4.3–4.4, §5.1, §6.1–6.3 (L415), §8, §10 (L610), §11.3, §12 (L710), §17.
- `G1-fullambition-mongo-native-domain.md`: §0–§1, §7.2 (L403–407), §13.1 (L642–643).
- `G2-judge-jackson-raindrop.md` §0–§4; `G2-judge-steffan-mongodb.md` §0–§5; `G2-judge-bosco-aws.md` §0–§3; `G2-judge-aram-modelence.md` §1–§5; `G2-judge-cv-veteran.md` §0–§6; `G2-judge-rsi-researcher.md` §0–§5.
- `G3-closing-guardrail-genome.md`, `G3-closing-mongo-native-domain.md`, `G3-closing-raindrop-self-healing.md`.
- The score tables, Borda count and final ballots supplied with this task.

**Debate and notes:**
- `research/debate/A3-why-they-won-synthesis.md` §0, §7.1–§7.5.
- `research/debate/F-redteam-judge-rules.md` K1, K7, D3.
- `research/notes/01-BRIEF-key-findings.md` §1–§9.
- `research/notes/41-raindrop-rsi-prize.md` §4.4–§4.5.
- `research/notes/44-judging-meta-and-demo-craft.md` §5.8 (via `G1-guardrail-genome` §14).

**Blueprint:** `BLUEPRINT.md` TL;DR, §2.5, §4.4, §4.6, §5, §7, §8, §9.3–9.8, §10–§16, Appendix A. Every correctness fix there is retained.
