# DA-1: foundation challenge (devils-advocate)

Reviewer: devils-advocate, effective model `claude-opus-5-5`. Date 2026-10-11. Scope: everything listed in the DA-1
brief. Read-only except `docs/review/`. No Git state touched, no credentials used or printed.

The team kept changing these files while I reviewed them, and several fixes landed in response to the findings
below. I reviewed the snapshot hashed in section 1. Every reproduction then ran against the code **as it was on disk
when it ran**, and section 2 records both the first run and the latest run. Section 3 marks a finding "fixed" only
when a latest run of its own reproduction returns NOT REPRODUCED. A source change that has not been re-run does not
count as a fix.

Reproduction exit-code convention: `0` = defect reproduced, `1` = not reproduced (fixed), `2` = environment/setup
error. The live Mongo checks use the local replica set (`packages/mongo/test/docker-compose.yml`, port 27018). They
use throwaway `da1_<random>` databases and drop them afterwards. This is local protocol evidence only, not Atlas
evidence.

## 1. Reviewed snapshot (sha256)

```
7f7e6fcfb73154bf5212af3dc15bd75135158c072dec7f372cfd362050dfd70e  apps/operator/src/client/expunge/ExpungeFoundation.tsx
8250feb262236ddc6681df15665f631d1feddd7361d806f9eb5e6b7240321edb  apps/operator/src/server/expunge/domain-service.ts
9e6e974e33985e984267e7f5891c3ed304edbb7d205b98165d89e83253425fb3  apps/operator/src/server/expunge/routes.ts
8549a4a47abe79981b54df8544c820cf888e2d3755ad49f7f6065747d737e7d6  apps/operator/src/shared/expunge.ts
91b07bca3545b80287d39c9206e9584fb07a4464a1bfbba843b52b9a00150669  apps/operator/tests/expunge-foundation.test.ts
5745b4d4f13c99109c16decfac4c5b96ed033ab449d416f2277eb63cc6557ded  infra/opendots/.env.candidates.example
b756fac90d3b852e8b944c7d6429db24125598f3a671fac59df505e3063f1e5b  infra/opendots/.gitignore
2bb5bb11bdecaf584369ade790eb1e3738199f8649cab8597562ae1d04f7ce3a  infra/opendots/BUILD-A1.md
add49163359af42907464c12872471408b349e1adf21b23a14f9a22beb9e2928  infra/opendots/README.md
3b3abc927b3fbd344019e53e5fe25447fc98e65a47b4bf7715d456105a99f743  infra/opendots/candidate-proxy.mjs
3310d3dd2d100130f393cf752d2f7ec0eee87df23f6c18a6cd80a44c13e3fc85  infra/opendots/candidate-proxy.test.mjs
271f2d7e96acdf064656351974c6755af2d7b82e84a795ddf5a4a5d6c6aa8c0f  infra/opendots/compose.candidates.yml
6e4632b7688f2e6d269f3fe19f7414c86d07c1b08977e5cfee72d1838d837b3b  infra/opendots/netguard.Dockerfile
769a598fee304b7eb31dbf099a5270604d61c3d96cb46d6db6ec911915a589a8  infra/opendots/netguard.sh
d77a433f7d7ca991007d6211f7d00d7288f20cf82478fb5ac8956d2ec74de0ee  infra/opendots/proxy.Dockerfile
a6ac68e9e27bf77da8816ae634f6ace790033dba9c81ed84fe840fbd56b4e7cf  infra/opendots/verify-candidate.mjs
aaf3f3bf8ede0a3eee842491f2321c6371f589e8faf42ecb7a5be7c36115ce5b  infra/opendots/verify-computers.mjs
3b44bac8a24da7f1c4c839148b446ff852b4577e888104215322ba37e5d6b788  packages/contracts/src/index.ts
9c25371d4419f86d31ced2d60f607c4e54ad9dcb188d8a951fc53ece2def14db  packages/fixtures/src/generator.ts
46560488f2ccb05a1bde4f5c01c2bc5f2fd8bc8b0adfef7102f4be0955396ae8  packages/fixtures/src/index.ts
69abda1b08aebb75b57b158f8b1fe6fdf3818178c707f31354c352e891c6ab01  packages/fixtures/src/paths.ts
525ca0e4966d4ec6d437146c109f343dcdf2da185ee8eaa89a800108048d5f1c  packages/fixtures/src/recipes.ts
8ea377b24bc9c1798eb2fcadb00ae158139f4051ef249ead3bad85f783d7cb7d  packages/fixtures/src/sealed.ts
0c7f5de71602f76631c36b7c63fb875f762d6a41dd2eee5004739bf759557792  packages/fixtures/src/source.ts
99b8c009af5fbda8661cf39cc954936cee2a5a0bb4a3a2c880acc6ba0d0e1c0e  packages/fixtures/src/splits.ts
677d0d04b3305ca54b8d59223252c96a0d108e384229ec5202e2931b08f0ad19  packages/fixtures/src/types.ts
3a3920c9cb251bbccd96dfbefeb893b9beaad667be5b2760e45de293077bdfc1  packages/fixtures/test/fixtures.test.ts
2d149b3191c59485ed8d497460c73e14492a06b073e4a98f9b3b361a1a56ad16  packages/grader/src/faults.ts
d09df572f95edb0e7fc0cf801055656b5fcb0a8caf6e4c4930e39f123b770f54  packages/grader/src/grade.ts
9655ea63eb58d7550341fd2b95845ec357c602eb3bc94adc0c9f59fa92ebd1b7  packages/grader/src/index.ts
a893243d062bcc8dfa6acfd23fc1acf8c0dce01127e09418249718960e8a9d64  packages/grader/src/reference.ts
be5b8bc63c0e433975f96ff1d5a52f406bb3a705d3fbf16934051df3505e6b10  packages/grader/test/faults.test.ts
6000ed8f4615fdc6548f4bd834b7d20497caaa1313d999932dd6d80e4dcf5f19  packages/grader/test/grader.test.ts
80cd9e46a64b70aaaf48c80f85fd194ac3d937e2e1cce24e1909e4a827809760  packages/mongo/src/artifacts.ts
3a41d8071060f62c2f9dc04a834c26933f68afa6f45ef7c304aeca3003653569  packages/mongo/src/client.ts
c66187a877966a280cd5c559dfe545bbf602b0945aa9296558fc0031e97482d0  packages/mongo/src/deployment.ts
13b0d04b2cb731caf319b3361d2ac9360d08fef947e96498e3e28bc3f432818e  packages/mongo/src/effects.ts
f9424c8c56fa8bcbf110c9c5a8c06b0bc2f01b8d9257d6599f5ce74d00ac3e8a  packages/mongo/src/events.ts
48a8787e89218121389ed80ca0ca2f7c0e4fa0c61491645642159a0201d8636f  packages/mongo/src/hashes.ts
184ba2959a88d2871a9a2f1b00b577c9be4f8072ecab2ccf532a8cf21140b354  packages/mongo/src/index.ts
a4b8ef2fcfa5934f1a9815a749a0393f5ee1921bbce745ff7b32edaae1606b0a  packages/mongo/src/jobs.ts
8ecc99f964981caca5ba189fdc772b6c4cadc80116578bc09bcfb7ebd53c79f0  packages/mongo/src/outbox.ts
0dbd05da5fefd2ed95e4a19022eec90c040b64d957b1d7bf51cf3b04cac250c8  packages/mongo/src/provenance.ts
f122d275fd3c8433a1364c8697eca3f4057de30bad102cf9016b3c533c96da0c  packages/mongo/src/roles.ts
7b581db6a39780812b711014bf2900ee22960f60757c727b5bf01fb6e1e00e5e  packages/mongo/src/scope.ts
e9860f632a57298effd61df66e338bc5eaf24f277ad322dc8acbce9d6053ca90  packages/mongo/src/setup.ts
9c0299dbacea658c4aa41638375256761a19c841ad6f23552c925a48f99a7f6b  packages/mongo/src/validators.ts
55722a314d7927fae266184b9e646550bb0fceab71005581d162298c57dc1da5  packages/mongo/test/auth-docker-compose.yml
87a593b6e3020f77ccecbe689696e8c21265b1f4a225fd5b5741c1f941b547de  packages/mongo/test/docker-compose.yml
6d76db7edc9b926181cb135c85af60b3ffbfbf8189d5aeb8d1535174645cfb42  packages/mongo/test/integration.test.ts
b6e5bbf12e862b83f10ce99afe527a5a814f3850eafa8e0f86d7e5cc092924d9  packages/mongo/test/protocol.test.ts
468f9e975916f02c9f523a3aa531ed1c5de5977ec3066853ddcc1cc3f276ae09  packages/mongo/test/rbac.integration.test.ts
```

