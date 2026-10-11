import type { Document } from 'mongodb';
import {
  CONTROL_COLLECTIONS,
  PRINCIPALS,
  PRIVATE_COLLECTIONS,
  WORLD_COLLECTIONS,
  atlasRoleManifests,
  createPrincipalService,
  mongoConfigFromEnv,
  type Principal,
} from '@expunge/mongo';

/**
 * Atlas RBAC probe, READ-ONLY by construction. For every principal that has a role manifest and a configured URI it tries each
 * verb on each collection with an operation that cannot change data whether or not it is authorized:
 *   find   : findOne on an _id that cannot exist (returns null; reads nothing)
 *   update : updateOne on a filter that matches nothing (no document, no upsert)
 *   remove : deleteOne on a filter that matches nothing
 *   insert : insertOne of a document that violates the collection's strict validator, so an authorized insert is rejected by
 *            the validator (code 121) and an unauthorized one by authorization (code 13). A collection WITHOUT a validator is
 *            not probed for insert (it would write): it is reported `not-probed`.
 * Insert probing is decided from the LIVE collection options (RP-2): only a collection whose validator is strict
 * (`additionalProperties: false`, `validationAction: error`, `validationLevel: strict`) as read from the server by the setup
 * principal is insert-probed. Separately (RP-1) each principal's full `connectionStatus` privilege set and role list are compared
 * for EXACT equality with the manifest, which also covers changeStream, DDL, cluster, admin/local/config and built-in roles.
 * Authorization is checked before validation and before matching, so "denied" means code 13 and "allowed" means the server got
 * past authorization. Each outcome is compared with what `atlasRoleManifests()` says should be allowed. Connection strings come
 * from the MONGODB_<PRINCIPAL>_URI variables by name; nothing secret is printed, only principal, collection, verb and outcome.
 */
const MISS = '__rbac_probe_no_such_id__';
type Verb = 'find' | 'insert' | 'update' | 'remove';
type Outcome = 'allowed' | 'denied' | 'allowed(validator-rejected)' | 'not-probed' | `error:${string}`;
const VERB_ACTION: Record<Verb, string> = {
  find: 'FIND',
  insert: 'INSERT',
  update: 'UPDATE',
  remove: 'REMOVE',
};

const config = mongoConfigFromEnv();
const names = {
  world: config.worldDatabase ?? 'expunge_world',
  control: config.controlDatabase ?? 'expunge_control',
  private: config.privateDatabase ?? 'expunge_private',
};
const manifests = atlasRoleManifests(names);
/**
 * True only when the schema certainly rejects a document carrying an unknown field: every branch of an anyOf/oneOf, or the
 * object itself, has `additionalProperties: false`. Anything looser is not insert-probed, so the probe can never write.
 */
function rejectsProbeDocument(schema: Document | undefined): boolean {
  const check = (node: Document | undefined): boolean => {
    if (!node) return false;
    const branches = (node.anyOf ?? node.oneOf) as Document[] | undefined;
    if (Array.isArray(branches)) return branches.length > 0 && branches.every(check);
    return node.additionalProperties === false;
  };
  return check(schema?.$jsonSchema as Document | undefined);
}
/** Collections whose live options make the insert probe certainly non-mutating, per database. */
const validated: Record<string, Set<string>> = {};
async function loadLiveValidators(): Promise<{ read: boolean }> {
  if (!config.uris.setup) return { read: false };
  const setup = createPrincipalService(config, 'setup');
  try {
    await setup.client.connect();
    for (const db of [names.world, names.control, names.private]) {
      const strictNames = new Set<string>();
      for (const entry of await setup.client.db(db).listCollections().toArray()) {
        const options = (entry as { options?: Document }).options ?? {};
        const level = options.validationLevel ?? 'strict';
        const action = options.validationAction ?? 'error';
        if (
          options.validator &&
          level === 'strict' &&
          action === 'error' &&
          rejectsProbeDocument({ $jsonSchema: options.validator.$jsonSchema })
        )
          strictNames.add(entry.name);
      }
      validated[db] = strictNames;
    }
    return { read: true };
  } finally {
    await setup.close();
  }
}
const namespaces: Array<{ db: string; collection: string }> = [
  ...WORLD_COLLECTIONS.map((collection) => ({ db: names.world, collection })),
  ...CONTROL_COLLECTIONS.map((collection) => ({ db: names.control, collection: String(collection) })),
  ...PRIVATE_COLLECTIONS.map((collection) => ({ db: names.private, collection })),
];
/** Manifest action names in the form the server reports them in `connectionStatus`. */
const SERVER_ACTION: Record<string, string> = {
  FIND: 'find',
  INSERT: 'insert',
  UPDATE: 'update',
  REMOVE: 'remove',
  CHANGE_STREAM: 'changeStream',
};
/** Every (action, resource) the manifest grants, flattened: `find@db.collection`. */
const manifestEntries = (principal: Principal): Set<string> =>
  new Set(
    (manifests[principal]?.actions ?? []).flatMap((a) =>
      a.resources.map((r) => `${SERVER_ACTION[a.action] ?? a.action}@${r.db}.${r.collection}`),
    ),
  );
