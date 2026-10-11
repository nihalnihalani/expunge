# DA-18: live Atlas RBAC probe (`scripts/atlas-rbac-probe.ts`, `docs/MONGO.md` "Atlas RBAC evidence")

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. Static read of the probe script and the MONGO.md section,
plus the shape of the raw output: `atlas-rbac-probe.json` has 9 principals × 79 collections × 4 verbs = 2844 matrix rows,
which is 288 probed plus 28 not probed per principal. Surprises, errors and unexpected writes are all empty. I did not
re-run it.

## Disposition: ACCEPT as evidence for exactly what it claims

The claim is that on the four data verbs, over the 79 registered collections, Atlas enforces `atlasRoleManifests()`
exactly. Two things are not proved by this probe and need an extra read-only step before anyone writes "least privilege
proved on Atlas":
- **RP-1:** that no principal holds privileges outside the 4 verbs or outside these collections and databases;
- **RP-3:** that every grant in the manifest is necessary.

## Can a "denied" result be a false negative?

**No, for the operations probed.**
- Code 13 (`Unauthorized`) comes only from the authorization layer. Atlas checks it before matching or validating, so
  "denied" means the server refused the verb on that namespace.
- The run had **0 `error:` outcomes**. Errors are excluded from the surprise count, so a non-zero error count would have
  hidden results; here there were none.
- A probe that reports "allowed" when it should report "denied" is also impossible: a 13 cannot turn into success.

What "denied" does **not** cover:
- the same capability reached through another action;
- a privilege the probe never exercises.

See RP-1.

## Is any principal's grant broader than its documented role?

**Not relative to the manifest. The probe shows equality on what it tests. But the probe cannot see everything.**

- **RP-1 (MEDIUM; required before "proved" is claimed): only 4 verbs on 79 named collections were probed.**
  - Not covered:
    - other actions: `changeStream`, `createIndex`, `collMod`, `dropCollection`, `createCollection`, `listCollections`,
      `killCursors`, `bypassDocumentValidation`, and others;
    - cluster-level privileges;
    - the `admin`, `local` and `config` databases;
    - any other database on the cluster;
    - collections that are not in the setup lists.
  - Example: a user that also carried a built-in `dbAdmin` (DDL with no data access), or a role on another database,
    would pass this probe with 0 surprises.
  - Fix, cheap and read-only:
    - for each principal, run `connectionStatus` with `showPrivileges: true`, which `probe:mongo` already does for the
      worker;
    - compare the **complete** returned privilege set (every action, every resource, cluster included) and the
      `authenticatedUserRoles` list against the manifest;
    - require exact equality: one custom role, nothing inherited, no built-in roles.

    That is the authoritative answer to "broader than documented", and it covers what the verb matrix cannot.
- **RP-2 (LOW-MEDIUM): the insert probe's safety rests on the code's validators, not the live ones.**
  - Collections are "strict" if `WORLD/CONTROL/PRIVATE_VALIDATORS` in code say so (`atlas-rbac-probe.ts:46-65`).
  - If a live Atlas collection were missing that validator (for example a collection created by older setup code), or had
    `validationAction: 'warn'`, or did not exist yet (an authorized insert then auto-creates it with no validator), then an
    authorized probe insert would **write**.
  - This run reports 0 unexpected writes, so it did not happen. But that is luck of state, not a property of the method.
  - Fix: read each collection's live options with `listCollections`. Insert-probe only when the live validator is strict
    and has `validationAction: 'error'` and `validationLevel: 'strict'`.
- **RP-3 (review, not a contradiction): manifest grants that look broader than the function needs.** The probe confirms
  these are granted as documented. Whether they are intended is a design question for mongodb-authority:
  - **`fixture_builder` holds UPDATE on `world.schema_registry`**, and also on `world.retained_invoices`.
    - The registry is meant to be insert-only per revision.
    - `ScopeRepository.read` returns the stored row without re-hashing its content (`mongo/src/scope.ts:235-242`).
      The `_id` is a hash of scope and revision only, not of the content.
    - So the fixture builder can edit a registry revision in place: drop a field or flip an identity flag. Jobs pinned to
      that revision would then run against a different coverage than the one they were bound to.
    - Fix: either insert-only (drop that UPDATE, as was done for `owner_sources`), or re-hash the content on read
      against a stored content digest.
  - **Five principals besides the worker can INSERT or UPDATE `jobs`:** observer, privacy controller, grader, fixture
    builder and promoter. This is the same breadth DA-11 F1-b relies on `run_attestations` to neutralize. Each one is
    worth justifying, or narrowing to the job kinds it creates.
  - **The promoter holds FIND on all 11 `expunge_world` collections**, including the customer records. Promotion reads
    artifacts, reports, policy and provenance. It is not obvious it needs domain records. Confirm, or remove.
  - **The grader's world and private reads are cluster-wide** (DA-13 GB-3). This is acceptable for the privileged
    evaluator, but it is not campaign-scoped.
- The `setup` principal is not probed, by design (no manifest). The MONGO.md section says so. Decision 21 / DA-10 A-1
  still applies: `setup` is `atlasAdmin` and sits in the agent-readable `.env`.

## Other notes

- The `provenance_closures` question is resolved by reading the code. `tainted`, `permitted` and `blockedByAncestry` read
  only `artifact_eligibility` and `provenance_edges`, and the probe shows the issuer denied on `provenance_closures`.
  Agreed.
- The 28 collections not insert-probed are listed honestly. Of those, `artifact_eligibility`, `provenance_edges`,
  `external_deletions`, `telemetry_outbox`, all seven domain collections and `schema_registry` are security-relevant for
  insert. RP-1's privilege-set comparison covers their insert grants without writing anything.
- MONGO.md's sentence "nothing is allowed that the manifest does not grant" should be qualified: "for find, insert,
  update and remove on the 79 registered collections". The same applies until RP-1 is done.
