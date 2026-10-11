# DA-2: stable surfaces (devils-advocate)

Reviewer: devils-advocate, effective model `claude-opus-5-5`. Date 2026-10-11. Targets:
- A3-R fixtures and grader (owner: rsi-evolution).
- `scripts/continuity` (owner: verifier).
- `packages/baselines` (owner: rsi-evolution).

Read-only except `docs/review/`. No Git state touched, no credentials used.

Reproduction exit-code convention, as in DA-1: `0` = defect reproduced, `1` = not reproduced (fixed), `2` = setup
error. Each reproduction runs against the code on disk when it ran.

`scripts/continuity` was reviewed by code reading only. Its findings are in LIKELY (section 4) and were sent to the
verifier as code-level observations with fixes. They have no reproduction.

## 1. Reviewed snapshot (sha256)

```
8588c6a2ab486f2f98a34af6c5dc8f43c1fa3c48bd3aa3c4b3d5ae5353c74378  packages/baselines/package.json
bcdc60ea9e9b001f3f8884483949166088d2f594b6e7a4510e0e3471c9deb979  packages/baselines/src/index.ts
91b51bae14b9ebcb111953a7f1fbfeef1ab49154d31453f1f4beec2eb135a143  packages/baselines/test/baselines.test.ts
9ecf5ae0fa9fd7d7ad52b56f0e16995f5231f9ab588a31894df6d1da190343dc  packages/fixtures/README.md
0f72adf73323881a2a8f6ee36500d07a15d642f4ec2d1e35228d553ad86607c1  packages/fixtures/package.json
83dc9f7ab91c84d247b58aa284d35004e4c2535e548eab3dffe19bb3365fad7e  packages/fixtures/src/generator.ts
9ce6337279fa1452f97cb6db08dfe6f635d4258b0e48c5269942b210923c3356  packages/fixtures/src/index.ts
b1c0621cffa2cbac45a090d13330ee08c3a2501fbab44686674d09f527e920bd  packages/fixtures/src/paths.ts
a6482e2249036162ec5d57fc3cd06fb6dd9218943be1fd5c7cac6af6f0c61d6c  packages/fixtures/src/recipes.ts
6aa3af3663fb8a0765b3f43f688224c8c8b9d31171f48214df63cc2548775421  packages/fixtures/src/scope.ts
d9438d5d259b5e323314a810c87d1c7251c481bbe882e31dc43fdf93b48fa5ab  packages/fixtures/src/sealed.ts
97b47f492600f5eda182d2693228b4ff80f1fb1c39c9a30e09bd4b4cf17fcf47  packages/fixtures/src/shape.ts
e9c5005d1cd1de633f1daa383d7be582dd035b15a89b7e2e1da07c647478f042  packages/fixtures/src/source.ts
3ae56318a4038be622fc4ff1e31001ac128721508fb639e3d354e37e980e7037  packages/fixtures/src/splits.ts
df67f6f7179b201e3e423371d85254a25cd6d3249e3a01885c9f92ea25ec23c7  packages/fixtures/src/types.ts
3c77ee9f42959b0bd63f330874bda268d5f1d7421119e8a8d11a8ec9fbbb9176  packages/fixtures/test/fixtures.test.ts
151e16991c381672a0ce4cb4ca2ccb0b3d1012a36fca1f8dd5a4459b61f51742  packages/fixtures/test/helpers.ts
e5b03f12bf1786925daaabc96b1b284cbd06c81f6774ec43950d76958fe7ddce  packages/fixtures/test/paths-and-bounds.test.ts
80ff7515ff275ab623f05522bbd69feeccf7983ba31ec0f16a25155f9bb5dce0  packages/fixtures/test/scope.test.ts
30c2af372e4d695454f7ab1dc47b76edbe6ceddfdb40c5a1bcc712364d572a9b  packages/fixtures/test/shape.test.ts
36b056beed3bf66d53d6ad904b52f93a04b9b3666492dbed05d62c801113f297  packages/grader/README.md
ee9ee92a9ab6486999fc56d50472bd920f282b19c956bf8ca867cd1e8629a670  packages/grader/package.json
fb6e6bf8245b50439c1ed0cb7fcc690aa876e9950a1a9dd65bd06efd458e457d  packages/grader/src/faults.ts
5945536cbf805f8bfe072310d73a7fdae4fbcbaf3ee8d0b7932a774c1c4455b0  packages/grader/src/grade.ts
59c5b2425cfe9e7e3f281f8a2f80d8a0d57285941e3e6f4ef401572cd6e17b83  packages/grader/src/index.ts
3c233f714894203cd982f31fdd3c36c69960f8cc7e1dd51b13ea1b60e7d64703  packages/grader/src/reference.ts
0952db19408d9a4266060f50f0e10e381e7bca64b1e32911df99229a72576684  packages/grader/test/admission-shape.test.ts
ad48c055bcec1c8cbccf57c89759129214ad2d683ccf10d82bfb73758079ee61  packages/grader/test/admission.test.ts
5fa83109fc7fa29888b701ca24fe6df1f2e4dc35453e878d9dbb24a59b674053  packages/grader/test/canary.test.ts
7cdec727255a53d040d4842195337e960605d03365e4a05f9a27438f58dcd492  packages/grader/test/faults.test.ts
664f049ebbb66995429ada99d4b5e66c03b2421d9bec63c7aa7cb1559ef845ba  packages/grader/test/grader.test.ts
19810bcaf3cd4d691ef705d83de627de7c302fca18cfe61ee6f6a48638af7116  packages/grader/test/protections.test.ts
638d8c705e677281e21cdce5987f39f02cf027dde3eeeb91ec16b6b900c7c816  packages/grader/test/wildcard.test.ts
5ca6913a0f9ff00146b3dec19dbd7aeb0176266537579874afb0b3e841863c25  scripts/continuity/checkpoint.mjs
ee85c066193218bcf991bf8698279cce4cbf5c9cba7f26945948e2559a6d4721  scripts/continuity/lib.mjs
961f5f759ddd791d364dec9ac0302dcf88571d359a59e43933ca9c4ba9e14ff2  scripts/continuity/restore-checkpoint.mjs
bf493cdba10fad4066cafc3dc3c2a9747542c89c57e09a7071e12c17603c16cf  scripts/continuity/test/checkpoint.test.mjs
4ed3afe61d21da02c31b1115a621ffe14163af62c00467538f8b79e348f972a6  scripts/continuity/test/helpers.mjs
4bbeeb8fd40c5cd540bc621ee7edbd3b3d203ee70acc29693e32d71345085b6c  scripts/continuity/test/interrupt.test.mjs
f3257581516d4fd18a230a4e47fd1208cd0ff0629e46b419fbb2f0b1e7f7b5a3  scripts/continuity/test/restore.test.mjs
f1f1f141680e95bd476847b791b172c79a61346f3f631f489ea19644968eb817  scripts/continuity/test/scenarios.test.mjs
575dc2d6263dd3e022bee63fca681c619d68a0f2070033593184f532361b8aa5  scripts/continuity/test/secrets.test.mjs
c9540eef90cf3b95dd3593ec2ef607a9d288a0b69ecdbcfc24ac3adabadba252  scripts/continuity/test/verify.test.mjs
cb5a86bc79d32e09e8e442bc7f42b749022574dede0a075e086e74e6dc2fc7d3  scripts/continuity/verify-checkpoint.mjs
```

