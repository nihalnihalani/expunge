# DA-4: authority re-check and repro maintenance (devils-advocate)

Reviewer: devils-advocate, effective model `claude-opus-5-5`. Date 2026-10-11. Base: commit fe12b51 plus later
working-tree changes. Read-only except `docs/review/`. No Git state touched, no credentials used.

Exit-code convention, unchanged: `0` = defect reproduced, `1` = not reproduced (fixed), `2` = setup error. Live
Mongo checks run on the local replica set (port 27018) in throwaway databases. That is protocol evidence, not Atlas
evidence.

## 0. What this pass covers

| Brief item | Status |
|---|---|
| (1) Reseed `mg-live.repro.ts` so each check reaches its own guard | **Done.** All 12 checks reach the guard they target (section 2). |
| (2) Make every repro ESLint- and Prettier-clean without changing what it tests | **Done.** `npx eslint docs/review/repro` -> 0 and `npx prettier --check docs/review/repro` -> 0. Every script re-run gives the expected result (section 2). |
| (3) Re-attack authority_revisions/touches, decisions, world_scope_bindings, grant_consumptions, per-kind principals | **Partial.** Reviewed by reading the transaction shapes (section 3). No new adversarial reproductions were produced in this pass, so the item is not closed. |
| (4) Re-attack CT1-CT4 and restore with a real symlinked target | **Not performed by devils-advocate.** The verifier reports regression coverage in `scripts/continuity/test/hardening.test.mjs`. This reviewer has not independently re-tested it. |
| (5) FakeChatModel import path for the rt-* scripts | **Done.** The scripts import `packages/runtime/src/testing/fake-chat-model.js`, which works before and after runtime-raindrop's K1 move. |

## 1. Reviewed snapshot (sha256, taken at the start of DA-4)

```
cba8fdeacc46348f38e915b18fdfa9986985f6fecaa6af7b5c73ee933b628d1a  packages/mongo/src/artifacts.ts
54ef7eb55ee9db8878a05b79d4a9a7c2ccc8a8992e952a99a180947fd84c2df7  packages/mongo/src/authority.ts
d08c5a6c7a2e4f3d574bd2e13082f94d556e83b017a18cb13c83ba944373e8cb  packages/mongo/src/candidates.ts
40ef6062f5a9a25b6050bf6bf2d679203a6fc279d3f95c6d59efba7979b006d0  packages/mongo/src/client.ts
3930f7d34dfd0f20677cf1742507a550536249d2318902e122ae1f9dba83d2df  packages/mongo/src/decisions.ts
a69a6572fc6de42f88a401922c4e70d21c0a51ed7aeed99d8c9bede29c54573b  packages/mongo/src/deployment.ts
e3fa342b71ddbc43f532cedd14dccb40aea5840c9edde1bc53b5d5dc603f4967  packages/mongo/src/effects.ts
a64f465dd7262654c4bdaceac5bca13399e39678f5ea719ab18d309adf81048d  packages/mongo/src/events.ts
bcc162268b8459e4a60cd463d651c909b6871f4ca5551940fceb5cb3a41b8045  packages/mongo/src/hashes.ts
1bcb3bf147f0c6080a6dd1b97ce71b67811ede6700cd7fa7fbeec5ea27b9139b  packages/mongo/src/index.ts
59de54661e70cf1d4dc7fa0ae73de77984f6f02fc4700410af37561087e7ddef  packages/mongo/src/jobs.ts
11bd5ee95b4cd892920a9e7fc9c569581c9ffd7c06261684a239cbf6c336c765  packages/mongo/src/outbox.ts
784d4072ca5a049f99d78091d45e9317f1bca9c0a68285c2ae9395066ab1890d  packages/mongo/src/policy.ts
ce739ff22c67e7e5518ee9443b5c5a941d18693e2fe9796c1dcfdd505c2f3edc  packages/mongo/src/provenance.ts
bda6fadf2deeef1a6c640daf7fab8539428a16ccdce22a6945ef53ed4d41aba5  packages/mongo/src/roles.ts
adc44b0621379097fefd088f19f3d0c337e521bb6d8233e736a098721be9a37b  packages/mongo/src/scope.ts
b3ae38e067e46dec7a3ff0761b9413d4b11e868042a25864ae321a9f83750863  packages/mongo/src/setup.ts
793c71783c6be8765330672a9b7022457ad39d6cf841156422f3077a8538563c  packages/mongo/src/validators.ts
01b82a9d05d5c601d4236ba06a3ebc7f949b687e2464d9d9b45022b222c0f352  packages/mongo/src/wake.ts
76ed6ec33c11bced85e4d244362590ae3a2829694d8f3bd1d3c70b51b789f63d  packages/mongo/src/worlds.ts
ebe7f7bc5da1a315ea7f3f3ae40daf565ff77ba4db410d0273198ac10512da3f  packages/contracts/src/index.ts
a98e28442e331e3cfda89de3230ebba0ea111347a0246c4764e64abebdf719da  docs/review/repro/bl-guardrail-scope.repro.ts
3bb118da825575701f5995446674f3def950232c914fe9dc699eb998cf6a3cf9  docs/review/repro/cand-dns.repro.sh
cff60e201ea2a661239899dc5502221676030628b97fa6aba56926e564b70bc7  docs/review/repro/fx-commitments.repro.ts
ecd178cd7581e4ce2febec7378363576b12404c255c10bfdc5452532cd679e5c  docs/review/repro/fx-cooccurrence.repro.ts
4ef936612b29dc727e7311664c8dd60f36ce117f02417f5c45f2f5c93e1d5ae9  docs/review/repro/fx-seed-recovery.repro.ts
d09ddcdf21fd76acf5fe616261b134e0deb2e5f2ded74b1f93f3c0ea9a30af90  docs/review/repro/fx-shape-shortcut.repro.ts
9f063577bb8c392c113d21b04fdb52eac4fdb8e2c59a30948cea7ab7e01218d4  docs/review/repro/mg-live.repro.ts
74dc9403eb31ea4a43408b84634380b203703777fc2ad9c0e0554a6c5b38b751  docs/review/repro/mg-static.repro.ts
17ca74a7095f90d1f4a91c9179312437a0c8c38d3c24ccee8592029aaa4f7e56  docs/review/repro/rt-clone-concurrency.repro.ts
8df6442305c3a9aea4b791e1872e64d76751537752c383be5a166d4dde6f3ead  docs/review/repro/rt-steplimit-spoof.repro.ts
b81bb51ad5932737f2bc3f83f94d0fc133fc847df839447bbe5bd37bdad11942  docs/review/repro/rt-tool-outlives.repro.ts
```

