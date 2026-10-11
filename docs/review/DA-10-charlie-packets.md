# DA-10: charlie-branch packets (evidence-process wiring before commit; retro on ab73210, 36f9497, 6b3b259; decision 21)

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. Read-only static review of branch `charlie` at `9cf96bc` and the
current working tree. I ran no tests for this pass and printed no secret.

## Dispositions

| Item | Disposition |
|---|---|
| (1a) `packages/privacy/src/export-guard.ts`, `packages/privacy/src/index.ts` | **BLOCK.** Two small fixes are needed first: G-1 (silent 1000-subject truncation) and G-2 (a non-atomic write that can expose the literals). It also has no test and no caller (G-3). |
| (1b) `packages/observer/src/sources.ts`, `main.ts`, `index.ts` | **ACCEPT-WITH-FOLLOWUP.** Fix S-1 (malformed `privateIds` silently dropped) in this packet if possible; it is a one-line refusal. S-2 to S-5 can follow, but they must land before any live Raindrop lane. |
| (1c) `packages/observer/test/sources.test.ts`, `main.integration.test.ts` | **ACCEPT-WITH-FOLLOWUP** (missing cases, T-1). |
| (1d) `packages/observer/README.md` | **ACCEPT-WITH-FOLLOWUP.** A stale paragraph contradicts the new one (R-1). |
| (2) ab73210 (E1 fixture initializes the deployment as setup) | **OK.** No follow-up commit is needed for this change. One note concerns the future bootstrap command. |
| (2) 36f9497 (GatePlanView, D8-1) | **FOLLOW-UP needed** (V-1 to V-3, all small). |
| (2) 6b3b259 (backup tools and drill) | **FOLLOW-UP needed.** B-1 (backups resurrect erased data) is the material one. |
| (3) Decision 21 (Atlas probe and setup) | **Sound procedure, with notes A-1 to A-5.** A-1 (an Atlas-admin credential sits in the agent-readable `.env`) needs a human decision. |

## (1) Evidence-process wiring

### Answers to the lead's questions

- **Can a stale or empty guard pass as protection?**
  - **Empty: no.** `requireGuard` refuses an empty literal list unless it has private-id hashes (`observability/src/leak.ts:165-171`), and `loadGuardFile` calls it.
  - **Stale or incomplete: yes, by design.** The guard is read once at start (`sources.ts:18-22`). The file carries no scope, generation, subject count or completeness marker, so the loader cannot tell any of the following from a correct guard:
    - a guard exported before new subjects were registered;
    - a guard for a different scope;
    - a guard truncated at 1000 subjects (G-1);
    - a hand-written file holding one arbitrary literal.
  - **Weakened: yes (S-1).** A `privateIds` block that is present but malformed is silently dropped (`sources.ts:41-47`), and the guard loads with literals only.
- **Is the file handoff a TOCTOU or privilege-boundary risk?**
  - **Writer (G-2).** `writeFileSync(path, ..., {mode: 0o600})` applies the mode only when it creates the file. If a file already exists with mode 0644, the literals are written into it while it is still world-readable, and only then `chmodSync` tightens it (`export-guard.ts:20-21`). The write is not atomic (no temporary file and rename), and it follows symlinks.
  - **Reader (minor).** `statSync` and then `readFileSync` (`sources.ts:27-28`) is a small TOCTOU. Opening once, then `fstat` and reading the same descriptor closes it.
  - **Privilege boundary (S-3, LIKELY).** The file is every subject literal of the scope in plaintext. Before this change the observer principal could not read the subject map. Now the observer process holds the whole literal set in memory and on its filesystem. It does not get the token mapping, but this is still a real widening. It must be disclosed, and the file belongs on a tmpfs secret mount.
- **Do suppression reads fail closed on Mongo errors? Yes.**
  - The dispatcher catches any error from `suppressedUserIds` and HOLDs the event (`outbox-dispatcher.ts:192-199`).
  - `activeUserKeys` fails closed above its bound (`mongo/src/privacy-stores.ts:340-353`).
  - Gap S-2: suppression is checked only for `type === 'event'` intents (`outbox-dispatcher.ts:191`). This predates the packet. Signals attach to an event id of a possibly suppressed user, so whether they need the same check should be stated.