Four files changed during review, after E1 was reported: `fixtures/src/generator.ts` (now f2d8960f), `shape.ts`
(now 60921fd4), `test/scope.test.ts` (now 369d3e3d) and `test/shape.test.ts` (now 486adaae). The latest runs below
use those versions.

## 2. Reproductions (all run; command -> exit code)

| Repro | First run | Latest run |
|---|---|---|
| `npx tsx docs/review/repro/fx-cooccurrence.repro.ts` | 0 | 1 (precision = chance on all 10 families; namesake 0.315 vs 0.315) |
| `npx tsx docs/review/repro/fx-seed-recovery.repro.ts` | 0 | 1 (R1 quarantined `weak_seed`; R2 rejected) |
| `npx tsx docs/review/repro/bl-guardrail-scope.repro.ts` | 0 | 0 |
| `npx tsx docs/review/repro/fx-shape-shortcut.repro.ts` (DA-1 regression) | n/a | 1 |
| `npx tsx docs/review/repro/fx-commitments.repro.ts` (DA-1 regression; master seed now random 64-hex) | n/a | 1 |

## 3. DEMONSTRATED defects

**E1. A fifth shape detector beat chance by cross-document co-occurrence (RE, medium-high; FIXED).**

The detector worked as follows:
- For every document, it computed the in-degree of the document's `_id` and the sorted global frequencies of the
  `syn_`/email strings the document holds.
- It took per-collection outliers.
- It used no identity resolution and no walk anchored at the subject.

Results on the snapshot generator (83dc9f7a):
- Pooled precision was 0.36-0.42 against a chance of 0.125 on 8 of 10 families, including the held-out
  `composed_holdout`, `diamond_alias` and `archive_bridge`.
- Among records sharing the subject's display name, "holds the most frequent `syn_` value" picked the subject
  chain at 0.634 against a chance of 0.315. A worker could therefore separate namesake chains from the subject
  chain without exact identity resolution.

Cause: `siblingChain()` linked chain 0 to chain 1 and the decoys into a cycle (c -> c mod (N-1) + 1). Chain 0 was
the only chain no other chain mentioned, and chain 1 was mentioned twice.

