# DA-17: Atlas roles apply (`scripts/atlas-roles-{plan,dry-run,apply}.ts`), before a live run

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. Static read of the three scripts and their two test files. I
ran nothing against Atlas. The `ATLAS_CLIENT_ID`, `ATLAS_CLIENT_SECRET` and `ATLAS_PROJECT_ID` names exist in `.env` and
are currently empty. The `.env` database names equal the defaults; I checked that by comparison only, without printing
any value.

## Disposition: is it safe to run `--apply` once? Not yet. Yes after AR-1 and AR-2.

Both changes are a few lines each. The password handling is safe, and secrets do not leak. The risk is that the
dry-run does not show what the PATCH would remove from roles that live services use today.

## Answers

**Can `--apply` drop privileges a running service needs mid-flight? Yes, and the operator cannot see it beforehand.**
- A differing role is PATCHed with the full action list (`atlas-roles-apply.ts:110-118`), which replaces its actions.
- The existing nine roles were created by another session's script from an unknown manifest version. The PATCH body
  comes from `atlasRoleManifests()` in **whatever tree runs the script**.
- The working tree's `packages/mongo/src/roles.ts` is modified and uncommitted (campaign authority, run attestations,
  guard exports, owner-source state). Run from the working tree, it applies uncommitted grants. Run from an older
  commit, it can remove grants that newer running code needs.
- So this is "narrowing (or widening) to the manifest of the tree you run it from", not necessarily the committed
  manifest.
- The same holds for users: a user whose roles differ (for example one carrying a built-in role from the other script)
  is PATCHed down to the single custom role (`:150-155`).
- The no-flag mode reports only `action: 'patch'` or `'patch-roles'` per role. It never says which
  `action@db.collection` pairs would be removed (`:118`). `atlas-roles-dry-run.ts` makes no network call at all.

**AR-1 (required before `--apply`).**
- In no-flag mode, print each role's diff against Atlas as two flattened sets: `added` and `removed`, each entry
  `ACTION@db.collection`. For users, print the roles that would be removed.
- Compare roles with those flattened sets (see AR-3).
- Run from a clean export of the commit whose manifest matches the code the live services run (as decision 21 did for
  setup), not from the working tree.
- Review the `removed` set before applying.

**AR-2 (required): `apply` ignores the configured database names.**
- `applyAtlasRoles` calls `planAtlasRoles()` with its defaults (`:54`): `expunge_world`, `expunge_control`,
  `expunge_private`.
- `atlas-roles-dry-run.ts` honours `EXPUNGE_*_DB`.
- On this `.env` the names equal the defaults, so it is harmless today. On any deployment with other names, apply would
  move every privilege onto databases that do not exist and strip the real ones.
- Fix: pass the same `EXPUNGE_*_DB` names, and refuse to run if they are unset.

**Can it leak a secret in errors? No.**
- `fail()` carries the step name, HTTP status and Atlas `errorCode` only (`:84-86`).
- A token failure carries the status only.
- A non-JSON response throws a `SyntaxError` that the top level reduces to `AtlasApplyFailed` without a message.
- The bearer token, client secret and passwords are never printed.

**AR-4 (LOW): the report prints the project id.** `report.projectId = env.ATLAS_PROJECT_ID` (`:55-56`). The Atlas project
(group) id is a private account identifier, and spec section 2 forbids printing those. Print `set` or `missing` instead.

**Is the PATCH-then-GET verification sound if Atlas normalizes? Mostly.**
- `sameRole` compares per-action entries after sorting, with `cluster` coerced to a boolean (`atlas-roles-plan.ts:83-104`).
- **AR-3 (LOW-MEDIUM, LIKELY).** If Atlas returns one entry per action and resource, or splits an action's resources
  across entries, the per-action comparison fails even though the privileges are identical.
  - The result would be `RoleVerifyMismatch` thrown **after** the PATCH has already landed.
  - The run would stop part way: later roles and all users untouched. Every later run would then re-PATCH.
  - Fix: compare flattened `ACTION@db.collection(:cluster)` sets (the same sets AR-1 prints).
- A role whose PATCH succeeds but whose verification fails is not rolled back. That is acceptable, because each role is
  left either fully old or fully new, but the report should say which roles were already applied when it stopped.

**Is there any path that touches a user's password? No.**
- A user is created only on 404, with the password read from `ATLAS_USER_PASSWORD_<PRINCIPAL>` (`:121-143`). The value is
  sent in the POST body and never printed.
- An existing user is PATCHed with `{ roles }` only (`:152`). Atlas v2 partial update leaves the password unchanged.
- No `.env` write and no URI output.

## Minor

- The planning comment and `dryRunReport` still talk about digest auth and `ATLAS_PUBLIC_KEY`/`ATLAS_PRIVATE_KEY`, while
  apply uses OAuth `ATLAS_CLIENT_ID`/`ATLAS_CLIENT_SECRET`. Because of that, `dryRunReport.liveApply` says BLOCKED when
  the OAuth variables are set. Align the names.
- The two scripts send different Accept versions: `2023-01-01` in apply and `2023-10-01` in plan. Use one.

## Suggested run order once AR-1 and AR-2 are in

1. Make a clean export of the intended commit.
2. Run with no flag and capture the per-role `removed` and `added` sets.
3. Confirm the live services run code from that same commit.
4. Run `--apply` once.
5. Re-run with no flag and expect every role and user to be `noop`.
6. Run `npm run probe:mongo` per principal URI, plus the RBAC denial matrix on Atlas.

## Closure (2026-10-11)

Verified by reading:
- The script bytes match the lead's hashes: `atlas-roles-apply.ts` 44f324f5, `atlas-roles-dry-run.ts` ff91df80,
  `atlas-roles-plan.ts` 198b4e84. All three are still untracked; commit them together with this evidence.
- **AR-1 fixed.** The report lists flattened `ACTION@db.collection` `added`/`removed` sets per role, and
  `removedRoles`/`addedRoles` per user.
- **AR-2 fixed.** Database names come from `EXPUNGE_*_DB`; unset names are refused, never defaulted.
- **AR-3 fixed.** Roles are compared as flattened sets.
- **AR-4 fixed.** `projectId` is reported as `set` or `missing`.
- One Accept constant is shared by both scripts.

Run evidence (lead's scratchpad `atlas-dry.json`, `atlas-apply.json`, `atlas-dry2.json`, from a clean export of HEAD
13374c9):
- **Dry run:** 8 roles `patch` with **0 removed**, 1 role (`expunge_proposer`) noop, all 9 users noop. The 28 added entries
  are exactly:
  - the new collections: campaign authority and its separate touches collection, `run_attestations`, `guard_exports`,
    `subject_set_generations`;
  - DP-2: issuer FIND on `artifact_eligibility` and `provenance_edges`;
  - domain-executor FIND on `telemetry_outbox`;
  - F-8: projection-reader FIND on `gate_reports`;
  - grader FIND on `completion_receipts`, `effects`, `preview_plans` and `run_attestations`.

  The campaign authority is now insert-only for the fixture builder, and UPDATE is granted only on
  `campaign_authority_touches`, which matches DA-14 CA-1.
- **Apply:** those 8 roles were patched, each `verified: true`. No user was touched.
- **Confirming dry run:** all roles and users noop.

**DA-17 is CLOSED.** One note for the probe: DP-2 also suggested FIND on `provenance_closures` for the approval issuer.
It was not added. If `ProvenanceRepository.tainted` reads closures for ancestry, the live RBAC probe of the issuer's
descriptor render will show it.