- **Can the process report READY while unprotected? Yes, in three ways:**
  - a stale, other-scope, truncated or token-only guard file (above);
  - a wrong `RAINDROP_ORGANIZATION_ID`, for which readiness says "configured, not provider-verified" (`process.ts:71-76`). `activeUserKeys` then filters by the wrong organization and returns an empty set, so events of users under erasure are sent. This is S-4 (LIKELY; it predates the packet, but this wiring is what makes it reachable);
  - a suppression source whose reads always fail is reported READY while every event is held. That is safe, but it is a liveness lie on the operator's readiness view.
- **Does the keep-alive timer block graceful shutdown? No.**
  - `stop` clears it before closing (`main.ts` diff). Because `process.once` is used, a second SIGTERM gets the default action.
  - LIKELY (S-5): `EvidenceProcess.stop()` only clears the timers (`process.ts:188-193`). It does not wait for an in-flight `drain`/`scan`, so `service.close()` can cut a running outbox transaction. Durable state recovers through lease expiry, so this is not a correctness defect. Waiting for in-flight work with a deadline would make shutdown actually graceful.
  - Minor: on BLOCKED, `main` closes a service the caller injected.

### Findings

- **G-1 (MEDIUM, DEMONSTRATED by reading).**
  - `guardFor` calls `deps.tokens.list(scope)`. `SubjectTokenRepository.list` defaults to `limit = 1000` (capped at 5000) with no signal that it truncated (`privacy-stores.ts:190-197`). The port signature `list(scope)` (`privacy/src/ports.ts:84`) cannot even ask for more.
  - A scope with more than 1000 token rows therefore exports a silently incomplete guard. This matters because the guard is the protection.
  - Contrast `activeUserKeys`, which fails closed (`SuppressionListTooLarge`).
  - Required: page to completion, or fail closed above a bound, and record the count in the file.
- **G-2 (MEDIUM, DEMONSTRATED by Node semantics).** The non-atomic write with the wrong-mode window described above.
  - Required: create a temporary file in the same directory with `open(..., 'wx', 0o600)`, write, fsync, `rename`, and refuse a symlinked target.
- **G-3 (LOW).** `exportGuardFile` has no caller and no test. Nothing in production registers subject tokens either: `registerSubjectTokens` is called only from `privacy/test/registry.test.ts`.
  - Today the only way to reach READY in production is a hand-built file, which is exactly the "one arbitrary literal" case.
  - Add a test now (mode on a pre-existing file, atomicity, truncation). The privacy-controller command that runs it belongs to the DA-9 item 9 process.
- **S-1 (MEDIUM, DEMONSTRATED).** A present but malformed `privateIds` must be refused, not dropped. The exporter wrote it, so dropping it silently weakens the guard.
- **S-3 (LIKELY).** Proposed fail-closed freshness design, needed before a live lane:
  - The privacy controller writes a small row the observer may FIND, e.g. `{scope, generation, digest, subjectCount, providerOrganizationId}`, in the same transaction that registers subject tokens.
  - The file carries the same fields.
  - `loadGuardFile` checks scope, organization and digest against the environment and the row.
  - The dispatcher HOLDs events while the database generation is ahead of the file's.
  - This covers staleness, the wrong scope, part of the wrong-organization case (S-4) and hand-made files.
