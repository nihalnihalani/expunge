# DA-15: post-restore erasure re-application (E) and guard subject-set coverage (G2)

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. This is a static read of the working tree. I read
`packages/privacy/src/{reapply,reapply-mongo,reapply-cli,export-guard}.ts`, the diffs to `packages/mongo/src/{guard-exports,privacy-stores}.ts`,
and the diffs to `packages/observer/src/{sources,process}.ts`. I ran no tests for this pass.

## Dispositions

| Packet | Disposition |
|---|---|
| **E: post-restore re-application** | **ACCEPT-WITH-FOLLOWUP as a partial tool.** It does **not close DA-10 B-1**: record B-1 as PARTIAL. The world-record effects and the derived-artifact retraction, the two things a restore resurrects most, rest on self-asserted attestations (E-1). The telemetry outbox is not covered (E-2). |
| **G2: subject-set coverage and race handling** | **ACCEPT.** It closes DA-14 G-1, G-2 and G-4, with one note (G2-1). |

## E: post-restore re-application

### Can a restore plus reapply report DONE with something resurrected? Yes.

The tool proves DONE only for what is in the ledger: erasure jobs (`external_deletions`), suppression rows and raw-source
tombstones. Each of those is verified by re-reading the database (`reapply.ts:148-165`), which is good. Everything else
a restore brings back is either self-asserted or not covered at all.

- **E-1 (HIGH, DEMONSTRATED): the two attestations are free text that anyone can write.**
  - `attest --cursor F NAME=REFERENCE` writes any non-empty string into the cursor file (`reapply-cli.ts:39-48`).
    - No principal is involved.
    - Nothing in the database is checked.
    - Anyone who can edit the cursor file can set them; the cursor is plain JSON, hash-bound to the ledger but not
      authenticated.
  - These two attestations cover the core of erasure:
    - `world-effects-reconciled`: the subject's records deleted or redacted by cleanup jobs, which come back in full with
      the restore;
    - `derived-artifacts-retracted`: lessons, eligibility and derived artifacts.
  - So DONE can be reported while every world record the subject asked to have deleted is back.
  - Required, so that each attestation becomes a check:
    - **World effects.** The ledger must carry the committed effects and receipts since the backup (effect key, address,
      kind, post hash, from `effects`, `completion_receipts` and, for native sources, the NA-2 intents). Reapply then
      re-applies them through the domain or native adapter, conditional on the restored preimage, and verifies them by
      read-back.
    - **Derived artifacts.** Verify that a `provenance_closures` row is complete, and that eligibility is revoked, for
      every tombstoned source in the ledger. Those rows are in the restored database, and the privacy controller can
      read them.
  - Until then, the CLI should print that DONE is "DONE for erasure jobs, suppressions and source tombstones; world
    effects and derived artifacts are ATTESTED, NOT VERIFIED". The runbook should keep a restore out of service while any
    cleanup completed after the backup.
- **E-2 (MEDIUM, LIKELY): the restored telemetry outbox can re-send to Raindrop.**
  - `telemetry_outbox` comes back in its pre-backup state. Rows that were later delivered, or HELD for suppression, are
    pending again, and the evidence process drains them.
  - Users under an active erasure are suppressed after reconciliation, which is correct. But a user whose erasure
    *completed* after the backup no longer holds an active suppression, if suppression is released on completion. Their
    events would be re-ingested by the provider after erasure.
  - Required:
    - reapply suppresses every user id of every ledger job whose erasure completed after the backup, or marks those
      outbox rows dead;
    - the observer stays down until reapply is DONE (the runbook says so; enforce it with a marker row the evidence
      process checks).
- **E-3 (LOW-MEDIUM, LIKELY): restore drops subjects registered after the backup.**
  - `subject_tokens` registered after the backup are lost, and the ledger deliberately carries no literals.
  - The re-exported leak guard therefore lacks those subjects. Their literals are no longer forbidden in telemetry, and
    their erasure jobs reference user ids whose subject mapping is gone.
  - Required: list those subjects as "re-register required" (the ledger can carry the token-row ids and counts without
    literals), and keep the evidence process held until they are re-registered.