While I worked, the owners rewrote all of `packages/mongo/src`, `packages/fixtures/src` and `packages/grader/src`
and `infra/opendots/netguard.sh`. They added `policy.ts`, `fixtures/src/scope.ts` and `fixtures/src/shape.ts`. The
live findings below were re-verified against those versions, not only against the snapshot. Section 2 records the
source hash prefixes at each run.

## 2. Reproductions (all run; command -> exit code)

| Repro | First run | Latest run |
|---|---|---|
| `npx tsx docs/review/repro/fx-shape-shortcut.repro.ts` | 0 (92/92 worlds solved) | 1 (0/92) |
| `DA1_MONGO_URI='mongodb://127.0.0.1:27018/?directConnection=true' npx tsx docs/review/repro/mg-live.repro.ts` | 0 (12/12) | 1 (0/12; each refused, codes in section 3) |
| `npx tsx docs/review/repro/mg-static.repro.ts` | 0 (3/3) | 1 (S1 and S3 fixed; S2 partial, see D13) |
| `npx tsx docs/review/repro/fx-commitments.repro.ts` | 0 (3/3; R1, R2 already fixed) | 1 (C1, C2 and C3 fixed) |
| `sh docs/review/repro/cand-dns.repro.sh` | 0 (resolved example.com) | 1 (embedded resolver ECONNREFUSED) |
| `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI npx vitest run packages/mongo` | 0 (6 passed, 41 skipped) | 0 (fast lane, same) |
| same with `EXPUNGE_REQUIRE_LIVE_TESTS=1` | n/a (gate absent) | 1 (3 live suites fail as required; RBAC suite still skipped) |

