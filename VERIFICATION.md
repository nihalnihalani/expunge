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

## Commit packets (per lane, verified on request)

### Packet: mongodb-authority / A2-R-finish

Paths: `packages/contracts/`, `packages/mongo/`, `scripts/setup-mongo.ts`, `scripts/probe-mongo.ts`, `docs/MONGO.md` (new). Checkpoint **`20261011T110113Z-7399111f`** (`complete=true`, base `506b73e`, 470 tracked + 191 untracked files, 37 unstaged-patch files from other lanes, taken 11:01:13Z). The tree was not globally frozen (other lanes active), so every row is scoped to the packet paths.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 2 | 12 errors, **all in `apps/worker`** (`dispatch.ts`, `index.ts`, `wiring.ts`, `test/dispatch.test.ts`, `test/fakes.ts`: another lane's in-flight `DispatchJobs`/`WorkerConfig` change); none under the packet paths | 11:01:22Z |
| Typecheck, packet only | `tsc -p <scratch tsconfig including exactly the packet paths>` | 0 | 0 errors | 11:01:46Z |
| Lint | `npx eslint packages/contracts packages/mongo scripts/setup-mongo.ts scripts/probe-mongo.ts` | 0 | 0 errors | 11:01:24Z |
| Format | `npx prettier --check packages/contracts packages/mongo scripts/setup-mongo.ts scripts/probe-mongo.ts docs/MONGO.md` | 0 | all files formatted (`docs/MONGO.md` is covered by `.prettierignore`, so prettier does not check it) | 11:01:25Z |
| Fast lane | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI npx vitest run packages/contracts packages/mongo` | 0 | 294 total / 67 passed / 0 failed / 227 skipped (live suites self-skip) | 11:01:54Z |
| Live lane | `npx vitest run packages/contracts packages/mongo` with `MONGODB_TEST_URI` (my throwaway replica set, 127.0.0.1:27118), `MONGODB_RBAC_TEST_URI` (local auth set, 127.0.0.1:27019) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | **294 / 294 passed, 0 failed, 0 skipped** (13 files: contracts 17; mongo: rbac 68, promotion 46, hardening 41 + 29, authority 21, provenance 16, scope 9 + 15, projection 9, integration 9, dispatch 8, protocol 6) | 11:02:07Z |
| Hash check, packet paths | `verify-checkpoint` against the checkpoint, filtered to the packet | 0 for the packet | 46 packet files, MATCH=46, CHANGED=0, MISSING=0 | 11:02:29Z |
| `docs/MONGO.md` shape | `wc -l`, fence count | n/a | 97 lines (under 150), exactly one mermaid block (line 8; 2 fence lines) | 11:02Z |

`packages/contracts/src/index.ts` sha256 at 11:02Z: `ebe7f7bc5da1a315ea7f3f3ae40daf565ff77ba4db410d0273198ac10512da3f`. Local replica-set evidence only; nothing here is Atlas evidence. Whole-tree `checkpoint:verify` at 11:02:29Z shows 23 CHANGED and 1 MISSING, all outside the packet and from lanes still active: `apps/operator/{index.html,src/client/App.tsx,WorkspaceDialog.tsx,expunge/ExpungeFoundation.tsx (MISSING, moved),style.css}`, `apps/worker/src/{config,dispatch,index,readiness,terminal,wake,wiring}.ts`, `docs/review/repro/*.repro.ts` (ten files, reformatted), `packages/harness-compiler/src/{index,issues}.ts`.

### Packet: devils-advocate / DA-4

Paths: `docs/review/` (`DA-4-authority.md` new, all `docs/review/repro/*.repro.ts` lint, format and import-path fixes, `mg-live.repro.ts` reseeded, `bl-guardrail-scope.repro.ts` amended after the packet was announced). Verified on the amended state, owner frozen. Checkpoint **`20261011T110624Z-c6c4193c`** (`complete=true`, base `082d2e1`, 471 tracked + 212 untracked, taken 11:06:24Z). A first attempt at 11:05:25Z was incomplete because my own new test file tripped the checkpoint's secret scan (a synthetic canary URI on a non-reserved host); I fixed my test, and that attempt's ID `20261011T110525Z-5e28e1d7` is not evidence.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Lint | `npx eslint docs/review/repro` | 0 | 0 errors | 11:06:25Z |
| Format | `npx prettier --check docs/review/repro` | 0 | all files formatted | 11:06:26Z |
| Repro: guardrail scope | `npx tsx docs/review/repro/bl-guardrail-scope.repro.ts` | 1 | B1 NOT REPRODUCED (`appliesTo=["apply_cleanup_batch"]`; denied for other tools: none), B2 NOT REPRODUCED (`sum(maxVisits)=12`, `toolCalls=12`); prints an INFO line that owner limits are not stated in ACCEPTANCE.md (graphNodes=16, graphEdges=32, maxCostMicrousd=100000). Both findings fixed. | 11:06:26Z |
| Repro: commitments | `npx tsx docs/review/repro/fx-commitments.repro.ts` | 1 | NOT REPRODUCED | 11:06:27Z |
| Repro: co-occurrence | `npx tsx docs/review/repro/fx-cooccurrence.repro.ts` | 1 | NOT REPRODUCED (precision equals chance on every family) | 11:06:27Z |
| Repro: seed recovery | `npx tsx docs/review/repro/fx-seed-recovery.repro.ts` | 1 | NOT REPRODUCED | 11:06:28Z |
| Repro: shape shortcut | `npx tsx docs/review/repro/fx-shape-shortcut.repro.ts` | 1 | NOT REPRODUCED | 11:06:28Z |
| Repro: mongo static | `npx tsx docs/review/repro/mg-static.repro.ts` | 1 | NOT REPRODUCED | 11:06:29Z |
| Repro: clone concurrency | `npx tsx docs/review/repro/rt-clone-concurrency.repro.ts` | 1 | NOT REPRODUCED | 11:06:29Z |
| Repro: step-limit spoof | `npx tsx docs/review/repro/rt-steplimit-spoof.repro.ts` | 1 | NOT REPRODUCED | 11:06:31Z |
| Repro: tool outlives lease | `npx tsx docs/review/repro/rt-tool-outlives.repro.ts` | 1 | NOT REPRODUCED | 11:06:32Z |
| Repro: live Mongo | `DA1_MONGO_URI=<my replica set 127.0.0.1:27118> npx tsx docs/review/repro/mg-live.repro.ts` | 1 | 12 checks, 0 reproduced | 11:06:34Z |
| Repro: candidate DNS | `sh docs/review/repro/cand-dns.repro.sh` | 1 | NOT REPRODUCED | 11:06:45Z |
| Hash check, packet paths | `verify-checkpoint` against the checkpoint, filtered to `docs/review/` | 0 for the packet | 15 packet files (4 reports including the new untracked `DA-4-authority.md`, plus 11 repros), MATCH=15, CHANGED=0, MISSING=0 | 11:07:10Z |

### Packet: runtime-raindrop / B2-2

Paths: `apps/worker/` (src, test), `packages/runtime/` (src, test, `package.json`), `packages/vendor-openmuse/` (src, test, `THIRD_PARTY.md`), `infra/opendots/{candidate-proxy.mjs,candidate-proxy.test.mjs,compose.candidates.yml,verify-candidate.mjs,verify-computers.mjs}`. Checkpoint **`20261011T110731Z-bf35d38f`** (`complete=true`, base `082d2e1`, 471 tracked + 215 untracked, taken 11:07:31Z). New untracked files in the packet that must be added explicitly: `packages/runtime/src/meter.ts`, `packages/runtime/src/testing/index.ts`, `packages/runtime/test/meter.test.ts`.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 2 | 13 errors, **none in the packet**: 12 in `packages/mongo/test/{hardening,scope}.integration.test.ts` (the mongodb-authority lane's in-flight `WorldKey`/`ScopeKey` change) and 1 in my own `tests/reliability/wake-endpoint.test.ts` (fixed at 11:07:51Z, a new `scope` readiness key) | 11:07:33Z |
| Typecheck, packet only | `tsc -p <scratch tsconfig including exactly apps/worker, packages/runtime, packages/vendor-openmuse>` | 0 | 0 errors | 11:07:51Z |
| Lint | `npx eslint apps/worker packages/runtime packages/vendor-openmuse infra/opendots` | 0 | 0 errors, 2 warnings (`no-explicit-any` at `apps/worker/test/dispatch.test.ts` lines 76 and 95) | 11:07:35Z |
| Format | `npx prettier --check --ignore-unknown apps/worker packages/runtime packages/vendor-openmuse infra/opendots` | 0 | all files formatted | 11:07:36Z |
| Default lane | `npx vitest run apps/worker packages/runtime packages/vendor-openmuse` (no live env) | 0 | 167 total / 155 passed / 0 failed / 12 skipped (16 files; skips: `dispatch.integration` 11, `live-provider` 1), matching the owner | 11:08:01Z |
| Live lane | same, with `MONGODB_TEST_URI` (my replica set 127.0.0.1:27118), `MONGODB_RBAC_TEST_URI` (27019) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 1 | 168 total / 166 passed / 1 failed / 1 skipped; the failure is the `live-provider` smoke, `BLOCKED: ... Set OPENAI_API_KEY ... or ANTHROPIC_API_KEY` (no provider credential), as expected; the skip is the optional case in the same file | 11:08:07Z |
| Candidate proxy | `node --test infra/opendots/candidate-proxy.test.mjs` | 0 | 6 / 6 / 0 / 0 | 11:07:37Z |
| Repro: clone concurrency | `npx tsx docs/review/repro/rt-clone-concurrency.repro.ts` | 1 | NOT REPRODUCED | 11:08:20Z |
| Repro: tool outlives lease | `npx tsx docs/review/repro/rt-tool-outlives.repro.ts` | 1 | NOT REPRODUCED | 11:08:21Z |
| Repro: step-limit spoof | `npx tsx docs/review/repro/rt-steplimit-spoof.repro.ts` | 1 | NOT REPRODUCED | 11:08:24Z |
| Compose config | `docker compose -f infra/opendots/compose.candidates.yml --env-file <scratch env with synthetic FAKE values for the five required variables, including EXPUNGE_CANDIDATE_BROKER_TOKEN> config` | 0 | 113 lines of resolved config, nothing started. The pre-rename host env file `/private/tmp/expunge-a1-host.env` fails as expected (exit 15, `EXPUNGE_CANDIDATE_BROKER_TOKEN` is missing a value), so the live candidate stack must be re-provisioned with the renamed variable before its next restart | 11:08:34Z |
| Exports map | `packages/runtime/package.json` | n/a | `exports` is exactly `{".": "./src/index.ts", "./testing": "./src/testing/index.ts"}` | 11:08Z |
| Fake not in production | grep for `runtime/testing`, `./testing` and `FakeChatModel` across `apps/worker/src`, `packages/*/src`, `apps/operator/src` | n/a | the only hits are inside `packages/runtime/src/testing/` itself; no production source imports the fake, and `packages/runtime/src/index.ts` does not re-export it | 11:08Z |
| Hash check, packet paths | `verify-checkpoint` against the checkpoint, filtered to the packet | 0 for the packet | 55 packet files, MATCH=55, CHANGED=0, MISSING=0 | 11:08:43Z |

Outside the packet and moved since the checkpoint (other lanes): `apps/operator/tests/expunge-css.test.ts`, `package-lock.json`, `packages/baselines/test/baselines.test.ts`, `packages/fixtures/README.md`, `packages/harness-compiler/{src/classify.ts,test/compile.test.ts,test/helpers.ts}`, `packages/mongo/test/{hardening,scope}.integration.test.ts`. `package-lock.json` changing while `packages/runtime/package.json` changed is worth the steward's attention: commit them together only if the lead says the lock edit belongs to this lane.

### Packet: rsi-evolution / C2-1

Paths: `packages/harness-compiler/` (new package files: `src/*`, `test/*`, `package.json`), `packages/baselines/src/primitives.ts`, `packages/baselines/test/baselines.test.ts`, `packages/fixtures/README.md`. Checkpoint **`20261011T110933Z-0f466519`** (`complete=true`, base `7cbb983`, 472 tracked + 216 untracked, taken 11:09:33Z). 21 packet files are new and untracked (`packages/harness-compiler/src/{classify,compile,decisions,guardrails,hashes,issues,literals,mongo-eval,mongo,noop,patches,plugins,policy,semantics,workflow}.ts` and `test/{compile.test,generators,helpers,live-parity.test,parity.test,semantics.test}.ts`); the steward must add them explicitly.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 0 | 0 errors | 11:09:34Z |
| Lint | `npx eslint packages/harness-compiler packages/baselines packages/fixtures packages/grader` | 0 | 0 errors, 0 warnings | 11:09:36Z |
| Format | `npx prettier --check packages/harness-compiler packages/baselines packages/fixtures packages/grader` | 0 | all files formatted | 11:09:38Z |
| Default lane | `npx vitest run packages/baselines packages/harness-compiler packages/fixtures packages/grader` (no live env) | 0 | 206 total / 204 passed / 0 failed / 2 skipped (17 files); the 2 skips are `live-parity.test.ts`, gated on `MONGODB_PARITY_URI`; matches the owner | 11:10:18Z |
| Live parity lane | `npx vitest run packages/harness-compiler` with `MONGODB_PARITY_URI` (my throwaway replica set, 127.0.0.1:27118) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | 74 total / 74 passed / 0 failed / 0 skipped. Live: "the server evaluates 300 generated predicates over 3,600 fact sets exactly as the TypeScript evaluator does" and "the server computes the same merged decision and fired rule ids for 100 generated rule sets"; plus the labelled in-process interpreter parity tests (5) | 11:10:29Z |
| Exhaustive rejection codes | `the compiler hashes > every rejection category in the vocabulary is provoked by a test above` | 0 | passed in the default lane, the live lane and a full-file run of `compile.test.ts` (55/55). It cannot run alone: with `-t` it fails (11:10:38Z) because it checks codes collected by the earlier tests in the same file. This is a test-order dependency, not a defect in the compiler; run the whole file | 11:10:48Z |
| Repro: guardrail scope | `npx tsx docs/review/repro/bl-guardrail-scope.repro.ts` | 1 | B1 NOT REPRODUCED (`appliesTo=["apply_cleanup_batch"]`, denied for other tools: none), B2 NOT REPRODUCED (`sum(maxVisits)=12`, `toolCalls=12`) | 11:10:38Z |
| Package resolution | `ls -l node_modules/@expunge/harness-compiler`, `npm ls @expunge/harness-compiler` | 0 | symlink to `../../packages/harness-compiler` (created 16:09 local, before the checkpoint); `npm ls` resolves `@expunge/harness-compiler@0.1.0 -> ./packages/harness-compiler`; `package-lock.json` has both the `packages/harness-compiler` entry and the link. No `npm install` is needed for this package | 11:09Z |
| Declared dependencies | imports in `packages/harness-compiler/{src,test}` vs `package.json` | n/a | bare imports are `@expunge/baselines`, `@expunge/contracts`, `node:fs`, `vitest`; the first two are declared, `mongodb` is declared as a devDependency | 11:09Z |
| Hash check, packet paths | `verify-checkpoint` against the checkpoint, filtered to the packet | 0 for the packet | 29 packet files, MATCH=29, CHANGED=0, MISSING=0 | 11:10:49Z |

Outside the packet and moved since the checkpoint (other lanes): `COMMIT-LEDGER.md`, `PHASE-CHECKPOINTS.md`, `docs/MONGO.md`, `docs/continuity/PROJECT-STATE.md`, `packages/mongo/src/{roles,setup,validators}.ts`, `packages/mongo/test/{authority.integration,hardening}.test.ts`. The lockfile diff versus HEAD is large (new `packages/observability` and `packages/observer` links and their dependencies from the runtime lane); it is not part of this packet.

### Packet: mongodb-authority / B1-0

Paths: `packages/contracts/`, `packages/mongo/` (new `src/worldkey.ts`, new `test/record-effects.integration.test.ts`), `docs/MONGO.md`. Checkpoint **`20261011T111558Z-67b789d4`** (`complete=true`, base `52c3b86`, 496 tracked + 256 untracked, taken 11:15:58Z). A first attempt at 11:15:17Z (`20261011T111517Z-28547290`) was incomplete: the scanner flagged `Bearer test-owner-access-token-12345` in `apps/operator/tests/expunge-fixture.test.ts`; I changed the scanner to treat tokens that name themselves as fixtures (test, fake, dummy, mock, example, sample, canary, placeholder, changeme, redacted) as test data and added tests (35/35 continuity tests still pass). Ignore the first ID.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 0 | 0 errors | 11:15:18Z |
| Lint | `npx eslint packages/contracts packages/mongo scripts/setup-mongo.ts scripts/probe-mongo.ts` | 0 | 0 errors | 11:15:21Z |
| Format | `npx prettier --check packages/contracts packages/mongo` | 0 | all files formatted | 11:15:22Z |
| Fast lane | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI npx vitest run packages/contracts packages/mongo` | 0 | 306 total / 68 passed / 0 failed / 238 skipped (14 files), matching the owner | 11:16:00Z |
| Live lane | same with `MONGODB_TEST_URI` (my replica set 127.0.0.1:27118), `MONGODB_RBAC_TEST_URI` (27019), `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | **306 / 306 passed, 0 failed, 0 skipped** (14 files: contracts 17; mongo: rbac 68, promotion 46, hardening 41 + 30, authority 23, provenance 16, scope 11 + 15, projection 9, integration 9, dispatch 8, record-effects 7, protocol 6) | 11:16:02Z |
| Repro: live Mongo | `DA1_MONGO_URI=<my replica set> npx tsx docs/review/repro/mg-live.repro.ts` | 1 | 12 checks, 0 reproduced | 11:16:28Z |
| WorldKey brand, run time | scratch `tsx` script: `new ScopeRepository(service).scan('plain-world-id', ...)` | 0 | rejects with **`InvalidWorldKey`** (before any query; the MongoClient never connected) | 11:16:40Z |
| WorldKey brand, compile time | temporary file with the same call, checked by `tsc -p .` (then deleted) | 2 | **`TS2345: Argument of type 'string' is not assignable to parameter of type 'WorldKey'`** | 11:17Z |
| WorldKey brand, permanent test | `tests/reliability/worldkey-brand.test.ts` (4 tests; its `@ts-expect-error` lines keep failing `npm run typecheck` if the type is loosened) | 0 | a bare string, a hand-built object, null, undefined, a spread copy of a real key, a JSON round trip and `Object.create(key)` are all refused at run time with `InvalidWorldKey`; a key issued by `worldKeyOf` is not; issued keys are frozen; empty world ids and scope revisions below 1 cannot be keyed. **Finding:** a spread copy `{...key}` still type-checks (symbol-keyed brand properties survive spread in the type), so only the run-time issued-set check stops it | 11:16Z |
| `docs/MONGO.md` shape | `wc -l`, fence count | n/a | 100 lines (under 150), exactly one mermaid block (2 fence lines) | 11:15Z |
| Hash check, packet paths | `verify-checkpoint` against the checkpoint, filtered to the packet | 0 for the packet | 48 packet files, MATCH=48, CHANGED=0, MISSING=0; new untracked: `packages/mongo/src/worldkey.ts`, `packages/mongo/test/record-effects.integration.test.ts` | 11:16:59Z |

`packages/contracts/src/index.ts` sha256 at 11:17Z: `e7d85bc14a62871408d0c8fdd9c62a28520e7c79beb50f50e49b7c533c2d7894` (it changed from `ebe7f7bc...` in the A2-R-finish packet; rsi-evolution's commitments that bind to it must be re-checked). Local replica-set evidence only. Since the checkpoint, other lanes moved `apps/operator/tests/browser/s1.mjs`, sixteen `docs/ui/screens/s1/*` files and `packages/harness-compiler/test/compile.test.ts`; none belongs to this packet.

### Packet: team-lead / lead-docs (documentation only)

Paths: `PHASE-CHECKPOINTS.md`, `docs/continuity/{PROJECT-STATE.md,TASKS.json,OWNERSHIP.md,SEALED-PATHS.json}`, `docs/continuity/briefs/`, `docs/expunge/CONTRACTS.md`, `docs/FEATURE-MATRIX.md`, `docs/ENVIRONMENT.md`, `PRODUCTION-READINESS.md`, `.env.example`, `.gitignore`. Checkpoint **`20261011T111730Z-948d66c0`** (`complete=true`, base `52c3b86`, taken 11:17:30Z). Of these paths only seven differ from HEAD (`.env.example`, `PHASE-CHECKPOINTS.md`, `docs/ENVIRONMENT.md`, `docs/FEATURE-MATRIX.md`, `docs/continuity/PROJECT-STATE.md`, `docs/continuity/TASKS.json`, `docs/expunge/CONTRACTS.md`); `SEALED-PATHS.json`, the four briefs, `PRODUCTION-READINESS.md`, `OWNERSHIP.md` and `.gitignore` are already tracked and byte-identical to HEAD.

| Check | Command | Result | Timestamp (UTC) |
|---|---|---|---|
| Format | `npx prettier --check docs/continuity/TASKS.json docs/continuity/SEALED-PATHS.json` | exit 0, formatted | 11:17:32Z |
| `.env.example` empty values | `grep -nE '^[A-Z_]+=.+' .env.example` | **returns 11 lines, so the stated expectation ("nothing") does not hold.** None is a secret: `EXPUNGE_WORLD_DB=expunge_world`, `EXPUNGE_CONTROL_DB=expunge_control`, `EXPUNGE_PRIVATE_DB=expunge_private`, `EXPUNGE_TENANT_ID=demo`, `EXPUNGE_ENV=demo`, `EXPUNGE_SCOPE_ID=synthetic-company`, `EXPUNGE_DOMAIN_URL=http://127.0.0.1:4320`, `EXPUNGE_ALLOWED_ORIGINS=http://localhost:3000`, `OWNER_ID=owner`, `APP_ORIGIN=http://localhost:5173`, `EXPUNGE_MODEL_PROVIDER=openai` (67 assignment lines in total). A second grep for names containing KEY, SECRET, TOKEN, URI, PASSWORD, PASSWD or CREDENTIAL that carry a value returns nothing, so every credential-bearing variable is empty. The scanner treats values equal to the `.env.example` default as public, so these do not affect checkpoints | 11:17Z |
| Ignore rules (`git check-ignore -v`) | `HANDOFF.md`, `.env`, `.env.local`, `.expunge/`, `.expunge/checkpoints/LATEST`, `.firecrawl/`, `.firecrawl/x.md`, `out/world.private.json`, `deep/dir/a.private.jsonl`, `x.private.ndjson`, `node_modules/x`, `infra/opendots/.env.candidates.local` | all ignored (rules `.gitignore:13`, `:3`, `:4`, `:10`, `:1`, `:19`, `:20`, `:21`, `:6`, and `infra/opendots/.gitignore:2`) | 11:17Z |
| Examples stay tracked | `git check-ignore` on `.env.example`, `apps/operator/.env.hosted.example`, `infra/opendots/.env.candidates.example`, `docs/continuity/SEALED-PATHS.json` | none ignored | 11:17Z |
| Sealed registry | parse `docs/continuity/SEALED-PATHS.json` and load it with the checkpoint tool | valid; keys `paths`, `sha256`, `note`; **both lists are empty**, so the registry is present but declares nothing yet; the registry file itself is exported by checkpoints (not withheld) | 11:17Z |
| Hash check, packet paths | `verify-checkpoint`, filtered to the 11 single files and `docs/continuity/briefs/` | 15 packet files (the 11 files plus the 4 briefs `B1-domain-gateway.md`, `C1-raindrop-evidence.md`, `C2-compiler-evolver.md`, `C3-admission-promotion.md`), MATCH=15, CHANGED=0, MISSING=0 at 11:17:56Z | 11:17:56Z |

Moved since the checkpoint, outside this packet (other lanes): `apps/operator/src/client/expunge/css/10-base.css`, `apps/operator/tests/browser/s1.mjs`, eleven `docs/ui/screens/s1/*.png` files, `packages/evolution/src/propose.ts`.

### Packet: mongodb-authority / B1-1

Paths: `packages/governance/` (new workspace: `package.json`, `src/{evaluator,facts,floor,index,ledger,owner-policy,revocation}.ts`, `test/{governance.test,ledger.integration.test}.ts`) and `packages/domain/package.json` (manifest only). Checkpoint **`20261011T112327Z-e6f7526f`** (`complete=true`, base `7e7e19d`, taken 11:23:27Z). The lockfile was not judged, as instructed.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 0 | 0 errors | 11:23:29Z |
| Lint | `npx eslint packages/governance` | 0 | 0 errors, 0 warnings | 11:23:32Z |
| Format | `npx prettier --check packages/governance packages/domain/package.json` | 0 | all files formatted | 11:23:33Z |
| Fast lane | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run packages/governance` | 0 | 18 total / 16 passed / 0 failed / 2 skipped (the 2 ledger integration tests), matching the owner | 11:23:48Z |
| Live lane | same with `MONGODB_TEST_URI` (my replica set 127.0.0.1:27118) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | 18 / 18 passed, 0 failed, 0 skipped (`governance.test` 16, `ledger.integration.test` 2), matching the owner | 11:23:49Z |
| Workspace resolution | `ls -l node_modules/@expunge/`, `npm ls @expunge/governance @expunge/domain` | 0 | both are symlinks to `packages/governance` and `packages/domain` (created 16:42 local); `npm ls` resolves `@expunge/domain@0.1.0` and `@expunge/governance@0.1.0` | 11:23Z |
| Hash check, packet paths | `verify-checkpoint`, filtered to the packet | 0 for the packet | 11 packet files (10 under `packages/governance/` incl. `package.json`, plus `packages/domain/package.json`), MATCH=11, CHANGED=0, MISSING=0 | 11:24:00Z |

Observations for the owner, none blocking: (1) `packages/governance/test/ledger.integration.test.ts` imports `mongodb`, which `packages/governance/package.json` does not declare (it resolves only because the root install hoists it; add it as a devDependency). (2) `packages/domain/package.json` sets `exports` to `./src/index.ts`, but `packages/domain/src` contains `edge-repository.ts`, `fields.ts` and `values.ts` and no `index.ts`, and those files are untracked and **not part of this packet**: committing the manifest alone leaves a workspace whose entry file does not exist until the domain lane lands (nothing imports `@expunge/domain` yet; checked by grep). The steward must not add the other `packages/domain/` files on this evidence.

### Packet: rsi-evolution / C2-2

Paths: `packages/evolution/` (new workspace: `package.json`, `README.md`, `src/{critic,evidence,fake-model,index,model,propose,replay,search}.ts`, `test/{evidence,helpers,propose,replay,search}.test.ts`, `scripts/c2-evidence.ts`), `packages/harness-compiler/{README.md,test/rejection-catalog.ts,test/rejection-catalog.test.ts,test/compile.test.ts}`. Checkpoint **`20261011T112604Z-cf40f999`** (`complete=true`, base `d183898`, taken 11:26:04Z; the working tree then carried 11 staged and 17 unstaged patch files from other lanes).

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 0 | 0 errors | 11:26:05Z |
| Lint | `npx eslint packages/evolution packages/harness-compiler` | 0 | 0 errors, 0 warnings | 11:26:08Z |
| Format | `npx prettier --check packages/evolution packages/harness-compiler` | 0 | all files formatted | 11:26:09Z |
| Default lane | `npx vitest run packages/baselines packages/harness-compiler packages/evolution packages/fixtures packages/grader` (no live env) | 0 | 300 total / 298 passed / 0 failed / 2 skipped (22 files; the 2 skips are `live-parity.test.ts`); evolution: evidence 6, propose 12, replay 7, search 8; matches the owner | 11:26:20Z |
| Live parity lane | `npx vitest run packages/harness-compiler` with `MONGODB_PARITY_URI` (my replica set 127.0.0.1:27118) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | 135 / 135 passed, 0 skipped (6 files), matching the owner | 11:26:24Z |
| Rejection catalog, standalone | `npx vitest run packages/harness-compiler/test/rejection-catalog.test.ts` | 0 | 62 / 62 passed on its own (61 category cases plus the exhaustiveness check); it no longer depends on other tests in `compile.test.ts` | 11:26:26Z |
| C2 evidence | `npx tsx packages/evolution/scripts/c2-evidence.ts` | 0 | 672 lines of JSON. **Per surface, against W0, labelled FAKE model and fixture ledger** (all `compiled`, arm `trace_informed`): `context` claimed behavioral = computed behavioral, cites `evt_a01`, 0 flips; `guardrails` claimed tightening = computed tightening, cites `evt_a01`, 2 flips (`fixture_dec_complete_unverified` and `_2`, allow to deny), 2 fixes, 0 regressions; `workflow` behavioral = behavioral, cites `evt_c03`, 0 flips; `tool_policy` tightening = tightening, cites `evt_b02`, 0 flips. **Three arms on one incident at equal budget (6000 chars):** `trace_informed` packet 851 chars, 2 proposals, stopped `good_candidate`, selected `guardrails.deny_complete_without_verification` (tightening, cites `evt_a01`, 2 fixes, 0 regressions); `score_only` packet 477 chars, 3 proposals, stopped on budget, selected `limits.modelCalls` (tightening, 0 fixes); `wrong_incident` packet 819 chars, 3 proposals, stopped on budget, selected `toolPolicy.prerequisites` (tightening, cites `evt_b02`, 0 fixes). **Rejection log:** 61/61 categories rejected across phases schema, infrastructure, edits, structure, classification, shortcuts and standing. This is a deterministic FAKE-model result on fixtures: it shows the pipeline separates the arms, not that any model learns | 11:26:53Z |
| Repro: commitments | `npx tsx docs/review/repro/fx-commitments.repro.ts` | 1 | NOT REPRODUCED | 11:27:18Z |
| Repro: co-occurrence | `npx tsx docs/review/repro/fx-cooccurrence.repro.ts` | 1 | NOT REPRODUCED | 11:27:18Z |
| Repro: seed recovery | `npx tsx docs/review/repro/fx-seed-recovery.repro.ts` | 1 | NOT REPRODUCED | 11:27:19Z |
| Repro: shape shortcut | `npx tsx docs/review/repro/fx-shape-shortcut.repro.ts` | 1 | NOT REPRODUCED | 11:27:20Z |
| Repro: guardrail scope | `npx tsx docs/review/repro/bl-guardrail-scope.repro.ts` | 1 | NOT REPRODUCED (B1, B2) | 11:27:21Z |
| Hash check, packet paths | `verify-checkpoint`, filtered to the packet | 0 for the packet | 20 packet files (16 under `packages/evolution/`, 4 harness-compiler), MATCH=20, CHANGED=0, MISSING=0 | 11:27:21Z |

Resolution: `node_modules/@expunge/evolution` exists (symlink to `packages/evolution`, created 16:42 local, so the owner note that it is not linked is out of date) and `npm ls @expunge/evolution` resolves it. Observation: `packages/evolution/package.json` pins `zod` 3.25.76, the same version as `@expunge/contracts` and the nested zod 3 copies; keep `console.error(<ZodError>)` out of that package until the Node floor is raised (see the Node `util.inspect` finding). Moved since the checkpoint (other lanes): `COMMIT-LEDGER.md`, `packages/observability/test/fake-raindrop.ts`, `packages/observer/{package.json,src/index.ts}`.

### Packet: ui-ux-improver / B3-S1 (PKT-10: operator readiness, shell, projection agent)

Manifest: the 68 paths ui-ux-improver listed, reconstructed by me as `git status --porcelain -uall -- apps/operator docs/ui DESIGN.md` minus the owner's declared S2 exclusions (16 untracked S2 files); my reconstruction also gave 68. Final evidence checkpoint **`20261011T113804Z-d9f6feba`** (`complete=true`, base `c45be9b`, taken 11:38:04Z). An earlier checkpoint `20261011T113041Z-7c964bc3` (11:30:41Z) captured `apps/operator/tests/fixtures/expunge-domain-fixture.ts` with seven S2 lines (`receiptDomainStatus`) that the owner reverted at about 11:31:31Z; the second checkpoint holds the reverted bytes, which are the ones the gate below ran on.

**Scratch-export gate (the HEAD-GREEN style proof asked for in PKT-10):** `git archive HEAD` (HEAD was `dbabd7e`) into a scratch directory, then only the 67 S1 files copied over it and `ExpungeFoundation.tsx` removed; none of the 16 S2 files exists there. No git state of the project was touched.

| Check | Command (in the scratch export unless stated) | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Root install | `npm ci --ignore-scripts` | 0 | 530 packages; lockfile coherent with the manifests | 11:33:53Z |
| Root typecheck | `npm run typecheck` | **2** | 1 error, **not from S1**: `packages/mongo/src/index.ts(22,15) TS2307: Cannot find module './edges.js'`, the HEAD defect the coordinator announced (fixed by PKT-11) | 11:34:06Z |
| Operator install | `npm ci --ignore-scripts --workspaces=false` (apps/operator) | 0 | 1023 packages | 11:34:09Z |
| Operator typecheck | `npm run typecheck` | 0 | 0 errors | 11:34:19Z |
| Operator lint | `npm run lint` | 0 | 0 errors (S1 files only) | 11:34:23Z |
| Operator build | `npm run build` | 0 | built in 1.00 s; only the large-chunk warning | 11:34:24Z |
| Operator tests, 25.2.1 | `npx vitest run` | 0 | 59 files, 390 total / 390 passed / 0 failed / **0 skipped**; telemetry tests included and not skipped (`telemetry.test.ts` 8, `setup-telemetry.test.ts` 10, `expunge-telemetry.test.tsx` 5) | 11:34:28Z |
| Operator tests, three Node versions | same, earlier export with linked `node_modules` | 0 | 390 / 390 on Node 25.2.1 (11:33:11Z), 24.11.1 (11:33:18Z) and 22.23.2 (11:33:25Z); matches the owner's 59 files / 390 | 11:33Z |
| Browser e2e | `node tests/expunge-browser.e2e.mjs s1` (Playwright 1.63 driving the installed Chrome, headless) against the S1-only build, a labeled fixture backend I started on 127.0.0.1:4371, a configured operator on :4373 and a setup-only operator on :4374 (all stopped afterwards; other agents' listeners on 4320, 4393 and 4394 were left alone) | 0 | **108 checks passed, 0 failed**; 17 output files (16 PNG plus `results-s1.json`), matching the owner's 108 | 11:35:51Z |

**Working tree (S2 files present), for completeness:** root `npm run typecheck` exit 0 (11:30:43Z); operator typecheck 0 (11:31:44Z); operator `npx prettier --check --ignore-unknown` on the packet paths 0 and `npm run check-format` 0; operator tests 60 files / 411 passed / 0 skipped on Node 25.2.1, 24.11.1 and 22.23.2 (the extra file is the S2 `expunge-projection.test.ts`); **operator `npm run lint` exit 1 with 2 errors, both in S2 files that are not in the packet**: `src/client/expunge/components/JobFrame.tsx` 65:10 `'Header' is defined but never used`, `tests/expunge-projection.test.ts` 249:7 `prefer-const`.

| Review item | Finding |
|---|---|
| Hash check against the manifest | checkpoint `d9f6feba`: 68 paths, MATCH=67, deleted-as-recorded=1 (`ExpungeFoundation.tsx`), CHANGED=0, MISSING=0; the S1 export bytes equal the checkpoint for every manifest path. Against the first checkpoint `7c964bc3`: MATCH=66, CHANGED=1 (`tests/fixtures/expunge-domain-fixture.ts`, the S2 edit later reverted), deleted=1 |
| Upstream diffs vs HEAD | `platform.ts` +14 -8: three imports, an optional constructor parameter `expungeDomain`, and the conditional agent registration (`ExpungeProjectionAgent` when the domain is configured and the Dot is the Expunge Dot, otherwise upstream `DotAgent`). `index.ts` +5 -2: `ensureExpungeDot` and passing `expungeDomain`. `style.css` +20 -0: the skip-link rule only. `index.html` +2 -2: title and meta description rebranded. `WorkspaceDialog.tsx` +2 -10: the telemetry paragraph replaced by `<TelemetryNotice />`. `App.tsx` +104 -30: Expunge route and navigation, configured-domain default view, document titles, skip link, `<main>` landmark, "Unlock Expunge" copy, `<TelemetryNotice />`. All are in files the OWNERSHIP roster approves **except `WorkspaceDialog.tsx`, which the roster row does not name** (the coordinator's packet text does, as "telemetry notice only", and the diff is exactly that). `platform.ts` goes slightly beyond "agent registration lines" by adding the constructor parameter, and `App.tsx` is larger than a line-level edit; the lead should confirm both are intended |
| View registry claim | `registry.ts` has no discovery; discovery is `import.meta.glob('./views/*View.tsx', { eager: true })` and `import.meta.glob('./css/*.css', { eager: true })` in `ExpungeApp.tsx`. A working-tree build therefore picks up any `*View.tsx` or `css/*.css` file that exists (the untracked S2 `JobsHomeView.tsx`, `WorkbenchView.tsx` and `20-workbench.css` included). The S1 export, which has none of them, builds and passes 390 tests, so the S1 tree stands without the S2 files |
| Telemetry | `TelemetryNotice` shows the server's actual state from `/api/expunge/status` (`disabled` or `enabled`, computed from `DO_NOT_TRACK` / `COPILOTKIT_TELEMETRY_DISABLED`), not a fixed claim; `scripts/run-from-root.mjs` sets `DO_NOT_TRACK=1` unless the owner opts in. The upstream "collected by default" paragraph is replaced |
| Screenshots | 16 PNG in `docs/ui/screens/s1/`, largest 166,671 bytes (all under 170 KB), folder 2.3 MB. I viewed 12 of the 16 (readiness 1440 light and dark, 1024 light, 390 dark, setup-only light and dark, and the ready, down, unauthorized, unbound, evidence-never-proven and evidence-dead-letter states): each shows the "Fixture backend ... deterministic test data" banner or the setup-only notice, environment variable NAMES only, no credential and no host. The other four (768 light and dark, 1024 dark, 390 light) are the same page at other widths; `results-s1.json` contains no URL, bearer string, fixture token or connection string |
| `apps/operator/package.json` and `package-lock.json` | **Not unchanged**: each has a one-line diff, `engines.node` `">=24.0.0"` changed to `">=24.13.1 <25.0.0 \|\| >=25.4.0"` (the OWNERSHIP roster permits "engines only"). Neither file is in the 68-path manifest, so the steward must not add them under PKT-10 unless the lead assigns them |
| Secret scan | the checkpoint scan (known token formats, local `.env` values, sealed markers) found nothing in any exported packet file; the fixture token strings in `expunge-domain-fixture.ts` are synthetic labeled constants (`fixture-*-token-...`) |

Also: HEAD moved to `c45be9b` while this ran; the gate above is on `dbabd7e` plus the packet, so re-run the export gate on the HEAD the commit actually lands on.

### Packet: runtime-raindrop / C1a (new workspaces `packages/observability` and `packages/observer`)

Manifest: `git ls-files -o --exclude-standard packages/observability packages/observer` returns exactly **33** files (observability: `package.json`, `src/{carrier,config,diagnostics,episode,index,ingest,outbox,sanitize,tools,tracing}.ts`, `test/{episode,ingest,provider-spans,sanitize}.test.ts`, `test/fake-raindrop.ts`; observer: `package.json`, `src/{bundle,evidence,index,mcp,outbox-dispatcher,query-client,scan}.ts`, `test/{bundle,mcp,mongo.integration,outbox-dispatcher,query-client,raindrop-live,scan}.test.ts`, `test/{helpers,mongo-support}.ts`); nothing in those directories is tracked yet. Checkpoint **`20261011T114310Z-86e41ce5`** (`complete=true`, base `c45be9b`, taken 11:43:10Z). A first attempt at 11:42:36Z was incomplete because the scanner flagged `mongodb+srv://u:p@` in verifier-2's section of this file; I extended the fixture rules to the SRV scheme (tests added, 35/35 continuity tests pass) and retook it.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | 0 | 0 errors | 11:43:12Z |
| Lint | `npx eslint packages/observability packages/observer` | 0 | 0 errors, 12 warnings (`no-explicit-any` in tests), as the owner said | 11:43:15Z |
| Format | `npx prettier --check packages/observability packages/observer` | 0 | all files formatted | 11:43:16Z |
| With replica set | `MONGODB_TEST_URI=<my 127.0.0.1:27118 set> npx vitest run packages/observability packages/observer` | 0 | 96 total / 95 passed / 0 failed / 1 skipped (11 files; the skip is `raindrop-live`); observer: bundle 14, mcp 8, mongo.integration 13, outbox-dispatcher 12, query-client 12, scan 13; observability: episode 10, ingest 4, provider-spans 1, sanitize 8 | 11:43:25Z |
| Without URIs | same, `MONGODB_TEST_URI` unset | 0 | 96 total / 82 passed / 0 failed / 14 skipped | 11:43:33Z |
| Mongo integration, required | `EXPUNGE_REQUIRE_LIVE_TESTS=1 npx vitest run packages/observer/test/mongo.integration.test.ts` (with my URI) | 0 | 13 / 13 passed, 0 skipped | 11:43:37Z |
| Raindrop live, required | `EXPUNGE_REQUIRE_LIVE_TESTS=1 npx vitest run packages/observer/test/raindrop-live.test.ts` (no credentials) | **1** | 1 failed, 0 passed, 0 skipped: `live suites are required but these variables are not set: RAINDROP_API_KEY, RAINDROP_QUERY_API_KEY, RAINDROP_PROJECT_ID`. This is the designed BLOCKED state and it never fakes a pass; without the flag the same file reports 1 skipped | 11:43:50Z |
| Regression lane | `MONGODB_TEST_URI=... npx vitest run apps/worker packages/runtime packages/vendor-openmuse packages/mongo` | 0 | 465 total / 396 passed / 0 failed / 69 skipped (29 files; skips: 68 RBAC tests without `MONGODB_RBAC_TEST_URI` plus the 1 worker live-provider smoke); the owner reported 392 passed, the four extra are tests other lanes added | 11:43:54Z |
| Hash check, manifest | 33 manifest paths vs the checkpoint | 0 | MATCH=33, CHANGED=0, NOT-IN-CHECKPOINT=0; the scratch-export bytes equal the checkpoint for all 33 | 11:47:04Z |

**Scratch-export gate** (`git archive HEAD` at `9d48ebb` plus the 33 files; no project git state or `node_modules` touched; the `.expunge/locks/npm.lock` mutex was taken with `mkdir` for the lock regeneration and released with `rmdir`):

| Step | Exit | Result | Timestamp (UTC) |
|---|---|---|---|
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | 0 | regenerated the lock | 11:45:41Z |
| structural diff of that lock against HEAD's | n/a | **not the "workspace entries only" the plan expected.** HEAD's lock has 616 `packages` entries, the regenerated one 748: **+132 added, 0 removed, 1 changed**. 6 are the expected workspace entries (`packages/observability`, `packages/observer`, their two `node_modules/@expunge/*` links, and a nested `zod` 4.6.5 under each). **126 are third-party additions (94 top-level), all pulled in by `raindrop-ai@1.0.1` and `@opentelemetry/otlp-transformer@0.57.2`, neither of which is in HEAD's lock**: 16 `@opentelemetry/*`, 12 `@traceloop/instrumentation-*` and relatives, `@grpc/grpc-js`, `@jitl/quickjs-*`, 9 `@protobufjs/*`, 5 `@types/*` and 46 unscoped packages (`protobufjs` has an install script, which `--ignore-scripts` skips). Licenses: MIT 60, Apache-2.0 51, BSD-3-Clause 10, ISC 4, BSD-2-Clause 1; none flagged dev-only. The one changed entry is `node_modules/acorn` (its `dev` flag cleared because a production dependency path now reaches it). The other pinned versions are unchanged: `@modelcontextprotocol/sdk` 1.32.1, `mongodb` 7.7.0, `@tanstack/ai-openai` 0.25.1, `@opentelemetry/api` 1.9.1 | 11:45Z |
| `npm ci --ignore-scripts` | 0 | 660 packages added | 11:46Z |
| `npm run typecheck` | 0 | 0 errors | 11:46Z |
| `npx vitest run packages/observability packages/observer` (no URIs) | 0 | 96 total / 82 passed / 0 failed / 14 skipped, as expected | 11:46Z |
| `npm audit --omit=dev` on the regenerated lock | 1 | **38 advisories (5 high, 33 moderate, 0 critical) versus 7 (2 high, 5 moderate) at 10:17Z**: 31 newly vulnerable packages, all in the new subtree. High: `@opentelemetry/propagator-jaeger` <= 2.8.0 (DoS via a malformed header, GHSA-45rx-2jwx-cxfr), `@opentelemetry/sdk-trace-node` <= 2.7.1 (via the OpenTelemetry packages), `langsmith` <= 0.5.26 (SSRF through a tracing header GHSA-v34v-rq6j-cj6p, prototype pollution GHSA-fw9q-39r9-c252, redaction bypass GHSA-rr7j-v2q5-chgv); moderate own advisories in `@opentelemetry/core` and `uuid`. npm's only fix for `raindrop-ai` is a semver-major change to 0.3.1 (a downgrade), so there is no clean upgrade; reachability was not traced | 11:46:41Z |

**Content confirmed by reading and probing:**
- Evidence store (`packages/observer/src/evidence.ts`): remote narrative is stored as a 32-hex SHA-256 prefix (`userInputSha`, `assistantOutputSha`); signals, tool-call names, span summaries and counts are kept as structure. **Not literally "hashes and structure only":** `event.properties` (everything except `$context`), `featureFlags`, `userId` and `convoId` are stored verbatim.
- Held-out leak guard (`bundle.ts` `assertNoLeak`): key-name based (13 keys, lower-cased) plus case-insensitive substring match on caller-supplied forbidden literals, applied to the bundle and to `observation.event.properties`; the owner is right that it is not semantic. Probed: `expectedOutcome`, `groundTruth`, `seedCommitment` and a key nested in an array are refused; **`expected_outcome`, `held_out`, `held-out`, `ground_truth` and `private_manifest` are allowed** (separators are not normalised), a value that says "the expected outcome is delete" is allowed, and a forbidden literal split by a zero-width character or URL-encoded is allowed.
- Outbox: `outbox-dispatcher.ts` implements pending, `sdk_enqueued`, `ingest_accepted`, `query_visible`, `evidence_ready`; transient failures retry with a delay and become `dead_letter` when attempts are exhausted; a non-retryable ingest failure dead-letters at once; an ingest `auth` failure and a query `auth` or `forbidden` failure are a **held block** (`blocked_ingest_*`, `blocked_query_*` with `authBlockDelayMs`), not a dead letter.
- `enqueueTelemetry` (`observability/src/outbox.ts`): outside a transaction a duplicate key returns `inserted: false`; inside one it throws `TelemetryIntentConflict`.
- No source file reads `RAINDROP_ORGANIZATION_ID` (grep over `packages/` and `apps/`: no match).
- Declared dependencies match the owner's list exactly (observability: `@opentelemetry/api` 1.9.1, `@tanstack/ai` 0.63.0, `mongodb` 7.7.0, `raindrop-ai` 1.0.1, `zod` 4.6.5, dev `@opentelemetry/otlp-transformer` 0.57.2 and `@tanstack/ai-openai` 0.25.1, plus workspace packages; observer: `@modelcontextprotocol/sdk` 1.32.1, `mongodb` 7.7.0, `zod` 4.6.5, plus workspace packages). `npm ls --all` resolves each third-party name to a single version except `zod` (3.25.76 and 4.6.5, both already present for other workspaces).

### C1a reachability evidence (lock accepted by the coordinator; evidence recorded rather than prose)

Subject: the 31 newly vulnerable packages the regenerated lock brought in (`raindrop-ai@1.0.1`, `@opentelemetry/otlp-transformer@0.57.2`). Tree: scratch export `$S/c1a-export` (HEAD `9d48ebb` plus the 33 C1a files, `npm ci --ignore-scripts`), compared with the committed `56b1de5` tree and the working tree where stated. Probe script (mine, no network): `tests/reliability/probes/propagator-selection.mjs`.

**1. Dependency paths (`npm ls`, export):**

| Package (installed) | Path |
|---|---|
| `@opentelemetry/propagator-jaeger@1.30.1` | `raindrop-ai@1.0.1 -> @opentelemetry/sdk-trace-node@1.30.1 -> @opentelemetry/propagator-jaeger@1.30.1` |
| `@opentelemetry/sdk-trace-node@1.30.1` | `raindrop-ai@1.0.1 -> @opentelemetry/sdk-trace-node@1.30.1` (also `propagator-b3@1.30.1`) |
| `langsmith@0.3.87` | `raindrop-ai@1.0.1 -> @traceloop/instrumentation-langchain@0.19.0-otel-v1 -> @langchain/core@0.3.80 -> langsmith@0.3.87` |
| `uuid@10.0.0` (and 9.0.1 under `gtoken`, `google-gax`, `teeny-request`) | same langchain chain, plus the Google client chain |
| `@opentelemetry/core@1.30.1` | everywhere in the `raindrop-ai` subtree, and `@expunge/observability -> @opentelemetry/otlp-transformer@0.57.2` (a dev dependency) |

The root workspace tree also carries `@copilotkit/runtime -> @langchain/core / langchain / langsmith@0.10.11`, which pre-dates C1a and is not in the 31.

**2. Does raindrop-ai let `OTEL_PROPAGATORS` select Jaeger? Yes, if the process environment sets it.**
- `raindrop-ai/dist` has no Jaeger code: 0 matches for `JaegerPropagator`, `propagator-jaeger`, `OTEL_PROPAGATORS`, `setGlobalPropagator`, `W3CTraceContextPropagator`, `CompositePropagator`. It builds `new NodeTracerProvider({resource, spanProcessors})` and calls `provider.register({contextManager: options.contextManager, propagator: options.propagator})` (`chunk-M6RTFC5O.mjs` lines 3105-3114).
- `@opentelemetry/sdk-trace-node@1.30.1` `NodeTracerProvider._registeredPropagators` includes `['jaeger', () => new JaegerPropagator()]` (`NodeTracerProvider.js:57`), and `BasicTracerProvider.register` runs `_buildPropagatorFromEnv()` when `config.propagator === undefined` (`BasicTracerProvider.js:102-103`, `:169-171`, reading `OTEL_PROPAGATORS`). No raindrop call site (`chunk-M6RTFC5O.mjs` lines 5207, 5242, 5266, 5324) passes a `propagator` unless one is spread in through `...otherOptions`.
- Measured with the probe (`api.propagation.fields()` after `new Raindrop(...)`, Node 25.2.1):

| Mode | `OTEL_PROPAGATORS` | Global propagator fields | Reading |
|---|---|---|---|
| default (unset) | unset | `traceparent, tracestate, baggage` | W3C, safe |
| env | `jaeger` | `uber-trace-id` | **Jaeger propagator is live** |
| env, W3C list | `tracecontext,baggage` | `traceparent, tracestate, baggage` | W3C |
| cast `propagator:` option | `jaeger` | `uber-trace-id` | **a cast does nothing at run time**: the public `AnalyticsConfig` type refuses the key (`tsc` TS2353 `'propagator' does not exist in type 'AnalyticsConfig'`; a made-up key gives the same error, so the check is sensitive), and the SDK did not apply it |
| `setGlobalPropagator(w3c)` after construction | `jaeger` | `uber-trace-id` | refused: `@opentelemetry/api: Attempted duplicate registration of API: propagation`; the global stays Jaeger |
| `propagation.disable()` then `setGlobalPropagator(w3c)` | `jaeger` | `traceparent, tracestate, baggage` | **works** |
| code assigns `process.env.OTEL_PROPAGATORS='tracecontext,baggage'` before `new Raindrop` | `jaeger` in the shell | `traceparent, tracestate, baggage` | **works** |

  Conclusion: reachability is **environment-controlled, not code-controlled and not impossible**: no repository code selects Jaeger, but a deployment that exports `OTEL_PROPAGATORS=jaeger` activates `JaegerPropagator@1.30.1` (GHSA-45rx-2jwx-cxfr, fixed in 2.9.0), whose `extract` throws on a malformed header. The advisory only matters where the process calls `propagation.extract` on an inbound carrier. A grep for `propagation.`, `.extract(`, `.inject(` over `packages/` and `apps/` finds no call at committed `56b1de5` (`git grep` over `packages apps`: no match); the only matches are the uncommitted C1c files (see 3).

**3. Repository state:**
- Committed `56b1de5` `packages/observability/src/tracing.ts`: 0 occurrences of `propagat`; `initTracing` passes `writeKey, projectId, endpoint, redactPii, localWorkshopUrl:false, debugLogs:false, maxTextFieldChars, disableBatching, bufferSize, bufferTimeout` and nothing else, so at HEAD **no propagator is pinned**; the SDK default or `OTEL_PROPAGATORS` decides.
- Working tree (C1c in flight, uncommitted; not part of this C1a verification): `tracing.ts` now sets `OTEL_PROPAGATORS` around construction, restores it, and calls `pinPropagator()` = `propagation.disable()` + `setGlobalPropagator(new CompositePropagator([W3CTraceContextPropagator, W3CBaggagePropagator]))`, with `test/propagator.test.ts` asserting fields `baggage, traceparent, tracestate` under `OTEL_PROPAGATORS=jaeger`. That is the `disable()`-then-set mode the probe shows working; to be verified when C1c arrives as a packet.
- `OTEL_PROPAGATORS` is not set in `.env.example`, `docs/`, or `infra/`; the only repository mention is `PRODUCTION-READINESS.md` line 33.
- Nothing imports langchain: `git grep -E "from '(langchain|@langchain/[a-z-]+|langsmith)'|require\('(langchain|@langchain|langsmith)"` at `56b1de5` over `packages apps scripts tests` returns no match, and no `package.json` (root, `packages/*`, `apps/*`) declares `langchain`, `@langchain/*` or `langsmith`. **But** `raindrop-ai` itself imports `LangChainInstrumentation` (`chunk-M6RTFC5O.mjs:2292`) and, when `instrumentModules` is not supplied (as `initTracing` does not), `createDefaultInstrumentations()` includes `new LangChainInstrumentation()` (line 5080; the manual path adds it unconditionally at line 5137), so `@traceloop/instrumentation-langchain` is constructed at runtime. That instruments a `langchain` module only if the application loads one; `langsmith` is a dependency of `@langchain/core` and is loaded only when `@langchain/core` is. In this repo neither is loaded by project code. The three langsmith advisories are about the client's own API (tracing header injection, `__proto__` guard, stream redaction, public prompt pull deserialization), which the instrumentation does not call.

**4. Audit table (`npm audit --omit=dev --json`, no upgrades): before = root audit at 10:17Z (`$S/matrix/audit-root.json`), after = regenerated C1a lock (`$S/matrix/pk-c1a/c1a-audit-export.json`).**

| | Total | Critical | High | Moderate | Advisory ids |
|---|---|---|---|---|---|
| Before | 7 | 0 | 2 | 5 | 15 advisories, all on `undici` and `@fastify/busboy`; the `@ai-sdk/*` rows only inherit from `undici` |
| After | 38 | 0 | 5 | 33 | 22 advisories: the same 15, plus 7 new (below) |

New advisories (all 7 are in the C1a subtree; none removed):

| Advisory | Package (installed) | Severity | Fixed in | Subject |
|---|---|---|---|---|
| GHSA-45rx-2jwx-cxfr | `@opentelemetry/propagator-jaeger` (1.30.1) | **high** | 2.9.0 | `JaegerPropagator` DoS: unhandled exception on a malformed header |
| GHSA-3644-q5cj-c5c7 | `langsmith` (0.3.87) | **high** | 0.6.0 | public prompt pull deserializes untrusted manifests |
| GHSA-v34v-rq6j-cj6p | `langsmith` | moderate | 0.4.6 | SSRF via tracing header injection |
| GHSA-fw9q-39r9-c252 | `langsmith` | moderate | 0.5.18 | prototype pollution, incomplete `__proto__` guard |
| GHSA-rr7j-v2q5-chgv | `langsmith` | moderate | 0.5.19 | streaming token events bypass output redaction |
| GHSA-8988-4f7v-96qf | `@opentelemetry/core` (1.30.1) | moderate | 2.8.0 | unbounded memory allocation in W3C Baggage propagation |
| GHSA-w5hq-g745-h8pq | `uuid` (9.0.1, 10.0.0) | moderate | 11.1.1 | missing buffer bounds check in v3/v5/v6 when `buf` is provided |

The five "high" entries after: `@fastify/busboy` and `undici` (both pre-existing), `@opentelemetry/propagator-jaeger` and `langsmith` (new, with their own advisories above), and `@opentelemetry/sdk-trace-node` (high only by inheritance from `propagator-jaeger`; no advisory of its own). The remaining moderates are inheritance rows (the `@traceloop/*`, `@opentelemetry/*` exporters and Google client packages) of `@opentelemetry/core` and `uuid`. `npm audit` offers `raindrop-ai@0.3.1` as the only fix (a semver-major downgrade) and `@opentelemetry/otlp-transformer@0.223.0` (major) for the dev dependency; neither was applied.

Net assessment for the coordinator: the Jaeger exposure is **real but conditional on a deployment variable and on inbound carrier extraction**; at committed HEAD nothing pins it, in the working tree C1c pins it and a test covers it. The langchain/langsmith advisories are **present in `node_modules` and constructed-for by raindrop's default instrumentation list, but not reachable through any repository code path** (nothing loads `langchain`). Both statements are limited to this repository's code; a future module that imports `langchain` or `@langchain/core` would change the second.

### Packet: ui-ux-improver / B3-S2 (PKT-17: jobs home and job workbench, 54 paths)

Manifest: the 54 paths the owner froze, reconstructed as 4 modified (`apps/operator/package-lock.json`, `package.json`, `tests/browser/s1.mjs`, `tests/fixtures/expunge-domain-fixture.ts`) + 21 new under `apps/operator` (`.nvmrc`; components `CoverageStatement`, `EventFeed`, `GapBanner`, `JobFrame`, `LimitsStrip`, `PhaseStepper`; `css/20-workbench.css`; `projection/{controller,reducer,selectors,store}.ts`; `viewModules.ts`; views `JobsHomeView`, `WorkbenchView`; `tests/browser/s2.mjs`; tests `expunge-projection.test.ts`, `expunge-toolchain.test.ts`, `expunge-workbench.test.tsx`; `tests/fixtures/expunge-samples.ts`, `tests/fixtures/ext/10-jobs.ts`) + `docs/ui/screens/s2/` (28 PNG + `results-s2.json` = 29) = **54**, exactly as the owner stated (4 + 21 + 29). Evidence checkpoint **`20261011T120014Z-2db83ff8`** (`complete=true`, base `56b1de5`, taken 12:00:14Z). The working tree also holds S3 files outside this manifest (`CancelControl`, `NodeChips`, `RecordInspector`, `Reference*`, `NewCleanupView`, `useGraph`, `lib/`, `projection/graph*.ts`, `css/30-cleanup.css`, `tests/browser/s3.mjs`, four more tests and fixtures, `docs/ui/screens/s3/`, and a `GRAPH_NODE_STATES` edit to `src/shared/expunge.ts`); none was copied to the export, and the export is green without them, so S2 does not depend on S3.

An earlier checkpoint attempt `20261011T115938Z-50c6020e` came out `complete=false`: my own scanner blocked `apps/operator/tests/browser/s3.mjs` (rule `bearer-token`) because the `Bearer fixture-read-token-...` string did not name itself a fixture under my rule. I added `fixture` to the self-labelled-token words in `scripts/continuity/lib.mjs` and a test line in `scripts/continuity/test/secrets.test.mjs` (`secrets.test.mjs` 7/7 pass); this belongs to the continuity packet.

**Scratch-export gate** (`git archive HEAD` at `56b1de5` plus exactly the 54 files, byte-identical to the working tree and to the checkpoint; no project git state or `node_modules` touched):

| Check | Command (in the export) | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Root install | `npm ci --ignore-scripts` | 0 | 660 packages | 12:01:13Z |
| Operator install | `npm ci --ignore-scripts --workspaces=false` (apps/operator) | 0 | 1023 packages; the lock resolves against the one-line `engines` edit | 12:01:24Z |
| Root typecheck | `npm run typecheck` | 0 | 0 errors | 12:01:33Z |
| Operator typecheck | `npm run typecheck` | 0 | 0 errors | 12:01:37Z |
| Operator lint | `npm run lint` | 0 | 0 errors, 0 warnings printed | 12:01:39Z |
| Operator format | `npm run check-format` | 0 | all matched files formatted | 12:01:41Z |
| Operator build | `npm run build` | 0 | built in 1.33 s; only the large-chunk warning | 12:01:45Z |
| Operator tests, Node 25.2.1 | `npm test` (`cross-env DO_NOT_TRACK=1 vitest run`) | 0 | 62 files, 429 total / 429 passed / 0 failed / **0 skipped** | 12:02:02Z |
| Operator tests, Node 24.11.1 | same | 0 | 62 files, 429 / 429 / 0 / 0 skipped | 12:02:15Z |
| Operator tests, Node 22.23.2 | same | 0 | 62 files, 429 / 429 / 0 / 0 skipped | 12:02:23Z |
| Browser s1 | `node tests/expunge-browser.e2e.mjs s1` (Playwright against the installed Chrome, headless) with the labeled fixture backend on 127.0.0.1:4371, the configured operator on :4373 and a setup-only operator on :4374 (all stopped afterwards; nobody else's listener was touched) | 0 | **108 checks passed, 0 failed** | 12:03:46Z |
| Browser s2 | same, slice `s2` | 0 | **190 checks passed, 0 failed**; 29 output files with the same names as the packet's `docs/ui/screens/s2/`; `results-s2.json` `failures` empty | 12:04:48Z |

Both browser counts equal the owner's (108 and 190).

| Review item | Finding |
|---|---|
| Hash check against the manifest | `verify-checkpoint` on `20261011T120014Z-2db83ff8`: all 54 packet paths MATCH in the working tree at 12:05Z (the five CHANGED files in that run are other lanes' `packages/deployment` and `packages/observer` edits, not this packet); the export bytes equal the working tree for all 54 |
| `apps/operator/package.json`, `package-lock.json` | one changed line each, `engines.node` `">=24.0.0"` to `">=24.13.1 <25.0.0 \|\| >=25.4.0"` (`git diff --numstat`: 1/1 and 1/1); no dependency or resolved-URL change; `.nvmrc` is a single line, `24.13.1`; the `expunge-toolchain` test passes |
| Secret and host scan of the 54 text paths | checkpoint scan found nothing; a separate grep for key formats and credentialed URIs found nothing; the only non-local URL is the `git+https://github.com/CopilotKit/OpenDots.git` repository field that was already in `package.json`. The fixture token strings are labelled constants |
| Screenshots | 28 PNG, 3,019,118 bytes in the folder, largest 172,420 bytes (`s2-jobs-1440-light.png`). I viewed 10: jobs 1440 light, jobs 390 dark, workbench 1440 dark, workbench 390 light, workbench-live 1440 light, and the states waiting-approval, projection-reset, disconnected, evidence and unavailable. Every job view carries the "Fixture backend. This is deterministic test data, not a live job or a database result." banner; subjects are `customers / 7f3a...c1 (objectId)` and the world is `world-northwind`; no tokens, real hosts, local paths or e-mail addresses appear. The unavailable state names the environment variables `EXPUNGE_DOMAIN_URL` and `EXPUNGE_INTERNAL_TOKEN` but shows no values. PNG strings contain no tEXt/iTXt chunks, `/Users/` paths or addresses; `results-s2.json` contains no URL or path |
| Reducer tests, the four cases the lead named | **Gap**: covered at reducer level twice (page jumps 3 to 5, and a hole inside one page) and at controller level ("never skips a gap: it re-bootstraps and ends with every event"). **Reset to an earlier snapshot**: reducer test (snapshot 3 after events to 6: notice `reset`, window cleared, re-read requested) and controller test (re-pages from 0 and says so). **Duplicate after retry**: reducer deduplicates by sequence (overlap and full replay return the identical state object) and the controller test "backs off through retrying to disconnected, then recovers without duplicating events". **Out-of-order sequence**: no test names it. I probed it (below): any non-contiguous or unsorted page is treated as a gap, never applied, and a late older page after newer ones is ignored |

**Probe results (scratch test `$S/s2/zz-verifier-probe.test.ts`, run inside the export and then removed from it; not added to the project).** Reducer, from a fresh state or after events 1..6:

| Input | Outcome |
|---|---|
| page `[2,1,3]` or `[3,2,1]` (unsorted) | nothing applied, notice `gap`, re-bootstrap requested |
| page `[1,1,2]` or `[1,2,2]` (duplicate inside one page) | treated as a gap the same way, not deduplicated |
| late older page `[2,3,4]` after 1..6 | same state object, no re-bootstrap |
| overlap `[4..7]` after 1..6 | applies only 7 |
| snapshot 4 after events to 6 | notice `reset`, window cleared, re-bootstrap |
| snapshot 8 after snapshot 10 with no events loaded | silently replaces the newer snapshot, no notice |
| event whose `jobId` is another job | applied (the reducer does not check `jobId`; the controller is per job and the URL carries the job id, so this is contained) |

**Findings for the owner (none blocks the 54-path hash):**
1. **Medium: an unbounded re-bootstrap loop.** In `controller.ts`, `cycle()` calls `this.schedule(0)` whenever `needsBootstrap` is set after a cycle, with no delay, backoff or cap. If the backend ever serves a head gap (event 1 trimmed or archived), an unsorted page or a duplicate inside a page, the controller re-reads the snapshot and the events at once, forever. Measured with fake `ProjectionDeps` and real timers for 1000 ms: head gap (page starts at 2) 769 snapshot and 769 events requests; unsorted page 744 and 744; in-page duplicate 797 and 797. The state ends with connection `live` and notice `gap`, so the user sees no error. Suggested fix: count consecutive re-bootstraps, back off with the existing `backoffDelay`, and after a small number surface an error state ("the projection is inconsistent") instead of `live`; add a controller test that a persistent gap makes a bounded number of requests.
2. **Low:** a duplicate inside a single page should be deduplicated, not treated as a gap (it feeds finding 1).
3. **Low:** root `npm run format:check` (`prettier --check .`) fails on `docs/ui/screens/s2/results-s2.json` and on `docs/ui/screens/s1/results-s1.json`, which is already at HEAD. Both are written by the e2e runner with `JSON.stringify(summary, null, 1)`. `apps/operator/` is in the root `.prettierignore` and the operator's own `check-format` does not cover `docs/`, so only the root check sees them. Fix by adding `docs/ui/screens/**/results-*.json` to `.prettierignore` (the lead owns it) or having the runner write 2-space JSON plus a newline.
4. **Low:** an older snapshot after a newer one is accepted without a notice when no events are loaded (probe row 6).

HEAD moved from `56b1de5` to `d9b42b2` (PKT-15 `96f7b89`, PKT-19 `83980b9` and their ledger commits) while this ran. `git diff --stat 56b1de5 d9b42b2 -- apps/operator docs/ui package.json package-lock.json` is empty, so the operator gate above applies unchanged to `d9b42b2`; the root typecheck was run at `56b1de5` and the HEAD proof is verifier-2's. Packet digest (SHA-256 of the sorted `sha256  path` lines of the 54 paths): `a3b886937730d8eee04779d420cc6b8a0c8eb38030c522b8df6ce8aa1bd25d80`, taken at 12:08Z when all 54 still matched; closing checkpoint `20261011T120827Z-0337c343` (`complete=true`, base `d9b42b2`).

### Packet: verifier / continuity handoff fixes, scanner rules, propagator probe, worldkey brand test (verified by verifier-2)

Manifest (8 paths): modified `scripts/continuity/{lib.mjs,restore-checkpoint.mjs,verify-checkpoint.mjs}` and `scripts/continuity/test/secrets.test.mjs`; new `scripts/continuity/README.md`, `scripts/continuity/test/handoff.test.mjs`, `tests/reliability/probes/propagator-selection.mjs`, `tests/reliability/worldkey-brand.test.ts`. Digest (SHA-256 of the sorted `sha256  path` lines): `74d954b7ea127a982e05aa0fb89cdb665705da6fa849902ba44adad7c0b2b25c`. Checkpoint **`20261011T121224Z-5ef9b4e5`** (`complete=true`, base `e2e1db1`, 12:12:24Z): all 8 paths MATCH. `VERIFICATION.md` is a living document and is not in the manifest.

What changed:
- `restore --apply` (and a rerun that is `ALREADY_APPLIED`) copies the pack's `briefing/HANDOFF.md` to `<target>/HANDOFF.md` and prints a `resume:` line naming the file and the pack path (`--json`: `briefing`, `resume`). An existing `HANDOFF.md` is never overwritten: identical is left alone, a differing file or symlink makes the copy land as `HANDOFF.from-<checkpointId>.md`, a taken alongside name with other content writes nothing and the resume line names the pack copy. Writes use the `wx` flag. A dry-run only notes what `--apply` will do. A refused restore writes no briefing.
- `verify-checkpoint` reports `headMoved` (and a `note:` line) when HEAD differs from the checkpoint base; the exit code still follows content only. `latest` on a clone without `.expunge/` now says the pack does not travel with git.
- `README.md` documents that `checkpoint:verify -- latest` needs the pack to travel with the repository, that `LATEST` lags HEAD until a post-commit checkpoint, the briefing placement table and the scanner rules (SRV and fixture-bearer rules, now also the word `fixture`).
- `probes/propagator-selection.mjs` is the C1a probe (see "C1a reachability evidence"); `worldkey-brand.test.ts` imports `worldKeyOf` by path and must land with or after PKT-15 (`96f7b89`, already at HEAD).

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Continuity suite (working tree) | `npm run test:continuity` | 0 | 42 tests / 42 passed (35 earlier + 7 new `handoff.test.mjs`) | 12:12:03Z |
| Mutation check (scratch copy of the tooling) | `wx` flag changed to `w` | 1 | 4 of the 7 handoff tests fail (first apply, differing file, both differ, symlink) | 12:10Z |
| Mutation check | `headMoved` forced to `null` | 1 | the HEAD-moved test fails; the other 6 pass | 12:10Z |
| Lint, format | `npx eslint scripts/continuity tests/reliability/probes tests/reliability/worldkey-brand.test.ts`; `npx prettier --check` same paths | 0, 0 | clean | 12:12Z |
| Scratch export (`git archive HEAD` at `e2e1db1` + the 8 files; bytes equal the working tree) | `npm ci --ignore-scripts` | 0 | ok | 12:12:32Z |
| Export typecheck | `npm run typecheck` | 0 | 0 errors | 12:12:40Z |
| Export continuity suite | `npm run test:continuity` | 0 | 42 / 42 | 12:12Z |
| Export worldkey test, fast | `env -u MONGODB_TEST_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run tests/reliability/worldkey-brand.test.ts` | 0 | 4 / 4 passed | 12:13Z |
| Export worldkey test, live | same with `MONGODB_TEST_URI` (my replica set, 127.0.0.1:27118) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | 4 / 4 passed | 12:13Z |

### Packets: rsi-evolution / C3 (PKT-23 fixtures and grader, PKT-24 gate, PKT-25 deployment), cumulative gates (write barrier stop: PKT-23 complete, PKT-24 partial, PKT-25 not started)

Evidence checkpoint **`20261011T121430Z-4a849c71`** (`complete=true`, base `e2e1db1`, 12:14:30Z) for all three packets. Packet digests (SHA-256 of the sorted `sha256  path` lines): P1 (18 paths) `094d145a5276019548b69d7b2f1e8218479899054c1e109bf9fcfc9cc495c4c5`, P2 (18) `6c99236896df8f31163f2a054c359b31644e6f8266eb40705264b591649f6090`, P3 (10) `3d1136287a97b38c4f2ffe4f76240b7ea55b567c27a94d3a7cb2de31c97282bb`. The three manifests equal the owner's lists exactly and no file in `packages/{fixtures,grader,gate,deployment}` is outside them. At the time of the stop all 18 / 18 / 10 files still matched their recorded hashes. HEAD moved from `e2e1db1` to `abafe0b` while this ran (docs only; no change under `packages/` or the manifests). Scratch exports: `$S/c3/x0` (HEAD only), `x1` (HEAD + P1), `x2` (HEAD + P1 + P2).

**PKT-23 (P1, fixtures and grader): verified.**

| Check | Command (export `x1`: `e2e1db1` + the 18 files) | Exit | Result | Time (UTC) |
|---|---|---|---|---|
| Install | `npm ci --ignore-scripts` | 0 | 660 packages | 12:14:46Z |
| Typecheck | `npm run typecheck` | 0 | **0 errors**; HEAD does not show the 30 diagnostics the owner saw | 12:14:57Z |
| Fast lane | `env -u MONGODB_TEST_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run packages/fixtures packages/grader` | 0 | 14 files, 133 / 133 passed, 0 skipped (new: `derivation` 6, `solvers` 5, `admission-solvers` 1) | 12:17:20Z |
| Lint, format | `npx eslint packages/fixtures packages/grader`; `npx prettier --check` same | 0, 0 | clean | 12:17Z |

- **Existing calls are byte-identical.** A scratch probe generated `generateSealedFixture(createWorldSpec(...), seed, scope)` without a derivation for 60 cases (10 families x 3 seeds x 2 scopes) in a HEAD-only export and in `x1`: `worldId`, the collections and the manifest without `generatorHash` and `manifestHash` are identical in all 60. `generatorHash` and the `manifestHash` that covers it differ in all 60, as claimed (the generator source commitment now includes `derivation.ts`; `worldIdFor` only adds the key id when it is non-null).
- **The tests are not unchanged, in two ways.** `fixtures.test.ts` gained two added lines (`'derivation.ts'` in the two source-commitment file lists). `admission.test.ts` and `helpers.ts` were adapted because `admitWorld` now quarantines with `unkeyed_derivation` unless it receives `{ derivation }` or the test-only `allowUnkeyedDerivation`. Running HEAD's own two test files against the P1 sources: 12 of 18 pass; the 6 failures are exactly those two source-commitment hash tests and 4 admission tests that now see `unkeyed_derivation`. That default is a deliberate change to the admission API; the only callers of `admitWorld` are inside `packages/grader` (no other package or app calls it at `abafe0b` or in the working tree).
- `reference2.ts` imports only `@expunge/contracts`, `@expunge/fixtures` and `node:fs`; a test asserts the import list and the absence of `valuesAtPath`; `INDEXED_SOLVER_HASH` differs from `REFERENCE_SOLVER_HASH`; the two solvers agree on every family keyed and unkeyed, on the 42 split worlds and on a partial observation.
- Mutation checks (restored afterwards): `worldIdFor` ignoring the key id fails 1 of 133 (`derivation.test.ts` reproducibility and key isolation); `admitWorld` skipping `plansAgree` fails 1 of 81 (`reports solver_disagreement and admits nothing`).

**PKT-24 (P2, gate): partial.** Done in export `x2` (`abafe0b` + P1 + P2):

| Check | Command | Exit | Result | Time (UTC) |
|---|---|---|---|---|
| Install with HEAD's lock | `npm ci --ignore-scripts` | 1 | refuses: HEAD's lock has no `packages/gate` | 12:18:08Z |
| Lock regeneration (mutex `.expunge/locks/npm.lock` taken and released) | `npm install --package-lock-only --ignore-scripts` | 0 | structural diff against HEAD's lock: 748 to 750 entries, **+2** (`node_modules/@expunge/gate` link, `packages/gate`), 0 removed, 0 changed, **no third-party entry** | 12:18:17Z |
| Install | `npm ci --ignore-scripts` | 0 | 661 packages | 12:18:30Z |
| Typecheck | `npm run typecheck` | 0 | 0 errors | 12:18:37Z |
| Lint, format | `npx eslint` and `npx prettier --check` on `packages/{gate,fixtures,grader}` | 0, 0 | clean | 12:18Z |
| Fast lane | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run packages/fixtures packages/grader packages/gate` | 0 | 19 files, 205 total / 196 passed / 0 failed / 9 skipped (gate `keys` live 4 + `store.integration` 5) | 12:18:56Z |
| Live lane | same three packages with `MONGODB_TEST_URI` (my set, 127.0.0.1:27118, `directConnection=true`), `MONGODB_RBAC_TEST_URI` (local auth set, 27019) and `EXPUNGE_REQUIRE_LIVE_TESTS=1` | 0 | **205 / 205 passed, 0 skipped** (gate: admission 36, campaign 11, keys 8, report 12, store 5) | 12:19:57Z |

An earlier live attempt without `directConnection=true` failed with ECONNREFUSED (the replica set advertises `localhost:27017`); that was my URI, not the packet.

- Mutation checks on the gate (all restored; every one is caught): no `BundleCompilerMismatch` in `runCampaign` fails 1 (`refuses before anything is seeded`); no `compiler_hash_mismatch` rejection fails 3; no `bundle_compiler_mismatch` rejection fails 2; `admittedUnder.compilerHash` not persisted fails 1 (`persists the compiler it was admitted under, inside the digest`); concurrency cap removed fails 1.
- Reading of `campaign.ts`: the compiler check runs before any `port.seed`; only the split label of a `test` entry is read in `selectGateWorlds`; `DEFAULT_EXPECTED` gives 2x3 = 6 trigger, 8x2 = 16 protected and 8x2 = 16 validation runs; failed, cancelled and timed-out arms become rows.
- **Finding (low): `concurrency: 1` runs two episodes at once.** A pool lane is a pair, so the lane count is `max(1, floor(c/2))`. Measured peak episodes in flight with the simulated port: configured 1 gives 2, 2 gives 2, 3 gives 2, 4 gives 4, 5 gives 4, 8 gives 8. The default of 4 and the tested lower setting 2 are right; only the minimum exceeds its setting. Fix by rejecting `< 2` or documenting that the unit is a pair.
- Not done for PKT-24: a compile-time probe that adding a reason without its catalog entry breaks `tsc`; a manual RBAC denial probe beyond the live `keys` tests that passed (`no other principal can mint or read a key`); the third owner mutation `no stale-bundle refusal in the campaign` is the one covered by M-a above.

**PKT-25 (P3, deployment): not started.** Remaining: export `x3` (P1+P2+P3), lock regeneration for `packages/deployment` (its manifest gained `@expunge/harness-compiler`), `npm ci`, typecheck, the four-package fast and live lanes (owner: about 225 passed live), `npx tsx packages/deployment/scripts/c3-evidence.ts` against the live set (record admitted report id and digest, rejected reason codes, promotion pointer move, pinned run's deny row, race log), and the mutation check `pin honouring a caller hash`.

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

## verifier-2 packet checks

Owner: verifier-2 (Sonnet 5.5, `claude-sonnet-5-5`), append-only, added 2026-10-11 11:45 UTC when packet checks queued behind `verifier`. Read-only on product code and Git. My own replica set is the throwaway compose project `expunge-v2` (container `expunge-v2-mongo`, copied from `packages/mongo/test/docker-compose.yml` with only the host port changed to 127.0.0.1:27218; the replica-set initiation in the healthcheck uses the container-internal `localhost:27017`, so no other change was needed). The RBAC lane reuses the existing auth set on 127.0.0.1:27019 with the documented local-only test credential from `packages/mongo/test/auth-docker-compose.yml` (not repeated here); use recorded in `.expunge/locks/mongo-local.users`. Local evidence only: nothing here is Atlas evidence. Live Atlas, model-provider and Raindrop checks stay BLOCKED (see the section above).

### Packet: mongodb-authority / PKT-12

Paths (6): `packages/mongo/src/effects.ts`, `packages/mongo/src/setup.ts`, `packages/mongo/src/validators.ts`, `packages/mongo/test/hardening.integration.test.ts`, `packages/mongo/test/hardening.test.ts`, `docs/MONGO.md`. Base HEAD **`c45be9b31a30f49101e2ad8e28d8861f144a741d`** (includes hotfix PKT-11 `5e229c9`: `packages/mongo/src/index.ts` at HEAD has no `edges` export, so the scratch export needed no manual edit). Checkpoint **`20261011T113613Z-9b77b25b`** (`complete=true`, tracked 527, untracked-exported 295, deleted 1, 37 unstaged-patch files from other lanes, taken 11:36:13Z). Packet diff: 6 files, +147/-7, no deleted files, nothing under `packages/contracts/` and `packages/mongo/src/roles.ts` untouched.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo | `npm run typecheck` | 0 | 0 errors | 11:36:50Z |
| Lint, owner's scope | `npx eslint packages/mongo` | 0 | 0 errors, 0 warnings | 11:36:55Z |
| Lint, the five packet source/test files | `npx eslint <the 5 .ts paths>` | 0 | 0 errors, 0 warnings | 11:37:05Z |
| Format, owner's scope | `npx prettier --check packages/mongo docs/MONGO.md` | 0 | all matched files formatted (`.prettierignore` contains `*.md`, so `docs/MONGO.md` is not actually checked by prettier) | 11:36:57Z |
| Format, the five packet .ts files | `npx prettier --check <the 5 .ts paths>` | 0 | all formatted | 11:37:05Z |
| Fast lane | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run packages/contracts packages/mongo packages/governance` | 0 | 329 total / **85 passed** / 0 failed / **244 skipped** (16 files: 5 passed, 11 skipped), matches the owner | 11:37:08Z |
| Live lane | `EXPUNGE_REQUIRE_LIVE_TESTS=1 MONGODB_TEST_URI=mongodb://127.0.0.1:27218/?replicaSet=expunge-local&directConnection=true MONGODB_RBAC_TEST_URI=<27019 auth set, local-only credential> npx vitest run packages/contracts packages/mongo packages/governance` | 0 | **329 / 329 passed, 0 failed, 0 skipped** (16 files), matches the owner. Per file: contracts 17; governance 16 + ledger 2; mongo: rbac 68, promotion 46, hardening.integration 45, hardening.test 31, authority 23, provenance 16, scope.integration 11, scope.test 15, projection 9, integration 9, dispatch 8, record-effects 7, protocol 6. The 5 new tests ran and passed: two `completeIncomplete` tests and two `campaign keys` tests in `hardening.integration.test.ts`, one `keeps campaign keys insert-only...` in `hardening.test.ts` | 11:37:15Z to 11:37:38Z |
| Secret scan, strict | `scripts` of mine: grep -E for `mongodb+srv://u:p@`, `mongodb://u:p@` (any host), `sk-`, `AKIA`, `-----BEGIN`, `Bearer <16+ chars>`, `api_key=<8+ chars>`, plus .env/.pem/.key file names, over the 6 packet files | 0 | 0 hits in all 7 pattern groups, no sensitive file names; the scan was run against a positive-control file first and flagged all 7 groups | 11:38:19Z |
| HEAD-green gate: export | `git archive c45be9b \| tar -x`, then the 6 packet files copied from the working tree over it (none marked D) | 0 | scratch differs from a pure HEAD export in exactly those 6 files (`diff -rq`); `index.ts` has no `edges` | 11:38:20Z |
| HEAD-green gate: install | `npm ci --ignore-scripts --no-audit --no-fund` in the scratch | 0 | added 530 packages in 6s; workspace links present (`baselines contracts evolution fixtures governance grader harness-compiler mongo runtime vendor-openmuse worker`); only EBADENGINE and deprecation warnings | 11:38:43Z |
| HEAD-green gate: typecheck | `npm run typecheck` in the scratch | 0 | 0 errors | 11:38:45Z |
| HEAD+packet, fast lane in the scratch | same fast command as above, inside the scratch | 0 | 85 passed / 0 failed / 244 skipped (16 files) | 11:39:56Z |
| HEAD+packet, live lane in the scratch | same live command as above, inside the scratch | 0 | 329 / 329 passed, 0 skipped | 11:40:13Z |
| Hash check, packet paths | `npm run checkpoint:verify -- <full path to 20261011T113613Z-9b77b25b> --json`, filtered to the packet | 0 for the packet | packet files **MATCH=6, CHANGED=0, MISSING=0**; the six working-tree files are also byte-identical (sha256) to the scratch copies. Whole checkpoint: pack MATCH=298 CHANGED=0 MISSING=0; worktree MATCH=806 CHANGED=17 MISSING=0 at 11:41:01Z (16 CHANGED at 11:40:17Z), all outside the packet and from lanes still active: `VERIFICATION.md`, `apps/operator/{package-lock.json,package.json,src/client/expunge/css/20-workbench.css}`, `docs/continuity/OWNERSHIP.md`, `docs/ui/screens/s2/s2-jobs-1440-light.png`, `packages/domain/src/{rows,store}.ts`, `packages/domain/src/tools/resolve-subject.ts`, `packages/gate/src/campaign.ts`, `packages/runtime/{src/ports.ts,src/session.ts,test/agent.test.ts}`, `packages/vendor-openmuse/{THIRD_PARTY.md,src/index.ts,src/tanstack-agent.ts,test/tanstack-agent.test.ts}` | 11:41:01Z |

Owner claims, each checked against `git diff HEAD -- <paths>` and the code (all present in the diff):

| Claim | Where | Verdict |
|---|---|---|
| `completeIncomplete` commits an `incomplete` receipt with at least one residual under the same binding, registry-coverage, authority-fence and world checks as `complete()` | `effects.ts`: both public methods delegate to one private `commitReceipt`, which does the principal check, replay, job fence, `ReceiptBindingMismatch` check, `assertReceiptCoversRegistry`, `authority.fence`, `worlds.assertRunnable`, `markVerified`, receipt insert, `jobs.finish(finalStatus)` in one transaction; `completeIncomplete` finishes the job `failed` with `[receiptId]` | CONFIRMED. Tests: honest incomplete receipt commits and the job is `failed` with that receipt as output; an incomplete receipt with empty `inspectedCollectionIds` is refused (coverage) and the job stays `running` |
| `complete()` and `completeIncomplete()` refuse each other's verdict | `complete()` fails `IncompleteReceipt` unless `complete_in_registered_scope` and 0 residuals; `completeIncomplete()` fails `ReceiptNotIncomplete` unless `incomplete` and residuals >= 1 | CONFIRMED, tested both directions plus the `incomplete` receipt with zero residuals |
| Replay by receipt id idempotent; changed payload under the same id is `ReceiptIdConflict` | unchanged `replay()` inside `commitReceipt` (content hash compare), now shared; test replays with `fence: 0` and gets the stored receipt, then submits `operationalResiduals: 3` and gets `ReceiptIdConflict` | CONFIRMED |
| `expunge_private.campaign_keys` has a strict validator (`_id`, `keyId`, 32-byte binData `key`, `createdAt`) | `validators.ts` `PRIVATE_VALIDATORS.campaign_keys`: `object({...})` helper (all four required, `additionalProperties: false`), `_id` and `keyId` bounded strings, `key: binData`, plus `$expr: { $eq: [{ $binarySize: '$key' }, 32] }` | CONFIRMED live: 31 and 33 byte keys, an extra field, a 129 char `_id`, a 65 char `keyId`, a missing key and a string key are all rejected with code 121; the 32 byte key inserts |
| Insert-only; only `fixture_builder` inserts, `fixture_builder` and `grader` read | no `roles.ts` change needed: `roles.ts` derives the grants from `PRIVATE_COLLECTIONS` (grader `FIND` all private collections and `INSERT` only `grader_results`; fixture_builder `FIND`+`INSERT` all private collections; nobody has `UPDATE`/`REMOVE` on private) and `setup.ts` adds `campaign_keys` to that list | CONFIRMED by the offline manifest test (`holders('INSERT')=['fixture_builder']`, `UPDATE`/`REMOVE` empty, `FIND` = fixture_builder and grader) and by the live authenticated RBAC matrix (`rbac.integration.test.ts` "enforces exactly the manifest..." iterates `PRIVATE_COLLECTIONS` x every verb x every principal on 27019, so `campaign_keys` is probed for real) |
| Setup applies a `PRIVATE_VALIDATORS` map | `setup.ts`: imports it and replaces the previous `{}` for `service.privateDb!`; the loop runs `assertSupportedMongoSchema`, `createCollection` with strict/error validation or `collMod` | CONFIRMED (the RBAC lane runs `setupMongo` against the authenticated set, so it also applied on a real server) |
| No change under `packages/contracts` | `git diff HEAD --stat -- packages/contracts` empty, `git status --short packages/contracts` empty | CONFIRMED |

Observations for the owner, none blocking:
1. Check order changed. The verdict check now runs in the public method before `requirePrincipal`, the replay lookup and the binding check (it used to run inside the transaction after the binding check). Both orders fail closed; the visible effects are that a non-executor principal passing a wrong-verdict receipt now sees `IncompleteReceipt` or `ReceiptNotIncomplete` instead of `PrincipalBoundary`, and a receipt with both a bad verdict and a bad binding reports the verdict error first. No test depends on the old order.
2. The error name `IncompleteReceipt` now means two things: "`complete()` was given a non-complete verdict" and "a receipt (of either verdict) fails registry coverage" (`assertReceiptCoversRegistry`). The new coverage test asserts `IncompleteReceipt` for an `incomplete` receipt, which reads oddly; a distinct coverage code would make diagnosis unambiguous. Behavior is correct as is.
3. The hardening test "is reachable through the fixture builder and grader only" runs on the unauthenticated set where `env.as(principal)` only labels the service ("rights are by code", per `support.ts`), so its assertions show the code-level `privateDb` wiring, not database-enforced denial. The enforcement evidence for `campaign_keys` is the offline manifest test plus the live RBAC matrix above; the docs claim ("nobody updates or removes") is backed by those two.
4. `docs/MONGO.md` is 107 lines with exactly one mermaid block; the diagram's private box now lists `campaign_keys`.
5. `$expr: { $eq: [{ $binarySize: '$key' }, 32] }` in a collection validator is accepted by MongoDB 8.0.15 locally (setup, createCollection and collMod all ran); I did not and cannot test it on Atlas (BLOCKED, no `.env`).

### HEAD proofs

Each row: `git archive <hash> | tar -x` into a fresh scratch directory (no working-tree files overlaid), `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, `npx vitest run` with no `MONGODB_*` or `EXPUNGE_REQUIRE_LIVE_TESTS` in the environment (default lane). Node v25.2.1 (outside the engines range; EBADENGINE warnings are expected, not failures).

| Date (UTC) | HEAD | npm ci | tsc | vitest default lane | Notes |
|---|---|---|---|---|---|
| 2026-10-11 11:39:48Z | `c45be9b31a30f49101e2ad8e28d8861f144a741d` (= origin/main, includes PKT-11 hotfix `5e229c9`) | exit 0 (530 packages, 6s) | exit 0 (0 errors) | exit 0: **537 passed / 0 failed / 254 skipped** (791 total; 54 files: 40 passed, 14 skipped) | The 254 skips are live-service suites that self-skip without URIs. `npm ci` 11:38:37Z to 11:38:43Z, `tsc` finished 11:38:45Z, vitest 11:39:37Z to 11:39:48Z. |

### Restore drill (spec section 20, transferred-workspace restore; verifier-2)

Procedure: `LATEST` read at the start (`20261011T114310Z-86e41ce5`), pack re-hashed, a fresh scratch `git clone --no-hardlinks` of the repository moved to the manifest base commit with `git checkout --detach` (scratch only; the live working tree, index and `.expunge` were only read), then `npm run checkpoint:restore -- <full pack path> <scratch repo>` dry-run, then `--apply`, then hash and exclusion audits, then `npm ci --ignore-scripts --no-audit --no-fund` and `npm run typecheck` inside the restored tree. Scratch tree left in place for inspection: `/private/tmp/claude-501/-Users-nihalnihalani-Desktop-Github-harness-hackathon/ee524045-9ba2-4ef8-804b-1b2296817e8a/scratchpad/v2/restore-drill/target` (logs and JSON next to it). Node v25.2.1. Nothing was restored onto the live tree.

| Item | Result | Time (UTC) |
|---|---|---|
| Checkpoint | `20261011T114310Z-86e41ce5`, `complete=true`, base `c45be9b31a30f49101e2ad8e28d8861f144a741d`, branch `main`, 0 staged files, 53 unstaged-patch files (52 M plus 1 D), 360 untracked copies, 887 manifest file hashes plus 1 deleted path, `excluded=[]`, `unlistedRoots=[]`, `incompleteReasons=[]`, `stability.stable=true` | 11:44:36Z |
| Pack integrity before restore | `verify-checkpoint --pack-only`: pack MATCH=363 CHANGED=0 MISSING=0, exit 0 (363 = 360 untracked copies + `staged.patch` + `unstaged.patch` + briefing) | 11:44:37Z |
| Negative control observed | First dry-run against a clone that had landed on the newer live HEAD `f17fd61`: `REFUSED BASE_MISMATCH`, exit 4, nothing written (clone `git status` stayed empty). Live HEAD kept moving (`a104f90`, then `109e2dc`) while LATEST stayed at base `c45be9b` | 11:44:37Z |
| Dry-run onto the base clone | exit 0, `READY`, actions: apply unstaged patch (53 files), copy untracked (360 files), counts applied 0 / pending 413 | 11:45:03Z |
| Apply | exit 0, `APPLIED`, 53 patch files + 360 untracked copies = **413 files restored** (about 5 s) | 11:45:18Z to 11:45:23Z |
| Hash matches, my independent script (sha256 of every `manifest.files` entry in the restored tree) | **887 / 887 MATCH, CHANGED=0, MISSING=0**; the 1 deleted path (`apps/operator/src/client/expunge/ExpungeFoundation.tsx`) is absent; 0 mode mismatches on the 360 untracked entries (exec bit vs recorded mode); 0 pack-copy hash mismatches | 11:45:25Z |
| Hash matches, the tool | `verify-checkpoint <pack> --repo <restored>` run with the live tooling and again from inside the restored tree with its own copy of `scripts/continuity`: worktree **MATCH=888 CHANGED=0 MISSING=0**, `RESULT: ALL MATCH`, exit 0 both | 11:45:25Z |
| Git state equals the recorded state | restored tree `git status --porcelain=v2` versus `manifest.git.statusPorcelainV2`: 111 entries each, 0 only-in-manifest, 0 only-in-restored; index empty (0 staged), matching the 0-byte `staged.patch` | 11:46:30Z |
| Idempotence | second `--apply`: exit 0, `ALREADY_APPLIED`, counts applied 413 / pending 0; a sha256 digest over every non-`.git` file was identical before and after (`ada85364cded34e3`) | 11:45:25Z |
| Exclusions confirmed | see the next table | 11:46Z |
| `npm ci --ignore-scripts --no-audit --no-fund` in the restored tree | **exit 0**, added 664 packages in 6 s (more than the 530 at HEAD `c45be9b` because the checkpoint carries the new workspaces); only deprecation and EBADENGINE warnings | 11:46:11Z to 11:46:18Z |
| `npm run typecheck` in the restored tree | **exit 0**, 0 errors, about 3 s | 11:46:18Z to 11:46:21Z |
| Wall time | 105 s from the clone to the end of typecheck (including the base-mismatch detour and the re-checkout); tool time: apply 5 s, second apply about 2 s, `npm ci` 7 s, typecheck 3 s | 11:44:36Z to 11:46:21Z |

Exclusion audit (my own rules, not the tool's `classifyPath`; applied to the manifest, the whole pack directory, the 53 `diff --git` headers of `unstaged.patch`, and the restored tree):

| Excluded class | Evidence |
|---|---|
| `.env` and other env files | none in the manifest (888 paths), pack (364 paths), patch headers or restored tree (888 paths excluding `.git`). `.env.example` is committed and carries names; its 11 non-empty values are non-secret defaults (database names, tenant/env/scope ids, a loopback URL, a localhost origin, `OWNER_ID=owner`, provider name `openai`). No root `.env` exists at all (`envRedaction.valueCount` 0) |
| Credentials (`.pem .key .p12 .pfx .jks`, `id_*`, `.npmrc .netrc`, `credentials.json`/`auth.json`) | 0 hits in all four path sets |
| Private manifests and held-out/sealed data | 0 hits by name in manifest, pack, patch headers and restored tree except `docs/continuity/SEALED-PATHS.json`, the registry itself (the tool exempts it on purpose; content is `{"paths": [], "sha256": [], note}`, no sealed material); the restored tree contains no file named like a private/held-out/sealed data file |
| Databases and raw telemetry | 0 hits (`*.sqlite* *.db *.mdb *.wt *.bson`, `mongod.lock`, `WiredTiger*`, `dump`, telemetry-named `.ndjson/.jsonl`) |
| `node_modules`, `.git`, `.expunge`, `dist`, `coverage` and other excluded dirs | live tree has `.git/`, `.expunge/` and 8 `node_modules/` directories (root, `apps/operator`, `apps/worker`, and five `packages/*`); manifest paths under any of them: 0. The restored tree had no `node_modules` before `npm ci`, and no `.expunge` or `HANDOFF.md` (see finding 1) |
| Ignored artifacts | the live tree holds `.DS_Store` and `research/.DS_Store`; neither is in the manifest, so the exclusion is observed, not merely the absence of such files |
| Briefing | `briefing/HANDOFF.md` (4275 bytes) and `manifest.json` pass the strict 7-group secret scan with 0 hits |
| Whole-pack strict scan | the 7-group scan over every pack file (patches, briefing, 360 copies; 183 text, 116 source, 44 PNG, others) found 5 groups with hits, all reviewed line by line and none a credential: template strings in `research/mongodb-new/*.md` (`${password}`, `{username}`, `user:pass@host`), canary or dummy fixture values in `tests/reliability/wake-endpoint.test.ts`, `apps/operator/tests/expunge-fixture.test.ts`, `packages/observer/test/mcp.test.ts`, `packages/observability/test/ingest.test.ts`, the PEM regex inside the tool's own scanner, and the grep patterns quoted in my own earlier section that the patch carries. The tool's own scan reported 0 findings over 360 exported files; it is pattern based by its own limitations note |

Findings for `verifier` (owner of `scripts/continuity/`); nothing here lost or altered a byte, and no restore defect that endangers data was found:
1. **Usability gap after a restore (low).** The restore writes the patched files and the untracked copies only. The restored tree has no `HANDOFF.md` (it is gitignored, and the pack carries it only as `briefing/HANDOFF.md`) and no `.expunge/checkpoints/` (so no `LATEST` and no pack). A fresh agent in the restored tree that follows `CLAUDE.md` will report "no prior checkpoint exists", and `npm run checkpoint:verify -- latest` there fails with `verify failed: no LATEST pointer under <target>/.expunge/checkpoints` (exit 2). Everything works when the pack is addressed by its full path, as above. Suggested fix: after a successful `--apply`, copy `briefing/HANDOFF.md` to the target root when it is absent and print the pack path to use, or state in the usage text and in `docs/continuity` that the pack must travel with the repository and be addressed by path.
2. **`--json` through npm (cosmetic).** `npm run checkpoint:restore -- ... --json` and `npm run checkpoint:verify -- ... --json` print npm's three-line header on stdout before the JSON, so a JSON consumer must strip up to the first `{` (I did) or call `node scripts/continuity/<tool>.mjs` directly.
3. **LATEST lags HEAD (state, not a tool defect).** Throughout the drill LATEST was the pre-commit checkpoint at base `c45be9b` while HEAD was already `f17fd61`, `a104f90` and `109e2dc`. Restoring LATEST onto a clone of current HEAD is correctly refused (exit 4, nothing written, observed), so a transferred workspace needs a post-commit checkpoint (spec section 20 checkpoint transaction, step 7) before it can be restored to the current commit.
4. **Not run:** restoring onto the live tree (forbidden), the writer-lock refusal (exit 7), the stale-checkpoint refusal (exit 6) and the interrupted-snapshot case; the tool's own 35 node tests cover those synthetic cases per the earlier V-1a section and I did not repeat them.

### Packet: rsi-evolution / C2-3 (PKT-19: in-sample vs held-out replay, attributed standing)

Paths (16, all modified, none untracked or deleted; `git status --porcelain -uall -- packages/evolution packages/harness-compiler` lists exactly these, +796/-64): `packages/evolution/{README.md, scripts/c2-evidence.ts, src/{critic,evidence,index,propose,replay,search}.ts, test/{helpers,propose.test,replay.test,search.test}.ts}` and `packages/harness-compiler/{README.md, src/compile.ts, test/compile.test.ts, test/rejection-catalog.ts}`. Checkpoint **`20261011T115126Z-80a59605`** (`complete=true`, base `ecfbb5c`, taken 11:51:26Z). HEAD moved three times while I worked (`ba41d7b`, `d0c2c53`, `e4f6b51`); the working-tree matrix ran on `ecfbb5c`, the scratch-export gate was run on `ba41d7b` and again on the current HEAD `e4f6b516e70bee208fa2621e7aa6c6a2e0fb8377` (the table gives the latter). No lock change in the packet.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo, working tree | `npm run typecheck` | 0 | 0 errors; no `worldkey-brand.test.ts` errors appeared at this time | 11:51:38Z |
| Lint | `npx eslint packages/evolution packages/harness-compiler`, and on the 11 `.ts` packet files alone | 0 and 0 | 0 errors, 0 warnings | 11:51:41Z |
| Format | `npx prettier --check packages/evolution packages/harness-compiler`, and on the 11 `.ts` packet files alone | 0 and 0 | all formatted (the two READMEs are not checked: `.prettierignore` has `*.md`) | 11:51:43Z |
| Fast lane | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI -u MONGODB_PARITY_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run packages/evolution packages/harness-compiler` | 0 | 9 files passed + 1 skipped; **184 passed / 0 failed / 2 skipped** (186), matches the owner; the 2 skips are `live-parity.test.ts` | 11:51:44Z |
| C2 evidence script | `npx tsx packages/evolution/scripts/c2-evidence.ts` | 0 | prints `rejection log: 61/61 categories rejected with the expected code` (928 output lines), matches the owner | 11:51:45Z |
| Script negative control (scratch export only) | appended a line to the scratch `rejection-catalog.ts` making category 0 produce category 1's rejection, then ran the script | **1** | printed `60/61 categories rejected with the expected code`; after restoring the file (sha256 equal to the working tree) it printed 61/61 and exited 0. So the script counts a category only when `rejection.codes` contains that category's own code and exits 1 otherwise | 11:53Z |
| Other packages | `npx vitest run packages/baselines packages/gate packages/contracts` | 0 | 4 files, **71 passed**, matches the owner. Caution: `packages/gate` is untracked at HEAD (in rsi-evolution's separate lane); in the HEAD+packet scratch export the same command runs 2 files and 28 passed (baselines + contracts), so the 71 is a working-tree number | 11:51:46Z |
| **Live parity lane (the owner did not run it)** | `EXPUNGE_REQUIRE_LIVE_TESTS=1 MONGODB_PARITY_URI=mongodb://127.0.0.1:27218/?replicaSet=expunge-local&directConnection=true npx vitest run packages/harness-compiler` | 0 | **136 passed / 0 failed / 0 skipped (6 files)**. The expected 135 is one short of this because the packet adds exactly one test to `compile.test.ts` ("the evidence catalog binds every identifier to its job and run"); C2-2 recorded 135 before it. Also 136/136 in the scratch export on HEAD+packet | 11:51:51Z |
| Scratch export: build | `git archive e4f6b51 \| tar -x`, the 16 packet files copied over it | 0 | `diff -rq` against a pure HEAD export shows exactly the 16 packet files differ | 11:54:34Z |
| Scratch export: install | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 660 packages | 11:54:40Z |
| Scratch export: typecheck | `npm run typecheck` | **0** | 0 errors (also 0 on a pure HEAD export, and on `ba41d7b` + packet earlier) | 11:54:53Z |
| Scratch export: lanes | fast lane, c2 script, live parity lane, as above | 0, 0, 0 | 184 passed / 2 skipped; 61/61; 136/136 | 11:54:57Z |
| Secret scan, strict | same 7-group scan as PKT-12 over the 16 files | 0 | 0 hits | 11:53:34Z |
| Hash check, packet paths | `verify-checkpoint <full pack path> --json`, filtered to the packet | 0 for the packet | **MATCH=16, CHANGED=0, MISSING=0**. Whole checkpoint: pack MATCH=279 CHANGED=0 MISSING=0; worktree MATCH=878 CHANGED=19 MISSING=0, all outside the packet (`COMMIT-LEDGER.md`, `docs/MONGO.md`, `docs/continuity/{PROJECT-STATE.md,TASKS.json}`, `apps/operator/{src/client/expunge/hooks/useGraph.ts,src/shared/expunge.ts}`, `packages/domain/src/tools/report-diagnostic.ts`, `packages/gate/{src/{admission,campaign,gate,index,report}.ts,test/{admission-catalog,campaign.test,helpers}.ts}`, `packages/governance/test/ledger.integration.test.ts`, `packages/mongo/test/{authority,hardening}.integration.test.ts`, `tests/reliability/e1-worker-faults.live.test.ts`) | 11:53:40Z |

Content checks, each confirmed in `git diff HEAD`:

| Claim | Where | Verdict |
|---|---|---|
| Replay splits rows by run into in-sample and held-out, separate fix counts, no aggregate `fixes` | `replay.ts`: a row is `in_sample` when its `runId` is in `scope.incidentRuns`, otherwise `held_out`; `ReplayReport` has `inSampleFixes`, `heldOutFixes`, `inSample` and `heldOut` (`SampleCounts` with rows, flips, fixes, regressions, knownAuthorityFlips) and the old `fixes` array is removed (`grep` of the type shows no aggregate); typecheck confirms no consumer still reads it | CONFIRMED |
| `replayCandidate` requires a scope; `ReplayScopeMissing` | `scope: ReplayScope` is a required parameter; an empty `incidentRuns` throws `ReplayScopeMissing`; exported from `index.ts`; test "refuses to replay without naming the incident run" | CONFIRMED. Note: the throw is for an empty list; a JS caller omitting `scope` entirely would get a `TypeError`, which TypeScript prevents |
| `ProposalRecord.evidenceLevel` in {`out_of_sample_fix`, `in_sample_only`, `no_replay_signal`} | `propose.ts` `EvidenceLevel` and `evidenceLevelOf`: held-out fix with no regression gives `out_of_sample_fix`; else in-sample fixes give `in_sample_only`; else `no_replay_signal`; set on every record that ran a replay | CONFIRMED |
| Search ranks by held-out fixes minus twice the regressions; stops `good_candidate` only on a held-out fix with no regression | `search.ts`: `score = heldOutFixes.length - 2 * regressions.length`; `isGoodCandidate` requires `compiled`, `evidenceLevelOf === out_of_sample_fix` and, when guardrails were edited, `attributedFlips > 0`; ties break on attributed flips, then fewer patches, then lower authority class; `RoundResult.selectionBasis` is `held_out`, `in_sample_only` or `none`. Tests: "does not stop on, or rank by, fixes that are only on the incident's own run" and "a candidate with fewer in-sample fixes but a held-out fix wins" | CONFIRMED (the stop condition is slightly stricter than stated: it also needs an attributed flip for guardrail edits) |
| Evidence catalog entries carry `evidenceId`, `jobId`, `runId`; flips attributed only through cited evidence bound to the row's job and run | `compile.ts`: `EvidenceCatalogEntry` gains the three fields from `bundle.evidenceId` and `bundle.binding`; `replay.ts` `attributingEvidence` keeps a cited id only when `entry.jobId === row.jobId && entry.runId === row.runId`; a flip's citations come from the changed rule that fired, or the candidate's patch citations when none did (loosening by removal); the new compile test checks both bundles' ids | CONFIRMED |
| A trace-informed guardrail edit with zero attributed flips is `replay_rejected` (`no_attributed_effect`) | `propose.ts`: arm `trace_informed`, `attribution.applicable` and `attributedFlips === 0`; the control arms are not rejected but reported with their attributed and unattributed counts | CONFIRMED, with negative tests ("a trace-informed rule whose cited evidence is not about the rows it flips earns no standing", "a rule citing an unrelated incident earns no attribution however many rows it flips") |
| Script counts a category only with its own code, exits 1 otherwise | see the negative control above; `c2-evidence.ts` uses `rejection.codes.includes(code)` and `process.exit(1)` when `exact !== REJECTION_CODES.length` | CONFIRMED |
| README states the fake-arm caveat | `packages/evolution/README.md` and the script header both say the fake's separation of the three arms is constructed by keyword rules, demonstrates the plumbing only, and that transfer to a real model is untested until credentials exist | CONFIRMED |
| Critic standing | `pruneRules`/`retestAccumulated` take an optional evidence catalog; with it, standing is attributed and the prune reason is `no_attributed_standing` (not in the owner's list, noted) | PRESENT, tested |

**COMPILER_HASH.** Measured by importing it, not copied from a message: pure HEAD `0b9d4cfa44e97f9f6188fe48f7581f33d9d5f8b25d82dcf8a611a93fc95afa16`; HEAD + the packet (and the working tree) `484cb134aa907ebf82d0f2aa8f26b60753c5b9c8c22c42ea11aa3838b7810ef0`; `VOCABULARY_HASH` unchanged (`83fd336f...`). It changes because `compile.ts` is one of the 18 modules `hashes.ts` commits to. A repo-wide grep (excluding `node_modules`, `.expunge`, `.git`, `dist`; text files only) for the old prefix `0b9d4cfa` finds **no file** pinning it, and the new prefix `484cb134` appears nowhere either: no file pins any literal compiler hash. Every consumer (`harness-compiler` tests, `evolution`, `gate`, `governance` tests) imports `COMPILER_HASH`, and `compile.test.ts` recomputes it from the source bytes. Anything persisted outside the repo (a stored artifact, a Mongo row) that recorded the old value would be refused by the compiler; none is in the tree.

Observations, none blocking: (1) `ReplayScopeMissing` fires on an empty `incidentRuns`, not on an omitted scope (the type system covers that). (2) The fallback attribution for a loosening by removal uses all of the candidate's cited ids, so a candidate that cites many incidents can attribute a removal flip to any one of them bound to the row's run; this is the documented intent but is the loosest part of the attribution rule. (3) While computing the hash on the working tree I briefly wrote and removed a one-line helper `.printhash-v2.mts` in the repository root (about two seconds); no checkpoint or hash check saw it, and the tree has no such file now.

### HEAD proofs (continued)

Same procedure as the first row (`git archive <hash> | tar -x` into a fresh directory with nothing overlaid, `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, default `npx vitest run` with no `MONGODB_*` or `EXPUNGE_REQUIRE_LIVE_TESTS`). Rows are appended here because my section is append-only; read them together with the first HEAD proofs table above.

| Date (UTC) | HEAD | npm ci | tsc | vitest default lane | Advisory baseline: `npm audit --omit=dev --json`, `.metadata.vulnerabilities` | Notes |
|---|---|---|---|---|---|---|
| 2026-10-11 11:54:18Z | `e4f6b516e70bee208fa2621e7aa6c6a2e0fb8377` (= origin/main; PKT-14 code `ba41d7b`, ledger `d0c2c53`, correction `e4f6b51`) | exit 0 (660 packages, 4 s) | exit 0 (0 errors) | exit 0: **620 passed / 0 failed / 272 skipped** (892 total; 65 files: 49 passed, 16 skipped) | audit exit 1 (advisories exist): low 0, moderate 33, **high 5**, critical 0, **total 38** (dependencies: prod 557, dev 169, optional 79, peer 26, total 747) | The 272 skips are live-service suites that need URIs. High advisories: `@fastify/busboy` (DoS), `@opentelemetry/propagator-jaeger` (DoS), `@opentelemetry/sdk-trace-node`, `langsmith` (untrusted manifest deserialization), plus `undici` (WebSocket DoS and decompression issues, several rated high or moderate). Direct dependencies affected: `raindrop-ai` and `@opentelemetry/otlp-transformer`, both introduced with the new `observability`/`observer` workspaces; the rest is transitive. Previous root baseline (verifier, 10:17Z, before PKT-14): 7 advisories, 0 critical, 2 high, 5 moderate. No upgrade was performed. |

### Packet: mongodb-authority / PKT-15 (DA-5a G3 versions and partial batches, G5 writeField session, G6-part stored row, `JobRepository.worldKey`, PKT-12 observations)

Paths (10, all modified; `git status --porcelain -uall -- packages/mongo docs/MONGO.md` lists exactly these, +372/-81): `docs/MONGO.md`, `packages/mongo/src/{decisions,effects,index,jobs,scope}.ts`, `packages/mongo/test/{authority.integration,hardening.integration,scope.integration}.test.ts`, `packages/mongo/test/support.ts`. Checkpoint **`20261011T115539Z-5bf111d3`** (`complete=true`, base `e4f6b51`, taken 11:55:39Z). The scratch-export gate ran on HEAD **`56b1de5003d466ccbd0dd4ce7a34273003b7260a`** plus the 10 files (HEAD moved from `e4f6b51` while I worked). My replica set 127.0.0.1:27218, RBAC set 127.0.0.1:27019 (documented local-only credential, not repeated). `tests/reliability/worldkey-brand.test.ts` (untracked, verifier-owned) is not part of the packet and is reported on its own line.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo, **working tree** | `npm run typecheck` | **2** | outside the packet and not caused by it: 11 errors at 11:56:32Z, all in `packages/observer/src/outbox-dispatcher.ts` (committed, unmodified; property `model`/`convoId` missing on a union type), triggered by uncommitted edits to `packages/contracts/src/{index,projection}.ts`; at 12:00:44Z the same command gives 5 errors, all in `packages/observer/test/bundle.test.ts` (another lane mid-edit). No error under `packages/mongo`, `packages/governance` or `tests/reliability` | 11:56:32Z, 12:00:44Z |
| Lint | `npx eslint packages/mongo`, and on the 9 `.ts` packet files alone | 0 and 0 | 0 errors | 11:56:35Z |
| Format | `npx prettier --check packages/mongo` | 0 | all formatted (`docs/MONGO.md` is not checked: `.prettierignore` has `*.md`) | 11:56:37Z |
| Fast lane, working tree | `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI -u MONGODB_PARITY_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run packages/contracts packages/mongo packages/governance tests/reliability/worldkey-brand.test.ts` | 0 | 17 files (6 passed, 11 skipped); **96 passed / 0 failed / 252 skipped** (348). The owner's 92 excludes the 4 `worldkey-brand` tests; 96 - 4 = 92, 252 skips as claimed | 11:56:38Z |
| Live lane, working tree | `EXPUNGE_REQUIRE_LIVE_TESTS=1 MONGODB_TEST_URI=<27218> MONGODB_RBAC_TEST_URI=<27019> npx vitest run packages/contracts packages/mongo packages/governance tests/reliability/worldkey-brand.test.ts` | 0 | **17 files, 348 passed, 0 failed, 0 skipped**, matches the owner | 11:56:40Z |
| `worldkey-brand.test.ts` alone | `npx vitest run tests/reliability/worldkey-brand.test.ts` (working tree) | 0 | 1 file, 4 passed. Not in the packet, not in the scratch export | 11:57:01Z |
| Secret scan, strict | 7-group scan over the 10 files | 0 | 0 hits | 12:00:30Z |
| **Scratch gate: build** | `git archive 56b1de5 \| tar -x`, the 10 packet files copied over it | 0 | `diff -rq` against a pure HEAD export shows exactly the 10 packet files differ | 11:57:27Z |
| Scratch gate: install | `npm ci --ignore-scripts --no-audit --no-fund` | 0 | 660 packages | 11:57:33Z |
| **Scratch gate: typecheck** | `npm run typecheck` | **0** | 0 errors. `worldKeyOf` / `worldKeyFromStoredBinding` are mentioned only inside `packages/mongo/src/{index,jobs,worldkey,worlds}.ts`; no committed file outside the package imports them, and `packages/mongo/package.json` has a single `exports` entry (`./src/index.ts`), so a deep import is not possible either | 11:57:40Z |
| Scratch: fast lane | `... npx vitest run packages/contracts packages/mongo packages/governance` (no URIs) | 0 | 16 files (5 passed, 11 skipped); 85 passed / 0 failed / 250 skipped (335) | 11:57:45Z |
| Scratch: live lane (strict) | same paths, `EXPUNGE_REQUIRE_LIVE_TESTS=1`, my 27218 set and the 27019 RBAC set | 0 | **16 files, 335 passed, 0 failed, 0 skipped**. Against the PKT-12 live total of 329 this is +6 = the packet's six new tests. The working-tree 348 differs by exactly 13: the 4 `worldkey-brand` tests and 9 governance tests from uncommitted governance edits (`governance.test` 23 vs 16, `ledger.integration` 4 vs 2) | 11:57:50Z |
| Scratch: behavior-change sweep | `MONGODB_TEST_URI=<27218> npx vitest run apps/worker packages/runtime` (no require flag, because `apps/worker/test/live-provider` needs a provider key) | 0 | 12 files, 123 passed / 0 failed / 1 skipped (the optional live-provider case). No committed caller of `commitEffect` that builds intents without versions fails | 11:58:10Z |
| Scratch: whole repo default lane with the replica set | `MONGODB_TEST_URI=<27218> npx vitest run` | 0 | 65 files (61 passed, 4 skipped), **826 passed / 0 failed / 72 skipped** (898) | 11:58:35Z |
| Hash check, packet paths | `verify-checkpoint <full pack path> --json`, filtered to the packet | 0 for the packet | **MATCH=10, CHANGED=0, MISSING=0**. Whole checkpoint: pack MATCH=294 CHANGED=0 MISSING=0; worktree MATCH=881 CHANGED=31 MISSING=0 at 12:00:37Z, all outside the packet (operator client files, `apps/worker/test/telemetry.test.ts`, `package-lock.json`, `packages/{deployment,domain,gate,observability,observer}` files, `scripts/continuity/{lib.mjs,test/secrets.test.mjs}`, `COMMIT-LEDGER.md`, `PRODUCTION-READINESS.md`, `VERIFICATION.md`) | 12:00:37Z |

Content checks against `git diff HEAD`:

| Claim | Where | Verdict |
|---|---|---|
| `commitEffect` requires `expectedDocumentVersions` naming exactly the intent's targets, `VersionBindingMismatch` before any query | `effects.ts` `assertVersionBinding`: unique targets, unique bound addresses, equal length, every bound address is a target, every version a safe integer >= 0. It runs after the pure `assertDerivedIdentity` and before `this.replay(...)` and the transaction, so nothing is read first | CONFIRMED. Test: missing, extra-record, repeated, negative and empty versions, each refused, 0 effects |
| Re-reads each target's `_rev` inside the transaction; `StaleDocumentVersion`; a missing target is stale | in the transaction, after `fence`, `authority.fence`, `decisions.verify`, `validate` and `assertRunnable`, before `worlds.advance` and `apply`: `findOne` on the world collection with the world filter and `projection {_rev}`; `!current \|\| current._rev !== expected.version` fails | CONFIRMED. Tests: target bumped by one revision (apply never ran, 0 effects) and target deleted |
| `PartialEffect` commits nothing (no effect, receipt or intent row, counter unchanged) | `appliedEffects.length < targetAddresses.length` fails inside the transaction, so it aborts as a whole, including whatever `apply` already wrote | CONFIRMED. The packet's test asserts no effect row, no receipt, record `A` still present and the world counter at 0; it does not assert the intent row, so I checked it myself with a scratch-only probe that added the assertion on `action_intents` (count 0, test passes) |
| `requirePrincipal` first in `complete()` and `completeIncomplete()` | `effects.ts`: both public methods start with `requirePrincipal(this.service, ['domain_executor', 'setup'])` before the verdict check | CONFIRMED in code; **no test in the packet pins it** (see finding 1) |
| `ReceiptCoverageIncomplete` as its own code | `assertReceiptCoversRegistry` now fails with it; the three coverage assertions in `hardening.integration.test.ts` were renamed; `IncompleteReceipt` stays the `complete()` verdict refusal | CONFIRMED |
| `writeField` requires a session (`EffectTransactionRequired`) | `scope.ts`: `session` is a required parameter and a runtime `if (!session) fail(...)`; every `writeField` call in the tests now runs inside `scopes.service.transaction` | CONFIRMED. Test G5 calls it through a cast with no session and checks the field is unchanged |
| `DecisionRepository.record` returns the stored row on a duplicate | `decisions.ts`: on error 11000 reads the stored row and returns it without `_id`; test G6 records twice with different inputs and gets the first inputs and digest back, one ledger row | CONFIRMED |
| `JobRepository.worldKey` reads the stored job through `readAuthorized` and mints the key | `jobs.ts`: `worldKeyOf(await this.readAuthorized(actor, jobId, session))`; scope test derives the key, checks `isWorldKey`, a copy fails `isWorldKey`, another scope's actor is refused and an unknown job gives `JobNotFound` | CONFIRMED |
| `index.ts` exports only `isWorldKey`, `assertWorldKey` and the `WorldKey` type from `worldkey.ts` | `export { isWorldKey, assertWorldKey, type WorldKey } from './worldkey.js'` replaces `export *`; scratch typecheck 0 proves no committed importer of the removed names | CONFIRMED |
| New tests: G3 x4, G5 x1, G6 x1, worldKey-from-stored-job | `hardening.integration`: 4 G3 + 1 G5; `authority.integration`: 1 G6; `scope.integration`: the existing key-derivation test now uses `jobs.worldKey` plus two new refusals; `support.ts` `intent()` now builds versions (default 1) from the targets; PKT-12 test renamed to "wiring" with an honest comment | CONFIRMED (+6 tests, matches the 329 to 335 move) |
| `docs/MONGO.md` | new bullets on versions, session, world key, receipt codes, decision rows and the approval-gate limitation; the limitation is accurate: `packages/governance/src/facts.ts` resolves `approval_grant` to `null` | CONFIRMED |

Mutation controls (scratch export only, each reverted and byte-compared with the working tree afterwards): with the guard removed, the new tests fail as they should.

| Mutation | Result |
|---|---|
| Delete the `_rev` comparison (`StaleDocumentVersion`) | 2 failed (moved target, deleted target) |
| Delete the `PartialEffect` check | 1 failed |
| Delete `assertVersionBinding(intent)` | 1 failed |
| Delete the `writeField` session guard | 1 failed (G5) |
| Make `DecisionRepository.record` return the caller's record on a duplicate | 1 failed (G6) |
| **Delete `requirePrincipal` from `complete()`** | **0 failed: the mutant survives the whole mongo and governance suites.** A scratch probe test (non-executor `observer` service calling `complete` with an incomplete-verdict receipt and `completeIncomplete` with a complete-verdict receipt, expecting `PrincipalBoundary`) passes with the packet and fails with the guard removed (`got 'IncompleteReceipt'`) |

Findings:
1. **Test gap (low).** Nothing in the packet pins `requirePrincipal`-first in `complete()` and `completeIncomplete()` (the PKT-12 observation 1 fix). The probe above is a ready-made test for `hardening.integration.test.ts`: `new EffectRepository(await env.as('observer'))`, then `complete(actor, lease, completionReceipt(id, { domainStatus: 'incomplete', operationalResiduals: 2 }))` and `completeIncomplete(actor, lease, completionReceipt(id))` both `rejects.toThrow('PrincipalBoundary')`.
2. **A committed devils-advocate repro became vacuous (for `docs/review/` owner, outside the packet).** `docs/review/repro/mg-live.repro.ts` L7 ("same logical batch under two tool-call ids commits twice") has `apply` return `[]` for a one-target intent. At HEAD it exercises the real idempotency path; with the packet it prints `NOT REPRODUCED (refused: PartialEffect)`, so it no longer tests what it claims (the packet fixed its own copy of this pattern in `hardening.integration.test.ts` by returning a real effect). L2 now reports `ReceiptCoverageIncomplete` instead of `IncompleteReceipt`, which is the intended rename. The other ten checks are unchanged. I ran it against my replica set in both scratch exports (exit 1 = nothing reproduced, both).
3. **Observation: versions are enforced but not part of the effect identity.** `deriveArgsDigest` does not include `expectedDocumentVersions`, so two intents that differ only in versions share an effect key and a decision id; a replay of an already committed effect returns the stored receipt without re-checking versions (intended idempotence). The versions are recorded through `intentHash` and the stored `action_intents` row.
4. **Observation: the in-transaction comment is true when `apply` writes each target.** MongoDB snapshot isolation does not validate a read at commit; the "cannot go stale" guarantee comes from the later write to the same document conflicting with a concurrent writer. `PartialEffect` forces one reported effect per target, but whether `apply` actually wrote the document is the caller's behavior (the gateway's `applyEffect` path does).
5. The working-tree typecheck failure above is in another lane's files; the gate that matters for this packet (HEAD + 10 files) is 0.

### HEAD proofs (continued, row 3)

Same procedure as rows 1 and 2 (fresh `git archive` export, nothing overlaid, `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, default `npx vitest run` with no `MONGODB_*` variables, then `npm audit --omit=dev --json`).

| Date (UTC) | HEAD | npm ci | tsc | vitest default lane | Advisory baseline (`.metadata.vulnerabilities`) | Notes |
|---|---|---|---|---|---|---|
| 2026-10-11 12:06:57Z | `d9b42b2ab03782b96dfc4c59e14c500255536b44` (= origin/main; PKT-19 `83980b9`, PKT-15 `96f7b89`, ledger `d9b42b2`) | exit 0 (660 packages, 5 s) | exit 0 (0 errors) | exit 0: **638 passed / 0 failed / 278 skipped** (916 total; 65 files: 49 passed, 16 skipped) | audit exit 1: low 0, moderate 33, **high 5**, critical 0, **total 38** (unchanged from row 2) | Against row 2 (`e4f6b51`): +18 passed, +6 skipped, same 65 files. The +6 skips are the six new PKT-15 live tests (they need a replica set; with one they pass, see the PKT-15 packet row); the +18 passes are PKT-19's new `evolution` and `harness-compiler` tests. The lockfile did not change between the two HEADs, so the advisory counts are identical. |

### Packet: runtime-raindrop / C1c (PKT-21: leak guard, quarantine, delivery labels, propagator pin, wrong-incident control)

**Manifest.** The message said "24 files (17 modified, 7 new)"; the paths it names are 28: 20 modified and 8 new, and `git status --porcelain -uall -- packages/observability packages/observer packages/contracts` lists exactly those 28 (the counts in the message were a miscount, the list is right). Modified: `packages/contracts/src/{index,projection}.ts`; `packages/observability/{package.json, src/{carrier,episode,index,outbox,sanitize,tracing}.ts, test/{episode,provider-spans}.test.ts}`; `packages/observer/{src/{bundle,evidence,outbox-dispatcher,scan}.ts, test/{bundle,helpers,mongo.integration,outbox-dispatcher,raindrop-live}.test.ts}`. New: `packages/observability/{README.md, src/leak.ts, test/{leak,propagator,unsafe-paths}.test.ts}`, `packages/observer/test/{c1c,raindrop-contract-probe}.test.ts`, `packages/contracts/test/evidence-additions.test.ts`. Not in the packet and untouched by my export: `apps/worker`, `packages/runtime`, `packages/vendor-openmuse` (held C1b), and `package-lock.json` (see check g). Checkpoint **`20261011T120747Z-1bd65026`** (`complete=true`, base `d9b42b2`, taken 12:07:47Z). The scratch gate ran on `d9b42b2` (12:08:51Z) and again on the then-current HEAD `e2e1db1da4ccb6e9001e10a01808b157ad84b294` (12:14:08Z); results were identical.

| Check | Command | Exit | Result | Timestamp (UTC) |
|---|---|---|---|---|
| Typecheck, whole repo, working tree | `npm run typecheck` | 0 | 0 errors (the earlier observer errors from other lanes are gone) | 12:09:50Z |
| Lint | `npx eslint packages/contracts packages/observability packages/observer` | 0 | **0 errors, 29 warnings**, all `no-explicit-any` in test files (`unsafe-paths.test.ts` 12, `c1c.test.ts` 5, `fake-raindrop.ts` 4, `episode.test.ts` 3, `provider-spans.test.ts` 2, `sanitize.test.ts` 2, `outbox-dispatcher.test.ts` 1). The owner said 39; I measure 29 on these three packages | 12:09:54Z |
| Format | `npx prettier --check` on the three packages | 0 | all formatted (`README.md` is not checked: `.prettierignore` has `*.md`) | 12:09:55Z |
| Default lane, no URI | `env -u MONGODB_TEST_URI -u ... npx vitest run packages/contracts packages/observability packages/observer` | 0 | 18 files (15 passed, 3 skipped); **184 passed / 0 failed / 16 skipped**, matches the owner | 12:09:56Z |
| Lane with my replica set | `MONGODB_TEST_URI=<27218> npx vitest run` same three packages | 0 | 18 files (16 passed, 2 skipped); **198 passed / 0 failed / 2 skipped** (the live smoke and the contract probe), matches the owner | 12:10:05Z |
| Observer mongo integration under the flag | `EXPUNGE_REQUIRE_LIVE_TESTS=1 MONGODB_TEST_URI=<27218> npx vitest run packages/observer/test/mongo.integration.test.ts` | 0 | **14 passed** (includes the new O2 test) | 12:10:16Z |
| Live smoke and contract probe under the flag, no keys | `EXPUNGE_REQUIRE_LIVE_TESTS=1 npx vitest run packages/observer/test/raindrop-live.test.ts packages/observer/test/raindrop-contract-probe.test.ts` (`RAINDROP_*` unset) | **1** | both fail naming exactly `RAINDROP_API_KEY, RAINDROP_QUERY_API_KEY, RAINDROP_PROJECT_ID`; **BLOCKED on the human, not faked** | 12:10:19Z |
| Wider regression, working tree | `MONGODB_TEST_URI=<27218> npx vitest run packages/contracts packages/observability packages/observer packages/runtime packages/vendor-openmuse apps/worker packages/mongo` | 0 | 49 files (45 passed, 4 skipped); **619 passed / 0 failed / 71 skipped** (owner 618 / 71; the extra pass is other lanes' uncommitted work in `apps/worker`/`runtime`) | 12:10:20Z |
| Propagator test alone | `env -u OTEL_PROPAGATORS npx vitest run packages/observability/test/propagator.test.ts` | 0 | 3 passed; the caller's `OTEL_PROPAGATORS` is restored by `initTracing` (the second test asserts it is still `jaeger` after construction) | 12:10:58Z |
| Operator contract parity (check f) | `cd apps/operator && npx vitest run tests/expunge-contract-parity.test.ts tests/expunge-projection-schema.test.ts` | 0 | 2 files, **16 passed**: the operator's mirrored contract and strict projection schema still agree with the contracts package that now has the optional `delivery` | 12:10:59Z |
| Secret scan, strict | 7-group scan over the 28 files (28 files passed to it) | 0 | 0 hits | 12:13:30Z |
| **Scratch export: build** | `git archive e2e1db1 \| tar -x`, the 28 files copied over it | 0 | `diff -rq` against a pure HEAD export: exactly the 28 packet files differ | 12:14:08Z |
| **Scratch export: lock regenerated (check g)** | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | 0 | **748 entries before and after; added none, removed none; exactly one changed entry**: the workspace entry `packages/observability` gains `"@opentelemetry/core": "1.30.1"` in `dependencies` (a one-line diff). `node_modules/@opentelemetry/core` is already locked at 1.30.1 (the SDK's hoisted copy), so no new third-party package. Not in the manifest, so the steward must regenerate it. `npm ci --dry-run` with the old HEAD lock and the new manifest also exits 0 (the hoisted 1.30.1 satisfies the range), so the commit would install either way, but it would leave the lock's workspace entry stale and `npm install` would rewrite it | 12:14:12Z |
| Scratch export: install | `npm ci --ignore-scripts --no-audit --no-fund` (regenerated lock) | 0 | 660 packages (same as HEAD) | 12:14:18Z |
| **Scratch export: typecheck** | `npm run typecheck` | **0** | 0 errors; no committed file outside the three packages uses a changed signature (`ObserverRunner`/`OutboxDispatcher` now require `guard`, `observeEvent` takes an options object, `assembleEvidenceBundle` takes `guard`, `HELD_OUT_KEYS` is gone and `assertNoLeak` takes a guard) | 12:14:24Z |
| Scratch export: default lane | same three packages, no URI | 0 | 184 passed / 16 skipped | 12:14:30Z |
| Scratch export: replica-set lane | same with `MONGODB_TEST_URI=<27218>` | 0 | 198 passed / 2 skipped | 12:14:40Z |
| Scratch export: observer mongo integration, flag | as above | 0 | 14 passed | 12:14:50Z |
| Scratch export: wider regression, committed code only | `MONGODB_TEST_URI=<27218> npx vitest run` over contracts, observability, observer, runtime, vendor-openmuse, mongo, governance, evolution, harness-compiler | 0 | 54 files (50 passed, 4 skipped); 744 passed / 0 failed / 72 skipped | 12:15:00Z |
| Hash check, packet paths | `verify-checkpoint <full pack path> --json`, filtered to the packet | 0 for the packet | **MATCH=28, CHANGED=0, MISSING=0**. Whole checkpoint: pack MATCH=345 CHANGED=0 MISSING=0; worktree MATCH=924 CHANGED=44 MISSING=1 at 12:13:59Z, all outside the packet (operator S2 files, `packages/domain/*`, docs, `.prettierignore`, ledgers) | 12:13:59Z |

Content checks:

| Item | Finding |
|---|---|
| Contracts diff is additive only | Confirmed by reading it: new optional `EvidenceReference.delivery?`, optional `EvidenceBundle.withheld?`, new interface `EvidenceDelivery`, optional `EvidenceReadyPayload.delivery?` with a strict, optional zod object, and new pure exports `PRIVATE_ID_DOMAIN`, `privateIdHash`, `bundlesDisjoint`, `selectWrongIncident` (plus a private helper). Nothing removed, no existing type or schema narrowed, no semantic change. There is no strict zod validator for `EvidenceBundle` or `EvidenceReference` anywhere in the repo, so the optional fields cannot be rejected by one |
| (a) Propagator test | `propagator.test.ts` runs the REAL `raindrop-ai` SDK through `initTracing` (no mock of the SDK; `FakeRaindrop` is only the HTTP endpoint) with `OTEL_PROPAGATORS=jaeger` set in `beforeAll`, asserts `propagation.fields()` sorted equals `[baggage, traceparent, tracestate]` and contains no `uber-trace-id`, and that the caller's variable is still `jaeger` after. **Probe method** (the verifier's `propchk/probe.mjs` against the scratch tree, `OTEL_PROPAGATORS=jaeger`): SDK constructed directly (unpinned) gives `["uber-trace-id"]`; with the global propagator replaced, `["traceparent","tracestate","baggage"]`; through the packet's `initTracing` gives `["baggage","traceparent","tracestate"]`. With both pins removed from `tracing.ts` in the scratch export the same probe gives `["uber-trace-id"]` and the test fails 2 of 3. Observation: either pin alone (env pin only, or `pinPropagator()` only) still passes the test, so the two layers are redundant and the test cannot tell them apart; that is defence in depth, not a defect |
| (b) `privateIdHash` vector | computed independently with `node:crypto`: `('salt-world-1','cust-0042')` gives `a30814d6ac27eae743f8e779f8f159c9da44845082a774d374153952ef671db7`, equal to the expected value; the full-width spelling folds to the same hash (NFKC); the contracts test and `leak.test.ts` assert the same vector |
| (c) `forbiddenLiterals` required | `requireGuard` throws `MissingForbiddenLiterals` (missing guard, non-array, or empty list with no private-id set) and `InvalidLiteral` (blank literal); `assembleEvidenceBundle`, `assertNoLeak`, `observeEvent`, `ObserverRunner` and `OutboxDispatcher` all call it. Mutant (`requireGuard` made a no-op): 4 tests fail. Note: an empty literal list is accepted when a non-empty private-id set is present (documented, tested) |
| (d) Quarantine can never reach `evidence_ready` | `observeEvent` returns a structure-only observation with `presentFields: []` and `quarantined`; the dispatcher stores it and dead-letters the row (`EvidenceQuarantined:<code>`) before the required-fields step; the scan's `settle` routes it to `quarantined`, not `ready` or `pending`; `assembleEvidenceBundle` refuses it (`QuarantinedObservation`). Mutants: dispatcher branch removed (1 fails), scan branch removed (1 fails), bundle refusal removed (1 fails) |
| (e) Read-before-send and labels | on a retry after `sdk_enqueued`, the dispatcher reads the remote event first; if the signal or event is visible it records `ingest_accepted` with `inferred-from-query-visible` and does not send; otherwise it resends and records `http-<status>-resend-unverified` (tests assert `http-204-resend-unverified` and `inferred-from-query-visible`; the worker's own events record `worker-attested-not-observed`); `deliveryOf` maps these to `observed`, `worker_attested`, `inferred`, `resend_unverified`; every send carries `dedupe_key` = the outbox operation id. Mutants: inferred label changed (2 fail), resend suffix dropped (1 fails) |
| DA test ids | I mapped the id as the first token of the nearest describe or test name. Vitest runtime cases (it.each rows counted separately), all passing: **O1 40** (34 in `leak.test.ts`, 6 in `bundle.test.ts`), **O2 11** (10 `c1c`, 1 `mongo.integration`), **O3 3**, **O4 4**, **O5 4**, **O6 4**, **O7 9** (`unsafe-paths` 2, `bundle` 4, `leak` 3). Source-level `it(`/`it.each(` definitions: O1 17, O2 5, O3 3, O4 4, O5 4, O6 4, O7 9. **O9** is not a test-name prefix: it is the header of `raindrop-contract-probe.test.ts` ("DA-6 O9") and shows as 1 skipped test without keys. I could not reproduce the owner's per-id numbers (O1 11, O2 7, O3 4, O4 6, O5 4, O6 5, O7 9); only O5 and O7 agree. O1 11 equals the number of definitions in `leak.test.ts` alone. No id is uncovered; the discrepancy is in counting, not coverage |

Observations, none blocking: (1) The changes to `observeEvent`, `assertNoLeak`, `BundleInput`, `ObserverRunner` and `OutboxDispatcher` are breaking inside the observer package; the held C1b files in the working tree already typecheck against them (working-tree `tsc` 0), and the committed tree has no other caller. (2) `package-lock.json` must come with this commit (one added line in the `packages/observability` workspace entry, text above); it is team-lead-owned, so I made no edit. (3) The 29 lint warnings are all in tests.