- **E-4 (LOW): the ledger is complete only relative to the database it was read from.**
  - It is read from a "damaged but readable" database.
  - The verification pass compares the restored database with the ledger, so anything the damage destroyed is invisible.
    This is disclosed as the main limit.
  - Add counts per collection and the latest `createdAt`/`receivedAt` to the ledger header, so an operator can spot a
    truncated ledger.

### Is the ledger a new store of subject data?

- **What it holds:** erasure jobs (opaque namespaced provider user ids, `subjectEntries` with `user_id` and dates), and
  tombstones (source id, reason, policy hash). No literals: `ExternalErasureJob` carries no handle. It is still
  pseudonymous personal data, because it links an erasure request to a user id.
- **Where it lives:** a file at an operator-chosen path, written atomically with mode 0600 (`writePrivateFile`).
  "Must travel with the backup".
- **E-5 (LOW-MEDIUM):**
  - Retention is undefined. Because it travels with the backup, it inherits the backup's retention, and DA-10 B-1's
    retention requirement (tied to the erasure deadline) still has no implementation.
  - The ledger is not authenticated. An edited ledger that drops a job yields DONE with that job's data resurrected.
  - Required:
    - a MAC or signature over the ledger, keyed by a privacy-controller secret and verified on apply;
    - a stated retention (delete the ledger with the backup it accompanies);
    - an encrypted destination.

## G2: subject-set coverage

- **G-1 is closed for the registration path.**
  - `SubjectTokenRepository.put` inserts the token row and bumps `subject_set_generations` in **the same transaction**
    (`privacy-stores.ts`).
  - The export reads the subject-set generation **before** listing subjects (`export-guard.ts`), so a guard covers at
    least that set.
  - A registration that commits after the export's read makes `status().covered` false (`guard-exports.ts:134-146`), and
    the observer HOLDs with `subject_set_ahead`.
  - A registration that lands between the generation read and the list read is included but recorded under the older
    generation. The result is a conservative HOLD until the next export.
- **G-4 is closed.**
  - `record` is conditional on the newest generation still being the one the exporter saw (`GuardExportRaced`), and it is
    retried.
  - A subject-set generation lower than the newest is refused (`GuardGenerationRegression`).
  - A subject-set generation above the current one is refused.
  - Concurrent exports of the same generation collide on `_id`.
  - An older snapshot can therefore no longer become "latest".
- **G-2 is closed.** `holdUnless` is checked before **each** drain batch and each scan (`process.ts`). Any value other
  than `true`, or a throw, HOLDs. The 60 s exit stays as a backstop.
- **G2-1 (LOW).** Only `put` bumps the generation. A raw `insertOne` into `subject_tokens` with the privacy controller's
  collection-wide INSERT grant would add a subject without a bump. Note it in the role notes. A later fix can make the
  observer also compare a count of subject rows against the exported count.
- Restore interplay is fine. After a restore, the on-disk guard (newer generation) does not match the restored `latest`,
  so the observer HOLDs until a re-export (fail-closed).

## Re-read: E-4 and E-5, ledger security (2026-10-11, working tree)

Files read: `src/ledger-security.ts`, the export count check in `src/reapply-mongo.ts`, and the `export`/`apply` paths in
`src/reapply-cli.ts`. Tests not run.

**Disposition: ACCEPT-WITH-FOLLOWUP.** E-5 integrity and encryption are sound. E-4 detects edits and concurrent changes,
but not a ledger that was already truncated when it was exported (LS-2). Retention can be bypassed by two flags (LS-1).

- **The MAC covers exactly the bytes replayed. Yes.**
  - At seal time, the MAC is HMAC-SHA256 over `stable(body)`, where `body` is the ledger plus its header. At open time it
    is recomputed over the parsed JSON minus `mac`.
  - Dates and ObjectIds serialize through `toJSON` before the key-sorting replacer, so sealing and opening produce the same
    canonical string.
  - Replay parses the same verified `plain` text (`parseLedger(plain)`), so the jobs and tombstones replayed are the
    MAC'd ones. `format`, `exportedAt` and the header are covered too.
- **The compare is constant-time. Yes:** length check, then `timingSafeEqual` (`ledger-security.ts:127-130`).
- **GCM nonce: fine.**
  - Each seal uses a fresh random 96-bit IV. With one long-lived key that is safe far beyond any realistic number of
    exports.
  - The tag is verified. A wrong key or edited ciphertext gives `LedgerDecryptFailed`.
  - There is no AAD, which is fine because the outer `format` field only selects the decryption path.