First run, source prefixes:
- mongo: deployment 555e314e, jobs 7ec7da59, effects fa1a2aaf, scope b43f8727, roles a978e7f1, hashes eb6c1369.
- fx-shape-shortcut: snapshot generator 9c25371d.
- fx-commitments: before splits 71405b6e and grade 5945536c (the earlier versions were not separately hashed).
- cand-dns: the `expunge-a1-candidate` stack, created at 10:11Z.

Latest run, source prefixes:
- mongo: deployment 56b5ea0e, jobs 20a4a6b5, effects c3005af6, scope adc44b06, roles 645c4c5b, hashes bcc16226,
  validators c9973b91, candidates d08c5a6c, policy 784d4072, client 40ef6062.
- fixtures: generator 83dc9f7a, shape 97b47f49, splits 71405b6e.
- grader: grade 5945536c.
- contracts: 5337c37a.
- infra: netguard.sh 1f880978.

The netguard container still shows Created 10:11Z, so the DNS rules were applied to the running namespace. The
latest cand-dns result is therefore not yet evidence for a clean `compose build && up`. Re-run the probe after a
clean rebuild.

I adapted mg-live.repro.ts (latest 9f063577) only so that its inputs carry the fields that are now mandatory:
derived `effectKey`, `argsDigest` and `targetHash`; a gate report carrying `computedClass`; a candidate row with no
`computedClass` (the validator now forbids it); and a registry row for L2. L10 now inserts the registry as `setup`,
which tests the grammar itself and is a stronger test. The attacks are unchanged, and every check now reaches the
specific refusal it targets.

## 3. DEMONSTRATED defects

Severity is the impact if the code path is reached in production: high = authority/isolation/answer leak, medium
= correctness/liveness, low = hygiene. Owners: MA = mongodb-authority, RE = rsi-evolution, RR = runtime-raindrop.

Line numbers for D3-D14 refer to the first-run hashes in section 2 unless marked "snapshot". Status at the latest run. "Fixed" means the defect's own repro returned NOT REPRODUCED with the refusal code shown.
Verifier: the fixes still need regression tests in the owners' suites; a passing repro here is not that test.