Fix landed (generator f2d8960f): every chain now has its own bystander token and record that no other chain holds.
Four detectors were added to the canary: `cooccurrence_signature_outlier`, `degree_outlier`,
`token_frequency_outlier` and `namesake_frequency_pick`. The latest repro run is at chance everywhere (exit 1).
Remaining residual, which RE states is by design: the namesake candidate set is 1/(namesakeCount+1).

**E2. Target IDs depend only on seed secrecy, and the Hider/admission path accepted any seed (RE, medium; FIXED at admission).**

`admitWorld(spec, 'demo-3')` admits the world (`grade.ts` admitWorld). `seededId(seed, collection, role, instance)`
(`recipes.ts:57`) and `worldIdFor` are public derivations, and `worldId` appears on every visible document. A worker
holding only the visible world recovered the seed in at most 250 guesses by testing
`H(seed,'customers','primary',worldId) == subjectHandle`. It then recomputed all six targets, exactly equal to
`manifest.effects`.

`buildSealedSplitPlan('0'.repeat(64))` is also accepted. `MASTER_SEED` (`splits.ts:43`) checks format, not entropy.

Fix:
- Mint the seed server-side inside admission and generation (`randomBytes(32)`) and overwrite
  `spec.seedCommitment`. A caller-supplied seed should only be allowed in tests, behind an explicit flag.
- Key the ID and token derivation with a sealed secret, e.g. HMAC(sealedKey, ...), so a leaked or guessed seed
  alone does not reveal targets.
- Reject degenerate master seeds, or accept only seeds minted by the sealed store.

Test: from a visible world plus a seed dictionary, recovery fails.

Status: the latest run exits 1.
- `admitWorld` now quarantines `weak_seed` unless the seed passes `isHighEntropySeed` or the test-only
  `allowLowEntropySeed` flag is set.
- `mintSeed()` and `bindMintedSeed()` exist, so the trusted entry point supplies the seed.
- `buildSealedSplitPlan` rejects degenerate master seeds.

Residuals:
- `generateWorld` and `generateSealedFixture` still accept any seed when called directly. Every production world
  must go through admission or the minted-seed path; enforce that with a test or a lint rule.
- There is no keyed derivation, so a leaked seed still reveals targets. RE accepts this as a residual.

**E3. The expert-static guardrail cannot be scoped to its tool (RE baselines, team-lead contract; medium; OPEN, owner fixing with boolean tool-class facts).**

`baselines/src/index.ts:178-185` defines rule `deny_apply_without_valid_plan` with predicate
`not(receipt_valid(preview_plan))`. The predicate names no tool, and `GuardrailAst` has no tool scope. As typed,
the rule denies every call made before a preview plan exists: inspect, resolve, discover, and preview itself. The
expert procedure therefore deadlocks, unless a runtime invents semantics from the `ruleId` text.

The contract cannot express the intended rule. `compare(fact 'tool.id' eq constant 'apply_cleanup_batch')` fails
with `invalid_union`, while the same shape with constant `delete` passes, because tool IDs are not an admitted
constant (`contracts/src/index.ts` operand enum). CONTRACTS.md says "approved status/tool enums".

Fix: either add tool-ID constants plus a `tool.id` fact, or add a typed `appliesTo: toolId[]` on GuardrailAst.
Then re-scope the expert rule, and add a test that the expert bundle admits `inspect_scope` before any plan exists.

**E4. The expert workflow declares more tool visits than its own ceiling (RE, medium; OPEN, owner fitting the graph to the limits).**

The expert's `sum(maxVisits)` is 19, but `limits.toolCalls` is 12 (`index.ts:92-115`, 219). A 5-hop world with
`partial_retry` faults needs roughly inspect 1 + resolve 1 + discover 5 + preview 1 + apply (1 + retries) +
verify 1 + complete 1, which is more than 12. Expert-static would then fail on budget rather than on procedure,
which biases the evolved-vs-expert comparison.

Fix: fit the graph to the ceiling, or record budget exhaustion as its own outcome. Add a test that a
minimal-success path for each family fits within `toolCalls`.

## 4. LIKELY risks

**Continuity (verifier; code reading only, no reproduction on my side).** Update: the verifier reports
CT1-CT3 confirmed by its own reproductions on the old code and CT4 confirmed by reading. All four are fixed, with
regression tests in `scripts/continuity/test/hardening.test.mjs` (35/35) and details in VERIFICATION.md. I have
not re-attacked them yet.

- **CT1, an incomplete snapshot is labelled complete.** `lib.mjs` `classifyPath` approves a root file only through
  `ROOT_FILE_RE` or the dotfile list. `checkpoint.mjs` `collectState` then excludes an untracked root `Dockerfile`,
  `LICENSE` or `Makefile` as `unapproved-root`, which is not a blocker. So `complete: true` and LATEST moves. The
  section 20 resume protocol would accept it as complete. Make these files blockers, or approve them.