/**
 * RP-1: the principal's full privilege set, exactly as the server reports it, against the manifest. Anything the server grants
 * that the manifest does not (a database-wide or cluster privilege, DDL actions, other databases) is `extra`; anything the
 * manifest grants that the server does not report is `missing`. The user's roles must be exactly the one custom role.
 */
async function exactPrivileges(principal: Principal, status: Document) {
  const privileges: Array<{
    resource?: { db?: string; collection?: string; cluster?: boolean };
    actions?: string[];
  }> = status.authInfo?.authenticatedUserPrivileges ?? [];
  const granted = new Set<string>();
  for (const entry of privileges)
    for (const action of entry.actions ?? [])
      granted.add(
        entry.resource?.cluster
          ? `${action}@cluster`
          : `${action}@${entry.resource?.db ?? ''}.${entry.resource?.collection ?? ''}`,
      );
  const wanted = manifestEntries(principal);
  const roles: Array<{ role: string; db: string }> = status.authInfo?.authenticatedUserRoles ?? [];
  const expectedRole = manifests[principal]!.roleName;
  return {
    principal,
    roles: roles.map((r) => `${r.db}.${r.role}`),
    rolesExact: roles.length === 1 && roles[0]!.role === expectedRole && roles[0]!.db === 'admin',
    privilegeEntries: granted.size,
    extra: [...granted].filter((e) => !wanted.has(e)).sort(),
    missing: [...wanted].filter((e) => !granted.has(e)).sort(),
  };
}
const expectedAllowed = (principal: Principal, verb: Verb, db: string, collection: string): boolean =>
  manifests[principal]?.actions.some(
    (a) =>
      a.action === VERB_ACTION[verb] && a.resources.some((r) => r.db === db && r.collection === collection),
  ) ?? false;

const codeOf = (error: unknown): number | null =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : null;

async function probeOne(
  principal: Principal,
  db: string,
  collection: string,
  verb: Verb,
  run: (operation: () => Promise<unknown>) => Promise<Outcome>,
  handle: ReturnType<ReturnType<typeof createPrincipalService>['client']['db']>,
): Promise<Outcome> {
  void principal;
  const c = handle.collection<Document>(collection);
  switch (verb) {
    case 'find':
      return run(() => c.findOne({ _id: MISS as never }, { maxTimeMS: 5000 }));
    case 'update':
      return run(() =>
        c.updateOne({ _id: MISS as never }, { $set: { __rbac_probe__: 1 } }, { maxTimeMS: 5000 }),
      );
    case 'remove':
      return run(() => c.deleteOne({ _id: MISS as never }, { maxTimeMS: 5000 }));
    case 'insert':
      if (!validated[db]?.has(collection)) return 'not-probed';
      return run(() => c.insertOne({ _id: MISS as never, __rbac_probe_invalid__: true }));
  }
}