| ID | Status | Evidence at latest run |
|---|---|---|
| D1 | fixed | 0/92 |
| D2 | fixed | ECONNREFUSED after a clean force-recreate (netguard Created 10:21:55Z); `iptables -S` order assertion |
| D3 | fixed | ApprovalRequired; class now read from the grader's gate report |
| D4 | fixed | RollbackTargetNeverDeployed |
| D5 | fixed | ArtifactIneligible |
| D6 | fixed | CompletionReceiptRequired; claim refused for the grader with PrincipalBoundary |
| D7 | fixed | IncompleteReceipt |
| D8 | **OPEN** | `effects.ts:163-164` unchanged; no stored authorization row |
| D9 | fixed | UnsafeFieldPath |
| D10 | fixed | InvalidFieldRegistry, plus runtime ScalarWriteOnArray |
| D11 | fixed | S1 and L8 not reproduced |
| D12 | fixed | EffectOutsideTargets |
| D13 | **partial** | see D13 |
| D14 | fixed | L3 job reaches cancelled |
| D15 | **partial** | require-live gate added; RBAC suite not gated |
| D16 | **partial** | grader tautology replaced by computed `visibleResiduals` (fixtures and grader: 116 passed); a no-op `validateAuthority` remains in promotion tests; operator fake test unchanged |

**D1. A shape-only rule finds every hidden target (RE, high, scientific validity).**
Snapshot `fixtures/src/generator.ts:80-92`. Unrelated documents always had exactly one non-null identity and exactly
one reference to a `syn_customers_*` ID. Primaries had a `[null]` identity, an extra namesake array element, extra
`accounts unrelated-1` and duplicate references, and references to non-customer prefixes. A rule that never resolves
the subject picked the "odd one out" per collection. It earned `usefulCompletion` on 92/92 worlds, including 24/24
held-out test worlds (fx-shape-shortcut, exit 0). An evolved harness could learn this artifact and appear to
transfer. Status: RE added isomorphic decoy chains and a `shape.ts` canary. The latest run is 0/92 for my rule. My
second probe (displayName class, in-degree, out-neighbour features) found no concentrated tell. Still required: keep
a generic canary in CI (a classifier over ID-stripped fingerprints plus graph degree), not only a port of this one
rule.

**D2. DNS exfiltration from the candidate sandbox (RR, high).**
Snapshot `infra/opendots/netguard.sh:17-18` accepts all of `-o lo`. Docker's embedded resolver `127.0.0.11` is
reached over lo, and dockerd forwards queries upstream because netguard also joins the non-internal
`candidate-control` bridge. Counterexample: a probe with the candidate's own constraints (cap-drop ALL, read-only,
no-new-privileges) joined to the live guarded namespace resolved `example.com` to public A records. Direct
1.1.1.1:53 was refused and TCP 443 timed out. The README claim that DNS is blocked was false, and BUILD-A1 had only
tested direct resolvers. Status: the netguard.sh fix (`-d 127.0.0.11 DROP` and port-53 drops before the lo
ACCEPT) blocks the probe in the running namespace (exit 1). Required: re-run cand-dns after a clean rebuild, and add
this probe to verify-candidate.mjs. The comment at netguard.sh:54
says `iptables -C` verifies ordering, but `-C` checks only that a rule exists. Use `iptables -S OUTPUT` with
position assertions.

**D3. A proposer can choose its own trusted mutation class, so the A2-R approval requirement is bypassed (MA, high).**
`mongo/src/deployment.ts:131-143` derives `requiresApproval` from `candidates.computedClass`. The only principal
granted INSERT on `candidates` is the proposer (`roles.ts:95`), and the promoter has UPDATE (`roles.ts:130`).
Counterexample (L11): the proposer's raw insert `{computedClass:'tightening', state:'eligible'}` for a child that
widens `toolPolicy.grants`. With `behavioralRequiresApproval: true` stored, it was promoted with no grant. Fix:
recompute the class inside the promote transaction from the parent and child artifact payloads with a trusted
classifier, or read it from the grader's insert-only gate report. Proposer-owned proposal rows must be separate from
gate-owned lifecycle and class. Test: a proposer-written row whose class disagrees with the artifact diff is ignored.