- **CT2, lock handling.** `acquireLock` treats an unreadable pid as stale and removes the lock. In the window
  between another writer's `mkdir` and its pid write, a second process can break a live lock. Both writers then
  run, and each deletes the other's `.tmp-*`. `findWriterLocks` treats an unreadable pid as active, so the two
  policies disagree. Create the lock atomically with the pid already inside, and treat unreadable as active for a
  bounded age.
- **CT3, unvalidated pack-relative fields.** `readManifest` validates the path fields but not `untracked[].copy`,
  `patches.*.file` or `briefing.copy`, which `verifyPack` and `applyRestore` join onto the pack directory. The
  restore copy step relies on `resolveInside`, a string-prefix check that does not resolve symlinked parent
  directories. Validate all pack-relative fields, realpath each parent, and require it to stay inside the root.
- **CT4, held-out material is excluded by file name only.** The basename must contain `private|held-?out|holdout`
  and `manifest|seed`, so a sealed plan or expected-poststate dump saved under another name is exported. The
  content scan matches known token formats and exact local env values only. The manifest should state that a clean
  scan does not prove absence, and held-out artifacts should be registered by path and hash.

**Fixtures and grader (RE):**
- **F1, split label visible to the worker.** Validation and test path segments are `v…` and `t…` prefixed
  (`splits.ts` `opaqueSegment`). A worker can tell a test world from a validation world by the registry path
  prefix. Use one prefix, or none.
- **F2, per-world public counters are a group-testing oracle.** `publicGradeReport` keeps `targetedResiduals`,
  `unrelatedRecordChanges`, `retentionViolations` and `preservationViolations` per world. On validation worlds,
  per-world counts combined with the traces of what each run touched let a proposer narrow the target set across
  repeats. Give the proposer only aggregated validation verdicts.
- **F3, test families are public.** The family assignment for test entries is fixed in `splits.ts`
  (composed_holdout, reverse_reference, diamond_alias, archive_bridge by `i % 4`). Only the field names are now
  hidden. Disclose this in PREREGISTRATION as "families public, layouts sealed".

**Baselines (RE):**
- **B3, limits attributed to ACCEPTANCE that it does not contain.** `OWNER_EPISODE_LIMITS` says it comes "from
  ACCEPTANCE.md", but `graphNodes=16`, `graphEdges=32` and `maxCostMicrousd=100000` are not in ACCEPTANCE. The
  cost ceiling is meant to be measured after baseline probes.
- **B4, undisclosed primitives.** `DISCLOSED_PRIMITIVES` omits the fact-ID and binding-ID vocabulary, the
  comparators and the constants. The expert uses binding IDs (`preview_plan`, `*.output`) that no vocabulary
  defines, yet the bundle hash-binds a `vocabularyHash`.
- **B5, wrong limit in a test.** `baselines.test.ts:58-59` compares workflow node and edge counts with
  `ResourceLimits.graphNodes/graphEdges`, which CONTRACTS defines as traversal limits.

## 5. SPECULATIVE concerns

- **S1, W0's failure mode may change.** W0 uses `completionPolicy: model_narrative` and calls `complete_cleanup`
  without a receipt. The repository's `complete()` now requires a coverage-valid receipt, so W0's failure may
  surface as a tool error instead of the documented "false completion". Confirm that the baseline still measures
  what PREREGISTRATION says.
- **S2, no failure terminal in the expert graph.** It has no failure terminal (for example `report_diagnostic` on
  exhausted verification). Behaviour after `verify` fails twice is runtime-defined.

## 6. Answers to the coordinator's questions

1. **Beat the shape detectors?** Yes on the snapshot (E1), now fixed. The DA-1 rule, structure and format
   fingerprints, and co-occurrence, degree and token-frequency detectors are all at chance on the latest code.
   **Identity from `_id` or alias derivation?** Only through the seed (E2). Admission now refuses weak seeds;
   the residual is direct generator calls.
   **Manifest fields from public outputs?** `publicGradeReport` withholds the manifest and poststate hashes, the
   admission verdict now hashes only public fields, and split `structuralHash` is salted. Residual: F2.
   **Namesake vs subject?** Separable on the snapshot (E1). At chance now; the residual is 1/(k+1) by design.
2. **Continuity.** CT1-CT4, from code reading. LATEST moves only after re-reading a complete manifest whose pack
   re-hashes, and restore refuses incomplete manifests unless `--allow-incomplete` is given. The completeness
   flag's meaning is the gap (CT1).
3. **Baselines.** Neither bundle exceeds the owner limits or grants a tool outside the frozen nine. The expert's
   only path to `complete` is `verify -> complete`, which requires `completion_receipt`. Defects: E3, E4, B3-B5.