Repro files after formatting (prefixes):
- bl-guardrail-scope 99663c09
- fx-commitments a4c68364
- fx-cooccurrence 19725226
- fx-seed-recovery 5edd8498
- fx-shape-shortcut 4c8ab4ba
- mg-live 3910d55a
- mg-static 4de41596
- rt-clone-concurrency 6fa66369
- rt-steplimit-spoof 72a22c97
- rt-tool-outlives 60db903a
- cand-dns 3bb118da (shell script; not covered by ESLint or Prettier)

## 2. Reproduction results after reseeding and formatting

| Repro | Exit | Notes |
|---|---|---|
| `DA1_MONGO_URI='mongodb://127.0.0.1:27018/?directConnection=true' npx tsx docs/review/repro/mg-live.repro.ts` | 1 | Each check refused by its own guard, see below |
| `npx tsx docs/review/repro/mg-static.repro.ts` | 1 | S1 and S3 fixed; the S2 residuals are listed in section 4 |
| `npx tsx docs/review/repro/bl-guardrail-scope.repro.ts` | 1 | B1 and B2 fixed (updated check: `appliesTo`, then `decide` across 9 tools x {null, invalid, valid}) |
| `npx tsx docs/review/repro/fx-shape-shortcut.repro.ts` | 1 | |
| `npx tsx docs/review/repro/fx-commitments.repro.ts` | 1 | |
| `npx tsx docs/review/repro/fx-cooccurrence.repro.ts` | 1 | |
| `npx tsx docs/review/repro/fx-seed-recovery.repro.ts` | 1 | |
| `npx tsx docs/review/repro/rt-clone-concurrency.repro.ts` | 1 | |
| `npx tsx docs/review/repro/rt-tool-outlives.repro.ts` | 1 | |
| `npx tsx docs/review/repro/rt-steplimit-spoof.repro.ts` | 1 | |
| `sh docs/review/repro/cand-dns.repro.sh` | 1 | |

