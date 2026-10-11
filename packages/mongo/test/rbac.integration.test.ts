import { beforeAll, afterAll, expect, it } from 'vitest';
import { MongoClient, MongoServerError, type Document } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { contentHash } from '@expunge/contracts';
import {
  AuthorityRepository,
  CONTROL_COLLECTIONS,
  JobRepository,
  PRIVATE_COLLECTIONS,
  WORLD_COLLECTIONS,
  WorldRepository,
  CampaignArtifactRepository,
  ErasureSuppressionRepository,
  LessonRepository,
  MetaDrawCommitmentRepository,
  RawArtifactRepository,
  SubjectTokenRepository,
  WorldSplitRepository,
  atlasRoleManifests,
  createPrincipalService,
  setupMongo,
  type MongoService,
  type Principal,
} from '../src/index.js';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import { HASH, RBAC_URI, actor, claimRow, createJob, describeRbac, freezeRow } from './support.js';

/**
 * Raw-driver privilege tests on an authenticated LOCAL replica set (see auth-docker-compose.yml). Roles are
 * created with `createRole`, which is test tooling only: on Atlas they are provisioned through the Atlas
 * Administration API from `atlasRoleManifests`. This file is local privilege evidence, not Atlas evidence.
 */
const prefix = `expunge_rbac_${randomUUID().replaceAll('-', '')}`;
const names = { world: `${prefix}_world`, control: `${prefix}_control`, private: `${prefix}_private` };
const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const PRINCIPALS_UNDER_TEST = [
  'domain_executor',
  'observer',
  'proposer',
  'grader',
  'approval_issuer',
  'promoter',
  'projection_reader',
  'privacy_controller',
  'fixture_builder',
] as const satisfies readonly Principal[];
type Probe = 'find' | 'insert' | 'update' | 'remove';
const PROBES: Probe[] = ['find', 'insert', 'update', 'remove'];
const VERB_TO_PROBE: Record<string, Probe | undefined> = {
  FIND: 'find',
  INSERT: 'insert',
  UPDATE: 'update',
  REMOVE: 'remove',
};
const ACTION_NAMES: Record<string, string> = {
  FIND: 'find',
  INSERT: 'insert',
  UPDATE: 'update',
  REMOVE: 'remove',
  CHANGE_STREAM: 'changeStream',
};
const MARK = '__rbacProbe';
const UNAUTHORIZED = 13;

const JOB_WRITERS = [
  'domain_executor',
  'observer',
  'grader',
  'promoter',
  'privacy_controller',
  'fixture_builder',
] as const;
const clients = new Map<Principal, MongoClient>();
let setup: MongoService;