- **Keys stay out of argv, logs and errors. Yes.**
  - Both keys are read from environment variables by name (`EXPUNGE_LEDGER_MAC_KEY`, `EXPUNGE_LEDGER_ENC_KEY`).
  - Errors name the variable, never the value, and the CLI has no key flag.
  - Minor: the MAC key is used as a UTF-8 string with only a length check (32 characters or more). Prefer 32 random bytes,
    hex-encoded, as for the encryption key.
- **Can retention be bypassed? Yes, twice. LS-1 (LOW-MEDIUM).**
  - `--allow-expired` skips the expiry check at apply time (`ledger-security.ts:142`).
  - `--retention-days` is `Number(...)` with no bound (`reapply-cli.ts:61`), so `--retention-days 36500` signs a ledger
    valid for a century.
  - Retention of the file itself is not enforced either: there is no pruning job (disclosed).
  - Fix:
    - bound `--retention-days`, for example 1 to 90, tied to the backup retention;
    - make `--allow-expired` require a reason string, and record its use (who and why) in an insert-only audit row,
      printed with the report.
    - The runbook must say an expired ledger is deleted, not overridden.
- **Is a ledger that was signed while already truncated detectable? Only partly. LS-2 (MEDIUM).**
  - The header is recomputed from the body on open. Post-signing edits are therefore caught twice, once by the MAC and
    once by the header.
  - Before signing, the export now refuses `LedgerChangedDuringExport` when the counts read differ from the collection
    counts before or after the read. That catches concurrent writers and paging bugs.
  - It cannot catch rows the damaged database had already lost. A consistent but short ledger is signed, and every later
    check passes.
  - Fix: give `apply` an independent floor.
    - `external_deletions` only grows (jobs are never deleted), so the ledger's job count must be at least the
      `external_deletions` count in the backup manifest's `sourceFingerprint` (`infra/services/backup`). The same holds
      for tombstones if the fingerprint gains a tombstone count.
    - A ledger with fewer jobs than the backup it is replayed onto is refused.
  - Without that floor, E-4 cannot see the case it exists to catch.

Status: DA-10 B-1 stays PARTIAL; E-1 (the self-asserted attestations) and E-2 (outbox resend) remain open.

## Re-read: E-3 part 1, subject manifest (2026-10-11, new files)

Files read: `src/reapply-subjects.ts` and `src/subjects-cli.ts`. Tests not run.

**Disposition: ACCEPT-WITH-FOLLOWUP.** SH-1 should be fixed in this packet (a one-line change). SH-2 is required before
any real subject is exported.

- **Can the hashed manifest be reversed? It cannot be inverted, but it can be confirmed by anyone. SH-1 (MEDIUM,
  DEMONSTRATED).**
  - `handleHash = sha256('expunge:subject-handle\n' + handle)` (`reapply-subjects.ts:32-33`). The domain prefix is a
    public constant, so in effect the hash is unsalted and unkeyed.
  - Handles are subject literals such as emails, customer ids and names, which are highly guessable. Anyone with the
    file, or with the terminal output of `check` (which "prints hashes only"), can confirm that a given person is a
    registered subject by hashing a candidate list.
  - The module's own comment admits this ("a guessable handle can be confirmed").
  - Fix: key it with `HMAC-SHA256(key, domain || handle)` using a privacy-controller secret, either the ledger MAC key
    under a distinct domain label or a separate `EXPUNGE_SUBJECT_HASH_KEY`. The `check` step recomputes with the same key,
    so nothing else changes. Then the printed values are useless without the key.
- **Is it a new store of personal data needing retention? Yes. SH-2 (MEDIUM).**
  - It is a per-subject pseudonymous identifier, together with scope, provider and token generation. Unkeyed, it is
    effectively a confirmable subject list.
  - Unlike the ledger, it has no `retainUntil`, no expiry refusal and no encryption option: "retention stated by the
    caller".
  - Fix: seal it with the same `ledger-security` machinery: header with `retainUntil` and a bounded retention, refusal
    when expired, and optional AES-256-GCM. The runbook should pair its deletion with the backup it accompanies.
