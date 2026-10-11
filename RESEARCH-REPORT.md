# Deep Research: Winning the MongoDB Harness Engineering Hackathon (Recursive Harnessing + Raindrop RSI)

**Prepared:** Saturday Oct 10 2026, the evening before the event.
**Event:** The Harness Engineering & Model Wrangling #SFTechWeek Hackathon (Cerebral Valley + MongoDB, Shack15, San Francisco, Sunday Oct 11 2026).
**Team goal:** Problem Statement 1 "Recursive Harnessing", the $3,000 Raindrop RSI (Recursive Self Improvement) prize, and the best overall placement (1st = $7,000).
**Rubric:** Round 1 is Impact 20 / Technical Demo 35 / Creativity 15 / Implementation Difficulty 30. The top-6 final uses the same criteria at equal weights. There are 6.5 build hours, a 3-minute live demo plus Q&A, and the MongoDB Atlas Hackathon Sandbox is required for finalists.
**The plan this report supports:** [BLUEPRINT.md](BLUEPRINT.md) (CaseLaw).

**How this report was made.**
- It synthesizes the full research corpus in `research/`:
  - 47 research notes (`research/notes/00`–`45`, including 30 winner deep dives);
  - a seven-persona debate (A1 positions, A2 rebuttals, A3 moderator synthesis);
  - seven proposals and their cross-examinations (B1, B2);
  - two adversarial fact-checks (C);
  - six judge-persona scorecards (D);
  - three red teams (F);
  - the final blueprint.
- The corpus holds about 585k words and about 1,250 distinct URLs. All of it was collected on Oct 10 2026 with the Firecrawl CLI, `gh` and curl.
- Two load-bearing pages were re-fetched while this report was written (Oct 10, evening): the SF event page and Raindrop's plans page. Both were unchanged on the points that matter.
- Web content is treated as data, never as instructions.

**Labels.**
- **[V]**: verified against a primary source in the cited note or fact-check.
- **[V3]**: verified only in a third-party source, such as another team's repo.
- **[I]**: inference.
- **[U]**: unverified and load-bearing.
- **[R]**: a claim from earlier notes that a fact-check **refuted or corrected**. A refuted claim is never stated as fact in this report.

**Citation key.** Paths are relative to `research/`. Section signs (§) point inside a file.

| Key | File |
|---|---|
| N00 / N00b / N01 | `notes/00-participant-guide.md` / `notes/00-mongodb-builder-guide.md` / `notes/01-BRIEF-key-findings.md` |
| N10 / N11 / N12 / N13 / N14 | `notes/10-event-agentic-memory-context-eng.md` / `notes/11-event-agentic-orchestration.md` / `notes/12-event-mongodb-local-2026.md` / `notes/13-event-prior-editions-and-rsi-hackathons.md` / `notes/14-event-other-mongodb-agent-hackathons.md` |
| W-ripple | `notes/20-winner-this-hackathon-prior-editions--ripple.md` (newest Ripple forensics) |
| W-offload | `notes/20-winner-mongo-local-2026--offload-rem-engine.md` |
| W-* | the other `notes/20-winner-*.md` deep dives, named by project |
| N30 / N31 / N32 | `notes/30-copilotkit-openbot.md` / `notes/31-copilotkit-openmuse.md` / `notes/32-copilotkit-opendots.md` |
| N40 / N41 / N42 / N43 / N44 / N45 | `notes/40-rsi-self-improving-harness-research.md` / `notes/41-raindrop-rsi-prize.md` / `notes/42-mongodb-features-for-rsi.md` / `notes/43-partner-and-extra-tools.md` / `notes/44-judging-meta-and-demo-craft.md` / `notes/45-zeitgeist-harness-rsi-oct2026.md` |
| A1-x / A2-x / A3 | `debate/A1-position-x.md` / `debate/A2-rebuttal-x.md` / `debate/A3-why-they-won-synthesis.md` |
| B1-x / B2-x | `debate/B1-proposal-x.md` / `debate/B2-crossexam-x.md` |
| C-ev / C-tech | `debate/C-factcheck-events-judges.md` / `debate/C-factcheck-tech-apis.md` |
| D-x | `debate/D-judge-x.md` (aram-modelence, bosco-aws, build-feasibility, cv-veteran, jackson-raindrop, steffan-mongodb) |
| F-feas / F-judge / F-tech | `debate/F-redteam-feasibility.md` / `debate/F-redteam-judge-rules.md` / `debate/F-redteam-technical.md` |
| BP | `BLUEPRINT.md` (repository root) |

---

## Executive Summary