const live = await loadLiveValidators();
const exact: Array<Awaited<ReturnType<typeof exactPrivileges>>> = [];
const results: Array<{
  principal: string;
  db: string;
  collection: string;
  verb: Verb;
  outcome: Outcome;
  expected: boolean;
}> = [];
const missing: string[] = [];
const wrote: string[] = [];
for (const principal of PRINCIPALS) {
  if (!manifests[principal]) continue;
  if (!config.uris[principal]) {
    missing.push(principal);
    continue;
  }
  const service = createPrincipalService(config, principal);
  try {
    await service.client.connect();
    exact.push(
      await exactPrivileges(
        principal,
        await service.world.command({ connectionStatus: 1, showPrivileges: true }),
      ),
    );
    const run = async (operation: () => Promise<unknown>): Promise<Outcome> => {
      try {
        await operation();
        return 'allowed';
      } catch (error) {
        const code = codeOf(error);
        if (code === 13) return 'denied';
        if (code === 121) return 'allowed(validator-rejected)';
        return `error:${code ?? 'unknown'}`;
      }
    };
    for (const { db, collection } of namespaces) {
      const handle = service.client.db(db);
      for (const verb of ['find', 'insert', 'update', 'remove'] as Verb[]) {
        const outcome = await probeOne(principal, db, collection, verb, run, handle);
        // An insert that was accepted would have been a write. Report it loudly (it should be impossible: no validator-valid doc).
        if (verb === 'insert' && outcome === 'allowed') wrote.push(`${principal}:${db}.${collection}`);
        results.push({
          principal,
          db,
          collection,
          verb,
          outcome,
          expected: expectedAllowed(principal, verb, db, collection),
        });
      }
    }
  } finally {
    await service.close();
  }
}

const isAllowed = (o: Outcome) => o === 'allowed' || o === 'allowed(validator-rejected)';
const surprises = results.filter(
  (r) => r.outcome !== 'not-probed' && !r.outcome.startsWith('error:') && isAllowed(r.outcome) !== r.expected,
);
const errors = results.filter((r) => r.outcome.startsWith('error:'));
const summary: Record<
  string,
  { probed: number; allowed: number; denied: number; notProbed: number; errors: number; surprises: number }
> = {};
for (const r of results) {
  const s = (summary[r.principal] ??= {
    probed: 0,
    allowed: 0,
    denied: 0,
    notProbed: 0,
    errors: 0,
    surprises: 0,
  });
  if (r.outcome === 'not-probed') s.notProbed++;
  else if (r.outcome.startsWith('error:')) s.errors++;
  else {
    s.probed++;
    if (isAllowed(r.outcome)) s.allowed++;
    else s.denied++;
  }
}
for (const r of surprises) summary[r.principal]!.surprises++;
console.log(
  JSON.stringify(
    {
      mode: 'read-only atlas rbac probe',
      databases: names,
      liveValidatorOptionsRead: live.read,
      principalsMissingUri: missing,
      exactPrivileges: exact,
      summary,
      surprises: surprises.map(({ principal, db, collection, verb, outcome, expected }) => ({
        principal,
        namespace: `${db}.${collection}`,
        verb,
        outcome,
        expectedAllowed: expected,
      })),
      errors: errors.map(({ principal, db, collection, verb, outcome }) => ({
        principal,
        namespace: `${db}.${collection}`,
        verb,
        outcome,
      })),
      unexpectedWrites: wrote,
      matrix: results
        .filter(() => process.argv.includes('--matrix'))
        .map(
          ({ principal, db, collection, verb, outcome }) =>
            `${principal} ${db}.${collection} ${verb} ${outcome}`,
        ),
    },
    null,
    2,
  ),
);
const inexact = exact.filter((e) => !e.rolesExact || e.extra.length > 0 || e.missing.length > 0);
if (surprises.length > 0 || wrote.length > 0 || inexact.length > 0 || !live.read) process.exitCode = 1;
