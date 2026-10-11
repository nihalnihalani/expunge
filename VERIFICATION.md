# VERIFICATION

Owner: verifier (Sonnet 5.5, `claude-sonnet-5-5`). Every row below was produced by running the command on the working tree at the stated time; nothing is copied from another teammate's prose. All times are UTC on 2026-10-11. Git state at run time: branch `main`, **UNBORN** (no commits), so there is no committed-artifact parity to check yet.

Other teammates were editing `packages/*`, `apps/worker`, `infra/opendots` and `docs/review` while these ran. Failures in those paths are recorded as in-flight observations, not final verdicts; re-run the matrix before any commit packet.

## Environment

| Item | Observed |
|---|---|
| Node / npm | v25.2.1 (default), v24.11.1 and v22.23.2 also installed under nvm; root engines `>=24` |
| Root `.env` | MISSING (`ls .env` fails) |
| `apps/operator/.env` | MISSING |
| `MONGODB_*` variables in the process environment | 0 set (`MONGODB_TEST_URI` unset, so local replica-set suites self-skip) |
| Docker | reachable; running containers are the `expunge-a1-candidate-*` OpenDots candidate stack (the `candidate-computer` container reports `unhealthy`) |
| `apps/operator/node_modules` | present, `@copilotkit/runtime` 1.75.0, `zod` 4.6.5, `@ag-ui/client` and `@ag-ui/core` 0.0.59, identical to `apps/operator/package-lock.json`; no `npm ci` was needed |

## Baseline check matrix (V-1 "run3", historical; superseded by the GO MATRIX section below)

`executed/passed/failed/skipped` counts tests; for typecheck, lint and format the cell gives the error or file count instead.

| Check | Command | Exit | Executed / passed / failed / skipped | Timestamp (UTC) | Notes |
|---|---|---|---|---|---|
| Root typecheck | `npm run typecheck` | 2 | 2 type errors | 10:10:20Z | Both in `packages/mongo/test/provenance.integration.test.ts` (line 60 argument type, line 304 `Cannot find name 'harness'`). In flight in mongodb-authority's path. |
| Root lint | `npm run lint` | 1 | 16 errors, 0 warnings | 10:10:22Z | 11 `@typescript-eslint/no-unused-vars`, 2 `no-useless-escape`, 1 each `no-empty`, `no-loss-of-precision`, `no-sparse-arrays`. By file: `packages/mongo/src/{effects.ts(3), events.ts(4), deployment.ts(1), roles.ts(1)}`, `packages/mongo/test/protocol.test.ts(2)`, `packages/contracts/test/contracts.test.ts(2)`, `packages/grader/test/grader.test.ts(1)`, `infra/opendots/verify-computers.mjs(2)`, `docs/review/repro/mg-live.repro.ts(1)`. |
| Root format | `npm run format:check` | 1 | 13 files not formatted | 10:10:23Z | `docs/continuity/TASKS.json`; `docs/review/repro/{fx-commitments,fx-shape-shortcut,mg-live,mg-static}.repro.ts`; `infra/opendots/{candidate-proxy.mjs,candidate-proxy.test.mjs,compose.candidates.yml,verify-candidate.mjs,verify-computers.mjs}`; `packages/vendor-openmuse/{src/provider.ts,src/tanstack-agent.ts,test/tanstack-agent.test.ts}`. |
| Root unit tests | `npx vitest run` | 0 | 92 executed / 92 passed / 0 failed / 41 skipped (133 total, 14 files) | 10:10:24Z | **41 skips are the four Mongo integration suites** (`packages/mongo/test/{integration,promotion.integration,provenance.integration,rbac.integration}.test.ts`: 10+11+16+4), which skip without `MONGODB_TEST_URI`. Real replica-set, RBAC, promotion and provenance behavior is therefore NOT verified by this run. |
| Candidate proxy | `node --test infra/opendots/candidate-proxy.test.mjs` | 0 | 5 / 5 / 0 / 0 | 10:10:26Z | Protocol test of the candidate proxy only; does not exercise the Docker candidate network. |
| Continuity tooling | `npm run test:continuity` | 0 | 35 / 35 / 0 / 0 | 10:38:43Z (V-2 re-run after CT1 to CT4; 27/27 at 10:22:53Z, 23/23 at 10:10:26Z) | `node --test` over `scripts/continuity/test/*.test.mjs`, synthetic git repos under `$TMPDIR`. |
| Operator typecheck | `npm run typecheck` (in `apps/operator`) | 0 | 0 type errors | 10:10:31Z | `tsc --noEmit`, no output. |
| Operator tests | `npm test` (in `apps/operator`) | 1 | 305 / 298 / 7 / 0 (49 files, 48 passed, 1 failed) | 10:10:34Z All 7 failures were in `tests/telemetry.test.ts`; see "Operator telemetry failures: root cause" below. Superseded: after the safe-console change the same command passes 312/312 on three Node versions (10:27Z).
| Real checkpoint | `npm run checkpoint` | 0 | n/a | 10:10:40Z | ID `20261011T101040Z-3108c807`, `complete=true`, base `UNBORN`, 532 files; `npm run checkpoint:verify -- latest` reported pack MATCH=535, worktree MATCH=532, `RESULT: ALL MATCH`. This checkpoint was taken before this file was written. Later checkpoints are reported in the final handoff message and `.expunge/checkpoints/LATEST`; a document cannot embed the ID of the checkpoint that contains it. |

## Earlier runs, kept so in-flight movement is visible

| Time (UTC) | Check | Result |
|---|---|---|
| 10:07:39Z | typecheck | exit 2, 2 errors: `packages/fixtures/test/scope.test.ts(296,36)` template-literal argument type; `packages/vendor-openmuse/src/provider.ts(56,39)` `ProcessEnv` assignability |
| 10:07:41Z | lint / format | lint exit 1 (16 errors); format exit 1 (9 files) |
| 10:07:56Z | `npx vitest run` | exit 0, 72 passed / 0 failed / 41 skipped (113 total, 12 files) |
| 10:09:14Z | `npx vitest run` | exit 1, 72 passed / 1 failed / 41 skipped (114 total); the failure was in `packages/fixtures/test/fixtures.test.ts` while rsi-evolution was editing; it passed (12/12) by 10:10:24Z |
| 10:09:38Z | typecheck | exit 2, 3 errors (`fixtures/test/scope.test.ts` plus the two `mongo/test/provenance.integration.test.ts` errors); the fixtures error was gone by 10:10:20Z |
| lead baseline (per `PROJECT-STATE.md`, not re-run by me) | typecheck | 1 error in `packages/mongo/test/integration.test.ts` (Uint8Array.equals); this no longer appears |