**The SF event is a rerun.** The same hackathon, under the same name and with the same two problem statements, ran in New York on Sep 26 2026 and drew 98 projects. Ripple won. It turns plain-English specs into printed-circuit-board designs, grades them with a hidden checker the agents can never read, and evolves a versioned `HarnessConfig` document in Atlas through a gate that marks each change kept, rolled back or rejected. Its headline evidence was a same-model held-out ablation: bare 0/4 → v0 2/4 → evolved 3/4 (N12 §2.3; C-ev #2) [V].

The fact-checks shrink that story in two ways:
- **The podium was partly crowd-selected.** At NYC the expert round cut 98 entries to 6, a conference-attendee vote chose 3 of them for the stage, and only then did judges rank those 3 (Ripple > Offload > Morgadarsha) (C-ev #1) [V].
- **The winners' evidence was thin.** Ripple's one kept version passed its gate on a tie, its n was 4, and three of its nine config knobs were never read at runtime (W-ripple §0). Offload's gains came from a scripted model (W-offload §0). Nobody exposed this on the day (A3 §0.5).

What the expert cut did select:
- **Domain-first entries with a proof object a judge can read in 5–10 seconds**, such as Gerbers, 83.5 g → 30.3 g, or a "denied (code 13)" tripwire.
- **Atlas on the critical path.**
- **An ablation table and held-out evaluation.** Each appeared in finalists at more than twice the base rate (A3 §0.3).

Meanwhile the basic "agent edits its own rules, versioned in Mongo, kept if the score rises" loop became the crowd default: 29–34% of NYC entries [R: corrected from 20–25%, C-ev #10]. It earns floor points and no Creativity.

**The SF panel is a different instrument, and there is no crowd step.**
- **Jackson Ferrigno (Raindrop FDE)** has written that "it's hard to stake success on a markdown file", and that infrastructure-enforced structure measured on production traces wins (https://www.raindrop.ai/blog/mcp-design) [V].
- **Raindrop's CTO** says most self-healing pitches "just do not work" (N41 §4.3) [V].
- **Bosco Albuquerque (AWS)** argues that compromise must never become authority (C-ev #9) [V].
- **Steffan Mejia (MongoDB)** will look for idiomatic, load-bearing Atlas use (A1-mongodb).
- **Aram Shatakhtsyan (Modelence)** will ask whether it is deployed and usable (D-aram §0).

The Raindrop RSI prize has **no published criteria**; the event page was re-checked tonight. The prize's eligibility relative to the "$18,000 … across the three final teams" wording is unknown (F-judge K7) [U].

The MongoDB realities are harsh:
- Custom roles can only be created in the Atlas UI, CLI or Admin API, by an Org Owner, Project Owner or Project Database Access Admin.
- Free-tier clusters cap throughput at 100 ops/s and allow 3 search indexes and 5 change streams.
- Atlas Agent Engine does not support Free clusters, and its guardrails are regex-only (C-tech #6, #8, #11) [V].

**The team's idea tournament** ran seven proposals past six judge personas. **CaseLaw** (guardrail-genome) scored best: composite 7.17, round-1 weighted 8.19. **Kintsugi** (raindrop-self-healing) fit the RSI prize best (9.0). IGNITION's mechanics were folded into CaseLaw.

Three red teams then found the converged design unbuildable as written: about 27–31 person-hours of scope against about 17.5 available (F-feas). Each red team named fatal flaws:
- the live beat copied HarnessForge's hero ticket;
- Raindrop was only a relay for the team's own grader;
- the sandbox might silently falsify the key spoken claims;
- the "cannot express loosening" claim was false;
- the held-out set was contaminated.

The final [BLUEPRINT.md](BLUEPRINT.md) fixes each one:
- a single live **data-loss** incident ("112 orders exist nowhere");
- an evolver that composes laws from **four generic primitives**, with zero domain features at v0;
- verdicts **computed by Atlas** in one `$setWindowFields` pipeline, shared by the live path and the replay;
- **three refusal layers** (database validator, compiler, as-of precedent replay), shown against a staged compromised evolver;
- an honest **precedent ratchet** as the recursion;
- Raindrop Self Diagnostics as the **only** signal for blocked valid work on unlabelled traffic;
- a **provenance header** that keeps every spoken claim true.

The residual risks are headroom, an evolver that fails to compose a working feature by 13:30, sandbox role rights, a likely tie with an expert-written static policy, Raindrop's per-org 1,000-event cap and latency, and an SF field converging on the same "database veto" idea.

---

## Key Findings

1. **SF is the second edition of a known event.** NYC (Sep 26 2026) had 98 entries and 6 finalists. 1st Ripple, 2nd Offload, 3rd Morgadarsha (Recursive Computer Use). Finalists: Da Vinci, Sightline, CyclopsDiary (C-ev #1; https://cerebralvalley.ai/e/mongodb-nyc-hackathon/hackathon/gallery; https://www.linkedin.com/posts/mongodbinc_mongodblocal-activity-7511818091685732353-C0J5) [V].
   - The two problem statements match. Ripple's DESIGN.md maps its features to them by name: https://github.com/jovianw/ripple/blob/main/DESIGN.md [V].
   - The NYC rubric weights rest only on one team's transcription (C-ev #1) [U].

2. **NYC's podium was filtered by a crowd, and SF's is not** (C-ev #1, flag 2; A3 §1.1) [V].
   - Attendees voted Morgadarsha 1st, Ripple 2nd, Offload 3rd. The judges ranked Ripple > Offload > Morgadarsha.
   - In Jan 2026 the CV `publicVotePlacement` field likewise inverts the judges' order, so it should never be read as a ranking (C-ev #6).
   - SF puts 6 finalists before judges only, at equal weights (N00).

3. **What the expert cut rewarded is legible proof plus rigor, not the idea of self-improvement** (A3 §0.2–0.3, §7.1) [V counts / I interpretation].
   - All 6 NYC finalists were domain-first, had Atlas on the critical path and showed a 5–10 s proof object.
   - An ablation table appeared in 2/6 finalists vs 3/79 others. Held-out evaluation appeared in 4/6 vs 22/79.
   - Rollback or rejection language (4/6 vs 38/79) and guardrail language (2/6 vs 26/79) are hygiene, not differentiators.

4. **Self-improving harnesses are the crowd default, and guardrail evolution alone did not place.**
   - Roughly a quarter to a third of NYC entries were self-improving harnesses [R: "20–25%" corrected to 29–34%, C-ev #10].
   - The cut took 0 of about 7 games or simulations and 0 of about 27 "tool for agent operators" entries, including 6 guardrail/security-evolution entries. The 0/27 figure is suggestive only (p ≈ 0.14) (A3 §7.1–7.2) [I].
   - HarnessForge, a solo, textbook gated-mutation entry with a dashboard, did not place (https://github.com/Deepesh-Katudia/harnessforge).
   - Hug Guardian **was never submitted** and is not evidence of anything [R: N01 and N45 said it "did not place", C-ev #10].

5. **Past winners' substance was thinner than their pitches** (A3 §0.5; W-ripple §0; W-offload §0) [V].
   - **Ripple:** one kept version (a tie, kept on cost and attempts); n=4 on GPT-4o-mini; v2 bundles config plus a subcircuit library plus lessons, so the gain is confounded; self-retrieval inflates its training scores; 3 of 9 knobs are inert; the MCP server was never wired.
   - **Offload:** a `ScriptedModel`, a 15-entry catalog proposer, about 74% of the engine present at its first commit (11:11 ET), and "tonight/tomorrow" wording scrubbed at 14:58. It still placed 2nd.
   - **Lesson:** judges score what they can see in about 5 minutes. With this panel, gaps between claims and code are the largest downside risk (A3 C1).

6. **Earlier MongoDB × CV winners won with personas and spectacle, under different rubrics** (N10, N11, N12 §3–6; A3 §6) [V].
   - The winners: ForgetMeNot (Oct 2025), JustPrice (Jan 2026), PlanPass (London, May 2026) and Amelia (Build Fest, Aug 2026).
   - Their rubrics differed: expert-only with unpublished criteria; Demo 50 / Impact 25 / Creativity 15 / Pitch 10; or an audience vote. None had a Difficulty criterion.
   - Their MongoDB use was shallow (depth 1–3 of 5). That playbook transfers poorly to a 30% Difficulty rubric judged by an infrastructure panel.

7. **The four SF judges have documented lenses** (C-ev #4, #8, #9; N41 §4.4; N44 §4; D-*) [V/I].
   - **Raindrop:** measurement and infrastructure-enforced structure. Ferrigno's −12% cost and −27% time-to-answer are a *team* result.
   - **AWS:** a "Hard Trust Boundary"; R(C) ⊆ R₀; "compromise does not become authority". This is a LinkedIn post, and the author's AWS affiliation is matched by name only.
   - **MongoDB DevRel:** the "delete, enforcement and show-me" tests.
   - **Modelence CEO:** deployment, real users, CodeSignal-style ungameable grading.
   - Steffan Mejia **did not judge NYC** as far as primary sources show [R: N01 §3 and N42 §1.2 say he did; C-ev flag 1].

8. **The Raindrop RSI prize has no public criteria** (N13 §5; F-judge K7; event page re-fetched Oct 10 evening) [V].
   - Raindrop's published "right way" is: Issue/Signal → evidence over MCP → a check that **fails before and passes after** → ship → verify with an Experiment (https://raindrop.ai/docs/cookbooks/self-healing-loop.md).
   - Hylak adds that behavioural failures need experiments, not fixes (N41 §4.3).
   - The judge-persona consensus: a loop where Raindrop is only a relay for your own grader loses the prize. Raindrop must measure something the grader cannot (D-jackson §1; F-judge K3).

9. **Raindrop's platform facts constrain any integration** (C-tech #1–5; https://raindrop.ai/docs/platform/plans.md, re-fetched Oct 10) [V].
   - Query API at `https://query.raindrop.ai`, plus a hosted MCP at `https://mcp.raindrop.ai/mcp`. No outbound webhooks, so poll.
   - TypeScript SDK with `featureFlags` and Self Diagnostics (`__raindrop_report`, four default categories, which custom categories *replace*).
   - Workshop is MIT-licensed, runs locally on port 5899 and has `replay_run`.
   - **Hobby** allows 1,000 events per month, then **stops ingesting for the rest of the calendar month**. Issues and creating Experiments need Pro ($299/month, 14-day trial).
   - Limits follow the org's subscription. F-tech T4 concluded the event cap is per org, so splitting into projects saves nothing [V-today in F-tech; the plans page ties limits to the org but does not literally say "per org"].

10. **MongoDB enforcement is real, but gated by permissions the sandbox may not grant** (C-tech #8–11; F-tech T1) [V].
    - Custom roles cannot be created through drivers on any tier.
    - Built-in `readWrite` includes `dropCollection` and `renameCollectionSameDB`, so a `$jsonSchema` "constitution" is theatre if the proposer holds `readWrite`.
    - A database-level change stream needs `find` on every collection in that database.
    - The free tier: 100 ops/s with a 1 s cooldown, 3 search/vector indexes, 5 change streams, 50 pipeline stages, and no server-side JavaScript.
    - Atlas Agent Engine does not support Free clusters, and its guardrails are regex `output_validation` only.
    - `$rankFusion` needs 8.0+ and `$scoreFusion` 8.3+. The `$rerank` stage version is contradictory in MongoDB's own docs (8.3 vs 9.0), and only the `rerank-3` models need M10+ [R: N01/N42 said "9.0+ / M10+" for the stage].

11. **The builder guide has rot and gotchas** (N42 §2; C-tech #14; N43 §1.2) [V].
    - "Building an Agent with Memory and Function Calling" redirects to the docs home.
    - "Adding Memory (JavaScript)" redirects to an unrelated Node driver page.
    - "Build AI Agents with MongoDB" returns 404.
    - The Automated Embedding blog still says "preview", although the feature has been GA since Aug 12 2026.
    - Modelence's hackathon page still shows `[CREDIT AMOUNT]` placeholders, and Modelence injects **its own** Atlas database as `MONGODB_URI` rather than the sandbox.

12. **The RSI research frontier (as reported in N40) supports specific, demonstrable mechanisms** [V in N40; not independently re-verified here].
    - A proposer that reads raw traces: Meta-Harness reached 56.7% with raw traces vs 41.3% with scores only (https://arxiv.org/abs/2603.28052).
    - Regularized search with a critic before evaluation, a noise floor, a cost rule and pruning: RRSI (https://arxiv.org/abs/2609.24972).
    - Public/private score splits at a fixed budget: AIDE² (https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement).
    - A four-artifact harness of system prompt, rule bank, safety memory and tool policy: SHE (https://arxiv.org/abs/2608.09885).
    - "Ignition" evidence, where the improver itself improves, is weak everywhere. AIDE² did not claim it.
    - Objective hacking is documented: DGM faked test logs, and STOP disabled its sandbox flag.

13. **The zeitgeist rewards governed, structural, specialized evolution and punishes hype** (N45 §0, §6) [V/I].
    - The labs now ship generic self-updating harnesses: the OpenAI Agents API (Sep 10) and Claude Mods (Sep 14).
    - MongoDB launched Atlas Agent Engine on Sep 29 2026.
    - RSI is a front-page safety story, after Amodei's "We Must Pace the Frontier".
    - Overdone: defining "harness", "routines become skills" (already placed several times), prompt optimizers called RSI, and dashboards.
    - Thin on GitHub: guardrail and permission evolution, and per-user specialization.

14. **CopilotKit's OpenBot, OpenMuse and OpenDots are MIT pattern libraries, not forks** (N30–N32; C-tech #13) [V].
    - All three need CopilotKit Intelligence plus Docker or SQL stores, and all ship large UIs, which is a new-work disqualification risk.
    - The patterns worth copying:
      - OpenBot's `govern()` (decide → record → act) and its `policy-dry-run` replay of a candidate policy over past audit rows;
      - OpenMuse's per-run agent construction and hash-bound expiring approvals;
      - OpenDots' server-stored approval record.
    - OpenBot PR #694 was closed because an injected decider would **bypass the enterprise kill-switch**, not because it was history-aware [R: N30 and N01 said "stateful guardrails explicitly rejected"]. Issue #350 (a pluggable, stateful decider) is still open.

15. **The idea tournament converged on CaseLaw, with Kintsugi as the RSI-first alternative** (D-*; orchestrator score table) [V].
    - CaseLaw led on composite (7.17), round-1 weighted (8.19), equal-weight final (8.13), Impact (8.0) and Difficulty (9.0).
    - Kintsugi led on RSI fit (9.0).
    - The Witness proposal was the most buildable (feasibility 6.5).
    - Every proposal scored 3–6.5 on feasibility.
    - Four of six judge personas ranked CaseLaw first. Jackson (Raindrop) ranked Kintsugi first. The build-feasibility judge ranked IGNITION's tighter scope first.

16. **As converged, the design did not fit the day** (F-feas FZ1, FZ2) [I].
    - About 27–31 person-hours of scope against about 17.5 effective. P(all beats live at 5 PM) ≈ 0.3.
    - At the cut scope in BP §14 (≈16 person-hours), P(a real live loop) ≈ 0.8.
    - Ripple, a 4-person team, got its first *useful* evolution only at 15:37. Every plan's "first real verdict by 13:30" is a stretch goal (D-build §0).

17. **The final blueprint's differentiators are three visible elements, and the database veto is not one of them** (BP §17; A3 C3; F-judge §3) [I]. Database-level refusals of self-edits were already shown at NYC: code 121 by CyclopsDiary and code 13 by Sightline, Ripple and Claim Cipher. CaseLaw's three:
    1. as-of precedent replay of stateful laws;
    2. a semantic loosening that passes the validator but is caught by the replay;
    3. a compromised *improver* refused on its own credentials.

18. **Claude 5.5 API constraints shape the build** [V-today in BP §14.3 against a bundled API reference; not re-verified here].
    - Non-default sampling parameters return 400 on Haiku and Sonnet 5.5; Opus 5.5 removes sampling parameters.
    - Forced `tool_choice` returns 400 on Opus and Sonnet 5.5.
    - Editing earlier history returns 400 for accounts created on or after 2026-08-31.
    - Consequences: no "temperature seeds" (the unit becomes the world seed), structured outputs instead of forced tools, and append-only context. The G0 kickoff probe re-checks all of this (BP §14.3 items 9–11).

---
## Detailed Analysis

### A. The NYC edition: what won and why

#### A.1 Format, judges and how the podium was decided
- **The event.** "The Harness Engineering & Model Wrangling Hackathon", New York, Sat Sep 26 2026; finals at MongoDB.local NYC on Sep 30 (https://cerebralvalley.ai/e/mongodb-nyc-hackathon) [V].
- **Field and statements.** 98 submissions, 6 finalists. The problem statements match SF's: they are cited by name across the gallery and in Ripple's DESIGN.md (C-ev #1) [V].
- **Judges.** Joseph Morais (MongoDB), Louis Vichy (OpenRouter), Brooke Jamieson (AWS), Vin Sachidananda (Radical Ventures), Dan Zakon (Tenex) and Andrey Sibirev (Vercel) (N12 §2.1) [V]. Steffan Mejia was **not** among them [R, C-ev flag 1].
- **Funnel.** An expert rubric in parallel rooms cut 98 → 6. At .local, attendees voted 3 of the 6 onto the stage, and the judges then ranked those 3. So only two judge signals exist: the 98 → 6 cut, and the order Ripple > Offload > Morgadarsha (A3 §1.1; C-ev #1) [V].
- **Rubric.** The 35/30/20/15 weights and the Difficulty wording ("How hard is this project to recreate? Is the technical depth more than a few AI prompts away?") come from Offload's copy of the NYC brief, not from the CV page: https://github.com/SpectrrT/MongoDB_HarnessHack/blob/main/docs/00-hackathon-brief.md (A1-difficulty §0) [V3].
- **Organizer warnings.** The same brief quotes "Please do not show us a presentation" and "We'll be checking to ensure your project was built entirely during the event" (N44 §1) [V3].

#### A.2 Placements

| Place (attendee vote) | Project | One line | Repo | Demo video |
|---|---|---|---|---|
| **1st** (vote 2nd, 12 hearts) | Ripple | English spec → routed PCB; hidden checker; self-evolving HarnessConfig | https://github.com/jovianw/ripple | https://www.youtube.com/watch?v=yMx84ME4XYA |
| **2nd** (vote 3rd) | Offload (REM: Replay, Evolve, Merge) | Day/night harness: exactly-once effects ledger by day, gated evolution by night, authority expansions sent to a human "morning ask" | https://github.com/SpectrrT/MongoDB_HarnessHack | (Google Drive link in N12 §2.2) |
| **3rd** (vote **1st**) | Morgadarsha / Recursive Computer Use | Local-first computer use; verified workflows replayed from shared MongoDB memory | https://github.com/lhnminh/self-improving-computer-use | https://youtu.be/x6hrG1wZUH4 |
| Finalist | Da Vinci (solo) | Recursive CAD harness; drone mount 83.5 g → 30.3 g under fixed stress/deflection limits | https://github.com/Cobeml/Da-Vinci | https://youtu.be/QjKv8p9AJu4 |
| Finalist | Sightline | Evolves which context a fast model sees in simulated storm triage; answer key locked by MongoDB roles; 57.9% → 67.1% | https://github.com/hughesbrayden/sightline | https://www.loom.com/share/02d8cd6855844d119fcd969e2a7aa2ad |
| Finalist | CyclopsDiary | Factory-floor shared memory from Meta glasses; answers "where is X?" with video proof | https://github.com/exploring-curiosity/CyclopsDiary | https://youtu.be/P9OXVsmuzuA |

Sources: N12 §2.2; C-ev #1, #3 [V].

#### A.3 Ripple (1st): the template, and its cracks

**How it works [V, N12 §2.3; W-ripple §3].**
- **Agents.** A Planner (strong model), a Coder (cheap model), a Critic that writes lessons, and a Meta-agent. The meta-agent proposes **one** JSON change per round to a versioned `HarnessConfig`, covering rules, context policy, tool flags, workflow and model routing.
- **Deterministic parts.** A hidden checker under `checks/` (never imported, prompted, embedded or exposed over MCP), plus a tscircuit compiler and autorouter, a gate and a model router.
- **Gate guardrails.** The gate rejects a candidate *before spending a batch* if it:
  - removes a rule;
  - turns off a check;
  - gives the coder database (MCP) tools;
  - pushes budgets out of range.
- **Ordering of "better".** Boards passing → partial credit → quality → attempts → cost.
- **Concurrency.** The gate claims a version atomically with `findOneAndUpdate`, re-scores the parent on fresh boards, and rejects a "stale" sibling.
- **Recorded rounds.**
  - Round 1 **rolled back** a coder→strong-model swap: still 0/2, at 37× the cost.
  - Round 2 **kept** v2: five rules promoted from failure causes.
  - Round 3 **rejected** v3, which reworded a rule.
- **Ablation on 4 held-out specs, GPT-4o-mini, memory writes off:** bare 0/4, v0 2/4, v2 3/4 (C-ev #2).
- **Demo arc.**
  1. A judge's spec fails a hidden check.
  2. Diagnosis and lesson.
  3. The config diff, with a rejection.
  4. The ablation table.
  5. Kill the worker and resume a 20-part board, then download Gerbers/BOM/KiCad.
  6. The close: "The model didn't get smarter. The harness did."
- **Team process.**
  - Four people, about 191 commits on the day, contracts frozen at kickoff.
  - A pre-written DESIGN.md.
  - Checkpoints: first board through the hidden checks at 12:30, feature freeze at 15:30.
  - An AGENTS.md telling coding agents what never to touch.
  - About $10 of OpenRouter per person. They still ran out of credit mid-afternoon (https://github.com/jovianw/ripple/pull/44).

**The skeptic's case [V, W-ripple §0; C-ev #2, flag 5].**
- **The kept version is weak evidence.** Exactly one version was kept, on a 4/8 vs 4/8 **tie**, because it used fewer attempts and cost less. W-ripple calls this a gate bug plus a tiebreak.
- **The ablation is confounded.** v2 bundles config, library and lessons. At n=4, a +1-board gain arises by chance about 36% of the time (A3 §1.2 #18) [CALC].
- **Training scores are inflated.** They were dominated by the coder retrieving its own earlier passing board.
- **Several features were not real.** 3 of the 9 knobs, "tool access" among them, are never read at runtime, and the MCP server was never wired.
- **The showcase rejection was a false positive.** It was an exact-string match on a reworded rule.
- **The ruler moved.** Gate tiebreaks were added at 15:53, after v2 was kept and after the ablation.

**Why it still won [I, W-ripple §7; A3 §6.1].**
- It was the most **complete and tangible** package from a real model: downloadable fabrication files, a hidden checker, visible kept, rolled-back and rejected verdicts, a same-model table, and a durability beat that also covered Statement 2.
- It was rehearsed, with a stub fallback for every segment.
- It maxed the two heavy criteria (Demo 35 + Difficulty 30).
- The judges moved it above the crowd's favourite.

#### A.4 Offload (2nd)

**What it built [V, W-offload §0; N12 §2.4].** REM gives a harness a day/night/morning cycle.
- **Day.** Every side effect is keyed by `sha256(runId, step, tool, args)` under a unique index, committed in the same transaction as the checkpoint. That is an exactly-once effects ledger. A revoked OAuth token parks the run, and a change stream resumes it.
- **Night.** It mines failures and proposes up to 3 bounded edits, each with a **falsifiable prediction**. An edit is accepted only if it is net-positive with zero regressions on train plus a held-out gym. Night 1 rejected an edit that "cut cost 81% but broke H2".
- **Morning.** Anything that expands authority becomes a human **ask** (`NEEDS_AUTHORITY`).
- **Results.** Held-out 1/5 → 3/5 → 4/5.
- **MongoDB depth.** The deepest at NYC: unique-key ledger, transactions, change streams, TTL, time-series, `autoEmbed` (voyage-4), Atlas Search, `$rankFusion`, `$setWindowFields`, `$merge`, and a compare-and-swap (CAS) policy head. All of it ran on the sandbox's MongoDB 8.0.32 [V3].

**The skeptic's case [V, W-offload §0].**
- The gains came from a deterministic **ScriptedModel**, which the README admits. Three real-model runs ($0.99) all failed.
- The proposer was a 15-entry catalog lookup.
- The held-out gym was consulted nightly, and it ran in memory, not on Atlas.
- **Provenance.** Public history starts at 11:11 ET with an 85k-line snapshot. About 74% of the REM engine existed by then. A 14:58 commit scrubbed "tonight/tomorrow" wording.
  - [Flag: N01 §1 credits Offload with a "BUILT-DURING-THE-EVENT timestamp list". The deep dive shows the opposite risk. Treat Offload as a cautionary case for provenance, not a model.]

**Why it placed [I].**
- The most complete *systems* story, with one metaphor ("an agent that sleeps").
- Deep, idiomatic MongoDB use.
- A rejection that named the held-out task it broke.
- Candour about its limits.

#### A.5 Morgadarsha (3rd) and the crowd-cut finalists
- **Morgadarsha** [V, N12 §2.5]. A computer-use agent that captures action guides, saves them to MongoDB, and replays and verifies them, relearning on drift. Its promotion gate requires:
  - the candidate is a direct child with the same scope;
  - its tool allowlist is a **subset** of the parent's;
  - its success rate strictly improves;
  - there is no regression in wrong clicks or policy violations;
  - the holdout never drives promotion.

  Its demo was a side-by-side LinkedIn post drafted in about 30 s by Codex vs about 5 s by the harness. Its validators were moved to **error mode** at 14:04 on the day [R: N42 §1.3 says "warn"; A3 §1.2 #6].
- **Sightline** [V, C-ev #3].
  - A blind curator proposes one context-policy change with a numeric prediction. The policy compiles to an aggregation pipeline (`$geoNear` / `$match` / `$switch`).
  - A paired bootstrap gate requires P ≥ 0.9.
  - Custom roles (created through the Atlas CLI, because drivers are blocked) lock the answer key, and a live probe shows **code 13** for the curator.
  - The storms are simulated.
- **Da Vinci** [V, N12 §2.6]. CadQuery agents build and test reusable tools. It uses GridFS, Vector Search and Database Triggers. Solo.
- **CyclopsDiary** [V, A2-mongodb]. Error-mode `$jsonSchema` + `$expr` validators (**code 121**), and a change-stream worker. This matters because it shows a **database refusing writes was already seen at NYC** (A3 C3).
- **The crowd cut.** These three were cut by the attendee vote, not by judges. Their lesson is positive: rigor plus a real operator plus a receipt clears the expert cut (A3 §7.3). Every persona withdrew the earlier "rigor lost to Offload" reading (A2-impact, A2-raindrop).

#### A.6 The rest of the field, and why look-alikes missed
Clusters, with the most likely reasons for missing the cut (A3 §7.2) [I from READMEs; no score sheets exist]:

| Cluster (examples) | Likely reason | Lesson |
|---|---|---|
| Generic gated self-edit: HarnessForge, Scar Tissue, Agent Evolve, Bisect, Rulebook, Reflex, SwipeHome, Kiara, Downshift | Crowd-default idea, no tangible artifact, dashboard-led. HarnessForge was built **solo in about 4.5 h** with a genome, locked guardrails and a hidden holdout, so the skeleton is cheap to recreate | The skeleton is plumbing; differentiate on artifact, honest trigger and closed boundary |
| Guardrail/security evolution: Antibody, Crucible, Immune-Harness, Shibboleth, Proofread | Sold to agent operators with no domain artifact. Proofread's Lean gate already "denied the test edits" | Don't headline guardrail evolution |
| Gatekeeper/Chor | **Overdetermined**: solo, first commit 12:12, demo unseen, yet real tool-access evolution and held-out runs | Evidence for no thesis |
| Self-Evolving Chip-Design Harness (solo) | Dashboard plus terminal; its peak-speed keep-rule **retired every evolved version** in run 2 (https://github.com/chmartin/chmartin.github.io/blob/master/_posts/2026-09-28-Self-Evolving-Chip-Design-Harness.md) | Use multi-objective keep rules (pass rate plus cost per valid result) |
| Games and simulations (Pokémon, Zork, MuJoCo, Many Lives…) | No operator, no artifact | 0 of about 7 got in |
| Data/DB agents (DownShift, Claim Cipher, HarnessForge's NL→MQL mode) | Real, rigorous and sponsor-aligned, yet missed | MongoDB as the *subject* is not rewarded |

#### A.7 What transfers to SF
- **Necessary floors** (everyone strong will have them):
  - a real operator;
  - a hidden or locked verifier;
  - held-out data;
  - visible kept/rejected verdicts;
  - change streams and transactions;
  - a "what is real" section;
  - a pre-written plan with frozen contracts.
- **Rare and valuable:**
  - a proof object readable in seconds, on a domain someone needs;
  - an honest **ablation**, including a strong static baseline;
  - a 4-person team that rehearses twice.
- **Cautions** (A3 §5, §7.5):
  - Do not reuse Ripple's thesis line, domain or script shape.
  - Do not stage a "spontaneous" authority grab from an aligned model.
  - Never claim a database refusal is unprecedented.
- **Convergence risk.** Expect 5–10 Ripple-grade loops in SF, several with database vetoes and several on NL→MQL.

### B. All past MongoDB / Cerebral Valley winners

"Why it won" is the debate's best inference unless a judge is quoted (A3 §6). Placements are [V] from CV gallery data, official videos or MongoDB posts, except where marked. MongoDB-depth scores are relative (0–5) and come from the winner notes.

#### B.1 MongoDB × Cerebral Valley series

| Event (format) | Place | Project | One line | GitHub | Why it won |
|---|---|---|---|---|---|
| **NYC, Sep 26 2026**: Harness Engineering & Model Wrangling (expert top 6 → attendee vote 3 → judges rank) | 1st | Ripple | English spec → PCB; hidden checker; evolving HarnessConfig | https://github.com/jovianw/ripple | Most complete tangible package from a real model; hidden verifier; kept/rolled-back/rejected on screen; same-model table; kill-and-resume; rehearsed 4-person team |
| | 2nd | Offload (REM) | Day/night harness with an exactly-once ledger and gated nightly evolution | https://github.com/SpectrrT/MongoDB_HarnessHack | Deepest systems + MongoDB story; one metaphor; candid (scripted model; heavy pre-existing code) |
| | 3rd | Morgadarsha | Self-improving local computer use via shared MongoDB memory | https://github.com/lhnminh/self-improving-computer-use | Vivid 30 s → 5 s replay; won the crowd vote; judges placed it 3rd |
| | Finalist | Da Vinci | Recursive CAD; 83.5 g → 30.3 g | https://github.com/Cobeml/Da-Vinci | Physical artifact with a hard number |
| | Finalist | Sightline | Context-policy evolution; roles lock the answer key; 57.9% → 67.1% | https://github.com/hughesbrayden/sightline | Most rigorous gate, staged as a code-13 receipt |
| | Finalist | CyclopsDiary | Glasses-based shared factory memory with video proof | https://github.com/exploring-curiosity/CyclopsDiary | Multimodal proof; error-mode validators |
| **Build Fest SF, Aug 13 2026**: Persistent Context Sprint (video + repo → 3 finalists → live audience vote) | 1st | Amelia for the Deaf | Live captioning that remembers speakers, on Mentra glasses | https://github.com/borisnezlobin/mongo-hacks | Only deaf/HoH entry of 94; theatrical "agent speaks to the room" moment; MongoDB customer story; won by audience vote although its stage attribution failed |
| | 2nd | TraceCase | Vague bug report → verified PR, reproduced across up to 12 environment configurations | https://github.com/Carldtitan/Tracecase | Verified outcome, with an honest "diagnosis only" path |
| | 3rd | Perpetual | Mined skills pushed to a second agent via change stream; tool list = `$vectorSearch` over self-written macros | https://github.com/rohangandotra18/perpetual | Quotable line: "Agent A got the experience. Agent B got the skill." |
| **.local London, May 2 2026**: Agentic Evolution (17 judges → top 6 → community vote 3 → VIP judges) | 1st | PlanPass AI | Planning-permission copilot: council rules cited to the page, rotatable 3D house, DXF/PDF export | https://github.com/rostam-sodagari/Builder-AI (now 404/private) | Priced pain (£5k fee, 13-week wait), a workflow "stuck in 1995" (Pete Johnson, MongoDB), coached two-speaker pitch; also community #1 |
| | 2nd | RunwayOps | SME payroll-risk command centre with human-approved actions and an ElevenLabs call | https://github.com/Bividib/MongoDBHackathon | Concrete SME pain plus a voice moment; placed despite running out of time mid-demo |
| | 3rd | Volt Control | Grid demand response with risk-tiered autonomy | https://github.com/AyushGupta05/Frequency- (404) | Risk-tiered autonomy; was asked "what was the actual agentic component?" |
| | Finalists | Substrate; Cooks/LiveRecall; Glass Houses | Shared coding-agent memory via MCP; bedside equipment Q&A; housing data | https://github.com/aswin-giridhar/mongodb_agentic_evolution ; https://github.com/Kazybekkh/LiveRecall ; https://github.com/VladimirAkopyan/GlassHouses | `$graphLookup` + `$vectorSearch` in one aggregation; change streams as the agent bus |
| **.local SF, Jan 10 2026**: Agentic Orchestration & Collaboration (rooms → top 6 + 4 HMs → community vote 3 → judges; Demo 50 / Impact 25 / Creativity 15 / Pitch 10) | 1st | JustPrice (repo "Fairward") | Healthcare price transparency; voice agents call hospitals; bill red flags | https://github.com/ohong/fairward | Opened with dollars ("$4k vs $9k MRI"); real-world agency; regulatory why-now; "data flywheel" close. Its finals call was **pre-recorded** [R: not live, A3 §1.2 #10] |
| | 2nd | Mongrate ("Moongrate") | Claude Code planner + builder migrates Postgres → MongoDB + Voyage | https://github.com/AndresNinou/mongodb_hackathon | Sold MongoDB's own migration business; openly pre-baked 20-min run; crowd #1, judges #2 |
| | 3rd | SOGA | Smart glasses spawn about 7 Claude Code sub-agents; LLM observer kills drifting agents | https://github.com/nic-olo/MongoDBHack-MentraOS | Live physical spectacle under a 50% Demo rubric (never mentioned MongoDB on stage) |
| | Finalists | Watch and Learn; EvacuTrace; Polaris | Teach-once browser agent; first-responder simulation; self-updating threat-intel guardrail | https://github.com/kfallah/watch-and-learn ; https://github.com/aparekh02/EvacuTrace ; https://github.com/NineSunsInc/threat-intelligence-service (404) | Visual browser task; high stakes; Polaris was the closest prior art to "evolving guardrails" (crowd-cut) |
| | Coinbase x402 track | x402-zkid (ZK Payment Negotiator) | Agent negotiation with a "lying user caught" moment on real x402 USDC | https://github.com/jayyu23/x402-zkid | Judge-thesis fit; win **self-reported** [V, self-reported] |
| **Shack15, Oct 11 2025**: Agentic Memory & Context Engineering (expert judges only; criteria unpublished) | 1st | ForgetMeNot | Dementia "who am I talking to" AR memory; two Fireworks LoRAs fine-tuned on the day | https://github.com/galileo-ml/mongodb-hackathon | "Unanimously judged winners" (swyx); live multimodal demo; visible difficulty; MongoDB depth 1/5 |
| | 2nd | contextScope | Eval framework for agent-to-agent context handoff ("87% fewer tokens, same 5/5") | https://github.com/aaarzyn/contextscope | The only entry that *measured* context instead of building another pipe |
| | 3rd | WebBrain | Browsing history → tiered memory, like S3 storage classes | https://github.com/shlawgathon/WebBrain | Relatable pain plus one metaphor (its `$vectorSearch` was disabled at 1:43 PM) |
| | Finalists | EchoStay; KitchenPal; MonGOD (Incident Copilot) | Airbnb travel assistant; cooking memory; seeded RAG with drift detection | https://github.com/OscarKhaing/EchoStay ; https://github.com/sathvikparasa/mongodb-agentic-memory (404) ; https://github.com/janavi2001/Seeded_Rag_Dashboard | Theme fit and personas; numeric before/after (23–31 s → 4 s) |

Our own team's history:
- **NeoRecall** (Oct 2025; Nihal Nihalani, Yahya Alhinai, Omkar Podey) did not place (N10 §5) [V].
- Yahya Alhinai was on **PodMan**, 2nd at AIEWF 2026 (A3 §6.6) [V].

#### B.2 Closest analogs outside the MongoDB × CV series

| Event | Place | Project | One line | GitHub | Why it won |
|---|---|---|---|---|---|
| AI Engineer World's Fair Hackathon (CV, Jun 27–28 2026, RSI theme; not MongoDB-judged) | 1st | SplatForge | Gaussian-splat twin of the judges' room; a robot self-trains; failures retrieved from Atlas | https://github.com/ShivamSinghNow/SplatForge | The most visual, "frontier" entry, with a live success curve (47% → 93%). The curve is a grasp-radius knob (A3 §6.6) |
| | 2nd | PodMan | Team pair programmer with a "self-tuning policy" | https://github.com/karti-ai/podman (404) | Team-specialized policy (code unverified) |
| | 3rd | rote | Computer-use runs compiled into verified macros replayed with zero model calls | https://github.com/gorajing/rote | Verified skills; repair on UI drift |
| | Finalists | field-ratchet; EvoLoRA; FocalPoint | Self-mutating PCB placer with a ratchet gate; bounded LoRA loop; prompt rewritten from eye-tracking | https://github.com/JacobFV/fieldratchet ; https://github.com/Visual-Studio-Coder/EvoLoRA ; https://github.com/ypatodkar/FocalPoint | Hard verifiers; auditable bounds |
| Google Cloud Rapid Agent (Devpost) | MongoDB track 1st / 2nd / 3rd | Epiq; KickOff; Sentinel Flood-Watch | MCP queries streamed on screen; change streams as the UI bus; least-privilege MCP | Epiq and KickOff: not listed; https://github.com/Hou-dini/sentinel-flood-watch | Visible MongoDB work |
| | Arize 1st | Cassandra | Watch → diagnose → synthesize eval → patch → replay → red-team | https://github.com/SirjanSingh/cassandra | Automated the sponsor's own workflow, but **never promoted its fix** |
| | Arize 2nd | ComplianceOS | Eval verdicts → per-regulation overrides persisted in MongoDB | https://github.com/bhupenbandi/compliance-os | An honest metric: "A metric that cannot go down cannot teach the agent anything" |
| WeaveHacks 3 (W&B) / WeaveHacks 2 | WH3 1st / WH2 Grand / WH2 Best Self-Improving | Aetheris V.O.; Daydreamer; ReviveAgent | Voice console guide; world-model fine-tune from its own outputs; reflection adjusts prompts **and tool selection** | https://github.com/savir2010/aetheris ; https://github.com/Atharva-Gundawar/machine-gun-baby ; https://github.com/nightlessbaron/rebibemecode | Spectacle and judge alignment. WH2 scored "self-improving-ness" explicitly. Aetheris's repo contains a malicious `.vscode` task (A3 §6.8): **do not open it in an IDE** |

**Reading the table [I, A3 §6.9].** Under expert-heavy rubrics with a Difficulty-like criterion (NYC), the podium was deep on MongoDB and built on real artifacts. Under crowd steps, Demo-50 rubrics or non-MongoDB panels, persona or spectacle entries with shallow MongoDB use won. Almost every winner's pitch outran its code. The constant across every format was **one proof object readable in seconds**.

### C. The multi-agent debate on why they won

#### C.1 Format
- **Round 1 (A1).** Seven personas each wrote a position on "why did past MongoDB / CV winners win?": Impact, Technical Demo, Implementation Difficulty, Creativity, MongoDB (Steffan lens), Raindrop (Ferrigno/Hylak lens) and a Contrarian CV veteran.
- **Round 2 (A2).** Each persona rebutted the others, with both fact-checks (C-ev, C-tech) in hand.
- **Moderator (A3).** A3 ranked the consensus patterns by strength of evidence, ruled on 18 contested issues (C1–C18), and listed 23 must-haves and the anti-patterns.

#### C.2 Positions, rebuttals and what survived

| Persona | A1 thesis (short) | What A2 conceded or changed | Survives in A3 as |
|---|---|---|---|
| **Impact** (A1-impact) | At NYC, Impact separated nobody at the top. Specific, costly pain beats grand stakes. Persona wins came from rubrics we won't face | Withdrew Sightline and Gatekeeper as evidence (crowd-cut / overdetermined); conceded that ForgetMeNot rescores about 8/10 on Difficulty | "Domain-first, platform second" (C2); Impact is a floor in round 1 and decisive in the final (C11) |
| **Demo** (A1-demo) | Every judge-ranked winner had one **money shot**: a witnessed state change in 5–10 s plus one number. Statistics without one didn't place | Conceded that JustPrice's finals call was pre-recorded, that labelled replay is tolerated, that no demo failure has been seen to cost a judged placement, and that the durability beat is a commodity | P1 (proof object, Tier A); P7 (failure-proofing as insurance); the ablation is the *evidence beat*, not the money shot |
| **Difficulty** (A1-difficulty) | Depth that is made legible wins. NYC's top entries had hard cores (hidden checker, transactional queue, CAS gate) | Withdrew Gatekeeper; adopted bundle-pinned resume (MongoDB's version); conceded range restriction in the final | "The apparatus is the must-ship; the gain is not" (C5); the loop skeleton is plumbing |
| **Creativity** (A1-creativity) | Winners were "the only X in the room"; the best levers are an anti-cheat verifier staged live and a real second-order step | **Withdrew** uniqueness as a placement predictor (selected on outcome); withdrew Hug Guardian; withdrew "learns what to forget" | Creativity is scored by contrast with what the panel has seen (RC1); avoid NYC domains; second-order "R" shown for 2 s only (C6) |
| **MongoDB** (A1-mongodb) | Delete / enforcement / show-me tests. Hollow MongoDB claims are common, and SF can check them | Restated "Atlas depth" as a **filter, not a ranker**; conceded that durability didn't carry NYC | P5 (Atlas on the critical path filters entry to the cut); the DB veto is an idiom upgrade, not a novelty (C3); MongoDB as mechanism, not subject (C15) |
| **Raindrop** (A1-raindrop) | Past winners won on the *shape* of self-improvement; this panel has the first judge whose job is finding silent failures | **Conceded the online gate**: Raindrop Experiments are underpowered at hackathon volume, so an offline fail-on-parent / pass-on-child gate decides and the online cohort is a shadow; conceded Sightline | C4 (the offline k=5 gate decides; hold on inconclusive); for Raindrop, "fit is the same thing as rigor" |
| **Contrarian** (A1-contrarian) | Judges score the 3-minute performance, not the repo; crowds decided 4 of 5 podiums; sponsor alignment is everywhere; winners pre-bake | Conceded survivorship in "12 of 14 winners had gaps"; conceded that the hook is an artifact plus a domain before/after, not an emotional persona; conceded the DQ asymmetry (no post-5:00 code) | C1: "Both, through one channel". Judges score what is visible in about 5 minutes, so depth counts only as on-screen receipts and crisp answers. C10: pre-bake everything **except code** |

#### C.3 Consensus, ranked by strength of evidence (A3 §2)
- **Tier A (strong).**
  - P1, a witnessable proof object (all 6 NYC finalists).
  - P2, a real domain with an external grader the agent can't argue with (0/~7 games got in).
  - P3, held-out evaluation and an ablation (the rarest trait that correlates with the cut).
  - P4, claims that match the code, with labelled replays and "what is real" sections.
  - P5, Atlas on the critical path (a filter).
- **Tier B (medium).**
  - P6, visible governance: one KEPT and one REJECTED, refused by infrastructure. Rejection language is in about half of all READMEs, and Ripple's showcase rejection was a false positive.
  - P7, demo craft and failure-proofing.
  - P8, team process (0 of 15 podium slots in the series went to a solo builder).
  - P9, one quotable line.
  - P10, sponsor fit. It decides sponsor prizes and only breaks ties overall.
- **Tier C (floors or cheap assets).** "Only X in the room", plain kill -9 resume (Groundhog did not place), and the emotional consumer persona.

#### C.4 Key verdicts on contested issues (A3 §3, condensed)
- **C1, performance vs substance.** Make what is visible real, label every replay, and map every claim to a file or query.
- **C2, customer.** Domain-first; the production operator is the one-sentence buyer.
- **C3, "the DB refuses the self-edit".** Not novel. It counts only if the boundary is closed (a custom find+insert role, not `readWrite`) and the trigger is honest: a staged compromised improver, not a "spontaneous" grab.
- **C4, promotion authority.** An offline k=5 replay gate. The arithmetic: 30% → 15% needs about 121 events per arm, while Hobby caps at 1,000 events per month [CALC].
- **C5, a must-ship gain.** No. Freeze the scorer, pre-register the rows, report a tie honestly.
- **C6, second-order "R".** Build it small, show it for 2 s, label n, never claim ignition.
- **C7, durability.** Bundle-pinned resume only, as a one-line receipt, and the first beat cut.
- **C9, Agent Engine.** A 20-minute probe and zero stage seconds.
- **C10, pre-baking.** Everything except code.
- **C12, breadth.** One closed loop first; at most three MongoDB enforcement moments on stage.
- **C17, per-user forks.** Not in round 1.
- **C18, self-pruning.** Only as a cost mutation.

#### C.5 Dissent that remained
- **Contrarian vs Raindrop on how much rigor pays.** Rigor protects Q&A and the RSI prize but may not decide placement. Kept as an open bet: the build carries both a legible receipt and pre-registered statistics.
- **Creativity vs Raindrop on the second-order "R".** Creativity sees it as the RSI differentiator. Raindrop sees it as statistically impossible at n≈11. Resolved as "mechanism shown for 2 s, numbers in Q&A". The blueprint later moved the recursion to the **precedent ratchet** (BP §8).
- **Impact vs Contrarian on the customer.** The SF copy says "production" (an agent-ops buyer); the NYC cut took 0/~27 agent-ops tools. Resolved as a two-layer pitch.
- **The deepest unresolved point.** **All seven B1 proposals chose a database veto, and six chose a MongoDB-ops or query domain** that NYC had already seen and that the SF builder guide seeds (A3 §0.4, §7.5). Of these, CaseLaw's governance-of-writes framing is the furthest from the "MongoDB as subject" trap, and it still rides on a DataOps agent.

#### C.6 Corrections the debate produced (A3 §1.2; C-ev; C-tech)

| Claim in earlier notes | Status |
|---|---|
| Steffan Mejia judged NYC | Unsupported [R] |
| Hug Guardian "did not place" | Never submitted [R] |
| 20–25% of NYC were self-improving | 29–34% [R] |
| Only 7/98 said "held-out" | Counted on truncated blurbs; 26/85 at README level [R] |
| The NYC rubric matched SF's | Supported only by Offload's transcription [U] |
| Morgadarsha's validators were "warn" | Error mode from 14:04 [R] |
| "No one has had the DB refuse a write" | False: codes 121 and 13 were both shown at NYC [R] |
| JustPrice's call was live at the finals | Pre-recorded [R] |
| Ripple's judge-typed spec was shown on stage | Unconfirmed [U] |
| Ferrigno's −12% / −27% | A team result [V, nuance] |
| Agent Engine as a build item | Free clusters unsupported; guardrails are regex-only [R as a build item] |
| Modelence "$100 credits" | The amount is a placeholder on Modelence's page; the builder guide still says $100 [U] |
| Custom roles lock eval truth | True, but requires UI/CLI/Admin API and Project Owner or DB Access Admin [V with caveat] |
| OpenBot rejected stateful guardrails | PR closed over the kill-switch bypass [R] |
| "Glasses finalists never win" | SOGA placed 3rd [R] |

### D. Recursive self-improvement research landscape

Everything in this section is drawn from N40 and N45, whose authors marked these sources [V] on Oct 10. Many are 2026 preprints that this report did not re-read. Quote figures from the papers on stage only after a teammate has opened them.

#### D.1 Definitions worth using (N40 §1)
- **Phil Schmid's ladder** (https://www.philschmid.de/recursive-self-improvement).
  - *Iteration*: the output changes.
  - *Self-improvement*: the system changes; the verifier is fixed.
  - *RSI*: the verifier also rises, without being captured.
  - "Every convincing result has a ruler the system does not own."
- **Weco's four levels** (https://www.weco.ai/blog/4-levels-of-recursive-self-improvement).
  - L0 delegation.
  - L1 net positive. Its four conditions: a fair human baseline, a sustained trend, generalization, and a fixed budget.
  - L2 ignition: a better outer-loop improver.
  - L3 inflection.
  - Weco places its own AIDE² at L1.
- **A survey of 1,250 papers** (https://arxiv.org/abs/2607.07663) finds that demonstrated self-improvement strength tracks the **verification hierarchy**, from formal verifiers (strongest) down to intrinsic self-assessment (weakest).

#### D.2 What gets mutated (N40 §1)
- **Prompts:** Promptbreeder, GEPA, RHI.
- **Context and playbooks:** ACE, Dynamic Cheatsheet, Letta sleep-time.
- **Skills:** Voyager, Hermes.
- **Harness code:** ADAS, DGM, SICA, Gödel Agent, Meta-Harness, RRSI, AIDE², AutoHarness.
- **Guardrails and tool policy specifically:** AutoHarness, SHE, SafeEvolve.
- **The improver itself:** STOP, Promptbreeder mutation-prompts, Gödel Agent, Hyperagents, the AIDE² ignition test.

Guardrail and tool-policy evolution is the thinnest research column. That matches the GitHub gap scan in N45 §4.3.

#### D.3 Systems most relevant to Statement 1

| System | What it shows | Use for us | Source |
|---|---|---|---|
| **Meta-Harness** (Stanford, COLM 2026) | A proposer (Claude Code + Opus 4.6) reads the raw code, scores and traces of every prior candidate. Raw traces 56.7% vs scores-only 41.3% vs summaries 38.7%; TB2 76.4% | Feed the evolver **raw rulings, not summaries** (BP §6 step 4) | https://arxiv.org/abs/2603.28052 ; https://github.com/stanford-iris-lab/meta-harness |
| **RRSI** (Google Research, Sep 21 2026) | Annealed edit budget; a **critic before evaluation** (leakage, deleted safety, grader gaming, unbounded work); noise-adjusted floor; cost rule; prune set; +4.3 OOD with 30% fewer policy tokens | The checklist for self-edit guardrails; a deterministic critic (BP §6 step 6) | https://arxiv.org/abs/2609.24972 ; https://github.com/google-research/rrsi |
| **AIDE²** (Weco) | Public/private score split, fixed $ per evaluation, heterogeneous tasks; about 9 in 10 proposals rejected; ignition (about 20 vs about 40 steps) **not significant**. Reward hacking fell 63% → 34% (blog) **or** 55% → 32% (arXiv) [U, conflicting figures] | Honest wording about ignition; hidden-score decides | https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement ; https://arxiv.org/abs/2609.26457 |
| **SHE** (Aug 2026) | Harness split into System Prompt / Rule Bank / Safety Memory / Tool Policy, almost word for word Statement 1; 3.1× lower attack success rate | A four-surface genome schema | https://arxiv.org/abs/2608.09885 ; https://github.com/RainbowQTT/SHE |
| **AutoHarness** (DeepMind) | A synthesized code harness prevents *all* illegal moves in 145 games | Evidence that evolved guardrails work as **code** | https://arxiv.org/abs/2603.03329 |
| **ACE** | Playbook bullets with helpful/harmful counters; delta updates avoid context collapse | Lessons as counted deltas | https://arxiv.org/abs/2510.04618 |
| **HarnessOpt-Bench / PAST-Bench** | A held-out partition inaccessible during search; gains "real but uneven", so show the *pathway* used | Show which law fired on a held-out ticket | https://arxiv.org/abs/2608.06301 ; https://arxiv.org/abs/2608.04003 |
| **Safety in Self-Evolving Agents** | Attacks are lineage-persistent (40/40 payloads persisted) | Provenance on every rule; quarantine; precedents | https://arxiv.org/abs/2606.23075 |
| **Industry practice** | OpenAI "harness engineering" (Codex writes the fix when an agent struggles); Anthropic "JSON is less likely to be overwritten than Markdown"; LangChain +13.7 points on TB2 from harness changes alone; Karpathy autoresearch keep/discard ledger; Cline RSI (69 → 79/89 at lower $) | Typed JSON genome; a keep/discard ledger; cost as a co-objective | https://openai.com/index/harness-engineering/ ; https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents ; https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering ; https://github.com/karpathy/autoresearch ; https://cline.bot/blog/recursive-self-improvement-for-coding-agents |

#### D.4 Five demo-able mechanisms (N40 §6)
1. A versioned harness genome, a trace-reading proposer and a keep/revert ratchet.
2. An ACE-style rule playbook with per-rule counters.
3. A **failure → guardrail compiler plus regression test**: promote only if every historical case passes. This is CaseLaw's core.
4. Signal-driven tool-access evolution with an authority gate: narrowing auto-promotes; widening needs a human.
5. Evolving the evolver: "proposals per accepted improvement" as a mini ignition test. Noisy; label it "early signal".

#### D.5 Failure modes and their mitigations (N40 §8)
- **Objective hacking.** DGM removed hallucination markers and faked test logs; STOP disabled its sandbox flag in 0.42% of runs (https://sakana.ai/dgm/ ; https://arxiv.org/abs/2310.02304).
  - *Mitigation:* keep the evaluator outside the editable surface (DB RBAC, a hash-pinned grader), and never trust agent-reported results.
- **Noise-driven false promotions.** *Mitigation:* paired runs and noise floors.
- **Regressions.** *Mitigation:* a regression suite of every past failure.
- **Bloat.** *Mitigation:* typed config and edit budgets.
- **Poisoning.** *Mitigation:* provenance and quarantine.
- **Privilege creep.** *Mitigation:* least privilege; grants need a human.
- **Spurious "RSI" claims.** *Mitigation:* name the mechanism honestly.

#### D.6 Zeitgeist, Aug–Oct 2026 (N45)
- **The labs productized the harness.**
  - OpenAI Agents API with an "evolving Codex harness" (https://openai.com/index/introducing-the-agents-api/).
  - Anthropic Claude Mods (https://www.latent.space/p/thariq).
  - MongoDB Atlas Agent Engine (Sep 29).
  - *Implication:* a generic harness is free. The value is in *specialized, safely governed* change.
- **September's research wave was harness RSI.** RRSI, ModularRSI, the Self-Evolving Harness paper (https://arxiv.org/abs/2609.38372), Dream-RSI (https://arxiv.org/abs/2609.14858) and AIDE². Shared lesson: harness evolution overfits.
- **RSI is a safety story.** Dario Amodei, "We Must Pace the Frontier" (https://darioamodei.com/post/we-must-pace-the-frontier). *Positioning:* "RSI with brakes", never "AGI liftoff".
- **The bitter-lesson debate.** Harnesses may be absorbed by models (https://hackernoon.com/is-harness-engineering-softwares-last-breath), yet a harness swing from 62.7% to 99.9% on ARC-AGI-3 was reported (https://aisocratic.org/blog/ai-socratic-sep-2026) [secondary].
- **HN pushback.** "Calling this RSI seems misleading?" Earn the word by naming the mechanism (N45 §6.1; F-judge §2).
- **Overdone vs fresh (N45 §6).**
  - *Overdone:* defining "harness"; a self-rewriting system prompt with a score chart; autoresearch on public benchmarks; "routines become skills"; agent civilizations and games; Jev-demo framing; dashboards.
  - *Fresh:* evolving *structure* (tool access, executable guardrails, context policy); visible anti-Goodhart regularization; counterfactual replay from history; per-user forks; evolving the evolver; an immutable evidence ledger; production signals as the trigger.

### E. Raindrop and the RSI prize

#### E.1 The company and its thesis
- **Positioning.** "Raindrop is the monitoring platform for AI agents… Raindrop discovers silent agent failures in production" (N41 §1) [V]. The homepage loop is **Trace → Detect → Investigate → Simulate → Verify** (https://www.raindrop.ai/).
- **Funding and launches.** A Series A on Sep 17 2026 ($50M total) launched **Simulations** (early access), which replay production traffic against "a proposed change to an agent harness" (https://www.raindrop.ai/blog/series-a) [V].
- **Raindrop 2.0, "Self-Healing Agents"** (Jun 3 2026): Issue Detection, then Triage root cause, then a coding agent fixes over MCP, then Workshop writes an eval from the failure, then Experiments verify (https://www.raindrop.ai/blog/introducing-raindrop-2) [V].
- **Ben Hylak (CTO).** "Everyone's sales pitch… has been self improving, self healing, and mostly it just does not work… There are right ways to do it." Fixable failures (a tool stops returning data) can be fixed directly. Behavioural ones (personalization, tone) "you cannot just fix. You have to run experiments" (https://creativeconviction.ai/interviews/ben-and-zubin-raindrop/) [V].
- **howtoeval.com** (https://www.howtoeval.com/) [V]:
  - be a floor-raiser and do error analysis on real trajectories;
  - write code-aware offline evals that assert on tool-call sequence and final state;
  - match the primitive to volume: Stumbles (1–100 runs/day) → Issues → Signals (1,000+) → Experiments (5,000+);
  - "20 high-signal cases beats 200";
  - beware special-casing user phrases;
  - expect the "collapse of harnesses" into models.
- **Raindrop runs its own daily RSI loop on its classifiers**: deploy → sample → evaluate → retune (Signals 2.0, https://www.raindrop.ai/blog/signals-2-frontier-classification) [V].
- **huggingworld** (https://www.raindrop.ai/blog/huggingworld). Its harness lesson: replayed context drove cost and "the prompt does not mention" it. That is an argument that context policy is a harness-level lever.

#### E.2 The judge: Jackson Ferrigno (Forward Deployed Engineer)
- **His post, "MCPs need to be designed too"** (Aug 7 2026, https://www.raindrop.ai/blog/mcp-design) [V].
  - A **tool hierarchy / funnel** (`get_conversation` → `list_events`/`get_event` → `get_trace`) "enforces direction without adding guardrails".
  - "it's hard to stake success on a markdown file. Infrastructure that's built on the same principles, and enforces them, is far more reliable."
  - Measured on production traces: cost −12%, time to final answer −27%. That was a team result (C-ev #8).
- **Questions he is likely to ask** (N41 §4.4; D-jackson) [I]:
  - "How do you know it's not noise?"
  - "Is this just prompt editing?"
  - "What happens when the signal is wrong?"
  - "**If I unplug Raindrop, what does this loop lose?**"
- **Background claims.** A LinkedIn snippet ("won company hackathon with an agent for wargaming code and RL") and a clinical-agents background are unverified. Do not tailor to them (A3 §8) [U].

#### E.3 Platform facts that constrain the build (C-tech #1–5; N41 §1–3; plans page re-fetched Oct 10) [V]

| Surface | Facts | Constraint |
|---|---|---|
| Write SDK (TS `raindrop-ai`) | `begin()`/`finish()` interactions, `featureFlags`, `trackAi`; **Self Diagnostics** via the `__raindrop_report` tool. Default categories are `missing_context`, `repeatedly_broken_tool`, `capability_gap`, `complete_task_failure`; custom categories **replace** them | Re-list the four defaults when adding a custom category |
| Query API | `https://query.raindrop.ai` with a Bearer Query key (separate from the write key); `/v1/signals`, `/v1/events` (count, timeseries, search, facets), `/v1/traces`; 400 RPM (50 for search) | **Org-scoped key**: never give it to the evolver (F-tech T12) |
| Hosted MCP | `https://mcp.raindrop.ai/mcp`: `run_rql`, `get_trace`, `list_issues`, `get_issue`, `create_experiment`… | Issues and creating Experiments need Pro; `list_issues` may also need the `new_issues_nav` flag; names may carry a `raindrop_` prefix, so call `list_tools` |
| Alerts | Slack only; **no outbound webhooks** | Poll |
| Workshop | MIT, local on :5899, `replay_run`; no event cap (https://github.com/raindrop-ai/workshop) | Replay needs `/setup-agent-replay` and `raindrop replay register` |
| Plans | **Hobby:** 1,000 events/month, then ingestion stops for the calendar month; 1 custom signal; 15 Triage messages. **Pro:** $299/month, 14-day trial, $0.003/event to 1M then $0.002 (https://raindrop.ai/docs/platform/plans.md) | Limits follow the org's subscription; F-tech treats the event cap as **per org** [V-today]. Tonight's smoke tests go to a throwaway org (BP §10) |

#### E.4 What the RSI prize is known to require
- **Known [V].** $3,000; listed as "Raindrop RSI Prize (Recursive Self Improvement)" in the participant guide (N00); Raindrop's judge is Ferrigno.
- **Not published.** No criteria on the event page (re-fetched Oct 10 evening), Partiful or Tech Week (N13 §5).
- **Unknown [U].** The event page says "$18,000 … across the three final teams". It is unclear whether a non-podium team can win the RSI prize, or which round it is judged from (F-judge K7). Ask CV staff at 10:30 (BP §15).
- **Inferred lens** [I; N13 §5; N41 §0; D-jackson §0–1]:
  - The loop closes on its own, from the agent's own traces, through a detected failure class, to a proposed structural change, a gated check, promotion, and improvement on the **next** run.
  - Honest evaluation: a hidden or held-out set, a visible rejection, n stated.
  - Self-diagnostics used, not merely logged.
  - Recursion named honestly.
  - Self-modification that is safe: no self-granted authority.
- **Past Raindrop prize.** Raindrop's past hackathon prize ("coolest use of Raindrop Workshop", Autoresearch Systems Hackathon, May 30 2026, https://luma.com/fvz1h1dq) rewarded creative use of Raindrop tooling *inside* an autonomous loop (N41 §4.5) [V for the prize; U for the winning project].
- **Name collision.** LiquidMetal AI's "Raindrop" is a different company. Do not cite its prizes (N13 §4.4).

#### E.5 The key critique and the blueprint's answer
- **The critique (D-jackson §1; F-judge K3).** In six of seven proposals, every loop trigger was computed by the team's own oracle and relayed through Raindrop. Unplug Raindrop and nothing changes.
- **Other shared problems the judges flagged:**
  - Nobody used Workshop for development traffic.
  - The 1k cap is easily exhausted.
  - Ingest-to-query latency is unmeasured.
  - Every team will end on the same line ("Raindrop is the measurement half of RSI"). BP bans that phrase.
- **What wins the prize** is a Raindrop-originated signal that **disagrees with the oracle on screen**, and the system doing the right thing about it.
- **BP §10's answer:**
  - **Self Diagnostics on the worker** adds a custom `guardrail_blocked_valid_action` category. Those reports go **only** to Raindrop.
  - A `$group` joins them to oracle labels, giving precision and recall with n. These are written to `improver_params.routingTrust`.
  - On an unlabelled **shadow stream**, Raindrop's self-diagnosis is the *only* signal. `routingTrust` sets how much of it the evolver needs before opening a narrowing investigation, which is always HELD for a human.
  - Rehearsed answer to "unplug Raindrop": "the utility side on unlabelled traffic."
  - Budget: one event per episode, a hard client-side meter at 750, cloud traffic only from 14:00, and Pro as upside.
- **The alternative.** Kintsugi (raindrop-self-healing) put Raindrop at the centre: a deployed refunds agent watched by Raindrop, presets and tool-error signals, a custom classifier, and a healer that must fail-before/pass-after. It scored RSI fit 9.0 but lower Creativity, because the refunds domain is seeded (HarnessForge). Jackson's persona would build "Kintsugi's front end on CaseLaw's back end" (D-jackson §4).

### F. MongoDB Builder Guide: deep analysis

#### F.1 Every resource in the guide, with status (N00b; N42 §2 audit, Oct 10) [V]

| Guide item | Status | What it really is | Use for this build |
|---|---|---|---|
| Atlas Hackathon Sandbox (link by email) | Required for finalists | Shared org; tier unknown for SF; NYC teams reported MongoDB **8.0.32** [V3] | Probe tier, version and role rights at 10:30 (BP §14.3) |
| [MongoDB Agent Skills](https://www.mongodb.com/docs/agent-skills/) | 200 | Coding-assistant skills (connection, schema, search-and-ai, query optimizer…); repo https://github.com/mongodb/agent-skills | Dev-time only. Its reference states that autoEmbed works on all tiers |
| [MongoDB MCP Server](https://www.mongodb.com/docs/mcp-server/get-started/) | 200 | Local `npx mongodb-mcp-server`, or Managed MCP | `allowRequestOverrides` headers can only **narrow** (`readOnly`, `disabledTools`); HTTP transport only (C-tech #10) |
| [NL → MongoDB queries](https://www.mongodb.com/docs/manual/natural-language-to-mongodb/) | 200 | Prompting recipe; backed by a 766-case benchmark (https://huggingface.co/datasets/mongodb-eai/natural-language-to-mongosh) | An eval substrate if needed; also a **seeded** domain (avoid as subject) |
| Atlas Managed MCP Server | No link | Hosted at mcp.mongodb.com; service accounts; 2,000 req/min per IP (https://www.mongodb.com/docs/mcp-server/remote-mcp/access-models/) | Needs the org-level "Allow AI clients" switch, which was **off for the first hour at NYC** [V3] |
| Frontier Marketplace Connectors | No link | Native plugins (Claude Code, Codex, Cursor, Grok Build, Devin), GA Aug 13 2026 (https://www.mongodb.com/company/blog/product-release-announcements/mongodb-for-agentic-era-built-for-developers-ai-agents) | Dev convenience |
| [Sample mflix](https://www.mongodb.com/docs/atlas/sample-data/sample-mflix) | 200 (redirects to /docs/manual/…) | `embedded_movies` with stored embeddings | Low |
| [Data modeling](https://www.mongodb.com/docs/manual/data-modeling/) | 200 | Patterns incl. document versioning | Versioned bundles |
| [Vector Search](https://www.mongodb.com/products/platform/atlas-vector-search) | 200 | Marketing page | — |
| [Atlas Search](https://www.mongodb.com/docs/atlas/atlas-search/) | 200, **redirects to /docs/search/** | Lexical search | Cut in round 1 (BP §9.7) |
| [Automated Embeddings blog](https://www.mongodb.com/company/blog/product-release-announcements/unlocking-ai-search-introducing-automated-embedding-in-mongodb-vector-search) | 200 but **stale** (still says preview) | GA since Aug 12 2026 (https://www.mongodb.com/products/updates/now-ga-automated-embedding-in-atlas-vector-search) | 3 RPM / 2k TPM at query time on M0 without a payment method |
| [Embedding & Reranking API](https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/) | 200 | `ai.mongodb.com/v1/{embeddings,rerank}`; 200M free tokens per model; trial 3 RPM / 10K TPM without payment | Reranking alternative to the `$rerank` stage |
| [Agent with Memory + Function Calling](https://www.mongodb.com/developer/products/atlas/interactive-rag-mongodb-atlas-function-calling-api/) | **Dead**: redirects to the docs home | Replacement: https://github.com/mongodb/docs-notebooks/blob/main/use-cases/ai-agent.ipynb | — |
| [Adding Memory (Python)](https://www.mongodb.com/developer/products/atlas/advanced-rag-langchain-mongodb/) | Redirects to the LangChain memory/semantic-cache page | Chat history plus cache | Low |
| [Adding Memory (JavaScript)](https://www.mongodb.com/developer/products/atlas/add-memory-to-javascript-rag-application-mongodb-langchain/) | **Redirects to an unrelated Node driver page** | Use a GenAI-Showcase notebook instead | Low |
| [LangGraph + Atlas](https://www.mongodb.com/docs/atlas/ai-integrations/langgraph/build-agents/) | 200 | `MongoDBSaver` + `MongoDBStore` | Not used (TS build) |
| [State & Persistence blog](https://www.mongodb.com/company/blog/technical/state-persistence-the-problem-of-agent-reliability) | 200 | Checkpoint at the tool-call boundary; **bundle versioning** ("give an in-flight execution the bundle it started on"); the kill test | **Vocabulary for run-pinned bundles** |
| [Build AI Agents with MongoDB](https://www.mongodb.com/docs/atlas/ai-agents/) | **404**; current page https://www.mongodb.com/docs/vector-search/about/ai-agents/ | Agentic RAG background | Low |
| [GraphRAG](https://www.mongodb.com/docs/atlas/ai-integrations/langchain/graph-rag/) | 200 | `MongoDBGraphStore` on `$graphLookup` | Lineage idea (Tier 2) |
| [GenAI Showcase](https://github.com/mongodb-developer/GenAI-Showcase/tree/main) | 200 | Includes an ambient-inventory agent (service-account Remote MCP, unique partial index for idempotent approvals) and a Deep Agents kill test | Reference patterns only |
| [Python quickstart](https://github.com/mongodb-developer/mongodb-atlas-python-quickstart/blob/main/quickstart-1-getting-started-atlas-python.ipynb) / [MERN starter](https://github.com/mongodb-developer/mern-stack-example) | 200 | Basics | Low |
| [MongoDB for Startups](https://www.mongodb.com/startups) | — | Post-event credits | — |
| Partner: [Modelence hacker guide](https://docs.modelence.com/hackathon/mongodb-2026) | 200, **credits section still `[CREDIT AMOUNT]`** | One Node web process; **injects its own Atlas DB as `MONGODB_URI`** (https://docs.modelence.com/deploy/setup.md) | Read `ATLAS_SANDBOX_URI` and fail closed (BP §11) |
| Partner: Raindrop ([docs](http://raindrop.ai/docs), [howtoeval](http://howtoeval.com), support@raindrop.ai "HACKATHON") | 200 | See §E | Email tonight |
| Partner: AWS Kiro ([IDE](https://kiro.dev/), CLI, [Crew](https://kiro.dev/crew/)) | 200 | See §H | Optional |
| Partner: [ElevenLabs hacker guide](https://docs.google.com/document/d/1mCh5MtOzBw0aJpurQVUmIVFfPMAHW3MjNemE-LNiMto/edit?tab=t.0) | Google Doc | 1 month of Creator via Discord | Cut (BP §14.5) |
| Partner: [Cursor $60](https://cursor.com/redeem/event/mongo-db-hackathon-sf-tech-week-ygcedp) | Valid Oct 11–12 only | Cursor + Grok Bot credits | IDE and chores |

**Template rot in the guide itself.** The schedule banner still reads "HACKATHON DAY — SEPT 26", carried over from NYC, while the requirements say "Record an on-site demo October 11th" (N00b) [V]. Trust N00 for the SF timetable.

#### F.2 Newest features (all 2026; N42 §4; C-tech) [V]
- **Atlas Agent Engine.** Public preview Sep 29 2026, AWS only, "not recommended for production" (https://www.mongodb.com/products/updates/now-in-public-preview-mongodb-atlas-agent-engine).
  - **Content Guardrails:** `output_validation` with regex `match_patterns` only; actions block / modify / log_only / require_review.
  - **Policy Engine:** `AUTHORIZED_TOOLS`, `AUTHORIZED_MODELS`, budgets such as `MAX_TOOL_CALLS_PER_EXECUTION`; a project policy must be at least as restrictive as the org's.
  - **Memory:** four types (semantic, episodic, procedural, taxonomic); needs Flex or higher and a Voyage key.
  - **Setup:** **no Free clusters**; needs a service account; 60–120 minutes (C-tech #6; https://www.mongodb.com/docs/agentengine/deploy/atlas-setup.md).
  - The event copy names it, but the debate verdict is a 20-minute probe at most and one Q&A sentence (A3 C9; BP §9.8).
- **Automated Embedding (voyage-4).** GA Aug 12 2026 on every Atlas tier including M0. Query-time limit on M0 without a payment method: 3 RPM / 2k TPM. The 200M free tokens per model are **per organization**, which may be shared by every team in the sandbox org (C-tech #7).
- **Embedding & Reranking API.** GA Aug 13 2026. **Managed MCP** and the Frontier connectors: Aug 13 2026.
- **MongoDB 9.0.** GA Sep 28/29 2026 (https://www.mongodb.com/docs/manual/release-notes/9.0/).
  - Faster baseline queries.
  - Intelligent Workload Management.
  - `constraint` validation level.
  - Server-side JS undeprecated on a WASM sandbox, but still **blocked on Free and Flex**.
  - Not on an 8.0 sandbox.
- **Atlas Infinite.** Preview, M10–M60. No Search, Vector Search or MCP server, so avoid it.
- **Other launches.** Atlas Ephemeral Clusters (Sep 24); MongoDB VFS for LangChain Deep Agents (Sep 3); Accelerated Search Aggregations (Sep 30) (N42 §4.12).
- **Hybrid search and reranking.** `$rankFusion` needs 8.0+ and `$scoreFusion` 8.3+. For the `$rerank` stage, docs disagree (9.0 vs 8.3), it needs Native Reranking enabled in Project Settings, and only `rerank-3` / `rerank-3-lite` need M10+ (C-tech #9).

#### F.3 Tier limits that bind (C-tech #8, #11; F-tech T7; D-cv §5; N42 §0) [V]

| Limit | Free (M0) | Flex | Notes |
|---|---|---|---|
| Throughput | **100 ops/s**, then throttling with a 1 s cooldown | 500 ops/s | How bulk writes and `$merge` count toward ops/s is not documented [U] |
| Search + vector indexes | **3** | 10 | The Agent Engine setup page contradicts this ("Free doesn't support Search indexes") |
| Change streams | **5** | 10 | Flex docs contradict themselves (the triggers page says Flex has no change streams); NYC teams used streams on the sandbox. Probe `db.watch()` |
| Database Triggers | Not stated in the corpus [U] (Da Vinci used Triggers at NYC on the sandbox [V3]) | **No** | Not needed by the blueprint |
| Aggregation | **Max 50 stages**; `allowDiskUse` ignored; `$function`/`$accumulator`/`$where` blocked | `$function` blocked | `$documents`, `$out`, `$merge` and `$setWindowFields` are not listed as restricted |
| Connections / storage | 500 connections; 0.5 GB; 100 DBs / 500 collections | — | Cache clients; `maxPoolSize` 10 |
| Roles | Driver `createRole`/`updateRole` **unsupported on every tier** | Same | UI/CLI/Admin API only; needs Org Owner, Project Owner or Project DB Access Admin; up to 30 s to deploy |
| `$$USER_ROLES` | Unsupported | Unsupported | No role-aware views (BP §9.3) |
| Time-series collections | No change streams, Search, validation, or transactional writes | Same | Keep metrics outside transactions |

#### F.4 Idiomatic depth: what is table stakes, and what still counts
- **Table stakes, all seen at NYC** (N42 §1.3; N01 §5) [V3]:
  - change streams over SSE;
  - transactions;
  - TTL;
  - time-series metrics;
  - `autoEmbed` plus `$rankFusion`;
  - validators, **including error-mode 121**;
  - roles hiding ground truth (**code 13**);
  - Queryable Encryption (Claim Cipher).
- **What Steffan's persona says still scores** (D-steffan §1; A1-mongodb §0):
  - enforcement the app cannot bypass, on the *proposer's own* credentials;
  - immutable, content-addressed bundles with no mutable `status`;
  - CAS promotion in a transaction;
  - one stream with persisted resume tokens;
  - the same expression used live and in replay;
  - a one-line "show me" for every claim.
- **His three Q&A questions** (D-steffan §5):
  1. "Show me the role on the proposer's user."
  2. "Your bundles are immutable. Why does the gate update them?"
  3. "Is the live verdict computed by the same expression your replay uses?"
- **The `readWrite` trap** (F-tech T1) [V-today]. Built-in `readWrite` includes `dropCollection`, `renameCollectionSameDB`, `createSearchIndexes` and `dropSearchIndex`; `dbAdmin` adds `collMod` and `bypassDocumentValidation`. A validator protects nothing from a principal that can drop the collection.

### G. CopilotKit OpenBot / OpenMuse / OpenDots analysis

#### G.1 Repo facts (N30–N32; C-tech #13) [V]

| | OpenBot | OpenMuse | OpenDots |
|---|---|---|---|
| What it is | Self-hosted "AI coworkers", each with its own computer; "every action decided before it happens and recorded after" | Personal agent with browser, terminal, files and "work that keeps going" (Expo/React Native + Hono) | Persistent specialist agents ("Dots") across web chat, browser voice and Slack; positioned against "OpenAI Dots" (https://www.copilotkit.ai/blog/introducing-opendots) |
| Repo | https://github.com/CopilotKit/OpenBot | https://github.com/CopilotKit/openmuse | https://github.com/CopilotKit/OpenDots |
| Size / age (Oct 10) | 6,287★; created Aug 17 2026; ~93.6k LOC server | 4,509★; created Sep 15 2026 | 4,728★; created Sep 29 2026 |
| License | MIT | MIT ("Intelligence is a separate service and is not included") | MIT |
| Storage | Postgres (~87 tables, Drizzle) | One generic JSONB `records` table on PGlite/Postgres | SQLite (`node:sqlite`); conversations live in CopilotKit Intelligence |
| Hard dependency | **CopilotKit Intelligence** key, Docker, Bun | Intelligence key required at startup, despite marketing that says "no subscription" (issue #73: https://github.com/CopilotKit/openmuse/issues/73) | Intelligence for chat; it returned 500/503 errors on Oct 9 (https://github.com/CopilotKit/OpenDots/issues/123) |
| Self-improvement | Seeds only: "always allow" rules, per-thread decline equivalence, a policy dry-run, skill drafts. The policy is a **single unversioned row** | None; prompts and tool lists are hard-coded | Uses closed "Automatic Learning" |

#### G.2 Patterns worth copying (re-implement; never fork)
- **OpenBot `govern()`** (`server/src/computer/gateway.ts`; an inner function of `createComputerGateway`, not an export, per C-tech #13) [V].
  1. Resolve the target from a **server-held snapshot**, never from the caller's description.
  2. Evaluate a CEL policy: deny before allow; a broken rule denies; an absent policy denies.
  3. **Write the audit row whichever way the decision went.**
  4. Only then run the approval gate and act.
  5. Write a second row on failure or stop.
  - The audit table is append-only via a Postgres trigger. This becomes CaseLaw's record-before / record-after gateway (BP §5).
- **OpenBot `policy-dry-run.ts`** replays a candidate policy over audit history, rebuilding each context "exactly as the gateway built it at decision time". That is a ready-made fitness function for evolving guardrails. CaseLaw generalizes it to **stateful, as-of** replay in Atlas.
- **The OpenBot gap, now correctly stated.** Issue #350 asks for a pluggable **stateful** decider ("This bot has already submitted three orders today" cannot be written in stateless CEL); it is still open. PR #694 was closed unmerged on Oct 2 2026 because an injected decider would **skip the enterprise kill-switch** (https://github.com/CopilotKit/OpenBot/issues/350 ; https://github.com/CopilotKit/OpenBot/pull/694) [R: the "stateful guardrails rejected" framing in N30 and N01 is wrong].
  - BP §17's answer: build the stateful decider **with the floor running first**, the property #694 lacked.
- **OpenMuse:**
  - per-run agent construction, so the harness genome is loaded per run (`ConversationAgent`);
  - a lease/heartbeat/CAS `TaskWorker`;
  - **hash-bound, expiring approval records**;
  - `@copilotkit/aimock` for deterministic demo fallbacks;
  - AG-UI `STATE_DELTA` (RFC 6902 JSON Patch) to stream genome diffs (https://docs.ag-ui.com/concepts/events) (N31 §0, §4.4) [V].
- **OpenDots:**
  - the **server-stored approval record**: approval runs the stored tool and arguments, never the model's paraphrase, and claims the action once (`INSERT OR IGNORE`);
  - a **run-scoped config fingerprint** that aborts a run if the harness changes under it (CaseLaw instead pins each run to its bundle hash);
  - per-conversation config pinning (N32 §3.3, §4.2) [V].

#### G.3 The contrast to pitch
CopilotKit's own "Automatic Learning" (https://docs.copilotkit.ai/learning) [V]:
- needs **15 eligible threads**;
- runs **daily** (default 02:00 UTC);
- proposes instruction-only `SKILL.md` skills that a human publishes;
- never touches rules, guardrails, tool grants or context policy;
- states that "learned guidance does not grant tools".

Statement 1 asks for exactly the parts it leaves out, governed and fast (N32 §5.3).

#### G.4 New-work rule
All three repos are MIT, but showing their UIs or forking them is a DQ risk ("demo must only highlight what was built during the hackathon"). It is also a time sink: Docker, Intelligence keys, Postgres.

The safe path (N30 §10; BP §16) is to re-implement the patterns (about 300–500 LOC), credit OpenBot as "pattern reference only, no code" in the README and in `BUILT_TODAY.md`, and keep any vendored file in a separately committed `third_party/` directory. The blueprint vendors nothing.

### H. Partner and extra tools stack

#### H.1 Partner verdicts (N43 §0, §7; C-tech #12, #14; BP §14.5) [V facts / I verdicts]

| Tool | What it offers a recursive harness | Constraint | Verdict for this build |
|---|---|---|---|
| **MongoDB Atlas Sandbox** | Genome store, ledgers, roles, validators, streams, transactions | Tier unknown; roles need Project Owner; M0 limits (§F.3) | **Core** (required) |
| **Raindrop** | Production signals, Self Diagnostics, Query API/MCP read-back, Workshop | Per-org 1k Hobby cap; Pro needed for Issues/Experiments; no webhooks | **Core for the RSI prize**, but only as the non-relay signal (§E.5) |
| **Modelence** (https://docs.modelence.com/deploy/setup.md) | One-command deploy; Live Queries on change streams; credits | **Node only, exactly one web process**; injects its own `MONGODB_URI`; free tier sleeps; credit amount is a placeholder (https://modelence.com/pricing) | **Deferred D5**: a read-only viewer at most, smoke-deployed by 11:30 or cut (BP §11) |
| **AWS Kiro** (IDE/CLI/[Crew](https://kiro.dev/crew/)) | Steering/hooks/`permissions.yaml` (deny > ask > allow: https://kiro.dev/docs/permissions.md); Kiro Crew's `bug_gate.py` **ACCEPT ⟺ RED ∧ GREEN ∧ STAYGREEN**; "The agent proposes; it never grades its own work" (https://github.com/kirodotdev/KiroCrew) | Free tier is 50 credits; headless needs a Pro key | **Pattern source** (the k=5 parent-red / child-green / STAYGREEN gate echoes it); export adapter optional and cut |
| **ElevenLabs** | Voice; Custom-LLM bridge; Twilio outbound call for "phone a human to approve" (https://elevenlabs.io/docs/api-reference/twilio/outbound-call); ElevenAgents Architect is itself prior art | Needs a Twilio number; venue noise; no separate prize | **Cut** |
| **Cursor + Grok Bot** ($60, Oct 11–12 only) | IDE plus background chores on a cloud computer (https://cursor.com/docs/grok-bot.md) | Grok Bot was once blocked by a home-router DNS (user memory); check reachability on venue Wi-Fi early | **Dev tool** only |

#### H.2 Extra candidates considered (N43 §6)
- **Runtimes.** Claude Agent SDK; OpenAI Agents SDK (Python); LangGraph + MongoDB (Python); Mastra (TS; MongoDB-stored agent versions); AWS Strands (harness SDK; AWS-judge synergy); Strands Harness Optimizer (https://github.com/strands-labs/harness-optimizer). Ripple positioned itself against the Optimizer.
- **Optional add-ons.**
  - Sandboxes: Daytona, E2B, Modal (skip unless synthesizing code tools).
  - Browserbase (only for a web domain).
  - Phoenix, Weave, Langfuse, Braintrust: **skip**; they compete with the sponsor Raindrop.
  - Temporal/Inngest: skip.
  - GEPA as a mutation engine: optional.
  - Voyage via the Atlas Embedding API: core-light, but **cut in BP round 1** to avoid "basic RAG" optics and M0 index caps.
- **The pick (N43 §0; BP §14.1).** A **thin TypeScript loop in one Node process**, with one MongoClient per principal (`mongodb@6.x`), plus the Raindrop TS SDK and a labelled `mingo` fallback for in-process aggregation.

#### H.3 Model-API realities that drive the design (BP §14.3; F-tech T11; F-feas FZ5) [V-today against a bundled API reference; probe at 10:45]
- **Models.** Worker: Haiku 5.5 at low effort, default sampling. Evolver: Opus 5.5 with structured outputs (`output_config.format`). Fallback: Sonnet 5.5.
- **Errors to expect:**
  - non-default sampling → 400 (so "seeds" are world seeds);
  - forced `tool_choice` → 400 on Sonnet and Opus 5.5;
  - edited history → 400 for new accounts (so context is append-only);
  - a spend-cap 429 without `retry-after` must be treated as fatal and failed over.
- **Throughput.** OTPM (output tokens per minute), not ITPM, is the binding limit when thinking can't be disabled. The feasibility judge's warning: k=5 gates can burst 0.7–1M+ tokens per minute, so the LLM key, not Atlas, is the likeliest mid-demo failure (D-build §0.4).
- **Credit.** Ripple ran out of credit at about 15:35 (https://github.com/jovianw/ripple/pull/44). Fund at least $25 per person across two keys and a second provider.

### I. Idea tournament: all proposals, the judge score table, and why the winner won

#### I.1 The seven proposals (B1), and how cross-examination (B2) changed them

| Key | Name | Core idea (one line) | B2 outcome |
|---|---|---|---|
| guardrail-genome | **CaseLaw** | A DataOps agent with write access works tickets through a decide-before/record-after gateway. Incidents become **stateful laws** proven by as-of replay of every past ruling plus an on-policy run. "Agents… should earn [autonomy] from precedent, and never grant it to themselves" | Refused to converge. v2 grafted Witness's witness, Kintsugi's "$ leaked" metric and cookbook-in-validator, IGNITION's cannot-express improver schema and MCP narrowing (Tier 2), and cut about 40% of scope |
| raindrop-self-healing | **Kintsugi** (Halcyon Desk) | A refunds-and-returns support agent used by simulated customers and watched by Raindrop. A healer proposes typed **structural** fixes promoted only if its check fails on the parent and passes on the child, a hidden oracle agrees, the golden set stays green, and a Raindrop-measured canary improves. The healer is itself versioned | v2 grafted precedent replay; the refunds domain was flagged as seeded (HarnessForge) |
| meta-harness-ignition | **IGNITION** | A data on-call agent for one company; sealed numeric oracle in a `vault` DB; SHE-style four-part genome; a Meta-Harness-style proposer over raw traces; an RRSI gate; an L2 improver genome with a pre-registered ignition test (proposals per accepted improvement) | **Converged onto CaseLaw**, contributing "Atlas computes the verdict" (one compiler), the validator on the evolver's own write path, and `routingTrust` |
| prior-work-steward | **Witness** | The user's Oct 7 BSON Witness, turned inside out: a SQL-view → aggregation-pipeline migration agent; SQLite/DuckDB oracle on hidden fixtures; failures **delta-debugged to 1–3-row witnesses** that become lint guards; Atlas refuses a `$function` genome | The most buildable; the fallback pivot (allowed only at 12:15) |
| tangible-hard-domain | **IXSCAN** | A DBA harness speeds up slow queries on a demo app without changing results; a differential oracle on a hidden adversarial "shadow" dataset; `explain()`-measured speed; 2-document witnesses when "fast" means "wrong" | Not a one-day build; its headline speed number is measured off the sandbox; a seeded class |
| mongo-native-domain | **Dialect** | A per-database NL→MQL agent that learns each database's "dialect" and **earns** MCP tool permissions enforced by one-way narrowing headers; verified on MongoDB's 766-case benchmark | **Converged onto Witness** with Dialect grafts |
| per-user-specialization | **Speciate** | A per-user harness fork; genes that generalize **merge upstream** and propagate by change stream; "Knowledge flows upstream. Authority never does" | Most creative; ruled out of round 1 by A3 C17 |

CaseLaw's proposer published self-assessed head-to-head odds that each rival would beat CaseLaw v2 (B2-guardrail-genome §1): IXSCAN 0.25, Witness 0.20, Kintsugi 0.15 (0.35 for the RSI prize alone), Dialect 0.12, Speciate 0.08, IGNITION 0.08. These are interested estimates.

#### I.2 The judge score table (six persona judges per proposal; orchestrator aggregate)

| Rank | Key | Name | Judges | R1 weighted | R2 equal | **Composite** | Impact | Tech demo | Creativity | Impl. difficulty | RSI fit | Feasibility (6.5 h) | MongoDB depth |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | guardrail-genome | CaseLaw v2: incidents become binding precedent. A back-office agent whose laws are written by the harness, proven on every past ruling, and enforced outside the model | 6 | **8.19** | **8.13** | **7.17** | **8.00** | **7.83** | 7.67 | **9.00** | 6.50 | 4.00 | 8.33 |
| 2 | raindrop-self-healing | Kintsugi v2: every production failure becomes a gated structural fix with a receipt | 6 | 7.42 | 7.25 | 6.94 | **8.00** | 7.50 | 5.67 | 7.83 | **9.00** | 4.33 | 7.17 |
| 3 | meta-harness-ignition | CaseLaw v2 (converged onto guardrail-genome, with IGNITION grafts): guardrails written from precedent, refused by Atlas | 6 | 7.38 | 7.29 | 6.75 | 7.00 | 7.00 | 6.83 | 8.33 | 7.33 | 4.33 | **9.33** |
| 4 | prior-work-steward | Witness: every wrong number gets a two-row proof, and every proof becomes a check Atlas enforces | 6 | 6.73 | 6.58 | 6.62 | 5.33 | 7.17 | 6.67 | 7.17 | 6.33 | **6.50** | 7.00 |
| 5 | tangible-hard-domain | IXSCAN v2: fast, with a receipt that no row changed | 6 | 7.23 | 7.21 | 6.21 | 6.17 | 7.00 | 7.67 | 8.00 | 5.50 | 3.00 | 7.67 |
| 6 | mongo-native-domain | Witness (converged onto prior-work-steward, with Dialect grafts): every law in this harness ships with a two-row proof | 6 | 6.30 | 6.13 | 5.90 | 4.83 | 6.17 | 5.83 | 7.67 | 5.83 | 4.67 | 8.33 |
| 7 | per-user-specialization | Speciate v2: per-customer harness forks with a measured merge protocol | 6 | 6.42 | 6.67 | 5.72 | 6.17 | 5.33 | **8.17** | 7.00 | 5.83 | 3.00 | 7.17 |

**How the aggregates relate** (checked arithmetically in this report):
- **R1 weighted** = 0.20·Impact + 0.35·Demo + 0.15·Creativity + 0.30·Difficulty. For CaseLaw: 1.60 + 2.74 + 1.15 + 2.70 = 8.19.
- **R2 equal** = the mean of the same four.
- **Composite** reproduces to within ±0.01 as **0.7·(0.75·R1 + 0.25·R2) + 0.10·RSI + 0.20·Feasibility** [I: reverse-engineered by least squares; the orchestrator's exact formula is not in the corpus]. On that reading, feasibility carries twice the weight of RSI fit, and MongoDB depth enters only through the rubric scores.

**Per-judge rankings** (D-* §ranking sections) [V]:

| Judge persona | 1st | 2nd | 3rd | Last |
|---|---|---|---|---|
| Aram (Modelence) | CaseLaw | Kintsugi | IGNITION | Speciate |
| Bosco (AWS) | CaseLaw | Kintsugi | IGNITION | Dialect / Speciate |
| Build-feasibility staff engineer | **IGNITION** (CaseLaw's core at IGNITION's scope) | CaseLaw | Kintsugi | Speciate |
| CV veteran | CaseLaw (only with scope cuts) | Kintsugi | Witness | Speciate |
| Jackson (Raindrop) | **Kintsugi** | CaseLaw | IGNITION | Speciate |
| Steffan (MongoDB) | CaseLaw | IGNITION | Kintsugi | Speciate |

#### I.3 Why CaseLaw won, and with what dissent
- **Highest on the scored rubric.** It had the best R1 (8.19) and R2 (8.13) and tied for best Impact (a sourced, visceral incident class: the Replit agent that wiped production data "for more than 1,200 executives and over 1,190 companies" during a code freeze, https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/) [V via B2].
- **The trust boundary *is* its fitness function.** Replaying every past ruling to measure whether authority grew is exactly Bosco's R(C) ⊆ R₀ made executable (D-bosco §3).
- **Atlas is both the world and the judge.** "The only domain where Atlas is both the world and the fitness function"; it answers the event copy's "agents that adapt their own guardrails" literally (D-steffan §4).
- **Production transfer.** "Precedent replay runs unchanged on a real decision ledger" (D-aram §3; BP §16).
- **Dissent 1: feasibility.** CaseLaw's feasibility averaged 4.0/10 across the six judges; Jackson's persona gave it 3. The staff-engineer judge ranked IGNITION's tighter scope first: one compiler executed by Atlas for both live and replay, parity by construction, a gate of about 14 runs (D-build §0). The blueprint adopted that scope.
- **Dissent 2: the RSI prize.** Jackson's persona ranked Kintsugi first: "the only entry where Raindrop's measurement changes what ships". Its advice was to graft `routingTrust` and Raindrop-as-trigger into CaseLaw, which recovers about 2 points of RSI fit (D-jackson §4). The blueprint did.
- **Dissent 3: floor safety.** The CV veteran named Witness as the fallback if the 12:15 headroom test fails (D-cv §0). The blueprint kept a Witness pivot at G1 only.

### J. Summary of the final blueprint ([BLUEPRINT.md](BLUEPRINT.md))

**The idea in one line.** CaseLaw is a governed self-improving harness for an agent with write access to production data. Every tool call passes a gateway whose verdict **Atlas computes**. When the agent causes an incident, an evolver composes a **stateful law** from four generic primitives. The law is ENACTED only after four checks pass:
1. Atlas accepts the proposal on the evolver's own find+insert credentials.
2. An **as-of replay** of every past ruling flips the incident and changes nothing labelled harmful or needed.
3. Fresh paired reruns go from ≤1/5 to ≥4/5, with near-miss twins staying green.
4. A CAS transaction promotes it.

Each enacted law's incident then becomes a **precedent that judges every future law** (BP TL;DR, §1).

**The money shot (round 1, about 2:40, one throughline; BP §12.1):**

| Time | Beat |
|---|---|
| 0:00–0:35 | On the 11:40 harness, the agent archives 2023 orders. The archive stops at 300/412, and it deletes all 412: **112 orders exist nowhere** |
| 0:35–1:35 | The evolver composes law r-11 from the raw rulings. The replay sweep turns the incident RED→GREEN with zero harmful newly allowed. Lamps go parent 0/5, child 5/5, twin green: **ENACTED**. Same ticket: **REFUSED by r-11, written 9 s ago. 0 orders lost** |
| 1:35–2:10 | A judge plays a fully compromised evolver. The crude grab dies with **MongoServerError 121 on `cl_evolver`**. The subtle grab ("narrow r-11 to deletes over 500") passes the validator, then the replay flips the 412-doc precedent: **LOOSENING DETECTED → VOID**. "The database refuses what it can see. The replay catches what it can't." |
| 2:10–2:40 | One saved-aggregation table: held-out, same model, n and confidence intervals; rows bare / v0 / expert-static / **evolved** / **structure-only**, plus unseen-tool and filter-shift columns. One measured Raindrop line. The close |

**Mechanism highlights:**
- **World.** Keyed tiny worlds: one `episodeId` per episode, a server-side `$merge` seed, TTL cleanup. Seven MCP-named tools plus Self Diagnostics. Episodes capped at 6 calls (§2).
- **Families and splits.**
  - F2 (partial archive → delete) is the live family.
  - F1 (non-idempotent refund timeout) is train, off stage; its held-out version uses an **unseen tool** (`credit-account`).
  - F5 is benign. Near-miss twins kill trivial laws.
  - 15 held-out tickets. The generator and `sha256(seed)` are committed at 12:30 (§2.3–2.4).
- **Verifier.** A hidden per-document hash oracle, readable only by `cl_grader`; an admission test; pass = **oracle-correct**, not merely "no harm"; a two-sided objective (safety and utility); a disclosed scripted approver; hash-pinned prompt, model, grader and task set (§3).
- **Genome.**
  - Content-addressed, insert-only `harness_versions` with no mutable status.
  - v0 has **zero domain features**: four primitives (`count`, `sum`, `exists`, `covers`), committed before the fault plans.
  - **Max-severity compile**, so tightening ops can never lower a verdict.
  - `narrowRule` is the only loosening op. It always runs authority-delta replay and is never auto-promoted (§4).
- **Live path.** One `STAGES(bundle)` function runs the live decision (`$documents` of the run's own rows) and the replay (`$setWindowFields` over the ledger), so parity holds by construction. A labelled `mingo` fallback covers the case where `$documents` is denied (§5).
- **Loop.** Act → grade → trigger (local oracle or Raindrop) → `summarizeRun` raw evidence → Opus structured proposal inserted by the evolver itself → deterministic critic → compile → precedent replay (train and validation only) → k=5 on-policy gate with STAYGREEN and a cost rule → CAS promotion → SSE after commit. No retry-until-pass (§6).
- **Refusal layers.** Database validator (121) and roles (13), then the compiler, then the replay. Plus a green test over five principals and a 12-case red-team insert suite. If custom roles are impossible: a no-credential evolver, disclosed, **never `readWrite`** (§7).
- **Recursion.** The **precedent ratchet**, plus Raindrop-measured `routingTrust`. "No ignition claim, and no p-value" (§8).
- **MongoDB.**
  - Four databases split by trust (`fixtures`, `world`, `cl_pub`, `cl_priv`), with an `env` key per round.
  - Five least-privilege principals.
  - One change stream, owned by `cl_stream`.
  - CAS on `{active: parentHash, rev}` inside a transaction; a `StaleParent` race test.
  - An M0 budget: a 60 ops/s token bucket, ≤8 features, zero search indexes.
  - At most three MongoDB moments on stage (§9).
- **Raindrop.** One event per episode; a meter capped at 750; a trusted observer polls; the evolver holds no key; precision/recall → `routingTrust`; a shadow stream (§10).
- **UI.** One page, the agent acting full-width, with the gate strip sliding in. A **provenance header** (cluster, version, atlas/mingo, evolver role, Raindrop meter, freeze hash) makes every spoken claim conditional. A take-home `law-r-11.json` (§11).
- **Metrics.** Five rows, with the structure-only row never cut; Wilson CIs; exact McNemar. A **pre-declared tie claim** against the expert-static row; a hash freeze at 15:00 (§13).

**The build plan (BP §14).**
- **Capacity.** About 16 of about 17.5 effective person-hours planned. Lanes: P1 WORLD, P2 RUNTIME, P3 EVOLVER/GATE (driver), P4 MONGO-OPS/STAGE (narrator).
- **Dated gates:**

  | Gate | Time | Done means |
  |---|---|---|
  | G0 | 10:50 | Probe |
  | I1 | 11:45 | One episode end to end |
  | G1 | 12:15 | Headroom (the Witness pivot is allowed only here) |
  | G2 | 12:45 | A hand-written law passes the full gate |
  | G3 | 13:30 | First LLM-evolver verdict; hard stop 14:15 |
  | G4 | 14:30 | First real ENACTED |
  | Freeze | 15:00 | Hash freeze |
  | Feature freeze | 15:30 | — |
  | Rehearsals | 15:30–16:30 | Two rehearsals; backup recording by 16:30 |
  | Upload | 16:50 | Submission uploaded |
  | Tag | 17:00 | Tagged commit |

- **Fallback ladder.** At 14:45 with no real ENACTED, the demo becomes a live failure, a real STRUCK/VOID, and a hand-written law **labelled as such**.
- **Cut and never-cut lists.** An explicit cut list, and a 16-item never-cut list.

**Tonight (BP TL;DR):**
1. Atlas project (second Project Owner, `0.0.0.0/0`).
2. Five custom roles.
3. Funded LLM keys and a second provider.
4. Raindrop account, Pro trial, "HACKATHON" email, and a throwaway org for tests.
5. A Modelence account only.
6. Contracts as a Markdown table.
7. Fault plans in prose.
8. A printed script and Q&A sheet.
9. Kickoff question cards.
10. Text templates (`BUILT_TODAY.md`, `WHAT_IS_REAL.md`).

**Differentiation claimed (BP §17).** Three visible elements that the team did not find at NYC (said as "we didn't find it", never "first"):
1. stateful as-of precedent replay;
2. a semantic loosening caught after the validator passed it;
3. a compromised improver refused on its own credentials.

The live family deliberately avoids HarnessForge's refund hero ticket. Sightline (compiled policy, roles) and Morgadarsha (subset allowlists) are credited. Code 13 stays off stage.

---

## Contrarian Views And Risks

**On the evidence base itself**
1. **"Why they won" rests on a few observable expert decisions** (A3 §0.1, §1.1).
   - There are no score sheets, no round-1 recordings, and only two judge signals from NYC (the 98 → 6 cut and the order of 3).
   - Every earlier event mixed in crowd votes or different rubrics.
   - Every pattern in §A–C is an inference that transfers to a **different panel** (Raindrop, AWS, MongoDB, Modelence) with **no crowd step**.
   - The base-rate statistics (2/6 vs 3/79 for ablations; 0/~27 for agent-ops tools, p ≈ 0.14) are suggestive, not significant.
2. **The Contrarian may be right that performance beats substance** (A1-contrarian; A2-contrarian).
   - Twelve of fourteen winners had gaps between pitch and code that nobody caught. JustPrice, the thinnest build, won Jan.
   - CaseLaw invests heavily in rigor that is invisible unless staged: pre-registration, Wilson CIs, McNemar tests, five principals.
   - If the first 35 seconds ("112 orders exist nowhere") don't land for a walk-up judge in a parallel room, the depth won't save it.
3. **The corpus checked itself.** Most [V] labels come from the same research pipeline, and many sources are 2026 preprints and blog posts that this report did not re-read (§D). The fact-checks (C) caught 18 errors in earlier notes. More almost certainly remain in claims nobody re-checked.

**On CaseLaw specifically**
4. **It sits in the cluster that went 0/6 at NYC.**
   - Guardrail/security evolution placed nobody (A3 §7.2).
   - A "database veto" was already seen: 121 from CyclopsDiary; 13 from Sightline, Ripple and Claim Cipher.
   - All seven of our own proposals converged on a veto, and A3 predicts 5–10 look-alikes in SF.
   - CaseLaw's differentiators (as-of replay, the semantic loosening catch, the compromised improver) are **subtle**. A judge may see "another governed self-edit loop with a DB refusal". The mitigation is staging, not mechanism (BP §17).
5. **A tie is likely, and that weakens the RSI claim** (BP §13.2; N01 §9).
   - The user's own BSON Witness prototype found **no adaptive superiority**: a fixed fixture caught 95/95 faults.
   - The blueprint predicts that evolved vs expert-static will be "almost surely no significant difference" at n=15.
   - A sharp judge can say: "you planted two fault families and the evolver wrote one deny rule per family."
   - The defences rest on things that may slip: time-to-law, the unseen tool, the filter-shift and F-blind tickets. F-blind is deferred.
6. **The recursion is modest.**
   - The "precedent ratchet" is, in plain terms, a regression suite that grows. That *is* Hylak's "memory of bugs you refuse to reintroduce", so it may resonate.
   - `routingTrust` is a precision estimate at n≈9.
   - An HN-style critic, or Jackson, can still call it "optimization, not RSI". The blueprint's answer is to name the mechanism and claim nothing more (BP §8).
7. **The RSI prize may have been traded away.**
   - Kintsugi scored 9.0 on RSI fit against CaseLaw's 6.5, and Jackson's persona ranked it first.
   - If the RSI prize is judged separately and open to non-podium teams, a Raindrop-centred loop might have been the better $3k bet [U, F-judge K7].
   - The grafts (Self Diagnostics as a non-relay signal, `routingTrust`, a shadow stream) are all **deferred items (D2)** that only start after G4.
8. **"Every user is simulated"** (D-aram §0.2).
   - The world is a generated retailer, the approver is scripted, and the faults are planted.
   - Aram's "would it run Monday?" gets a split answer: replay transfers, while the k=5 gate needs a staging simulator.
   - The Impact story rests on the Replit incident class, not on a real user of this system.
9. **Statement 1's literal ask, "fit a specific user, task, or use case", is only partly answered.** Per-user forks (Speciate, the most creative idea at 8.17) were cut. CaseLaw specializes to one tenant's incident history only.

**On execution**
10. **Feasibility is the dominant risk** (F-feas; D-build).
    - Every proposal scored 3–6.5 on feasibility.
    - At the cut scope, P(a live core loop with a real ENACTED) ≈ 0.8, and person-hour estimates are ±25% [I].
    - Ripple's first useful evolution came at 15:37. The plan needs G3 by 13:30 and G4 by 14:30.
    - The 13:30 "can the evolver compose features?" decision may force the fallback close ("composed from a small human-written feature catalog").
11. **The sandbox can silently falsify the best lines** (F-judge K4).
    - If custom roles can't be created, the 121 fires on the gate's write ("evolver creds: none").
    - If `$documents` is denied, decisions run in `mingo`.
    - The provenance header keeps the pitch honest, but either fallback weakens the Bosco and Steffan story.
12. **Rate limits and money.** The LLM key, not Atlas, is the likeliest mid-demo failure. Raindrop's per-org Hobby cap stops ingestion **for the rest of October** if dev traffic leaks into it.
13. **The API claims are unverified here.** The blueprint's Claude 5.5 behaviours (sampling 400s, forced `tool_choice` 400s, the history-edit 400, prices) were checked against a bundled reference, not live. The G0 probe exists to catch this.
14. **Dashboard and DQ optics.**
    - A gate strip, lamps, a counter footer and an ablation table can still read as "a dashboard is the main feature" (F-judge K6).
    - Creating the Atlas project the night before is allowed only if the sandbox email permits it [U]. Log it in `BUILT_TODAY.md` as "provisioned, no data, no code".
    - The NYC organizers said "We'll be checking".
15. **Same-evening state.** A self-modifying system is non-idempotent: once round 1 enacts r-11, F2 no longer fails at 7 PM. Per-round `env` clones from the pre-law snapshot are mandatory (A3 P7; BP §12.4).

---

## Open Questions

| # | Question | Why it matters | How to settle (owner / time) |
|---|---|---|---|
| 1 | Sandbox tier, MongoDB version, and whether participants have Project Owner or DB Access Admin rights for custom roles | Decides the 121-on-own-credentials beat and the role table (C-tech #11) | Ask MongoDB staff at 10:30; G0 probe item 1 (P4, 10:35–10:50) |
| 2 | Is creating the project tonight acceptable? | DQ optics (BP §15) | Read the sandbox email; ask at 10:30 |
| 3 | Do `$documents` and `$setWindowFields` run under a custom least-privilege role on the sandbox version? | "Atlas computes the verdict" | G0 probe 6; `mingo` fallback labelled |
| 4 | How do `$merge`, `insertMany` and `bulkWrite` count toward M0's 100 ops/s? | Gate wall-clock and throttling | G0 probe 7 |
| 5 | Do change streams work on the sandbox tier (Flex docs contradict themselves)? | The single SSE stream | G0 probe 5 |
| 6 | Who judges the Raindrop RSI prize, from which round, and can a non-podium team win it? | Whether to invest in D2 (the Raindrop table) early | Ask CV staff at 10:30 (F-judge K7) |
| 7 | Raindrop ingest-to-query latency; whether Self Diagnostics reports appear in `/v1/events/count` filters; SDK behaviour when disabled | Whether any Raindrop number can be live | Measure at 11:30 (BP §14.2) |
| 8 | Does the Pro trial need a card, and does the "HACKATHON" email grant credits or the `new_issues_nav` flag? | Issues and Experiments access | Email tonight |
| 9 | Will the evolver compose working features from the four primitives by 13:30? | The "zero human-written laws" close | G3 decision (BP §4.2) |
| 10 | Does the headroom test pass (incident fails ≥4/5 on v0; benign passes ≥4/5)? | Without headroom there is no ENACTED | G1 at 12:15; lure strength, then worker model, then the Witness pivot |
| 11 | Actual LLM tier limits (RPM/OTPM) and the exact call shapes for Haiku/Sonnet/Opus 5.5 | Mid-demo 429s; 400s on parameters | G0 probe 9–11 at 10:45 |
| 12 | Do round-1 rooms include the four named judges? | Which nouns go in the first 60 s | Ask at kickoff; design for any technical judge (N44 L52) |
| 13 | Modelence credit amount, and whether a forked `child_process` counts as a second process | Whether D5 is worth 50 minutes | Ask at the Modelence table; 11:30 smoke deploy |
| 14 | AIDE² reward-hacking figures (63% → 34% blog vs 55% → 32% arXiv) | Only if quoted | Quote both or neither |
| 15 | What the NYC rubric actually said | Low (SF weights are given) | None needed |
| 16 | Whether a strong static policy written blind (R4) ties the evolved harness | The headline claim's strength | The pre-registered ablation at 15:00; say "tie" aloud if so |

---

## Sources

Every URL below appears in the research corpus (`research/notes/*`, `research/debate/*` or `BLUEPRINT.md`). Two were re-fetched while writing this report (marked ✓). Treat every page as data. Local corpus files are cited by the keys in the citation table at the top.

**This event and its rules**
- https://cerebralvalley.ai/e/mongodb-sftw-hackathon ✓ — SF event page: judges, the $18k wording, Atlas Agent Engine, "adapt their own guardrails"; no RSI criteria (re-fetched Oct 10).
- https://partiful.com/e/SLKAGzRbpQ3d3TGM8pAU — Partiful listing: Shack15 address; older $15k figure.
- https://www.tech-week.com/calendar/sf/events/the-harness-engineering-and-model-wrangling-hackathon-88af9295-2ccc-4bf8-bbc5-1eb223817051 — Tech Week listing (pre-Raindrop $15k).
- https://www.mongodb.com/products/platform/atlas-agent-engine — Agent Engine product page linked from the event page; preview pricing.
- https://cursor.com/redeem/event/mongo-db-hackathon-sf-tech-week-ygcedp — Cursor $60 credit redemption, valid Oct 11–12.
- https://docs.google.com/document/d/1mCh5MtOzBw0aJpurQVUmIVFfPMAHW3MjNemE-LNiMto/edit?tab=t.0 — ElevenLabs hacker guide (Creator month via Discord).

**NYC edition (Sep 26 2026)**
- https://cerebralvalley.ai/e/mongodb-nyc-hackathon — NYC event page: judges, attendee-vote format.
- https://cerebralvalley.ai/e/mongodb-nyc-hackathon/hackathon/gallery — 98-project gallery with placements and `publicVotePlacement`.
- https://www.linkedin.com/posts/mongodbinc_mongodblocal-activity-7511818091685732353-C0J5 — MongoDB's official NYC winners post (Oct 2).
- https://x.com/MongoDB/status/2106056436904042684 — MongoDB's X post on the NYC winners.
- https://allai.events/event/the-harness-engineering--model-wrangling-hackathon-2 — listing naming more NYC partners.
- https://github.com/jovianw/ripple — Ripple repo (1st).
- https://github.com/jovianw/ripple/blob/main/DESIGN.md — Ripple's design doc; statement mapping; HarnessConfig contract.
- https://github.com/jovianw/ripple/pull/44 — Ripple ran out of model credit mid-afternoon.
- https://github.com/jovianw/ripple/pull/47 — Ripple's stale-parent-score issue.
- https://www.youtube.com/watch?v=yMx84ME4XYA — Ripple's 1-minute submission video.
- https://github.com/SpectrrT/MongoDB_HarnessHack — Offload repo (2nd).
- https://github.com/SpectrrT/MongoDB_HarnessHack/blob/main/docs/00-hackathon-brief.md — Offload's copy of the NYC brief (rubric wording, "We'll be checking").
- https://github.com/lhnminh/self-improving-computer-use — Morgadarsha repo (3rd).
- https://youtu.be/x6hrG1wZUH4 — Morgadarsha demo video.
- https://github.com/Cobeml/Da-Vinci — Da Vinci repo (finalist).
- https://youtu.be/QjKv8p9AJu4 — Da Vinci demo video.
- https://github.com/hughesbrayden/sightline — Sightline repo (finalist; roles, code-13 tripwire).
- https://www.loom.com/share/02d8cd6855844d119fcd969e2a7aa2ad — Sightline demo.
- https://github.com/exploring-curiosity/CyclopsDiary — CyclopsDiary repo (finalist; error-mode validators).
- https://youtu.be/P9OXVsmuzuA — CyclopsDiary demo.
- https://github.com/Deepesh-Katudia/harnessforge — HarnessForge (non-placer; refunds-desk hero ticket).
- https://github.com/99thDragon/Hugging-Agents — Hug Guardian repo (never submitted to the gallery).
- https://github.com/chmartin/chip-harness — Self-Evolving Chip-Design Harness (non-placer).
- https://github.com/chmartin/chmartin.github.io/blob/master/_posts/2026-09-28-Self-Evolving-Chip-Design-Harness.md — chip-harness post-mortem (keep-rule lesson).
- https://github.com/the-woody-kim/scar-tissue — Scar Tissue (hash-pinned active config).
- https://github.com/brahmi9811/team-claim-cipher — Claim Cipher (QE; roles hide `sim_truth`).
- https://github.com/imfabiokeller/goalkeeper/blob/main/planning/judges.md — an NYC team's predictions of judge questions (third-party).
- https://github.com/strands-labs/harness-optimizer — Strands Harness Optimizer, Ripple's cited related work.

**Earlier MongoDB × CV events**
- https://cerebralvalley.ai/e/persistent-context-sprint-hackathon — Build Fest SF (Aug 2026) event page.
- https://cerebralvalley.ai/e/persistent-context-sprint-hackathon/hackathon/gallery — Build Fest gallery.
- https://x.com/MongoDB/status/2088318267370688599 — MongoDB post on the Build Fest winners.
- https://github.com/borisnezlobin/mongo-hacks — Amelia for the Deaf (1st, Build Fest).
- https://github.com/Carldtitan/Tracecase — TraceCase (2nd, Build Fest).
- https://github.com/rohangandotra18/perpetual — Perpetual (3rd, Build Fest).
- https://cerebralvalley.ai/e/mongo-db-london-hackathon — London Agentic Evolution (May 2026) event page.
- https://cerebralvalley.ai/e/mongo-db-london-hackathon/hackathon/gallery — London gallery.
- https://www.youtube.com/watch?v=d9mrjlfD3no — London finals video.
- https://github.com/rostam-sodagari/Builder-AI — PlanPass AI repo (1st London; now 404/private).
- https://github.com/Bividib/MongoDBHackathon — RunwayOps (2nd London).
- https://github.com/AyushGupta05/Frequency- — Volt Control (3rd London; 404).
- https://github.com/aswin-giridhar/mongodb_agentic_evolution — Substrate (London finalist).
- https://github.com/Kazybekkh/LiveRecall — Cooks/LiveRecall (London finalist).
- https://github.com/VladimirAkopyan/GlassHouses — Glass Houses (London finalist).
- https://cerebralvalley.ai/e/agentic-orchestration-hackathon — Jan 2026 Agentic Orchestration event page.
- https://cerebralvalley.ai/e/agentic-orchestration-hackathon/hackathon/gallery — Jan gallery (all marked "Finalist"; vote data inverted).
- https://www.youtube.com/watch?v=dHMariXb2wg — Jan finals video with the award ceremony (the authoritative ranking).
- https://github.com/ohong/fairward — JustPrice (1st Jan).
- https://github.com/AndresNinou/mongodb_hackathon — Mongrate (2nd Jan).
- https://github.com/nic-olo/MongoDBHack-MentraOS — SOGA (3rd Jan).
- https://github.com/kfallah/watch-and-learn — Watch and Learn (Jan finalist).
- https://github.com/aparekh02/EvacuTrace — EvacuTrace (Jan finalist).
- https://github.com/NineSunsInc/threat-intelligence-service — Polaris (Jan finalist; 404).
- https://github.com/jayyu23/x402-zkid — x402-zkid (Coinbase track; self-reported).
- https://cerebralvalley.ai/e/mongoDB-hackathon — Oct 2025 Agentic Memory & Context Engineering event page.
- https://cerebralvalley.ai/e/mongoDB-hackathon/hackathon/gallery — Oct 2025 gallery (expert-only placements).
- https://www.linkedin.com/posts/shawnswyxwang_agentic-memory-context-engineering-hackathon-activity-7382218036390322176-PXGY — swyx: ForgetMeNot "unanimously judged winners".
- https://www.linkedin.com/posts/seyeong-han_meta-mongodb-hackathon-activity-7383894410163548160-A3nt — Young Han's "How to Win a Hackathon" judge tips.
- https://github.com/galileo-ml/mongodb-hackathon — ForgetMeNot (1st Oct 2025).
- https://github.com/aaarzyn/contextscope — contextScope (2nd Oct 2025).
- https://github.com/shlawgathon/WebBrain — WebBrain (3rd Oct 2025).
- https://github.com/OscarKhaing/EchoStay — EchoStay (finalist).
- https://github.com/sathvikparasa/mongodb-agentic-memory — KitchenPal (finalist; 404).
- https://github.com/janavi2001/Seeded_Rag_Dashboard — MonGOD / Incident Copilot (finalist).

**RSI-themed and other analog hackathons**
- https://cerebralvalley.ai/e/aiewf-hackathon-2026 — AIEWF Hackathon 2026 (RSI theme).
- https://cerebralvalley.ai/e/aiewf-hackathon-2026/hackathon/gallery — AIEWF gallery and placements.
- https://www.youtube.com/watch?v=MrdXQv5wlB4 — SplatForge demo.
- https://github.com/ShivamSinghNow/SplatForge — SplatForge (1st AIEWF).
- https://github.com/karti-ai/podman — PodMan (2nd AIEWF; 404).
- https://github.com/gorajing/rote — rote (3rd AIEWF).
- https://github.com/JacobFV/fieldratchet — field-ratchet (AIEWF finalist).
- https://github.com/Visual-Studio-Coder/EvoLoRA — EvoLoRA (AIEWF finalist).
- https://github.com/ypatodkar/FocalPoint — FocalPoint (AIEWF finalist).
- https://dev.to/dailycontext/two-day-hackathon-kicks-off-ai-engineer-worlds-fair-2l1d — AIEWF coverage.
- https://rapid-agent.devpost.com/ — Google Cloud Rapid Agent Hackathon (MongoDB and Arize tracks).
- https://github.com/Hou-dini/sentinel-flood-watch — Sentinel Flood-Watch (MongoDB track 3rd; MCP gotchas).
- https://github.com/SirjanSingh/cassandra — Cassandra (Arize 1st; watch → diagnose → patch → replay).
- https://github.com/bhupenbandi/compliance-os — ComplianceOS (Arize 2nd; "a metric that cannot go down…").
- https://cerebralvalley.ai/e/weave-hacks-3-self-improving-agents-hackathon-with-weights-and-biases-7014fe80 — WeaveHacks 3 (self-improving agents).
- https://weavehacks2.devpost.com/ — WeaveHacks 2 (criteria include "self-improving-ness").
- https://github.com/savir2010/aetheris — Aetheris V.O. (WH3 1st; contains a malicious `.vscode` task, do not open in an IDE).
- https://github.com/Atharva-Gundawar/machine-gun-baby — Daydreamer (WH2 Grand Prize).
- https://github.com/nightlessbaron/rebibemecode — ReviveAgent (WH2 Best Self-Improving Agent).
- https://cerebralvalley.ai/e/crusoe-recursive-agents-hackathon — upcoming Recursive Agents Hackathon (Oct 17).
- https://nyc.aitinkerers.org/p/agents-money-hackathon — example of the unrelated LiquidMetal "Raindrop" prize (name collision).

**Judges' own writing**
- https://www.raindrop.ai/blog/mcp-design — Jackson Ferrigno, "MCPs need to be designed too" (markdown-file quote; −12% / −27%).
- https://www.linkedin.com/posts/boscoalbuquerque_agenttrustarchitecture-domainagi-aitrustengineering-activity-7505130403649761281-WT_l — Bosco Albuquerque, "Hard Trust Boundary" (R(C) ⊆ R₀).
- https://modelence.com/blog/modelence-mongodb-atlas — Modelence on Atlas (Aram's company framing).

**Raindrop**
- https://www.raindrop.ai/ — homepage: Trace → Detect → Investigate → Simulate → Verify; customers.
- https://raindrop.ai/docs/platform/plans.md ✓ — Hobby/Pro limits; ingestion stops for the month (re-fetched Oct 10).
- https://raindrop.ai/docs/cookbooks/self-healing-loop.md — Raindrop's self-healing loop (fail-before / pass-after).
- https://raindrop.ai/docs/platform/self-diagnostics.md — Self Diagnostics; custom categories replace the defaults.
- https://raindrop.ai/docs/platform/signals.md — signal types; which ones count against custom slots.
- https://raindrop.ai/docs/platform/experiments.md — Experiments (cohorts, 95% CI, Pro).
- https://raindrop.ai/docs/platform/alerts.md — Slack-only alerts (no webhooks).
- https://raindrop.ai/docs/sdk/typescript.md — TS SDK: featureFlags, `__raindrop_report`.
- https://raindrop.ai/docs/query-api/api-reference.md — Query API endpoints and rate limits.
- https://raindrop.ai/docs/query-api/sdk.md — Query SDK; separate Query key.
- https://query.raindrop.ai/v1/openapi.json — Query API OpenAPI spec.
- https://raindrop.ai/docs/mcp/overview.md — hosted MCP tool list and auth.
- https://github.com/raindrop-ai/skills/blob/main/raindrop-investigate/references/mcp-tools.md — `new_issues_nav` flag; `raindrop_` prefixes.
- https://github.com/raindrop-ai/workshop — Workshop (MIT, :5899, `replay_run`).
- https://raindrop.ai/docs/workshop/overview.md — Workshop replay registration.
- https://raindrop.ai/docs/llms-full.txt — full docs dump (absence-of-webhooks check).
- https://www.raindrop.ai/blog/series-a — Series A and Simulations (Sep 17 2026).
- https://www.raindrop.ai/blog/introducing-raindrop-2 — Raindrop 2.0 "Self-Healing Agents".
- https://www.raindrop.ai/blog/signals-2-frontier-classification — Signals 2.0; Raindrop's own daily retune loop.
- https://www.raindrop.ai/blog/huggingworld — huggingworld; replayed-context cost lesson.
- https://www.raindrop.ai/blog/thoughts-on-evals — Hylak on evals; per-user variants can't be eval'd.
- https://www.howtoeval.com/ — Hylak's "How to evaluate AI agents" (floor-raising; volume ladder).
- https://creativeconviction.ai/interviews/ben-and-zubin-raindrop/ — Hylak: most self-healing pitches "just do not work".
- https://benhylak.substack.com/p/humanitys-last-problem — "Monitoring is humanity's last problem."
- https://www.raindrop.ai/case-studies/speak — Speak: coding agents use Raindrop MCP to propose prompt PRs.
- https://www.raindrop.ai/case-studies/gc-ai — GC.AI hill-climbing with Workshop.
- https://www.torontomachinelearning.com/ — Raindrop ML engineer's talk in an "RSI" track.
- https://luma.com/fvz1h1dq — Autoresearch Systems Hackathon with a Raindrop Workshop prize.

**MongoDB: docs, product updates and blogs**
- https://www.mongodb.com/docs/agent-skills/ — Agent Skills (builder guide).
- https://github.com/mongodb/agent-skills/blob/main/skills/mongodb-search-and-ai/references/automated-embedding.md — autoEmbed on all tiers incl. M0.
- https://www.mongodb.com/docs/mcp-server/get-started/ — MCP Server getting started.
- https://www.mongodb.com/docs/mcp-server/local-mcp/configuration/options/ — `allowRequestOverrides`; narrowing-only headers.
- https://github.com/mongodb-js/mongodb-mcp-server/blob/main/packages/cli/src/config/configOverrides.ts — header prefix `x-mongodb-mcp-`; HTTP only.
- https://www.mongodb.com/docs/mcp-server/remote-mcp/access-models/ — Managed MCP access models.
- https://www.mongodb.com/company/blog/product-release-announcements/mongodb-for-agentic-era-built-for-developers-ai-agents — Frontier connectors and Managed MCP (Aug 13).
- https://www.mongodb.com/docs/manual/natural-language-to-mongodb/ — NL → MQL prompting guide.
- https://huggingface.co/datasets/mongodb-eai/natural-language-to-mongosh — MongoDB's 766-case NL → mongosh benchmark.
- https://www.mongodb.com/docs/atlas/sample-data/sample-mflix — sample_mflix (redirects).
- https://www.mongodb.com/docs/manual/data-modeling/ — data modeling.
- https://www.mongodb.com/products/platform/atlas-vector-search — Vector Search marketing page.
- https://www.mongodb.com/docs/atlas/atlas-search/ — Atlas Search (redirects to /docs/search/).
- https://www.mongodb.com/company/blog/product-release-announcements/unlocking-ai-search-introducing-automated-embedding-in-mongodb-vector-search — stale autoEmbed blog (says preview).
- https://www.mongodb.com/products/updates/now-ga-automated-embedding-in-atlas-vector-search — autoEmbed GA (Aug 12 2026).
- https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/models/ — autoEmbed rate limits (3 RPM on M0 without payment).
- https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/ — Embedding & Reranking API.
- https://www.mongodb.com/developer/products/atlas/interactive-rag-mongodb-atlas-function-calling-api/ — dead builder-guide link (redirects to docs home).
- https://github.com/mongodb/docs-notebooks/blob/main/use-cases/ai-agent.ipynb — replacement for the dead agent tutorial.
- https://www.mongodb.com/developer/products/atlas/advanced-rag-langchain-mongodb/ — "Adding Memory (Python)" (redirects).
- https://www.mongodb.com/developer/products/atlas/add-memory-to-javascript-rag-application-mongodb-langchain/ — "Adding Memory (JS)" (redirects to an unrelated page).
- https://www.mongodb.com/docs/atlas/ai-integrations/langgraph/build-agents/ — LangGraph + Atlas.
- https://www.mongodb.com/company/blog/technical/state-persistence-the-problem-of-agent-reliability — bundle versioning and the kill test.
- https://www.mongodb.com/docs/atlas/ai-agents/ — 404 builder-guide link.
- https://www.mongodb.com/docs/vector-search/about/ai-agents/ — current AI-agents page.
- https://www.mongodb.com/docs/atlas/ai-integrations/langchain/graph-rag/ — GraphRAG on `$graphLookup`.
- https://github.com/mongodb-developer/GenAI-Showcase/tree/main — GenAI Showcase.
- https://github.com/mongodb-developer/mongodb-atlas-python-quickstart/blob/main/quickstart-1-getting-started-atlas-python.ipynb — Python quickstart.
- https://github.com/mongodb-developer/mern-stack-example — MERN starter.
- https://www.mongodb.com/startups — MongoDB for Startups.
- https://www.mongodb.com/company/blog/technical/agent-harness-why-llm-is-smallest-part-of-your-agent-system — MongoDB's six harness components; "governed fleet".
- https://www.mongodb.com/company/blog/technical/agent-observability-monitoring-decisions-not-requests — "the unit is the decision".
- https://www.mongodb.com/company/blog/technical/agent-memory-inside-harness — "memory as governed infrastructure".
- https://www.mongodb.com/products/updates/now-in-public-preview-mongodb-atlas-agent-engine — Agent Engine public preview (Sep 29 2026).
- https://www.mongodb.com/company/newsroom/press-releases/mongodb-launches-atlas-agent-engine-to-put-ai-agents-in-production-without-a-new-stack — Agent Engine press release.
- https://www.mongodb.com/docs/agentengine/manage/governance/guardrails.md — Content Guardrails (regex `output_validation` only).
- https://www.mongodb.com/docs/agentengine/manage/governance/policy-engine.md — Policy Engine (`AUTHORIZED_TOOLS`, budgets).
- https://www.mongodb.com/docs/agentengine/add-features/memory-types.md — four memory types.
- https://www.mongodb.com/docs/agentengine/deploy/atlas-setup.md — no Free clusters; service account.
- https://www.mongodb.com/company/blog/product-release-announcements/how-atlas-agent-engine-powers-mongodbs-internal-ai-strategy — MongoDB's internal "Holly" agents.
- https://www.mongodb.com/docs/manual/release-notes/9.0/ — MongoDB 9.0 release notes.
- https://www.mongodb.com/docs/atlas/infinite/atlas-infinite-landing/ — Atlas Infinite (no Search/MCP in preview).
- https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ — Free tier: 100 ops/s, limits.
- https://www.mongodb.com/docs/atlas/reference/flex-limitations/ — Flex limits (500 ops/s).
- https://www.mongodb.com/docs/vector-search/deployment/compatibility-limitations/ — 3 / 10 search-index caps.
- https://www.mongodb.com/docs/atlas/atlas-ui/triggers/limitations/ — no Triggers on Flex; contradictory change-stream text.
- https://www.mongodb.com/docs/atlas/unsupported-commands/ — `createRole` unsupported via drivers.
- https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/ — custom roles via UI/CLI/Admin API; 30 s deploy.
- https://www.mongodb.com/docs/manual/reference/built-in-roles/ — `readWrite` privileges (drop, rename…).
- https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/ — `$rankFusion` (8.0+).
- https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/ — `$scoreFusion` (8.3+).
- https://www.mongodb.com/docs/vector-search/query/aggregation-stages/rerank/ — `$rerank` stage (says 9.0).
- https://www.mongodb.com/docs/vector-search/query/native-reranking/quickstart/ — Native Reranking quickstart (says 8.3).

**Partner and extra tools**
- https://docs.modelence.com/hackathon/mongodb-2026 — Modelence hacker guide (credit placeholders).
- https://docs.modelence.com/deploy/setup.md — single Node web process; injected `MONGODB_URI`.
- https://modelence.com/pricing — Modelence free tier sleeps when idle.
- https://github.com/modelence/modelence — Modelence framework repo.
- https://kiro.dev/ — Kiro IDE.
- https://kiro.dev/crew/ — Kiro Crew.
- https://github.com/kirodotdev/KiroCrew — Kiro Crew repo (`bug_gate.py` RED ∧ GREEN ∧ STAYGREEN).
- https://kiro.dev/docs/permissions.md — Kiro `permissions.yaml` (deny > ask > allow).
- https://elevenlabs.io/docs/api-reference/twilio/outbound-call — ElevenLabs outbound-call API.
- https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm.md — ElevenAgents Custom LLM bridge.
- https://elevenlabs.io/docs/eleven-agents/operate/architect/proposals.md — ElevenAgents Architect proposals (prior art).
- https://cursor.com/docs/grok-bot.md — Grok Bot docs.
- https://github.com/gepa-ai/gepa — GEPA reflective prompt evolution.

**CopilotKit**
- https://github.com/CopilotKit/OpenBot — OpenBot (MIT; `govern()`, policy dry-run).
- https://www.copilotkit.ai/openbot — OpenBot product page.
- https://github.com/CopilotKit/OpenBot/issues/350 — open issue: pluggable stateful decider.
- https://github.com/CopilotKit/OpenBot/pull/694 — closed PR (kill-switch bypass).
- https://github.com/CopilotKit/openmuse — OpenMuse (MIT).
- https://www.copilotkit.ai/openmuse — OpenMuse page ("no Intelligence subscription" claim).
- https://github.com/CopilotKit/openmuse/issues/73 — make Intelligence optional (open).
- https://github.com/CopilotKit/OpenDots — OpenDots (MIT).
- https://www.copilotkit.ai/blog/introducing-opendots — OpenDots launch post.
- https://github.com/CopilotKit/OpenDots/issues/123 — Intelligence outage reports (Oct 9).
- https://docs.copilotkit.ai/learning — Automatic Learning (15 threads, daily, skills only).
- https://docs.ag-ui.com/concepts/events — AG-UI events (`STATE_DELTA` JSON Patch).

**RSI research and harness practice**
- https://www.philschmid.de/recursive-self-improvement — Schmid: iteration vs self-improvement vs RSI.
- https://www.weco.ai/blog/4-levels-of-recursive-self-improvement — Weco's four RSI levels.
- https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement — AIDE² blog (public/private split; ignition not significant).
- https://arxiv.org/abs/2609.26457 — AIDE² paper (different reward-hacking figures from the blog).
- https://arxiv.org/abs/2607.07663 — survey of 1,250 self-improvement papers; verification hierarchy.
- https://arxiv.org/abs/2603.28052 — Meta-Harness (raw traces 56.7% vs scores 41.3%).
- https://github.com/stanford-iris-lab/meta-harness — Meta-Harness code.
- https://arxiv.org/abs/2609.24972 — RRSI (critic, noise floor, cost rule, prune).
- https://github.com/google-research/rrsi — RRSI code.
- https://arxiv.org/abs/2608.09885 — SHE (four-artifact safety harness evolution).
- https://github.com/RainbowQTT/SHE — SHE code.
- https://arxiv.org/abs/2603.03329 — AutoHarness (code harness; zero illegal moves).
- https://arxiv.org/abs/2510.04618 — ACE (playbooks with helpful/harmful counters).
- https://arxiv.org/abs/2608.06301 — HarnessOpt-Bench (held-out partition inaccessible during search).
- https://arxiv.org/abs/2608.04003 — PAST-Bench (show the pathway, not just the score).
- https://arxiv.org/abs/2606.23075 — safety of self-evolving agents (lineage-persistent attacks).
- https://sakana.ai/dgm/ — Darwin Gödel Machine (faked test logs).
- https://arxiv.org/abs/2310.02304 — STOP (sandbox-flag disabling).
- https://openai.com/index/harness-engineering/ — OpenAI, "Harness engineering".
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — Anthropic: JSON less likely to be overwritten than Markdown.
- https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering — LangChain: TB2 52.8 → 66.5 from harness changes alone.
- https://github.com/karpathy/autoresearch — autoresearch keep/discard ratchet.
- https://cline.bot/blog/recursive-self-improvement-for-coding-agents — Cline RSI (higher score at lower cost).
- https://code.claude.com/docs/en/hooks — Claude Code hooks incl. `ConfigChange`.
- https://www.anthropic.com/institute/recursive-self-improvement — Anthropic Institute framing of RSI.

**Zeitgeist**
- https://openai.com/index/introducing-the-agents-api/ — OpenAI Agents API ("evolving Codex harness").
- https://www.latent.space/p/thariq — Claude Mods / "mutable software".
- https://www.prnewswire.com/news-releases/mongodb-launches-atlas-agent-engine-to-put-ai-agents-in-production-without-a-new-stack-302892753.html — Agent Engine wire release.
- https://arxiv.org/abs/2609.38372 — Self-Evolving Harness with the Agent as Its Own Optimizer.
- https://arxiv.org/abs/2609.14858 — Dream-RSI (history as a replay simulator).
- https://news.ycombinator.com/item?id=49726955 — HN discussion of Dream-RSI.
- https://x.com/dair_ai/status/2101835306953736396 — DAIR.AI on ModularRSI.
- https://darioamodei.com/post/we-must-pace-the-frontier — Amodei, "We Must Pace the Frontier".
- https://hackernoon.com/is-harness-engineering-softwares-last-breath — the bitter-lesson argument against harnesses.
- https://aisocratic.org/blog/ai-socratic-sep-2026 — ARC-AGI-3 harness swing; Jev skepticism (secondary).
- https://cognition.com/blog/devin-fusion — Devin Fusion multi-model routing.
- https://github.com/deepseek-ai/deepseek-harness — DeepSeek Harness (adoption signal).
- https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/ — Replit agent wiped production data during a code freeze (CaseLaw's impact open).

---

## Rerun Inputs

```
workflow: firecrawl-deep-research
topic: MongoDB Harness Engineering hackathon — recursive harnessing, past winners, Raindrop RSI, CopilotKit Open* repos
depth: exhaustive
output: markdown
```