**D4. Rollback activates a never-gated artifact (MA, high).** `deployment.ts:226-239` requires only a `permitted`
eligibility row and a matching target. It does not check that `toHash` ever appeared in this key's promotion history.
Counterexample (L4): an unrelated artifact with no gate report and no promotion became `activeHash`. Fix: require a
`promotions` row in the same DeploymentKey whose `fromHash` or `toHash` equals the target, and re-check eligibility
inside the transaction.

**D5. A revoked child is promotable (MA, high).** `promote()` reads artifacts with `read`, not `readPermitted`
(snapshot `deployment.ts:21`, first-run `:106-107`). Counterexample (L5): child eligibility `revoked`, grant consumed, pointer moved.
Fix: check `readPermitted(parent, child)` inside the transaction and fail closed.

**D6. Job success without a receipt, from any principal (MA, high).** `jobs.ts` `finish(...,'succeeded')` has no
principal check and no completion-receipt requirement. `claim()` admits domain_executor, observer, promoter,
privacy_controller, grader and fixture_builder for every job kind. Counterexample (L1a/L1b): the worker, and
separately a grader principal, marked a cleanup job `succeeded` with fabricated `outputRefs` and zero
`completion_receipts`. This contradicts "model messages cannot activate completion". Fix: `succeeded` for cleanup is
reachable only through `complete()`, which requires an inserted completion receipt in the same session; add a job
kind -> principal claim map.

**D7. `complete()` certifies zero coverage (MA, high).** `effects.ts:147-199`. The coverage arrays come from the
caller and `validate` is optional. Counterexample (L2): `inspectedCollectionIds: []`, `discoveredFieldIds: []`,
`domainStatus: complete_in_registered_scope` produced a committed receipt and a succeeded job. Fix: a mandatory
in-transaction read of the bound registry revision, plus exact-coverage equality (the grader's `validScopedReceipt`
rule).

