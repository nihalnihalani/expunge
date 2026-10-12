# Expunge demo: the governed cleanup loop

This demo shows one pass of Expunge's improvement loop on the invited MongoDB Atlas Sandbox and a real model provider.
The world it cleans is a **seeded synthetic company** (family `direct_nested`), not owner data. Every step below says
whether it is real, a pilot, or a labelled test fixture.

## Run the app

All three processes read the root `.env`. Use a **new** scope id for each fresh world (a scope holds one world).

1. Seed a world and deploy the improved child of W0 as that scope's starting harness. If you want W0 instead, run
   `seed:world` with the same arguments:

   ```sh
   EXPUNGE_SCOPE_ID=demo-scope-1 npm run seed:candidate -- --family direct_nested --seed demo-1
   ```

   The scope set inline wins over `.env`. The output gives `worldId`, `subjectHandle` and the deployed harness hash.
   The sealed manifest goes to `.expunge/worlds/<worldId>.private.json`, which is ignored.

2. Start the domain service (4320), the worker (4330) and the operator (4310 and vite 5173) on that scope:

   ```sh
   npm run demo:start -- demo-scope-1            # add --dry-run to print the commands and variable names only
   ```

   The script passes the scope, tenant, environment and domain URL explicitly to all three processes. The operator
   gets only the variables it reads, never a `MONGODB_*` or `ATLAS_*` one. The script refuses to start if a port is
   already taken. Logs go to `.expunge/run/logs/` and pids to `.expunge/run/pids/`. `npm run demo:stop` stops only
   the processes the script started.

3. Open `http://localhost:5173`. Under New cleanup, choose the seeded world, set **Identifier type** to `String`, and
   enter the `subjectHandle` from step 1 (the subject's `customers._id`) as the exact identifier. Then preview and
   submit.

## Run order

| Step | What happens | Command or place | Status |
|---|---|---|---|
| 1. Baseline run | The W0 harness cleans one subject with the real model; the receipt is `incomplete` because W0 only deletes from `customers` | Operator UI (`npm run dev`, then `http://localhost:5173`) or the record in `docs/continuity/PROJECT-STATE.md` decision 22 | **Real** (Atlas, real model, `run_attestations` row written) |
| 2. Evidence | The worker's Raindrop episode is read back through the Query API and becomes citable evidence | `packages/observer` evidence process | **Real read-back**: for the baseline job the subject was registered (generation 1), the leak guard exported (generation 1), the outbox reached `evidence_ready`, and the Raindrop event read back (trace `7002add2…`, 20 spans). Gap: nothing registers a job's subject at submit time yet, so this step was run by hand |
| 3. Candidate | An operator-authored child of W0 (schema mode `selected_fields` to `all_registered_fields`, nested arrays on, traversal depth 1 to 5) compiled by the real harness-compiler, which computes the authority class (`behavioral`, no grant required) | `node --import tsx scripts/demo/candidate.ts` ([candidate.md](candidate.md)) | **Real compiler**; the edit is operator-authored, not model-generated |
| 4. Pilot | Parent and candidate on fresh worlds with the real model, 6 training pairs | `node --import tsx --env-file=.env scripts/demo/pilot.ts` | **Pilot, not an admission** (the admission rule needs 38 pairs) |
| 5. Approval, promotion, new run, rollback | A labelled test-fixture admit report, the approval descriptor rendered from stored rows, a single-use grant, atomic promotion, a job pinned to the child and run with the real model, then an audited rollback | `node --import tsx --env-file-if-exists=.env scripts/demo/promote.ts` ([promotion.md](promotion.md)) | **Real governance code and real model run**; the admit report is a **labelled test fixture** |
| 6. Supporting evidence | Atlas RBAC: all nine principals' allowed and denied find/insert/update/remove on 79 collections equal the committed manifest (0 surprises, 0 writes); attestation fails closed before any model call when the stamp cannot be written | `docs/MONGO.md` "Atlas RBAC evidence"; `docs/review/DA-18-atlas-rbac-probe.md` | **Real** (live Atlas probe) |

## Results so far

- Baseline (real, Atlas): job `job_eea9d3478001637c1291d1beb60be90bb18ef542`, receipt `domainStatus incomplete`, 5 model calls, about 0.0007 USD.
- Pilot (real model, local replica set, 6 fresh training pairs, [pilot.md](pilot.md), **PILOT, NOT ADMISSION**): parent W0 0 of 6 useful (33 residuals), candidate `f1eb5184…` **3 of 6 useful** (18 residuals); all 12 receipts verified, 0 collateral, every stamp from the real provider; the candidate cost $0.0131 vs $0.0076. The gain is on the `direct_nested` family only (pairs 0, 2, 4: 0 residuals each); both arms fail all three `alias_two_hop` pairs. A second independent run gave the same split (0/6 vs 3/6, 31 vs 18 residuals). The earlier pilot of the superseded child `bd1eaf18…` was 0/6 vs 0/6. Six pairs, no held-out split, no statistics, operator-written eligibility rows.
- Promotion run (real model, local replica set, [promotion.md](promotion.md)): fixture admit, grant, promotion W0 to child `f1eb5184…` at pointer revision 1 with the grant consumed in the same transaction, then W0 and the child each ran one job on an identically seeded fresh world. W0 left 5 targeted residuals (receipt `incomplete`); the child left **0** (receipt `complete_in_registered_scope`, useful completion), 0 collateral in both, at about 2.5 times the tokens. Rollback to W0 at revision 2 with its own grant. One run per arm: it shows the mechanism, not a measured improvement.
- Root cause of W0's miss: `selected_fields` hides the identity fields on `messages` and `notes`, so the model never discovers those records. The earlier child (`bd1eaf18…`, nested arrays and depths only) still left 2 residuals and is superseded.

## What is real and what is pending

| Claim | State |
|---|---|
| Atlas Sandbox, least-privilege principals, strict validators | Real; probed live for 4 data verbs on 79 collections (full privilege-set equality, RP-1, still to run) |
| Real model provider in the worker | Real (OpenAI) |
| Raindrop tracing from the worker | Ingest observed in the Raindrop dashboard; Query read-back of the baseline episode demonstrated (trace `7002add2…`, 20 spans) after the `tool_call.tool_name` fix; subject registration at submit time is not wired yet |
| Evidence-linked, model-generated mutation | Pending: the production evolver has no real model adapter yet; the demo candidate is operator-authored |
| Fresh admission (38 pairs, 76 episodes) | Pending: not run; the demo uses a 12-episode pilot and a labelled test-fixture admit |
| Real owner data, 360-episode protocol, meta controls | BLOCKED: no authorized owner data, no specification file for the real-data protocol |
| Live Raindrop user deletion | Out of scope for this demo |