## Operator telemetry failures: root cause (V-2.1)

The 7 failures in `apps/operator/tests/telemetry.test.ts` are a **Node `util.inspect` regression (nodejs/node#60717)**, not Expunge or OpenDots code. Sent to team-lead and ui-ux-improver; no operator file was changed.

Chain, each step observed: the test's child process posts an invalid body to `/api/copilotkit/agent/:id/run`. `@copilotkit/runtime` 1.75.0 `dist/v2/runtime/handlers/shared/agent-utils.mjs` `parseRunRequest` catches the `ZodError` thrown by `RunAgentInputSchema.parse` (zod **3.25.76**, the copy nested under `@ag-ui/core`; own keys `stack, issues, addIssue, addIssues, name`, plus an inherited `errors` getter on `ZodError.prototype`) and calls `logger.error("Invalid run request body:", error)`, which ends in `console.error`. Node's internal `formatError` appends the key `errors` whenever `Array.isArray(err.errors)` with no own-property check; `formatProperty` then does `desc ??= Object.getOwnPropertyDescriptor(value, key)` and reads `desc.value` on `undefined`: `TypeError: Cannot read properties of undefined (reading 'value')` (`node:internal/util/inspect`, line 2279 on v24.11.1, 2532 on v25.2.1). The TypeError escapes `parseRunRequest`, `handleRunAgent` answers with a non-400, and the child fails with `Expected SDK body validation failure`.

| Experiment | Result | Time (UTC) |
|---|---|---|
| `util.inspect(ZodError v3)` on Node 22.23.2 / 24.11.1 / 25.2.1 | ok / throws / throws | 10:13Z |
| Node source, `Print errors aggregated` block | v22.23.2 and current `main` have `ObjectPrototypeHasOwnProperty(err, 'errors')`; v24.11.1 does not | 10:13Z |
| Our `apps/operator`, only `tests/telemetry.test.ts`, Node 22.23.2 | 8 passed, exit 0 | 10:14:57Z |
| Our `apps/operator`, full `npm test`, Node 24.11.1 / 25.2.1 | 7 failed, 298 passed | 10:08Z and 10:08:33Z |
| Pristine upstream: shallow fetch of `CopilotKit/OpenDots` at `625452e06cde74cb25b0ce319e2c1be0488f5a5f` into a disposable scratchpad clone, `npm ci --workspaces=false --ignore-scripts`, only `tests/telemetry.test.ts` | Node 24.11.1: 7 failed / 1 passed; Node 25.2.1: 7 failed / 1 passed; Node 22.23.2: 8 passed | 10:15:54Z to 10:16:05Z |

Our `apps/operator/package-lock.json` differs from the upstream pin only in the package name, and `tests/telemetry.test.ts` and `src/server/platform.ts` are byte-identical to upstream, so the pin itself fails on this machine.

Upstream fix: nodejs/node PR #61032, shipped in Node 25.4.0 (2026-01-19) and 24.13.1 (2026-02-10) per the Node changelogs. I did not install those versions (downloading Node needs a human OK).

Smallest upstream-compatible fix candidates, in order:
1. **Toolchain only, no code change**: use Node >= 24.13.1 (or >= 25.4.0) for development, CI and the tests. Optionally raise `apps/operator/package.json` `engines.node` to `>=24.13.1` and add an `.nvmrc`. `apps/operator/Dockerfile` uses the floating tag `node:24-bookworm-slim`, so a rebuilt image should pick up a fixed patch; the digest of any image already built is not verified.
2. **Defense in depth, only if the product must survive affected patch levels**: a ~8 line `console` wrapper (try the original call; on failure retry with `Error` arguments replaced by `name: message`) imported at the top of `src/server/platform.ts`, because the test child imports `Platform` directly and `index.ts` alone would not cover it. `platform.ts` is frozen upstream code, so this needs a team-lead proposal.
3. Not recommended: stubbing `console.error` in the test. It would hide a real production 400-to-non-400 change on affected Node versions.

**Update 10:27Z, independently re-run after ui-ux-improver's defense-in-depth change** (`apps/operator/src/server/expunge/safe-console.ts` imported at the top of `src/server/platform.ts`, plus `tests/expunge-safe-console.test.ts`; I did not write or edit it): `npm test` in `apps/operator` now gives 50 files / 312 tests passed, exit 0, on Node 25.2.1 (10:27:01Z), 24.11.1 (10:27:07Z) and 22.23.2 (10:27:13Z); `npm run typecheck` exit 0 (10:27:19Z); `npx eslint src tests vite.config.ts` exit 0 (10:27:22Z). The wrapper only retries a failing console call with `Error` arguments reduced to `name: message`, so the node bug is worked around, not fixed: affected Node patch levels still need the toolchain floor (>= 24.13.1 / >= 25.4.0) and the module should be removed once the floor is raised. `apps/operator/dist` was not rebuilt, so any committed-artifact smoke check needs `npm run build` first.

Expunge-owned exposure: `packages/contracts` pins zod 3.25.76, so `console.error(<its ZodError>)` throws on Node 24.11.1 and 25.2.1 as well. Log `.issues`/`.message`, and apply the same Node floor to the root `engines`.

## Dependency audit (V-2.2, no upgrades performed)

`npm audit --omit=dev --json`, root at 10:17:31Z and `apps/operator` at 10:17:35Z (registry data as of that time). Both exit 1 because advisories exist. Reachability was checked two ways: import-graph tracing (an ESM resolve hook recording every module loaded when `@copilotkit/runtime/v2` is imported from `apps/operator` and from `packages/vendor-openmuse`) and source greps.

### Root: 7 advisories (0 critical, 2 high, 5 moderate)

All come from one chain: `packages/vendor-openmuse` -> `@copilotkit/runtime@1.75.0` -> `@ai-sdk/google-vertex@3.0.181` (and `@ai-sdk/openai-compatible@1.0.58`) -> nested `@ai-sdk/provider-utils@3.0.41` -> `undici@5.29.0` -> `@fastify/busboy@2.1.1`.

| Severity | Package (installed, nested path) | Advisories | Fixed in | Reachable in our usage? |
|---|---|---|---|---|
| high | `undici` 5.29.0 (`node_modules/@ai-sdk/google-vertex/node_modules/undici`, `.../openai-compatible/node_modules/undici`) | High: WebSocket permessage-deflate unbounded memory (GHSA-vrm6-8vpv-qv8q), WebSocket invalid `server_max_window_bits` unhandled exception (GHSA-v9p9-hfj2-hcw8), WebSocket fragment-count DoS (GHSA-vxpw-j846-p89q). Moderate: unbounded decompression chain (GHSA-g9mf-h72j-4rw9), request/response smuggling (GHSA-2mjp-6q6p-2qxm), CRLF in `upgrade` option (GHSA-4992-7rv2-5pvq), Set-Cookie header injection (GHSA-p88m-4jfj-68fv), retry-interceptor desync (GHSA-8xcm-r25x-g524), blob `type` CRLF (GHSA-m8rv-5g2x-5cg5), cookie attribute injection (GHSA-v3r7-h72x-cjcm). Low: SameSite downgrade (GHSA-g8m3-5g58-fq7m), keep-alive queue poisoning (GHSA-35p6-xmwp-9g52), retry-interceptor response splitting (GHSA-r53p-7pc4-xj5r). | undici >= 6.28.1 (the top-level `undici` 6.29.0 is not flagged) | **Not in current use.** Loading `@copilotkit/runtime/v2` does load `@ai-sdk/google-vertex` and `@ai-sdk/provider-utils` (the runtime's agent module statically imports `createVertex`), but my trace shows no `undici` or `@fastify/busboy` module is loaded at import time. Expunge's model path is `@tanstack/ai-openai` / `@tanstack/ai-anthropic` (`SupportedProvider = 'openai' \| 'anthropic'` in `packages/vendor-openmuse/src/provider.ts`), no source in `packages/*/src` or `apps/worker/src` imports `@ai-sdk/*`, and no Vertex configuration exists. It becomes reachable only if someone enables CopilotKit's AI SDK adapters (Vertex, openai-compatible). I did not trace every call site inside the `@ai-sdk` packages. |
| high | `@fastify/busboy` 2.1.1 (nested under the two `undici` copies; the other copy, 3.2.3 under `@whatwg-node/node-fetch`, is not flagged) | High: DoS via prototype-named multipart part header (GHSA-x8mw-p69m-v3mx, fixed >= 3.2.1). Moderate: CRLF injection via multipart filename (GHSA-gxm5-99cw-xjw9, fixed >= 3.2.2) | >= 3.2.2 | Not in current use; only reachable through the nested `undici` multipart parsing above, which is not loaded. |
| moderate (x5) | `@ai-sdk/provider-utils` 3.0.41, `@ai-sdk/openai-compatible` 1.0.58, `@ai-sdk/google-vertex` 3.0.181, nested older `@ai-sdk/anthropic` and `@ai-sdk/google` | No advisory of their own; flagged only because they depend on the vulnerable `undici` | npm reports a non-breaking fix (newer transitive ranges inside `@copilotkit/runtime`) | Same as above. |

### `apps/operator`: 11 advisories (0 critical, 4 high, 7 low)

| Severity | Package (installed) | Advisory | Fixed in | Reachable in our usage? |
|---|---|---|---|---|
| high (3 entries) | `@graphql-tools/utils` 11.2.2, via `graphql-yoga` 5.24.1 and `@graphql-yoga/plugin-defer-stream` | prototype pollution in `mergeDeep` (GHSA-7mx3-vvmw-hjmv, affected <= 12.0.0) | > 12.0.0; npm reports a non-breaking fix | **Not loaded.** The operator imports only `@copilotkit/runtime/v2` (6 import sites); the traced import graph of that entry loads neither `graphql-yoga` nor `@graphql-tools/utils` (only the `graphql` package itself). It would matter only if the legacy GraphQL runtime endpoint were mounted. |
| high | `source-map-js` 1.2.1 (via `@copilotkit/channels` peer `vitest` -> `vite` 8.3.1 -> `postcss` 8.5.28) | event-loop DoS through indexed source-map section offsets (GHSA-68fv-2mgg-jv7q, affected <= 1.2.1) | >= 1.2.2 | Build/test tooling only (processing a malicious source map). It is in the production dependency set only because `@copilotkit/channels` declares `vitest` as a peer dependency and npm installs peers; the operator Dockerfile runs `npm ci --omit=dev`, so vitest and vite ship in that image although nothing imports them at runtime. |
| low (x7) | `katex` 0.16.47 and its dependents `mermaid`, `streamdown`, `rehype-katex`, `remark-math`, `micromark-extension-math`, `@copilotkit/react-core` | KaTeX prototype pollution can bypass trust restrictions (GHSA-238p-pmpm-9mq7, affected < 0.18.2) | katex >= 0.18.2; npm's only suggested fix is a semver-major change of `@copilotkit/react-core` to 1.54.1 (a downgrade), which I do not recommend | The built client bundle (`apps/operator/dist/client`) contains katex, mermaid and streamdown via `@copilotkit/react-core`. It matters only if untrusted LaTeX reaches a react-core markdown surface with KaTeX `trust` enabled; `src/client/ChatTranscript.tsx` renders with `react-markdown` and no math plugin. Client-side, low impact. |

Nothing was upgraded, pinned or overridden. The spec asks for exploitable relevant advisories to be addressed with compatible changes, not blind upgrades; none of the 18 above is shown to be exploitable in current usage, and all root ones and the two operator graphql/source-map ones hinge on code paths Expunge does not call.

## A3-R independent verification (V-2.3, part 1)

Requested after rsi-evolution reported A3-R (`packages/fixtures`, `packages/grader`) complete. Run by me on the working tree at the times shown (UTC, 2026-10-11); A2-R and B2-1 were still in flight.

| Check | Command | Exit | Executed / passed / failed / skipped | Timestamp |
|---|---|---|---|---|
| Fixtures and grader tests | `npx vitest run packages/fixtures/test packages/grader/test` | 0 | 116 / 116 / 0 / 0 (11 files: grader admission-shape 1, admission 4, canary 7, faults 3, grader 19, protections 27, wildcard 12; fixtures fixtures 13, paths-and-bounds 6, scope 11, shape 13) | 10:23:51Z |
| Lint | `npx eslint packages/fixtures packages/grader` | 0 | 0 errors, 0 warnings | 10:23:54Z |
| Format | `npx prettier --check packages/fixtures packages/grader` | 0 | all files formatted | 10:23:55Z |
| Typecheck (whole repo) | `npx tsc --noEmit` | 0 | 0 errors | 10:23:56Z |
| DA repro: shape shortcut | `npx tsx docs/review/repro/fx-shape-shortcut.repro.ts` | 1 (NOT REPRODUCED) | shape-only shortcut earns usefulCompletion on 0/92 worlds (train 0/2, protected 0/8, validation 0/8, test 0/24, family 0/50) | 10:24:03Z |
| DA repro: commitments | `npx tsx docs/review/repro/fx-commitments.repro.ts` | 1 (NOT REPRODUCED) | C1 held-out structure recovered from public structuralHash: 0/42 entries from 210 guesses; C2 weak masterSeed rejected (`InvalidMasterSeed`); C3 `referenceResultHash` is no longer the private report hash; R1 same seed in different scope gives different worldIds and 0 shared customer ids; R2 implicit/explicit/extra-actor-key bindings equivalent | 10:24:04Z |

sha256 of `packages/contracts/src/index.ts` when these checks ran: `5337c37af865663fbc0ebd3582a8a4abbe0992f7e348c9d2735e1625a684bfb7` (taken at 10:23:51Z and unchanged when re-read after the repros at 10:24:04Z). Re-read at 10:25:03Z: `323ae3b57459109d39f32286e458434ad81110fbad60e2fb93d09311b943dc1e`, i.e. `packages/contracts/src/index.ts` was edited after these checks (A2-R was in flight), so rsi-evolution's commitments and these results must be re-checked against the new bytes if that file's change is meant to be kept. rsi-evolution's commitments bind to this hash. Scope of this claim: the listed commands pass on that tree; it does not cover the Mongo integration suites or any live check.

## Continuity tooling (task V-1a)

Files: `scripts/continuity/{lib,checkpoint,verify-checkpoint,restore-checkpoint}.mjs` and `scripts/continuity/test/*.test.mjs`. Commands: `npm run checkpoint [-- --notes TEXT --repo DIR --out DIR --no-briefing]`, `npm run checkpoint:verify -- <dir|latest> [--repo DIR --pack-only --verbose --json]`, `npm run checkpoint:restore -- <dir|latest> <targetRepo> [--apply]` (dry-run unless `--apply`).

Exit codes: checkpoint 0 complete and LATEST moved, 1 error, 2 usage, 3 incomplete snapshot written (LATEST preserved). verify 0 all MATCH, 1 any CHANGED/MISSING, 2 usage or bad manifest. restore 0 READY/APPLIED/ALREADY_APPLIED, 2 usage, 3 invalid or incomplete checkpoint or bad target, 4 base mismatch, 5 conflict (including files changed after the checkpoint that the restore would write), partial presence or post-restore mismatch, 6 stale checkpoint (target has newer work; needs `--force-review`), 7 active writer lock.

### What the 35 tests demonstrate (spec section 20)

| Spec requirement | Test (file) | Result |
|---|---|---|
| UNBORN snapshot, no HEAD diff, approved files become copies, `.env`/sqlite/cache dirs excluded with reasons | UNBORN repository (`checkpoint.test.mjs`) | pass |
| Commits + staged + unstaged + staged-then-unstaged + binary + deleted + untracked | repo with commits (`checkpoint.test.mjs`) | pass |
| Post-commit checkpoint is a new immutable manifest; previous manifest bytes unchanged; LATEST moves | checkpoint after a commit (`checkpoint.test.mjs`) | pass |
| Worktree changing during capture is detected, retried, otherwise `complete:false` and LATEST not moved | edited during capture (`checkpoint.test.mjs`) | pass |
| Secret in untracked file, in unstaged/staged tracked change, from a present `.env` value, in the briefing and in `--notes`: snapshot `complete:false`, offending path and rule ID listed, secret bytes never on disk | `secrets.test.mjs` (7 tests: 4 scenario tests plus scanner-rule, path-policy and env-parsing unit tests) | pass |
| Interrupted write before rename and before LATEST: previous LATEST and manifest preserved, no final dir for the failed id | `interrupt.test.mjs` | pass |
| Live checkpoint lock respected, stale lock replaced | `interrupt.test.mjs` | pass |
| Restore onto a matching base: dry-run writes nothing, `--apply` reproduces the tree byte for byte and the staged/unstaged split, second restore is `ALREADY_APPLIED` and rewrites nothing (mtimes unchanged) | `restore.test.mjs` | pass |
| UNBORN checkpoint restored onto an empty repo once | `restore.test.mjs` | pass |
| Restore refused on mismatched base (target moved on; UNBORN vs commit both ways), nothing written | `restore.test.mjs` | pass |
| Restore never overwrites a differing file, refuses partial presence and non-matching preimages | `restore.test.mjs` | pass |
| Restore refuses corrupt pack, incomplete manifest, non-repo-root target, path-traversal manifest | `restore.test.mjs` | pass |
| verify reports MATCH/CHANGED/MISSING per file, expected-absent files, tampered pack, bad manifest | `verify.test.mjs` | pass |
| DA-2 findings CT1 to CT4 (reproduced first, then fixed; see "DA-2 review of the tooling" below) | `hardening.test.mjs` (8 tests) | pass |
| Stale narrative versus newer code: a file modified after the manifest is reported `CHANGED (modified after checkpoint)` by verify; restore onto the same workspace refuses with `STALE_CHECKPOINT` (exit 6) until `--force-review`, then reports `ALREADY_APPLIED` without touching the newer file; `--force-review` still refuses (exit 5) to overwrite a path the restore would write; on a transferred checkout, unrelated newer local work needs review, then the WIP restores around it and the newer file is preserved | `scenarios.test.mjs` (2 tests) | pass |
| Active old-writer lock under `<target>/.expunge/locks`: dry-run and `--apply` (with or without `--force-review`) are refused with exit 7, a message naming the lock, pid and owner and "not removing it"; nothing is written and the lock stays; a lock whose pid is dead is reported as a note, left in place, and does not block; an entry with no recorded pid is treated as active | `scenarios.test.mjs` (2 tests) | pass |

Not covered by this tooling (protocol or other owners): an outgoing native goal waking up and reclaiming files after takeover (the lock check only sees lock files and live pids, not Claude-internal state), campaign/outbox resume, Claude to Codex to Claude role handoff. The pack is self-contained, so a snapshot taken before a failed model turn is usable by `verify --pack-only` and `restore` with no other state.

### Real checkpoints taken on this repository

| ID | complete | Why |
|---|---|---|
| `20261011T100633Z-2a09fdb7` | false | First run. Two false-positive `mongodb-uri` hits on prose mentions of the bare scheme in `research/notes/20-winner-*--amelia-for-the-deaf.md`. Kept as an immutable incomplete record; LATEST was not moved. Rule refined (a bare scheme with no host is not a connection string; a real host still is). |
| `20261011T100700Z-c6c05ae8` | true | Three committed example env files (`apps/operator/.env.hosted.example`, `.env.local-evaluation.example`, `infra/opendots/.env.candidates.example`) were wrongly excluded as env files. Classification fixed (`*.example`, `*.sample`, `*.template` are not secrets). Disposable restore of this checkpoint into an empty scratch repo: dry-run READY, `--apply` APPLIED (486 files), verify against the restored copy MATCH=486, second `--apply` ALREADY_APPLIED. |
| `20261011T100730Z-73186666` | true | After the classification fix (494 files). |
| `20261011T101040Z-3108c807` | true | Matrix-time checkpoint (532 files), pack and worktree both ALL MATCH. |

### DA-2 review of the tooling (CT1 to CT4, V-2 item 5)

Each finding was reproduced on the unmodified code first (scratch test, 10:2xZ), then fixed with a regression test in `scripts/continuity/test/hardening.test.mjs` (plus updated expectations elsewhere).

| Finding | Reproduced before the fix | Fix | After |
|---|---|---|---|
| CT1 snapshot labelled complete while files were dropped | untracked root `Dockerfile`, `LICENSE`, `Makefile` were dropped as `unapproved-root` with `complete=true`; the existing UNBORN test even asserted `complete=true` next to a dropped `data.sqlite` | Completeness rule: **any non-gitignored file that is dropped for any reason other than being an ignored path makes the manifest `complete:false`** (reason `dropped:<reason>:<path>`, LATEST not moved). Every dropped path is listed in `manifest.excluded` with its reason and a recovery hint; directory-wide drops list their files (capped at 500, with `count` and `truncated`). Conventional root files (Dockerfile, LICENSE, Makefile, `.dockerignore`, NOTICE, ...) are exported; an unrecognised root file is a blocker. Recovery for a deliberate drop is to gitignore the path. | `complete=false` with the paths named; becomes `complete=true` again once the paths are ignored |
| CT2 lock-break race | a lock directory with no pid file yet (the window between mkdir and the pid write) was removed and re-created by a second process | mkdir (atomic) then write the pid then re-read it; an unreadable or ownerless lock younger than 60 s is respected; only a dead pid, or an unreadable owner older than 60 s, can be taken over, by renaming the directory aside (one winner) and re-checking what was moved (put back if it belongs to a live pid); release removes the lock only if it still carries our own pid | live and fresh-ownerless locks are never removed; a 6-process concurrent run produced one intact checkpoint per successful run and only legitimate refusals (`another checkpoint is in progress` or `unreadable owner exists and is recent`); this concurrent run also showed the real window being hit and respected |
| CT3 manifest fields and symlinks | `readManifest` accepted `untracked[].copy = ../../../a.txt` | every pack-relative field is pinned: `copy` must equal `untracked/<path>`, `patches.*.file` must be `staged.patch`/`unstaged.patch`, `briefing.copy` must sit under `briefing/`, hashes must be 64-char hex, modes `100644`/`100755`, `manifest.json` must be a regular file; pack members must be regular files reached without symlinked directories; restore refuses (`SYMLINKED_PATH`, exit 5) when a restore path passes through a symlinked directory in the target and re-checks before every write | crafted manifests give `INVALID_MANIFEST`; a symlinked `docs` in the target is refused and nothing is written outside the repo |
| CT4 held-out material excluded by file name only | a sealed dump saved under any other name would have been exported (and the scanner has no seed rule) | withheld by (a) content marker: a JSON document, or any JSON Lines row, whose **top-level** object has `"expungePrivate": true`; (b) the `.private.json` / `.private.jsonl` / `.private.ndjson` suffix; (c) a declared registry, `docs/continuity/SEALED-PATHS.json` (tracked, team-lead owned) and/or `.expunge/sealed-paths.json`, each `{"paths": [...], "sha256": [...]}` (a path ending in `/` or `/**` is a prefix; a listed content hash withholds the file under any name); (d) the earlier name rules, broadened to data files named sealed/held-out/answer-key/ground-truth/expected-state. A nested marker, a mention in source or docs, and `"expungePrivate": false` are not withheld. The manifest states `secretScan.limitations`: the scan is pattern based and a clean result does not prove the absence of private material. | marked and registered material never reaches the pack; because withheld files are dropped files, a snapshot that withheld any is `complete:false` unless the paths are gitignored |

One more fix found by running the stricter rules on the real tree (10:38Z): a new fixture in `apps/worker/test/wake.test.ts` was flagged `mongodb-uri`. A credentialed `mongodb://` URI on a reserved or example host (`*.example`, `*.invalid`, `*.test`, `*.localhost`, loopback) or with a password shorter than 3 characters is now treated as a fixture; an Atlas or other real host still blocks.

### Deviations and limits worth knowing

- Approved roots: the listed roots (`apps packages scripts infra docs tests`, plus `research` and `.claude`) are approved by name. Any other top-level directory is also approved and reported in `manifest.unlistedRoots`, because silently dropping unlisted project source from a continuity snapshot is worse than exporting it. Sensitive paths (`.env*` except examples, `.firecrawl/`, `.expunge/`, `node_modules/`, `*.sqlite`, credentials, private manifests/seeds, sealed or `expungePrivate` material, raw telemetry) are never exported, and since V-2 item 5 dropping any of them while they are not gitignored makes the snapshot `complete:false`. Root-level files are limited to config, text and conventional names (Dockerfile, LICENSE, Makefile, ...); any other root file is a blocker.
- Scanning covers every exported file, the briefing copy, the notes, each patch section and the worktree copy of every changed tracked file. Unchanged tracked files are not exported and not scanned. Secret rules: Mongo connection strings (placeholders and bare schemes ignored), `sk-` style keys, AWS keys, PEM private keys, long Bearer tokens, GitHub/Slack/Google tokens, JWTs, npm auth tokens, and any value of 8+ characters from a present `.env`, `apps/operator/.env`, `infra/opendots/.env.candidates.local` or `.env.local` that differs from the `.env.example` default. Findings report paths and rule IDs only.
- The snapshot is not atomic across files. The tool reads twice and compares; if the tree moved it retries (3 attempts) and otherwise marks `complete:false` with the changed paths. With teammates writing, quiesce them first for a trustworthy checkpoint.
- While UNBORN, staged state is recorded (`git.stagedPaths`) but cannot be restored; every approved file is restored as a plain file. Restoring a non-UNBORN checkpoint uses `git apply --index` for `staged.patch`, so it does write the target's index.
- Restore safety rules added in V-2: any non-hidden entry in `<target>/.expunge/locks` counts as a writer lock (file or directory; pid read from JSON `pid`, a plain number, or `<dir>/pid`); an entry with no readable pid blocks because nothing proves its owner is gone, and a lock is never removed or bypassed by a flag. A target file that differs from both the checkpoint and the base commit is "newer work": if the restore would write it, restore refuses (exit 5, never overwritten); if it is outside the restore set, restore refuses with exit 6 until `--force-review` acknowledges it. A transferred checkout whose files are merely still at the base commit is not stale.
- Mode-only changes, untracked symlinks (blocker), submodules (policy exclusion) and files over 16 MiB (blocker) are the known edge cases.

## GO MATRIX: full matrix on the frozen tree with the local replica sets (V-2.3 part 2)

Run on 2026-10-11 between 10:40:52Z and 10:42:53Z after team-lead's "GO MATRIX". Evidence is pinned to checkpoint **`20261011T104052Z-d8708c42`** (`complete=true`, base UNBORN, 619 files, taken before any lane ran). All lanes finished by 10:42:48Z; by mtime and hash the only files that appeared inside that window were two new devils-advocate repros (`docs/review/repro/rt-steplimit-spoof.repro.ts` 10:41:07Z, `rt-tool-outlives.repro.ts` 10:41:50Z), which no lane executes. `lint` and `format:check` had already run (10:41:04Z, 10:41:06Z).

**The tree did not stay frozen afterwards**: `checkpoint:verify` against the checkpoint at 10:44:17Z reports 11 files changed after the run (list below), so this matrix does not cover them.

| Check | Command | Exit | Executed / passed / failed / skipped | Timestamp (UTC) | Notes |
|---|---|---|---|---|---|
| Checkpoint | `npm run checkpoint` | 0 | n/a | 10:40:52Z | ID `20261011T104052Z-d8708c42`, complete=true, 619 files, 0 dropped paths, 0 blockers. |
| Typecheck | `npm run typecheck` | 0 | 0 errors | 10:41:02Z | |
| Lint | `npm run lint` | 1 | 18 errors, 0 warnings | 10:41:04Z | 18, not the 14 expected. Exact files below. |
| Format | `npm run format:check` | 1 | 14 files | 10:41:06Z | Exact files below. |
| Root unit tests, no live env | `npx vitest run` | 0 | 322 / 322 / 0 / 217 (539 total, 41 files) | 10:41:07Z | The 217 skips are all live-service suites that need `MONGODB_TEST_URI` (`packages/mongo/test/`: rbac 68, hardening 41, promotion 30, authority 21, provenance 16, scope 9, projection 9, integration 9, dispatch 7; `apps/worker/test/dispatch.integration` 6) plus `apps/worker/test/live-provider` 1. They are exercised by the replica-set row. |
| Fixtures / grader / baselines / harness-compiler | `npx vitest run packages/fixtures packages/grader packages/baselines packages/harness-compiler` | 0 | 136 / 136 / 0 / 0 (13 files) | 10:41:32Z | |
| Worker / runtime / vendor-openmuse | `npx vitest run apps/worker packages/runtime packages/vendor-openmuse` | 0 | 119 / 119 / 0 / 7 (126 total, 15 files) | 10:41:36Z | The 7 skips are `apps/worker/test/dispatch.integration` (6, needs the replica set) and `live-provider` (1, needs a provider key). |
| Local replica-set lane | `MONGODB_TEST_URI=<my 127.0.0.1:27118 replica set> MONGODB_RBAC_TEST_URI=<local auth replica set 127.0.0.1:27019> EXPUNGE_REQUIRE_LIVE_TESTS=1 npx vitest run packages/mongo apps/worker` | 1 | 298 / 297 / 1 / 1 (299 total, 17 files) | 10:41:53Z | **All Mongo integration suites pass**: rbac 68, hardening 41 (+29 unit), promotion 30, authority 21, provenance 16, scope 9 (+15 unit), projection 9, integration 9, dispatch 7, worker dispatch.integration 6. The single failure is `apps/worker/test/live-provider.test.ts` "live provider smoke (required)", which under `EXPUNGE_REQUIRE_LIVE_TESTS=1` correctly fails with `BLOCKED: ... Set OPENAI_API_KEY ... or ANTHROPIC_API_KEY` (no provider credential, root `.env` missing); the 1 skip is the same file's optional case. Port 27118 is my own throwaway compose project (`verifier-mongo`, copied from `packages/mongo/test/docker-compose.yml`); the RBAC set on 27019 is mongodb-authority's existing auth container, using the documented local-only test credential from `packages/mongo/test/auth-docker-compose.yml` (not repeated here). Local evidence only; this says nothing about Atlas RBAC. |
| Continuity tooling | `npm run test:continuity` | 0 | 35 / 35 / 0 / 0 | 10:42:15Z | |
| Candidate proxy | `node --test infra/opendots/candidate-proxy.test.mjs` | 0 | 6 / 6 / 0 / 0 | 10:42:21Z | |
| Candidate stack, live | `node infra/opendots/verify-candidate.mjs /private/tmp/expunge-a1-host.env` | 0 | 1 verification | 10:42:21Z | Against the running `expunge-a1-candidate-*` stack: computer health 200, file round trip true, proxy 403, and blocked: internet IP, metadata, host gateway, public DNS, system resolver, getaddrinfo, embedded 127.0.0.11, direct 1.1.1.1. `docker ps` showed the `candidate-computer` container as `(unhealthy)` while its API health endpoint answered 200. |
| DA repro: candidate DNS | `sh docs/review/repro/cand-dns.repro.sh` | 1 (NOT REPRODUCED) | 1 probe | 10:42:24Z | Embedded resolver example.com A: ECONNREFUSED; direct 1.1.1.1:53 ECONNREFUSED; tcp 1.1.1.1:443 timeout. |
| DA repro: live Mongo | `DA1_MONGO_URI=<my 127.0.0.1:27118 replica set> npx tsx docs/review/repro/mg-live.repro.ts` | 1 (NOT REPRODUCED) | 12 checks, 0 reproduced | 10:42:28Z | L1a to L11 each refused with the expected domain error (UnknownWorld, AuthorityMissing, RollbackTargetNeverDeployed, InvalidFieldRegistry, UnsafeFieldPath); L8 int32 `_id` handled. Throwaway databases only. |
| Operator typecheck | `npm run typecheck` (apps/operator) | 0 | 0 errors | 10:42:35Z | |
| Operator tests | `npm test` (apps/operator) | 0 | 328 / 328 / 0 / 0 (52 files) | 10:42:39Z | Includes the safe-console and telemetry tests. |
| Operator build | `npm run build` (apps/operator) | 0 | built in 1.31 s | 10:42:45Z | Only the usual large-chunk warning. `apps/operator/dist` (gitignored) is now fresh. |
| Nothing moved? | `npm run checkpoint:verify -- latest` | 1 | pack MATCH=622; worktree MATCH=618 CHANGED=1 at 10:42:53Z, MATCH=608 CHANGED=11 at 10:44:17Z | 10:42:53Z | NOT clean. Changed after the run: `docs/review/DA-2-stable-surfaces.md`, `packages/runtime/src/{agent,ports,session}.ts`, `packages/runtime/test/{ag-ui-pipeline.test,agent.test,fakes,usage.test}.ts`, `packages/vendor-openmuse/THIRD_PARTY.md`, `packages/vendor-openmuse/src/tanstack-agent.ts`, `packages/vendor-openmuse/test/provenance.test.ts`; first edit 10:42:55Z. Re-run the runtime and vendor-openmuse lanes (and tsc, eslint, prettier on those packages) once runtime-raindrop stops editing. |

### Lint errors, exact (18)

| File | Count | Rule and lines |
|---|---|---|
| `docs/review/repro/fx-seed-recovery.repro.ts` | 1 | `no-empty` 28 |
| `docs/review/repro/mg-live.repro.ts` | 2 | `no-empty` 106, 248 |
| `docs/review/repro/mg-static.repro.ts` | 1 | `no-empty` 16 |
| `packages/contracts/test/contracts.test.ts` | 2 | `no-loss-of-precision` 24, `no-sparse-arrays` 35 |
| `packages/mongo/src/effects.ts` | 4 | `@typescript-eslint/no-unused-vars` 14, 164, 262 (twice) |
| `packages/mongo/src/events.ts` | 4 | `@typescript-eslint/no-unused-vars` 60 (twice), 66, 159 |
| `packages/mongo/src/roles.ts` | 1 | `@typescript-eslint/no-unused-vars` 1 |
| `packages/mongo/test/protocol.test.ts` | 1 | `@typescript-eslint/no-unused-vars` 2 |
| `packages/mongo/test/scope.integration.test.ts` | 2 | `@typescript-eslint/no-unused-vars` 1, 27 |

### Format failures, exact (14 files)

`docs/continuity/TASKS.json`; `docs/review/repro/{bl-guardrail-scope,fx-commitments,fx-cooccurrence,fx-seed-recovery,fx-shape-shortcut,mg-live,mg-static,rt-clone-concurrency}.repro.ts`; `infra/opendots/{candidate-proxy.mjs,candidate-proxy.test.mjs,compose.candidates.yml,verify-candidate.mjs,verify-computers.mjs}`.

### Addendum: runtime lanes on the settled tree (GO RUNTIME LANES)

After runtime-raindrop finished R1 to R3 and every writer had stopped, I took a fresh checkpoint and re-ran the lanes that the first matrix did not cover. Pinned to checkpoint **`20261011T104733Z-e126f3e6`** (`complete=true`, base UNBORN, 622 files, taken 10:47:33Z). `npm run checkpoint:verify -- latest` after all runs (10:48:22Z): exit 0, pack MATCH=625, worktree MATCH=622 CHANGED=0 MISSING=0, so nothing moved while these ran. This supersedes the earlier matrix for `packages/runtime`, `packages/vendor-openmuse`, `apps/worker` and the format list.

| Check | Command | Exit | Executed / passed / failed / skipped | Timestamp (UTC) | Notes |
|---|---|---|---|---|---|
| Typecheck | `npm run typecheck` | 0 | 0 errors | 10:47:47Z | |
| Lint, runtime scope | `npx eslint apps/worker packages/runtime packages/vendor-openmuse infra/opendots` | 0 | 0 errors | 10:47:49Z | |
| Lint, whole repo | `npm run lint` | 1 | 18 errors, 0 warnings | 10:47:50Z | Same 18 as the matrix above, same files (none in the runtime scope). |
| Format | `npm run format:check` | 1 | 15 files | 10:47:51Z | `docs/review/repro/{bl-guardrail-scope,fx-commitments,fx-cooccurrence,fx-seed-recovery,fx-shape-shortcut,mg-live,mg-static,rt-clone-concurrency,rt-steplimit-spoof,rt-tool-outlives}.repro.ts`; `infra/opendots/{candidate-proxy.mjs,candidate-proxy.test.mjs,compose.candidates.yml,verify-candidate.mjs,verify-computers.mjs}`. `docs/continuity/TASKS.json` now passes; the two new `rt-*` repros are added. |
| Runtime lane, no live env | `npx vitest run apps/worker packages/runtime packages/vendor-openmuse` | 0 | 133 total (15 files) / 126 / 0 / 7 | 10:47:53Z | 7 skips: `apps/worker/test/dispatch.integration` 6, `live-provider` 1. Runtime `agent.test` 37, `tanstack-agent.test` 16. |
| Runtime lane, replica set | same command with `MONGODB_TEST_URI` (my throwaway replica set on 127.0.0.1:27118), `MONGODB_RBAC_TEST_URI` (local auth set on 27019) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 1 | 134 total / 132 / 1 / 1 | 10:48:06Z | `apps/worker/test/dispatch.integration` 6 of 6 pass against the replica set. The single failure is the `live-provider` smoke, correctly reporting `BLOCKED: ... Set OPENAI_API_KEY ... or ANTHROPIC_API_KEY` (no provider credential); the single skip is the same file's optional case. Local evidence only. |
| DA repro: clone concurrency | `npx tsx docs/review/repro/rt-clone-concurrency.repro.ts` | 1 (NOT REPRODUCED) | 1 | 10:48:18Z | Second model call refused with `RunAlreadyActive`; one call in flight for the lease. |
| DA repro: tool outlives lease | `npx tsx docs/review/repro/rt-tool-outlives.repro.ts` | 1 (NOT REPRODUCED) | 1 | 10:48:19Z | Tool start, tool end, then release and job settle as cancelled together. |
| DA repro: step-limit spoof | `npx tsx docs/review/repro/rt-steplimit-spoof.repro.ts` | 1 (NOT REPRODUCED) | 1 | 10:48:21Z | The model-forged step-limit text does not end the run as a step limit; the dispatcher reports `NoCompletionReceipt`. |
| Nothing moved? | `npm run checkpoint:verify -- latest` | 0 | pack 625 MATCH; worktree 622 MATCH, 0 CHANGED, 0 MISSING | 10:48:22Z | Clean. |

My `verifier-mongo` compose project was recreated for the replica-set row and removed again afterwards; `expunge-protocol-mongo-1` and `expunge-rbac-mongo-1` were not touched.

## BLOCKED live checks

All of these need the root `.env`, which does not exist. Variable NAMES are taken from `.env.example`; no values were read or exist to read.

| Live check | Status | Needed variable names |
|---|---|---|
| Atlas schema/index/role setup, RBAC denial and transaction evidence on Atlas, Search/Vector | BLOCKED | `MONGODB_SETUP_URI`, `MONGODB_DOMAIN_EXECUTOR_URI`, `MONGODB_OBSERVER_URI`, `MONGODB_PROPOSER_URI`, `MONGODB_GRADER_URI`, `MONGODB_APPROVAL_ISSUER_URI`, `MONGODB_PROMOTER_URI`, `MONGODB_PROJECTION_READER_URI`, `MONGODB_PRIVACY_CONTROLLER_URI`, `MONGODB_FIXTURE_BUILDER_URI` (database names `EXPUNGE_WORLD_DB`, `EXPUNGE_CONTROL_DB`, `EXPUNGE_PRIVATE_DB` have defaults) |
| Real model provider run (agent loop, cancellation, token and cost accounting) | BLOCKED | `EXPUNGE_MODEL_PROVIDER`, `EXPUNGE_MODEL_ID`, one of `OPENAI_API_KEY` (+ `OPENAI_MODEL`, optional `OPENAI_BASE_URL`) / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`, `EXPUNGE_MODEL_PRICE_INPUT_MICROUSD_PER_MILLION`, `EXPUNGE_MODEL_PRICE_OUTPUT_MICROUSD_PER_MILLION` |
| Raindrop ingestion, query read-back, diagnostics, observer | BLOCKED | `RAINDROP_API_KEY`, `RAINDROP_QUERY_API_KEY`, `RAINDROP_PROJECT_ID`, `RAINDROP_ORGANIZATION_ID` |
| CopilotKit Intelligence proof (operator runtime entitlement, thread persistence) | BLOCKED | `CPK_INTELLIGENCE_API_KEY`, `INTELLIGENCE_API_KEY`, `OWNER_TOKEN`, `OWNER_ID`, `APP_ORIGIN`, `CPK_TELEMETRY_ID` |
| Authenticated operator to worker transport, candidate sandbox broker and artifact routes against live services | BLOCKED | `EXPUNGE_AUTH_SECRET`, `EXPUNGE_INTERNAL_SECRET`, `EXPUNGE_INTERNAL_TOKEN`, `EXPUNGE_DOMAIN_URL`, `EXPUNGE_SANDBOX_BROKER_URL`, `EXPUNGE_SANDBOX_ARTIFACT_URL`, `COMPUTER_SUPERVISOR_URL`, `COMPUTER_SUPERVISOR_TOKEN`, `COMPUTER_TOKEN` |

Not credential-blocked and now RUN: the local replica-set Mongo suites (see the GO MATRIX section: all pass). Still NOT RUN: browser and accessibility journeys, production-image smoke and secret-exclusion checks, security scans beyond `npm audit`, backup/restore and restart-recovery drills. None of these may be reported as passing until they are executed.

## Re-running

```
npm run typecheck; npm run lint; npm run format:check; npx vitest run
node --test infra/opendots/candidate-proxy.test.mjs
npm run test:continuity
(cd apps/operator && npm run typecheck && npm test)
npm run checkpoint && npm run checkpoint:verify -- latest
```