**D8. Live revocation cannot work (MA, high).** No stored authorization revision exists anywhere in packages/*/src
(grep). `commitEffect` compares the caller's `actor.authorizationRevision` with the caller's
`intent.policyDecision.authorizationRevision` and accepts the caller's `result:'allow'` (`effects.ts:70-75`).
`assertJobAccess` compares the caller's actor with the stored job actor. Every live check above fabricated
`policyDecision` and committed. Fix: an authoritative per-scope authority row that the effect transaction reads and
conditionally writes; the gateway, not the intent, computes the decision from stored guardrails. Test: ACCEPTANCE
"Live revocation".

**D9. A registry path can move records across tenants (MA, high).** The frozen grammar admits `tenantId`, `worldId`,
`env`, `_rev`, `eligibility`, `access` and `lifecycle`. `ScopeRepository.insert` is callable by domain_executor.
`compileWritePlan` (`scope.ts:128`) then writes them. Counterexample (L10): a field with path `['tenantId']` and a
`replace` write changed the record's `tenantId` to `tenant-victim`. Fix: a reserved-root denylist in the grammar and
in write compilation, plus a test.

**D10. A non-wildcard path over an array overwrites unrelated elements (MA, high).** `compileWritePlan` ignores
`FieldDescriptor.isArray`. Counterexample (L9): `['data','aliases']` over `['subject-alias','unrelated-alias']`
became the string `"[redacted]"`. This is the "blindly dropping `*`" hazard in another form. Fix: reject
`isArray !== path.includes('*')` at registry insert, and add `{[path]: {$not: {$type: 'array'}}}` to non-wildcard
write filters.

**D11. BSON identity: int `_id` unreachable; one record has many accepted spellings (MA, medium).**
`findByField` uses `promoteValues:false`, so an int32 `_id` arrives as `Int32` and `typedAddress` throws
UnsupportedAddressType (L8). Snapshot `hashes.ts:12` `Number(recordId)` accepted `'0x10'`, `'1.6e1'`, `' 16 '`,
`'016'` and `'16.0'` for `_id` 16, and accepted `''` for `_id` 0. An upper-case ObjectId hex produced a distinct
`nodeKey` (mg-static S1). Distinct target hashes for one record weaken dedupe and idempotency. Status: `hashes.ts`
now has `canonicalInt`; see the latest run. Required: wrapper-type handling, plus a test over string, ObjectId,
int, long and double `_id` values end to end. Latest run: S1 and L8 not reproduced.

**D12. Applied effects are not bound to the intent (MA, medium).** `effects.ts:103` checks only the count.
Counterexample (L6): the intent targets A, `apply` deletes B, and the committed receipt claims B. Fix: every applied
address must be in `targetAddresses`, and `targetHash` must be recomputed from them.

**D13. Collection-level roles let non-owners rewrite authority rows (MA, high).** `roles.ts` (mg-static S2):
- domain_executor has INSERT and UPDATE on `schema_registry` and UPDATE on `world_revisions`, so the worker principal
  can widen its own registry or scopeRevision (`roles.ts:23-24`).
- The promoter has UPDATE on `approvals`, so it can retarget or extend an unconsumed grant (the uniqueness of
  `consumedGrantId` blocks only reuse).
- Six principals have UPDATE on `jobs`.
- The proposer has INSERT on `candidates` (D3).

The protocol test "declares actual collection-role gaps" checks only three negatives. Fix: registry and
`world_revisions.scopeRevision` writable only by setup or fixture_builder. Grant consumption goes through an
insert-only `grant_consumptions` collection (unique grantId), or an issuer MAC over the grant fields. Add negative
assertions for each item.

Status: partial. The executor's registry INSERT/UPDATE and the promoter's approvals UPDATE were removed, and grants
now use `grant_consumptions`. Still open:
- domain_executor UPDATE on `world_revisions` (it can rewrite `scopeRevision` and `maintenanceMode` with a raw
  driver).
- UPDATE on `jobs` for six principals. A raw-driver `$set: {status: 'succeeded'}` bypasses the repository's
  completion-receipt rule. RBAC is collection-level, so this must be documented as application-enforced, or job
  status must move to a collection only one principal can write.
- The proposer can still insert `candidates.state: 'eligible'` (now low impact).

**D14. Cancellation never terminates (MA, medium).** Counterexample (L3): `cancel()` on a queued job, or on a running
job with an expired lease, stays `queued` or `running` forever. `claim` excludes `cancellationRequested` and
`finish('cancelled')` needs a live lease. Fix: an owner-side transition from queued or expired-running to cancelled
under a fence increment.

**D15. Required live suites skip silently (team-lead / verifier, medium).** Without URIs, `vitest run packages/mongo`
reports 41 skipped and exits 0. Nothing marks the Mongo integration and RBAC suites as required (spec section 15:
"fails on unexpected skipped required tests"). Fix: an `EXPUNGE_REQUIRE_LIVE=1` lane in which `describeLive` throws
instead of skipping, used by the verifier and CI. Status: partial. `EXPUNGE_REQUIRE_LIVE_TESTS=1` now fails the
three replica-set suites. `rbac.integration.test.ts` still uses its own `describe.skip` on `MONGODB_RBAC_TEST_URI`,
so it stays skipped even in require-live mode.

**D16. Weak assertions (owners as listed, low to medium).**
- `grader/test/grader.test.ts:92`, now :124 (RE): `expect(operationalReceipt.operationalResiduals).toBe(0)` asserts
  a literal set in the same test.
- `mongo/test/promotion.integration.test.ts` (MA): `prepare(...,'authority_expansion')` seeds `computedClass`
  itself, and every promote passes `validateAuthority: async () => {}`. The class derivation is never tested, which
  is why D3 passed unnoticed.
- `apps/operator/tests/expunge-foundation.test.ts:79` (ui-ux-improver): the "forged tenant/role" case runs against a
  fake service that cannot see query parameters, so it proves nothing about server binding.
- Snapshot `fixtures.test.ts` "keeps oracle fields absent" greps label strings only, and missed D1.

## 4. LIKELY risks (mechanism shown; exposure path not yet built)

Latest status:
- Fixed by repro: K1 (L7: derived key, so the second call replays), K2, K3 and K4 (C1-C3), K5 (S3:
  UnsafePredicate).
- In code but not repro-verified: K7 (`committedPromotion` replay).
- Partially fixed: K8 (`expiresAt` is now bounded; hashes are still caller-built).
- Open: K6, K9 and K10.

- **K1 Logical effect identity is caller-defined (MA).** `effectKey` and `argsDigest` are never derived by the
  repository. L7: the same (job, plan, batchOrdinal, targets) under two keys (for example, one including a tool-call
  ID) committed twice. Derive `effectKey = H(jobId, approvedPlanHash, stepId, batchOrdinal)` and the digest inside
  `commitEffect`.
- **K2 Held-out structure is public (RE).** `splits.ts` `structuralHash` is an unsalted hash over about 210
  possible structures. All 42 entries, including the 24 test layouts, were recovered from `publicSplitCommitment`
  alone (fx-commitments C1). Salt it, and reveal the salt after final scoring.
- **K3 No entropy floor on masterSeed (RE).** `buildSealedSplitPlan('')` is accepted, and `seedCommitment = H(seed)`
  is unsalted. A dictionary recovered the test master seed (`held-out-master`), which yields every seed and so every
  target ID (C2). Require a master seed of at least 256 bits.
- **K4 The "safe" admission verdict carries a private commitment (RE).** `publicAdmissionVerdict` returns
  `referenceResultHash = report.reportHash`, whose payload includes `manifestHash` and `expectedStateHash`. These are
  the fields `publicGradeReport` withholds, and together they make an offline answer-checking oracle (C3). Return
  the `publicReportHash` instead.
- **K5 Generated predicates are unrestricted (MA).** `worldFilter` forwards `$where` and any other operator
  (mg-static S3). The conjunction prevents tenant escape, not server-side JavaScript or expensive operators.
  Whitelist the operators in the factories and reject `$where`, `$function` and `$accumulator`.
- **K6 World isolation inside one tenant is a parameter (MA).** `findByField` and `writeField` take `worldId`
  freely, and paired-trial arms share tenant and env. Derive `worldId` from the fenced job binding.
- **K7 Promotion has no ambiguous-commit reconciliation (MA).** A committed-but-unacknowledged promotion that is
  retried fails as StaleParent or ApprovalInvalidOrConsumed. Replay it by consumedGrantId and candidateId, as
  `EffectRepository.replay` does (spec section 6g analogue).
- **K8 Grants are caller-built (MA).** `ApprovalRepository.issue` stores any grant that has matching actor fields:
  hashes, descriptor, flipSetDigest and an unbounded `expiresAt`. `promote` compares the grant only with caller
  input; it never re-derives from the stored candidate or gate report. `approvedDescriptor` equality is
  BSON-field-order sensitive (a spurious denial).
- **K9 Projection payloads reach the browser unvalidated (ui-ux-improver / MA).** `domain-service.ts:67` uses
  `payload: z.record(z.string(), z.unknown())`, and `ProjectionRepository.append` accepts any JsonValue. No
  per-kind schema stops raw subject content or grader fields from reaching the UI. Use per-kind strict schemas at
  both ends.
- **K10 One token name for two principals (RR).** `EXPUNGE_INTERNAL_TOKEN` is both the operator's projection-reader
  token (infra README) and the candidate proxy's broker token (`compose.candidates.yml:79`). Both services default
  to `:4320`. Reusing the token would let admitted candidate routes act as the operator principal. Rename the broker
  token and have the broker reject the operator principal on candidate routes.

## 5. SPECULATIVE concerns

- **P1 Single-algorithm admission (RE).** Admission requires the one reference fixed-point solver to succeed. The
  snapshot generator special-cases `family !== 'reverse_reference'` so that solver does not over-select. If
  `discover_references` or expert-static implement the same fixed point, the benchmark ceiling is that algorithm.
  The visible `schema.referenceExpansion` is exactly its direction input. Use a second, independently written
  admission solver, and keep `referenceExpansion` out of the schema the worker sees.
- **P2 Wildcard `remove` with a tail `$pull`s the whole element (MA).** This drops sibling fields of a mixed
  element. Confirm that this is the owner policy for `delete` and not `redact`.
- **P3 Self-attested evidence completeness (RR).** `OutboxRepository.advance('evidence_ready')` trusts the
  caller-supplied `presentFields`. Bind it to a hash of the fetched remote content.
- **P4 Shared fallback owner (ui-ux-improver).** `domain-service.ts:172` falls back to `OWNER_ID || 'opendots-owner'`,
  so every unconfigured deployment shares one owner binding. Fail when the value is unset.
- **P5 Readability as a risk.** In the snapshot, `deployment.ts:44` (rollback), `jobs.ts:29` (finish),
  `effects.ts:22-47`, `provenance.ts:9` (revoke), `scope.ts:8` (insert) and `roles.ts:12-20` were single lines of
  200 to 1000 or more characters. D4, D6 and D13 sat inside them. The code is now Prettier-formatted, but D4 and D6
  survived the reformat. Gate on `prettier --check` and a max-len lint, and still review behaviour, not just layout.

## 6. Answers to the eight attack questions

1. **Hidden answers.** Worker side: D1 and K3. Proposer side: K2 and K4. All four are now fixed. The UI is not yet a path,
   but K9 is open. Error and quarantine codes are sanitized (`grade.ts` quarantineCodes). `worldId` derivation does
   not leak the seed.
2. **Independence.** The oracle (`sealed.ts`) never calls the solver, and the solver never imports `sealed`. The
   oracle is role-based, so a shared traversal blind spot would still fail grading. No runtime discovery exists yet
   (`packages/runtime` imports only contracts), so there is no shared helper today. P1 is the residual risk.
3. **Scope and tenant.** `worldFilter` conjunction holds. The breaks are D9, D10, D11, K5 and K6.
4. **Authority.** The breaks are D3, D4, D5, D6, D7, D8, D13 and K8. Stale-parent grant rollback IS guaranteed by
   the transaction shape: the grant update and the pointer CAS share one session, `fail` aborts the transaction,
   and the loser's write conflict re-runs the callback into StaleParent. The existing integration test confirms
   this locally. K7 is the remaining gap.
5. **Fencing.** `fence()`, `renew`, `checkpoint`, `yield` and `finish` are conditional writes; I found no read-only
   lease check standing in for a write. A stale worker fails with LostLease (an existing test). Gaps: D6 (fencing
   is irrelevant when any principal can claim), D14 and K1, all now fixed. `effectKey` is now derived from (jobId, approvedPlanHash, stepId,
   batchOrdinal), so nothing that depends on the retry can enter it.
6. **Weak tests.** D15 and D16. `rbac.integration.test.ts` is correctly labelled "not Atlas provisioning". Do not
   cite it as Atlas evidence.
7. **Containment.** IPv4 and IPv6 default-deny, metadata, host gateway and direct TCP are blocked (BUILD-A1, plus
   my TCP probe). DNS was not blocked (D2). The README correctly says the path allowlist is not domain
   authorization (K10 aside).
8. **Formatting.** See P5.

## 7. Resolved during review (re-verified by repro, not prose)

- R1 Fixture `_id`s are now instance-scoped (snapshot `recipes.ts` `seededId` had no instance). The fx-commitments
  INFO line shows 0 shared IDs.
- R2 Implicit and explicit default binding and extra actor keys now give identical `worldId` and `scopeId`
  (fx-commitments INFO).
- The `requiresApproval` input was removed (A2-R). It is superseded by D3.
- `publicGradeReport` now withholds `expectedStateHash`. It is superseded by K4.
- D1: the latest fx-shape-shortcut run is 0/92 (decoy chains).
- D3-D7, D9-D12 and D14: the live repro was re-run against the latest hashes, and each check was refused with the
  code shown in the section 3 table.
- D2 was confirmed after a clean rebuild (netguard and computer created 10:21:55Z; cand-dns exit 1). K10: the proxy
  now uses EXPUNGE_CANDIDATE_BROKER_TOKEN and refuses EXPUNGE_INTERNAL_TOKEN (proxy tests 6/6 per owner). The
  running proxy container predates this change. The broker-side rejection is pending until the broker exists.
- Still open at hand-off: D8 (live revocation), the D13 residuals, the D15 RBAC gate, the D16 promotion and operator
  tests, and K6, K8 and K9. P1 (single-solver admission, `referenceExpansion` visible) is acknowledged by RE
  as flagged to the lead and not done.