async function clientFor(principal: Principal): Promise<MongoClient> {
  const existing = clients.get(principal);
  if (existing) return existing;
  const password = randomUUID();
  const user = `${prefix}_${principal}`;
  const role = atlasRoleManifests(names)[principal]!;
  const privileges = role.actions.flatMap((action) =>
    action.resources.map((resource) => ({ resource, actions: [ACTION_NAMES[action.action]!] })),
  );
  await setup.client.db('admin').command({ createRole: user, privileges, roles: [] });
  await setup.client
    .db('admin')
    .command({ createUser: user, pwd: password, roles: [{ role: user, db: 'admin' }] });
  const target = new URL(RBAC_URI!);
  target.username = user;
  target.password = password;
  const client = new MongoClient(target.toString(), { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  clients.set(principal, client);
  return client;
}
const dbName = (db: 'world' | 'control' | 'private') => names[db];
/** A MongoService over a principal's real, authenticated client, so repositories run with exactly its privileges. */
async function serviceFor(principal: Principal): Promise<MongoService> {
  const client = await clientFor(principal);
  return {
    principal,
    client,
    world: client.db(names.world),
    control: client.db(names.control),
    transaction: (work) =>
      client.withSession((session) =>
        session.withTransaction(() => work(session), {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      ),
    close: async () => undefined,
  } as MongoService;
}
/**
 * Runs one raw-driver probe. `denied` means the server answered Unauthorized (13). A validation failure or a
 * successful no-op means the privilege exists.
 */
async function probe(
  principal: Principal,
  db: 'world' | 'control' | 'private',
  collection: string,
  kind: Probe,
): Promise<'denied' | 'allowed'> {
  const target = (await clientFor(principal)).db(dbName(db)).collection<Document>(collection);
  try {
    if (kind === 'find') await target.findOne({ [MARK]: 'none' });
    if (kind === 'insert') await target.insertOne({ [MARK]: 'row' });
    if (kind === 'update') await target.updateOne({ [MARK]: 'none' }, { $set: { [MARK]: 'x' } });
    if (kind === 'remove') await target.deleteOne({ [MARK]: 'none' });
    return 'allowed';
  } catch (error) {
    if (!(error instanceof MongoServerError)) throw error;
    if (error.code === UNAUTHORIZED) return 'denied';
    // Any other server answer (document validation, duplicate key) happened after authorization succeeded.
    return 'allowed';
  }
}
const DATABASES: Array<['world' | 'control' | 'private', readonly string[]]> = [
  ['world', WORLD_COLLECTIONS],
  ['control', CONTROL_COLLECTIONS],
  ['private', PRIVATE_COLLECTIONS],
];

describeRbac('real authenticated local replica-set RBAC (not Atlas provisioning)', () => {
  beforeAll(async () => {
    setup = createPrincipalService(
      {
        uris: { setup: RBAC_URI! },
        worldDatabase: names.world,
        controlDatabase: names.control,
        privateDatabase: names.private,
      },
      'setup',
    );
    await setup.client.connect();
    await setupMongo(setup);
    const bundle = validBundle();
    await setup.control
      .collection<Document & { _id: string }>('artifacts')
      .insertOne({ _id: contentHash(bundle), payload: bundle, createdAt: new Date(), sourceBlobIds: [] });
    await setup.privateDb!.collection('oracle_manifests').insertOne({ answer: 'sealed' });
    await setup.world.collection('retained_invoices').insertOne({ retention: 'required' });
    await new WorldRepository(setup).create(scope, 'w', 1);
    await new AuthorityRepository(setup).install(scope, HASH);
  }, 60000);
  afterAll(async () => {
    for (const client of clients.values()) await client.close();
    if (!setup) return;
    await setup.world.dropDatabase();
    await setup.control.dropDatabase();
    await setup.privateDb!.dropDatabase();
    const roles = await setup.client.db('admin').command({ rolesInfo: 1 });
    for (const row of roles.roles ?? [])
      if (row.role.startsWith(prefix)) await setup.client.db('admin').command({ dropRole: row.role });
    const users = await setup.client.db('admin').command({ usersInfo: 1 });
    for (const row of users.users ?? [])
      if (row.user.startsWith(prefix)) await setup.client.db('admin').command({ dropUser: row.user });
    await setup.close();
  }, 60000);

  it('enforces exactly the manifest for every principal, database, collection and verb (no inherited grants)', async () => {
    const manifests = atlasRoleManifests(names);
    const mismatches: string[] = [];
    for (const principal of PRINCIPALS_UNDER_TEST) {
      const granted = new Set<string>();
      for (const action of manifests[principal]!.actions) {
        const probeKind = VERB_TO_PROBE[action.action];
        if (!probeKind) continue;
        for (const { db, collection } of action.resources) granted.add(`${db}/${collection}/${probeKind}`);
      }
      for (const [alias, collections] of DATABASES) {
        for (const collection of collections) {
          for (const kind of PROBES) {
            const expected = granted.has(`${dbName(alias)}/${collection}/${kind}`) ? 'allowed' : 'denied';
            const actual = await probe(principal, alias, collection, kind);
            if (actual !== expected)
              mismatches.push(
                `${principal} ${kind} ${alias}.${collection}: expected ${expected}, got ${actual}`,
              );
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    // The probes inserted marker rows wherever a role may insert; remove them with the setup principal.
    for (const [alias, collections] of DATABASES) {
      const db = alias === 'world' ? setup.world : alias === 'control' ? setup.control : setup.privateDb!;
      for (const collection of collections)
        await db.collection(collection).deleteMany({ [MARK]: { $exists: true } });
    }
  }, 120000);

  /**
   * Explicit negatives, written out so a manifest regression cannot make the matrix above agree with itself.
   * Each tuple is [principal, database, collection, verb] that must be refused by the server.
   */
  const MUST_BE_DENIED: Array<[Principal, 'world' | 'control' | 'private', string, Probe, string]> = [
    ['proposer', 'private', 'oracle_manifests', 'find', 'proposer reads sealed truth'],
    ['proposer', 'control', 'artifacts', 'update', 'proposer edits an admitted artifact'],
    ['proposer', 'control', 'artifacts', 'remove', 'proposer deletes an admitted artifact'],
    ['proposer', 'control', 'candidates', 'update', 'proposer edits a candidate after inserting it'],
    ['proposer', 'control', 'candidates', 'remove', 'proposer deletes a candidate'],
    ['proposer', 'control', 'gate_reports', 'insert', 'proposer writes the gate class (L11)'],
    ['proposer', 'control', 'grant_consumptions', 'insert', 'proposer burns a grant'],
    ['proposer', 'control', 'authority_policies', 'update', 'proposer edits the approval policy'],
    ['proposer', 'control', 'jobs', 'update', 'proposer touches job state'],
    ['domain_executor', 'world', 'retained_invoices', 'remove', 'executor removes retained data'],
    ['domain_executor', 'world', 'retained_invoices', 'update', 'executor rewrites retained data'],
    ['domain_executor', 'world', 'schema_registry', 'insert', 'executor widens its registry (D9/D13)'],
    ['domain_executor', 'world', 'schema_registry', 'update', 'executor rewrites its registry'],
    [
      'domain_executor',
      'world',
      'world_scope_bindings',
      'update',
      'executor rebinds the scope revision (D13)',
    ],
    ['domain_executor', 'world', 'world_scope_bindings', 'insert', 'executor creates a world binding'],
    [
      'domain_executor',
      'control',
      'authority_revisions',
      'update',
      'executor edits its own authorization (D8)',
    ],
    ['domain_executor', 'control', 'authority_revisions', 'insert', 'executor installs authorization (D8)'],
    ['domain_executor', 'control', 'authority_policies', 'update', 'executor edits the approval policy'],
    ['domain_executor', 'control', 'decisions', 'update', 'executor edits a recorded decision (D8)'],
    ['domain_executor', 'control', 'decisions', 'remove', 'executor deletes a recorded decision (D8)'],
    ['domain_executor', 'control', 'gate_reports', 'insert', 'executor writes a gate report'],
    ['domain_executor', 'control', 'candidates', 'update', 'executor edits a candidate'],
    ['domain_executor', 'control', 'approvals', 'update', 'executor edits a grant'],
    ['domain_executor', 'private', 'oracle_manifests', 'find', 'executor reads sealed truth'],
    ['promoter', 'control', 'approvals', 'insert', 'promoter mints a human approval'],
    ['promoter', 'control', 'approvals', 'update', 'promoter rewrites an unconsumed grant (D13)'],
    ['promoter', 'control', 'grant_consumptions', 'update', 'promoter un-consumes a grant'],
    ['promoter', 'control', 'grant_consumptions', 'remove', 'promoter deletes a consumption'],
    ['promoter', 'control', 'authority_revisions', 'update', 'promoter edits authorization (D8)'],
    ['promoter', 'control', 'authority_policies', 'update', 'promoter edits the approval policy'],
    ['promoter', 'control', 'authority_policies', 'insert', 'promoter installs an approval policy'],
    ['promoter', 'control', 'gate_reports', 'insert', 'promoter writes a gate report'],
    ['promoter', 'control', 'decisions', 'insert', 'promoter writes a decision'],
    ['promoter', 'control', 'candidates', 'insert', 'promoter proposes a candidate'],
    ['promoter', 'world', 'schema_registry', 'update', 'promoter rewrites a registry'],
    ['approval_issuer', 'control', 'approvals', 'update', 'issuer edits a grant after issuing'],
    ['approval_issuer', 'control', 'approvals', 'remove', 'issuer deletes a grant'],
    ['approval_issuer', 'control', 'gate_reports', 'insert', 'issuer writes a gate report'],
    ['approval_issuer', 'world', 'world_scope_bindings', 'update', 'issuer rebinds a world'],
    ['grader', 'control', 'gate_reports', 'update', 'grader edits a gate report after the fact'],
    ['grader', 'control', 'gate_reports', 'remove', 'grader deletes a gate report'],
    ['grader', 'control', 'candidates', 'update', 'grader edits a candidate'],
    ['grader', 'control', 'authority_revisions', 'update', 'grader edits authorization'],
    ['observer', 'world', 'world_scope_bindings', 'update', 'observer rebinds a world'],
    ['observer', 'world', 'world_revisions', 'update', 'observer advances a world counter'],
    ['observer', 'world', 'customers', 'find', 'observer reads domain records'],
    ['privacy_controller', 'world', 'world_scope_bindings', 'update', 'privacy controller rebinds a world'],
    ['privacy_controller', 'world', 'world_revisions', 'update', 'privacy controller advances a counter'],
    ['projection_reader', 'control', 'jobs', 'update', 'projection reader mutates jobs'],
    ['projection_reader', 'control', 'authority_revisions', 'find', 'projection reader reads authorization'],
    ['fixture_builder', 'control', 'authority_revisions', 'update', 'fixture builder edits authorization'],
    ['fixture_builder', 'control', 'decisions', 'insert', 'fixture builder writes a decision'],
    ['fixture_builder', 'control', 'approvals', 'insert', 'fixture builder mints an approval'],
  ];
  it.each(MUST_BE_DENIED)('%s cannot %s %s.%s (%s)', async (principal, db, collection, kind) => {
    expect(await probe(principal, db, collection, kind)).toBe('denied');
  });

  /** The positive side of the same boundaries: each owner can still do exactly its job. */
  const MUST_BE_ALLOWED: Array<[Principal, 'world' | 'control' | 'private', string, Probe, string]> = [
    ['proposer', 'control', 'candidates', 'insert', 'proposer inserts a candidate (no class field)'],
    ['domain_executor', 'control', 'authority_touches', 'update', 'executor fences with the touch counter'],
    ['domain_executor', 'world', 'world_revisions', 'update', 'executor advances the revision counter'],
    ['domain_executor', 'control', 'decisions', 'insert', 'the gateway records a decision'],
    ['promoter', 'control', 'grant_consumptions', 'insert', 'promoter consumes a grant by insert'],
    ['promoter', 'control', 'authority_touches', 'update', 'promoter fences with the touch counter'],
    [
      'approval_issuer',
      'control',
      'authority_revisions',
      'update',
      'issuer bumps the authorization revision',
    ],
    [
      'approval_issuer',
      'control',
      'authority_touches',
      'update',
      'issuer rewrites the touch row with the bump',
    ],
    ['grader', 'control', 'gate_reports', 'insert', 'grader writes the gate report and class'],
    ['fixture_builder', 'world', 'world_scope_bindings', 'update', 'fixture builder rebinds a world'],
    ['observer', 'world', 'world_revisions', 'find', 'observer reads the world rows jobs bind to'],
  ];
  it.each(MUST_BE_ALLOWED)('%s can %s %s.%s (%s)', async (principal, db, collection, kind) => {
    expect(await probe(principal, db, collection, kind)).toBe('allowed');
    const target = db === 'world' ? setup.world : db === 'control' ? setup.control : setup.privateDb!;
    await target.collection(collection).deleteMany({ [MARK]: { $exists: true } });
  });

  it('proposer insert-only privilege still enforces nested strict BSON validation', async () => {
    const proposer = await clientFor('proposer');
    const b = validBundle();
    await expect(
      proposer
        .db(names.control)
        .collection<Document & { _id: string }>('artifacts')
        .insertOne({
          _id: 'b'.repeat(64),
          payload: {
            ...b,
            guardrails: [
              {
                ruleId: 'r',
                predicate: {
                  op: 'not',
                  predicate: {
                    op: 'compare',
                    comparator: 'eq',
                    left: { kind: 'fact', factId: 'f' },
                    right: { kind: 'constant', value: 'raw@example.com' },
                  },
                },
                result: 'allow',
                sourceEvidenceIds: [],
              },
            ],
          },
          createdAt: new Date(),
          sourceBlobIds: [],
        }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it('no runtime role can bypass validation or alter a validator', async () => {
    const proposer = await clientFor('proposer');
    await expect(
      proposer
        .db(names.control)
        .collection('artifacts')
        .insertOne({ raw: 'x' }, { bypassDocumentValidation: true }),
    ).rejects.toMatchObject({ code: UNAUTHORIZED });
    await expect(
      proposer.db(names.control).command({ collMod: 'artifacts', validator: {} }),
    ).rejects.toMatchObject({ code: UNAUTHORIZED });
    const executor = await clientFor('domain_executor');
    await expect(
      executor.db(names.control).command({ collMod: 'decisions', validator: {} }),
    ).rejects.toMatchObject({ code: UNAUTHORIZED });
  });

  it('job status: the validator blocks an empty "succeeded" from every job writer; the receipt rule itself is application-enforced', async () => {
    // Six principals hold UPDATE on jobs (collection-level RBAC cannot split fields or values), so the receipt
    // rule lives in JobRepository.finish. The query-operator validator is the only structural guard, and it only
    // catches the degenerate "succeeded with nothing to point at". See docs/MONGO.md.
    await new WorldRepository(setup).create(scope, 'job-world', 1);
    const job = await new JobRepository(setup).create(actor, {
      jobId: 'raw-status-job',
      kind: 'cleanup',
      binding: {
        runId: 'r',
        worldId: 'job-world',
        harnessHash: HASH,
        scopeRevision: 1,
        workerProfileHash: HASH,
      },
    });
    for (const principal of JOB_WRITERS) {
      const jobs = (await clientFor(principal)).db(names.control).collection<Document>('jobs');
      await expect(
        jobs.updateOne({ _id: job._id as never }, { $set: { status: 'succeeded' } }),
        `${principal} bare succeeded`,
      ).rejects.toMatchObject({ code: 121 });
    }
    const worker = (await clientFor('domain_executor')).db(names.control).collection<Document>('jobs');
    // KNOWN LIMITATION, asserted so a change is noticed: fabricated refs pass the validator at the database.
    await expect(
      worker.updateOne(
        { _id: job._id as never },
        { $set: { status: 'succeeded', outputRefs: ['fabricated'] } },
      ),
    ).resolves.toMatchObject({ modifiedCount: 1 });
  });

  it('gate, fault, refusal and permit collections: named raw-driver denials (DA-8 C1)', async () => {
    type Kind = 'find' | 'insert' | 'update' | 'remove';
    const denied = async (principal: Principal, collection: string, kinds: Kind[]) => {
      for (const kind of kinds)
        expect(
          await probe(principal, 'control', collection, kind),
          `${principal} ${kind} ${collection}`,
        ).toBe('denied');
    };
    const allowed = async (principal: Principal, collection: string, kinds: Kind[]) => {
      for (const kind of kinds)
        expect(
          await probe(principal, 'control', collection, kind),
          `${principal} ${kind} ${collection}`,
        ).toBe('allowed');
    };
    // Frozen values: written once by the fixture builder, read by the grader, changed by nobody.
    await allowed('fixture_builder', 'campaign_freezes', ['find', 'insert']);
    await allowed('grader', 'campaign_freezes', ['find']);
    await denied('grader', 'campaign_freezes', ['insert', 'update', 'remove']);
    await denied('fixture_builder', 'campaign_freezes', ['update', 'remove']);
    await denied('proposer', 'campaign_freezes', ['find', 'insert', 'update', 'remove']);
    await denied('domain_executor', 'campaign_freezes', ['find', 'insert', 'update', 'remove']);
    // Claims, attempt counters and held runs belong to the grader alone; nothing is ever removed.
    for (const collection of ['gate_claims', 'gate_attempts', 'gate_held_runs']) {
      await allowed('grader', collection, ['find', 'insert']);
      await denied('grader', collection, ['remove']);
      await denied('fixture_builder', collection, ['find', 'insert', 'update', 'remove']);
      await denied('proposer', collection, ['find', 'insert', 'update', 'remove']);
      await denied('domain_executor', collection, ['find', 'insert', 'update', 'remove']);
    }
    await denied('grader', 'gate_held_runs', ['update']);
    // The fault plan: the worker reads it for a campaign world and can never write it.
    await allowed('fixture_builder', 'world_faults', ['insert']);
    await allowed('domain_executor', 'world_faults', ['find']);
    await denied('domain_executor', 'world_faults', ['insert', 'update', 'remove']);
    await denied('grader', 'world_faults', ['insert', 'update', 'remove']);
    await denied('fixture_builder', 'world_faults', ['update', 'remove']);
    await denied('proposer', 'world_faults', ['find', 'insert']);
    // The gateway's step log: the grader reads the fault attestation and can write nothing there.
    await allowed('grader', 'domain_steps', ['find']);
    await denied('grader', 'domain_steps', ['insert', 'update', 'remove']);
    await denied('proposer', 'domain_steps', ['find', 'insert']);
    // Refused rollbacks: inserted by the promoter, audit-only.
    await allowed('promoter', 'rollback_refusals', ['insert']);
    await denied('promoter', 'rollback_refusals', ['update', 'remove']);
    await denied('domain_executor', 'rollback_refusals', ['insert', 'update', 'remove']);
    await denied('observer', 'rollback_refusals', ['insert']);
    // A campaign permit is not an eligibility row: the grader cannot make any artifact eligible for a production run.
    await allowed('grader', 'campaign_artifact_permits', ['find', 'insert']);
    await denied('grader', 'campaign_artifact_permits', ['update', 'remove']);
    await allowed('domain_executor', 'campaign_artifact_permits', ['find']);
    await denied('domain_executor', 'campaign_artifact_permits', ['insert', 'update', 'remove']);
    await denied('grader', 'artifact_eligibility', ['insert', 'update', 'remove']);
    await denied('fixture_builder', 'artifact_eligibility', ['insert', 'update', 'remove']);
    // Episode evidence for the gate: read-only for the grader.
    for (const name of ['completion_receipts', 'effects', 'preview_plans']) {
      await allowed('grader', name, ['find']);
      await denied('grader', name, ['insert', 'update', 'remove']);
    }
    // The operator Evaluation view reads gate reports; it cannot write them.
    await allowed('projection_reader', 'gate_reports', ['find']);
    await denied('projection_reader', 'gate_reports', ['insert', 'update', 'remove']);
    // The fixture builder can write NO standing authority: raw-driver inserts are denied. Its campaign row is separate.
    await denied('fixture_builder', 'authority_revisions', ['insert', 'update', 'remove']);
    await denied('fixture_builder', 'authority_touches', ['insert', 'update', 'remove']);
    await allowed('fixture_builder', 'campaign_authority', ['find', 'insert']);
    await denied('fixture_builder', 'campaign_authority', ['update', 'remove']);
    // The floor and revision cannot be rewritten by the principals that fence; only the counter row is theirs.
    await allowed('domain_executor', 'campaign_authority', ['find']);
    await denied('domain_executor', 'campaign_authority', ['insert', 'update', 'remove']);
    await allowed('promoter', 'campaign_authority', ['find']);
    await denied('promoter', 'campaign_authority', ['insert', 'update', 'remove']);
    await allowed('fixture_builder', 'campaign_authority_touches', ['insert']);
    await denied('fixture_builder', 'campaign_authority_touches', ['update', 'remove']);
    await allowed('domain_executor', 'campaign_authority_touches', ['find', 'update']);
    await denied('domain_executor', 'campaign_authority_touches', ['insert', 'remove']);
    await allowed('promoter', 'campaign_authority_touches', ['find', 'update']);
    await denied('grader', 'campaign_authority', ['insert', 'update', 'remove']);
  });

  it('PKT-62 collections: named raw-driver denials', async () => {
    type Kind = 'find' | 'insert' | 'update' | 'remove';
    const expectAll = async (
      principal: Principal,
      collection: string,
      kinds: Kind[],
      verdict: 'denied' | 'allowed',
    ) => {
      for (const kind of kinds)
        expect(
          await probe(principal, 'control', collection, kind),
          `${principal} ${kind} ${collection}`,
        ).toBe(verdict);
    };
    // Campaign results are insert-only for the grader, read by the service and the projection, never edited.
    for (const collection of [
      'campaign_artifacts',
      'campaign_artifact_rows',
      'adversary_trials',
      'adversary_campaigns',
    ]) {
      await expectAll('grader', collection, ['find', 'insert'], 'allowed');
      await expectAll('grader', collection, ['update', 'remove'], 'denied');
      await expectAll('proposer', collection, ['find', 'insert', 'update', 'remove'], 'denied');
      await expectAll('fixture_builder', collection, ['insert', 'update', 'remove'], 'denied');
    }
    await expectAll('projection_reader', 'campaign_artifacts', ['find'], 'allowed');
    await expectAll('projection_reader', 'campaign_artifacts', ['insert', 'update', 'remove'], 'denied');
    await expectAll('domain_executor', 'campaign_artifact_rows', ['find'], 'allowed');
    await expectAll('domain_executor', 'campaign_artifact_rows', ['insert', 'update', 'remove'], 'denied');
    // The meta draw record: fixture_builder inserts and reads; a second write or an edit is not possible by grant.
    await expectAll('fixture_builder', 'meta_draw_commitments', ['find', 'insert'], 'allowed');
    await expectAll('fixture_builder', 'meta_draw_commitments', ['update', 'remove'], 'denied');
    await expectAll('grader', 'meta_draw_commitments', ['find'], 'allowed');
    await expectAll('grader', 'meta_draw_commitments', ['insert', 'update', 'remove'], 'denied');
    await expectAll('proposer', 'meta_draw_commitments', ['find', 'insert', 'update', 'remove'], 'denied');
    await expectAll(
      'domain_executor',
      'meta_draw_commitments',
      ['find', 'insert', 'update', 'remove'],
      'denied',
    );
    // World splits: written once at seed time by the fixture builder, read by the observer and the grader.
    await expectAll('fixture_builder', 'world_splits', ['insert'], 'allowed');
    await expectAll('fixture_builder', 'world_splits', ['update', 'remove'], 'denied');
    await expectAll('observer', 'world_splits', ['find'], 'allowed');
    await expectAll('observer', 'world_splits', ['insert', 'update', 'remove'], 'denied');
    await expectAll('proposer', 'world_splits', ['find'], 'denied');
    // Export suppression: the observer and the service read it and can read nothing of the erasure jobs themselves.
    await expectAll('observer', 'erasure_suppressions', ['find'], 'allowed');
    await expectAll('observer', 'erasure_suppressions', ['insert', 'update', 'remove'], 'denied');
    await expectAll('domain_executor', 'erasure_suppressions', ['find'], 'allowed');
    await expectAll('domain_executor', 'erasure_suppressions', ['insert', 'update', 'remove'], 'denied');
    await expectAll('observer', 'external_deletions', ['find', 'insert', 'update', 'remove'], 'denied');
    await expectAll(
      'domain_executor',
      'external_deletions',
      ['find', 'insert', 'update', 'remove'],
      'denied',
    );
    await expectAll('privacy_controller', 'erasure_suppressions', ['find', 'insert', 'update'], 'allowed');
    await expectAll('privacy_controller', 'erasure_suppressions', ['remove'], 'denied');
    // Privacy stores: a tombstone replaces a row; nobody else touches them.
    await expectAll('privacy_controller', 'raw_artifacts', ['find', 'insert', 'update', 'remove'], 'allowed');
    await expectAll('privacy_controller', 'lessons', ['find', 'insert', 'update'], 'allowed');
    await expectAll('privacy_controller', 'lessons', ['remove'], 'denied');
    await expectAll('privacy_controller', 'subject_tokens', ['find', 'insert', 'remove'], 'allowed');
    await expectAll('privacy_controller', 'subject_tokens', ['update'], 'denied');
    for (const collection of ['raw_artifacts', 'subject_tokens'])
      await expectAll('grader', collection, ['find', 'insert', 'update', 'remove'], 'denied');
  });

  it('PKT-62 repositories run with exactly the privileges their principals hold', async () => {
    const campaign = 'rbac-campaign';
    const parent = 'a'.repeat(64);
    const child = 'b'.repeat(64);
    const control = setup.control;
    await new WorldRepository(setup).create(scope, 'rbac-campaign-world', 1, { campaignId: campaign });
    await control.collection('campaign_freezes').insertOne(freezeRow(campaign) as never);
    await control
      .collection('gate_claims')
      .insertOne(claimRow({ campaignId: campaign, parentHash: parent, childProjectionHash: child }) as never);

    // grader: commits rows and a summary; the event append, the scope checks and the reads all hold grants.
    const grader = new CampaignArtifactRepository(await serviceFor('grader'));
    await grader.commitRow(scope, campaign, {
      rowId: 'r1',
      kind: 'meta',
      manifestHash: HASH,
      result: 'measured',
      payload: { v: 1 },
    });
    await grader.commitSummary(scope, campaign, {
      kind: 'meta',
      manifestHash: HASH,
      rowIds: ['r1'],
      payload: {},
    });
    const reader = new CampaignArtifactRepository(await serviceFor('projection_reader'));
    expect((await reader.readSummary(scope, campaign))?.artifactId).toBe(`campaign:${campaign}`);
    expect(await reader.listRows(scope, campaign)).toHaveLength(1);
    expect(
      await control.collection('projection_events').countDocuments({ jobId: `campaign:${campaign}` }),
    ).toBe(1);

    // fixture_builder: the meta draw record and a world split.
    const draw = new MetaDrawCommitmentRepository(await serviceFor('fixture_builder'));
    await draw.commit('rbac-meta', {
      commitment: { seedCommitment: HASH, incidentPoolHash: HASH, worldPoolHash: HASH },
      i0Hash: HASH,
    });
    expect(
      (await new MetaDrawCommitmentRepository(await serviceFor('grader')).read('rbac-meta')).commitment,
    ).toBeTruthy();
    const splitJob = await createJob(setup, { id: 'rbac-split-job' });
    await new WorldSplitRepository(await serviceFor('fixture_builder')).assign(
      scope,
      'world-rbac-split-job',
      'train',
      HASH,
    );
    expect(await new WorldSplitRepository(await serviceFor('observer')).splitOfJob(scope, splitJob)).toEqual({
      split: 'train',
      planCommitment: HASH,
    });

    // privacy_controller and the readers of the suppression list.
    const privacy = await serviceFor('privacy_controller');
    const raw = new RawArtifactRepository(privacy);
    await raw.put(
      scope,
      {
        sourceId: 'rbac-s',
        kind: 'trace',
        contentSha256: HASH,
        sizeBytes: 3,
        retention: 'raw',
        registeredAt: new Date(),
      },
      'abc',
    );
    expect(
      await raw.purge(scope, 'rbac-s', 'trace', 'source_retracted', { policyHash: HASH, closureId: null }),
    ).toBe('purged');
    await new SubjectTokenRepository(privacy).put(scope, {
      subjectHandle: 'h',
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: ['u'],
      registeredAt: new Date(),
    });
    const lessons = new LessonRepository(privacy);
    await lessons.put(scope, {
      lessonId: 'rbac-l',
      moduleId: 'm',
      family: 'f',
      structure: {},
      retention: 'structural',
      sourceIds: [],
      policyHash: HASH,
      registeredAt: new Date(),
    });
    expect(
      await lessons.purge(scope, 'rbac-l', 'source_retracted', { policyHash: HASH, closureId: null }),
    ).toBe('purged');
    await new ErasureSuppressionRepository(privacy).setActive(
      {
        tenantId: scope.tenantId,
        env: scope.env,
        providerOrganizationId: 'org',
        userKey: 'user',
        jobId: 'job-rbac',
      },
      true,
    );
    for (const principal of ['observer', 'domain_executor'] as const)
      expect(
        await new ErasureSuppressionRepository(await serviceFor(principal)).activeUserKeys('org'),
        principal,
      ).toEqual(['user']);
  });
});