- **Is the 5000 bound a silent truncation? Not on export.**
  - `exportSubjectManifest` refuses with `SubjectManifestIncomplete` when a scope returns 5000 or more rows
    (`reapply-subjects.ts:53-54`). That is fail-closed.
  - Two notes:
    - The bound is a hard ceiling. A scope with 5000 or more subjects can never be exported, so this needs paging before
      real scale.
    - `subjectsToReRegister` reads the restored database with `list(scope, 5000)` and **no** check (`:105`). If the
      restored scope holds 5000 or more rows, held rows past the bound are reported as missing. That is over-reporting,
      in the safe direction (more re-registration and exit 5), but it is unchecked. Apply the same refusal there.
- **Minor.**
  - The MAC uses plain `JSON.stringify`, not the ledger's key-sorted `stable()`. It works only because `JSON.parse`
    preserves key order. Use the shared canonicalizer.
  - The CLI's scope env is limited to `dev`, `evaluation` and `demo`, so a native source's `staging`/`production` scope
    cannot be exported. Align it with the `source.ts` scope env when native sources go live.

Status: E-3 part 1 is done once SH-1 and SH-2 land. The observer-hold part (hold the evidence process until
re-registration completes) is still owed. B-1 stays PARTIAL, and E-1 and E-2 remain open.

## Re-read: SH-1, SH-2 and LS-2 fixes (2026-10-11, untracked files)

Files read: `src/sealed-json.ts`, `src/reapply-subjects.ts`, `src/subjects-cli.ts`, `src/reapply-floor.ts`, and the
current `src/reapply-cli.ts` and `src/ledger-security.ts`. Tests not run.

| Item | Status |
|---|---|
| SH-1 (guessable handle hashes) | **CLOSED** |
| SH-2 (manifest retention and encryption) | **CLOSED** |
| LS-2 (truncated ledger floor) | **NOT closed**: the check exists but nothing calls it (LS-2b) |
| LS-1 (ledger retention bypass) | **Still open**, but only for the ledger; the new sealed format does not reintroduce it |

- **SH-1 is closed.** `handleHash` is now HMAC-SHA256 under `EXPUNGE_SUBJECT_HASH_KEY` (64 hex), or a key derived as
  `HMAC(EXPUNGE_LEDGER_MAC_KEY, 'expunge:subject-hash-key')`. Neither the file nor the `check` output can be confirmed
  against a guess without the key.
  - What is left: whoever holds the privacy-controller key can still confirm a guess, and leaking that key re-opens the
    risk. That is acceptable, and it should be stated.
  - Rotating the key between export and check makes every entry look missing. That fails safe (exit 5); document it.
- **SH-2 is closed.** `sealed-json.ts` gives the manifest:
  - a key-sorted canonical MAC;
  - retention bounded to 1 to 90 days and enforced at seal time;
  - `SealedExpired` on open;
  - optional AES-256-GCM with a random IV;
  - 64-hex keys;
  - a constant-time compare.

  `subjectsToReRegister` now refuses at the 5000 bound.
- **Does "unless allowed" reintroduce LS-1? Not for the subject manifest.** `allowExpired` exists only as an API option,
  and `subjects-cli.ts` exposes no flag for it.
- **LS-1 is still open for the ledger.** The ledger still goes through `ledger-security.ts`:
  - `reapply-cli.ts:61` takes `--retention-days` with no bound;
  - `--allow-expired` (`:82`) needs no reason and leaves no audit row.

  Fix: move the ledger onto `sealed-json.ts` (bounded retention), or add the same bound to the ledger, and require a
  reason plus an audit row for `--allow-expired`.
- **LS-2b (MEDIUM, DEMONSTRATED): `checkLedgerFloor` has no caller.** It is correct as a function (`reapply-floor.ts`),
  but `reapply-cli.ts apply` never calls it, so a truncated ledger is still replayed.
  - Fix: make `--backup-manifest FILE` mandatory for `apply`, refuse when `ok` is false (including "floor unavailable"),
    and bind it to the restored archives. `restore-mongo.mjs` already verifies the archive sha256 values against that
    manifest; the reapply step should take the same file.

Status: B-1 stays PARTIAL. E-1 (self-asserted attestations), E-2 (outbox re-send), the E-3 observer hold, LS-1 for the
ledger and LS-2b remain open.