- **T-1.** Missing test cases:
  - a malformed `privateIds` is refused;
  - an unreadable suppression source through `main` HOLDs events (the dispatcher's existing test covers the mechanism, not this wiring);
  - an `exportGuardFile` target that already exists with mode 0644;
  - a guard export over more than 1000 subjects.
- **R-1.** The README still has the paragraph "Until the privacy controller's `erasure_suppressions` read (PKT-62) and a leak-guard source exist, the process is BLOCKED". It sits right after the new paragraph saying both are wired. Reword it to "absent or invalid sources leave it BLOCKED", and disclose S-3 (plaintext literals in the observer's filesystem) and the read-once staleness.

## (2) Retro on committed charlie commits

### ab73210: E1 fixture deploys the harness

- Correct and minimal. `beforeEach` calls `env.reset()` first, so the non-idempotent `insertOne` inside `DeploymentRepository.initialize` (`deployment.ts:223-243`) cannot collide between tests.
- Note for the bootstrap command (DA-9 item 2), not for this commit. `initialize`:
  - writes no promotion receipt and no deployment outbox row;
  - checks neither artifact eligibility nor the authority floor;
  - is not idempotent;
  - takes the scope revision from its caller.
  A production bootstrap must add those, and must not copy this test call.
- Verification: E1 passing should be confirmed in a live-lane run on the committed tree. I did not rerun it.

### 36f9497: GatePlanView (D8-1)

- **V-1 (LOW, DEMONSTRATED).** The structure-overlap checks in `verifyGatePlanView` compare published `structuralHash` values (`splits.ts:224-229`). Those are seed-salted (`contentHash({seed, structure})`, `splits.ts:145-147`), and every fixture has a different seed, so two fixtures with the same structure never collide. Both checks are therefore vacuous:
  - `GatePlanViewStructureOverlap` among held entries;
  - the one between final-split rows and held entries.
  The docstring claim "structural signatures are unique across splits" (`splits.ts:189-191`) is not what the code proves; disjointness rests on the builder alone.
  - Fix: compare the unsalted `entry.structuralHash` among held entries (possible, since they are held in full). Reword the docstring for the final split: that disjointness can only be committed by the builder, not checked by the gate.
- **V-2 (LOW-MEDIUM, LIKELY).** `expectedSplitHash` is optional. The in-flight gate calls `verifyGatePlanView(config.view)` without it (`packages/gate/src/gate.ts:112`) and compares against the freeze only later, in admission. A self-consistent foreign view therefore passes verification.
  - Fix: pass `freeze.splitManifestCommitment` at `gate.ts:112`, so the gate refuses before any claim is taken. The comment there already promises this. Belongs in the gate packet's review; flagged here because the API invites the omission.
- **V-3 (LOW).** `gate-view.test.ts` does not exercise `GatePlanViewBuilderMismatch`, `GatePlanViewDuplicateFixture`, `GatePlanViewCountsMismatch` or either overlap code. Adding them would have exposed V-1.

### 6b3b259: backup and restore tools

- **B-1 (MEDIUM-HIGH, LIKELY; DEMONSTRATED gap in the runbook).** A logical backup captures the three databases as they are. That includes:
  - records later deleted by cleanup;
  - `raw_artifacts`, `subject_tokens` and lessons later purged by retraction;
  - the sealed `expunge_private` material.

  A restore brings all of it back, after erasure was promised. `docs/runbooks/BACKUP-RESTORE.md` says nothing about erasure, purge, tombstones, suppression or backup retention (grep finds none of them).
  - Required: a maximum backup retention tied to the erasure deadline.
  - Required: a mandatory post-restore step that re-applies every committed effect, tombstone, purge and active suppression recorded after the backup's timestamp. Until that step exists, restore stays refused when any erasure completed after the backup.
  - Required: state all of this in the runbook.
- **B-2 (MEDIUM, LIKELY).** The tools container runs as root with no `--user`, and mongodump writes the archives with default permissions (typically 0644). Only the manifest is written 0600 (`backup-mongo.mjs:70`). The archives hold the private database and the subject literals.
  - Fix: run with `--user $(id -u):$(id -g)`, apply a umask or chmod 0600, and refuse an output directory that is group- or world-accessible.
- **B-3 (LOW-MEDIUM).** Consistency is disclosed ("quiesce writers") but not enforced. The fingerprint is taken before the dump, so with live writers the manifest's fingerprint can disagree with the archives, and nothing notices.
  - Fix: take a second fingerprint after the dump and refuse on difference. Alternatively, refuse while `jobs` has running leases or the `telemetry_outbox` has leased rows.
- **B-4 (LOW, now relevant).** `EXPUNGE_BACKUP_URI` is a principal outside `PRINCIPALS` and the role manifest (the runbook says so). The Atlas setup user holds the built-in `backup` role (decision 21), which makes using it here the path of least resistance. The runbook forbids that, but the tool cannot check it.
  - Fix: at minimum, have the tool refuse when the URI's user equals the setup user. That can be compared via `connectionStatus` without printing either value.
- **B-5 (LOW).** Errors include the last five lines of mongodump's stderr (`backup-mongo.mjs:52-54`). mongodump redacts credentials, but it can print host names. Acceptable; noted.
- Good: pinned image by tag and digest; URIs passed by name and never in argv; `--read-only --cap-drop ALL no-new-privileges`; database names validated before shell interpolation; restore requires `--confirm-databases` and refuses a non-empty target without `--drop`; the drill refuses non-local URIs.

## (3) Decision 21: Atlas probe and setup

The procedure is right: a read-only probe first, setup from a clean export of committed code rather than working-tree WIP, a second run to check idempotence, and the human's confirmation recorded. Notes:

- **A-1 (needs a human decision).** The setup user holds `atlasAdmin`, `readWriteAnyDatabase`, `dbAdminAnyDatabase`, `backup` and others. That cluster-admin credential now sits in the agent-readable root `.env`. `.env.example` line 1 says "Never put setup/admin credentials in an agent sandbox."
  - Recommend the human either remove `MONGODB_SETUP_URI` from the agent-readable `.env` once setup is done, or replace it with a setup user limited to DDL on the three Expunge databases.
  - Least-privilege runtime principals still need the Atlas UI or Admin API, which is unchanged.
- **A-2.** Record the exact commit and tree hash of the "clean export" in decision 21. As written, the evidence cannot be tied to bytes.
- **A-3.** "Same counts on the second run" proves idempotence of counts only, not of validator bodies, index options or seeded rows.
  - Fix: run `fingerprintAll` from `infra/services/backup/lib.mjs` before and after the second run and record that the diff is empty. The tool exists and only reads.
- **A-4 (LIKELY, for mongodb-authority).** Validator coverage needs reconciling against the intended list: world 3 of 11, control 40 of 54, private 1 of 7. Owner-shaped world collections without validators may be by design. But 14 control and 6 private collections without strict validators should be named and justified. The private ones hold sealed answers.
- **A-5.** "`listSearchIndexes` succeeds" does not establish Search/Vector availability. Hybrid retrieval stays NOT_STARTED/BLOCKED until a search index is created, reaches READY and returns a filtered query on this cluster.
- **Reminder.** Setup created collections, indexes and the authority seed only. There is still no registry, world or initial deployment on Atlas (DA-9 D4). The cluster can be probed, but no cleanup job can be created on it yet.

## Re-read of the (1a)/(1b) fixes (2026-10-11, working tree)

I read `packages/observability/src/guard-file.ts`, `packages/privacy/src/{export-guard.ts,export-guard-cli.ts,registry.ts,ports.ts}`,
`packages/observer/src/sources.ts`, the new tests and both READMEs. Command:
`env -u MONGODB_TEST_URI npx vitest run packages/privacy packages/observer packages/observability`. Result: exit 0, 21 files
passed and 7 skipped; 233 tests passed and 35 skipped. The live CLI and main integration tests skip without a replica set; I did
not run them.

| Item | Disposition |
|---|---|
| privacy (export-guard, CLI, registry, ports, tests, README) | **ACCEPT-WITH-FOLLOWUP**. The BLOCK is lifted. |
| observer (sources, main, tests, README) | **ACCEPT-WITH-FOLLOWUP** |

Verified by reading:
- G-1 is fixed. `guardFor` lists with a limit of 5000 and refuses with `GuardIncomplete` when 5000 or more rows come back
  (`registry.ts`). This is fail-closed. It counts rows rather than distinct handles, so it errs on the safe side.
- G-2 is fixed. The file is opened with `openSync(temp, 'wx', 0o600)`: O_EXCL never follows a symlink at the temporary
  name. The writer fsyncs, then `renameSync` replaces whatever sits at the target, a symlink included, without following
  it. Tests cover a pre-existing 0644 file and a symlinked target.
- G-3 is fixed: a real caller (`export-guard-cli.ts` as `privacy_controller`, counts only), plus unit and CLI tests.
- S-1 is fixed: `parseGuardFile` refuses a malformed `privateIds` block.
- Scope, organization, count and digest are all checked. R-1 is fixed, and both READMEs disclose the plaintext literals
  and the read-once staleness.

Follow-ups. None of them blocks the commit, but the first must land before any live Raindrop lane.
1. **Staleness**: a generation row in Mongo, with events HELD while the file is stale. Disclosed as not done.
2. **The digest is an unkeyed content hash.** It catches truncation and accidental edits. Anyone able to write the file can
   recompute it, so "refuses an edited file" does not hold against a malicious writer. Write-protection rests on file
   ownership and the read-only mount. Either say so, or use an HMAC keyed by a privacy-controller secret.
3. **The organization check compares configuration with configuration** on both sides. A wrong `RAINDROP_ORGANIZATION_ID`
   set consistently on both sides still passes (S-4 remains).
4. **Minor**:
   - If `renameSync` throws, the plaintext temporary file (0600) is left in place.
   - The directory is not fsynced after the rename.
   - `loadGuardFile` still calls stat and read separately; opening once and using fstat on the same descriptor closes the gap.