The mg-live checks are now seeded through `WorldRepository.create`, `AuthorityRepository.install`,
`DecisionRepository.record`, the derived intent identity and `CandidateRepository.propose`. Promotion checks bind
grants through `bindingFor` and pass `deployments.authority.validator(actor)`. Each check opens its own databases.

Each check now stops at the guard it targets:

| Check | Refused by / observed |
|---|---|
| L1a | `CompletionReceiptRequired` |
| L1b | `PrincipalBoundary` |
| L2 | `IncompleteReceipt` (registry present) |
| L3 | queued and expired-running jobs both reach `cancelled` |
| L4 | `RollbackTargetNeverDeployed` |
| L5 | `ArtifactIneligible` |
| L6 | `EffectOutsideTargets` |
| L7 | second tool-call ID replays the first receipt (applied once) |
| L8 | int32 `_id` resolved as `{recordId: 424242, recordIdBsonType: 'int'}` |
| L9 | `InvalidFieldRegistry` |
| L10 | `UnsafeFieldPath` |
| L11 | `ApprovalRequired` |

## 3. Item 3: reading-based review of the new authority code (no new reproductions)

Each conclusion below follows from the transaction shape plus MongoDB snapshot-transaction write-conflict
semantics. None was exercised by a live interleaving test in this pass.

- **Authority fencing** (`authority.ts`): `fence()` reads the authoritative row and writes `authority_touches`
  under the expected revision. `bump()` writes both rows in one transaction.

  Any bump that commits after an effect's snapshot touches the same `authority_touches` document, so the effect's
  write conflicts and the driver retries the effect. The retry reads the new revision and fails
  `AuthorityRevisionStale`. A missing touch row fails closed.

  I found no ordering in which a stale revision commits through the repository API. The single touch document per
  scope serialises every effect in that scope; that is a throughput note, not a correctness defect.
- **Decisions ledger** (`decisions.ts`): `decisionId` is derived from the job, run, harness, step, batch,
  `argsDigest` and the decision body. `verify()` recomputes it and compares every field plus the decision-body
  hash, all within the actor's scope. Because the ID includes `jobId`, `runId` and `harnessHash`, I found no way
  to reuse a row across jobs or scopes, or to point at a row with a different digest.
- **World binding vs effect** (`worlds.ts`): `rebind()` updates the binding and advances the counter in one
  transaction, and an effect reads the binding then advances the same counter. Either the effect conflicts and
  retries into `StaleWorldBinding`, or it commits first and is ordered before the rebind. I found no race in which
  an effect commits against a superseded binding through the repository API.
- **Grant consumptions** (`deployment.ts`): consumption is an insert with unique `_id = grantId`, made in the same
  transaction as the pointer CAS and the promotion receipt. Double consumption hits the unique index; consumption
  without promotion rolls back with the transaction; promotion without consumption is blocked when the gate's
  class and the stored policy require approval.
- **Per-job-kind principals** (`jobs.ts` `JOB_KIND_PRINCIPALS`, `workerJob`): enforced on claim, renew, checkpoint,
  finish and decision recording. `propose` jobs are driven by `observer`, not `proposer`; that should be a
  disclosed design choice.

Still to do for item 3, not done here: live interleaving tests that inject a bump or rebind between an effect's
read and write, and raw-driver privilege checks of the new collections on the authenticated RBAC lane.

## 4. Open items carried forward (from earlier rounds, re-checked by code or repro this pass)

- **B1 (rsi-evolution): fixed.** The rule now carries `appliesTo: ['apply_cleanup_batch']`. I updated the repro to
  check that scope through `appliesToTool` and the compiler's `decide`. No other tool is ever denied, and the
  positive control holds: apply is denied with a null or invalid `preview_plan` and allowed with a valid one. The
  old predicate-text and tool-constant variant is retired.
- **K6 (mongodb-authority, medium; open by code).** `ScopeRepository.findByField` and `writeField` still take
  `worldId` as a free parameter (`scope.ts` around lines 255 and 285). It should be derived from the fenced job
  binding.
- **S2 residuals (mongodb-authority, low-medium; open by mg-static).** domain_executor still has UPDATE on
  `world_revisions` (the counter), the proposer still has INSERT on `candidates` (now class-free), and six
  principals still have UPDATE on `jobs`. MongoDB roles are collection-level, so these boundaries are
  application-enforced and must be documented that way.
- **DA-3 K2-K4 (runtime-raindrop).** Reported in progress by the owner; not re-checked here.
