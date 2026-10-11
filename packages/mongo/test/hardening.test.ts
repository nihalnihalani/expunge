import { describe, expect, it } from 'vitest';
import { Double, Int32, Long, ObjectId } from 'mongodb';
import type { JobKind, MutationClass } from '@expunge/contracts';
import {
  AuthorityPolicyRepository,
  CandidateRepository,
  CONTROL_VALIDATORS,
  JOB_KIND_PRINCIPALS,
  PRINCIPALS,
  WORLD_VALIDATORS,
  addressId,
  approvalRequired,
  atlasRoleManifests,
  canonicalAddress,
  createPrincipalService,
  deriveArgsDigest,
  deriveDecisionId,
  deriveEffectKey,
  deriveTargetHash,
  nodeKey,
  seedOptionsFromEnv,
  typedAddress,
  worldFilter,
  type Principal,
} from '../src/index.js';
import { HASH, actor, intent, proposalOf } from './support.js';

/** Checks that need no database. Their live counterparts are in hardening.integration.test.ts. */
const roles = atlasRoleManifests();
const can = (principal: Principal, verb: string, collection: string): boolean =>
  roles[principal]?.actions.some(
    (action) =>
      action.action === verb && action.resources.some((resource) => resource.collection === collection),
  ) ?? false;
const holders = (verb: string, collection: string): Principal[] =>
  PRINCIPALS.filter((principal) => can(principal, verb, collection));

describe('S1: one stored _id has one spelling', () => {
  it('accepts only canonical decimal ints and canonical lowercase ObjectId hex', () => {
    for (const bad of ['0x10', '1.6e1', ' 16 ', '016', '16.0', '', '+16', '-0', '1e1', '16\n'])
      expect(() => addressId({ collectionId: 'c', recordId: bad, recordIdBsonType: 'int' }), bad).toThrow();
    expect(addressId({ collectionId: 'c', recordId: '16', recordIdBsonType: 'int' })).toBe(16);
    expect(addressId({ collectionId: 'c', recordId: 16, recordIdBsonType: 'int' })).toBe(16);
    expect(addressId({ collectionId: 'c', recordId: '-7', recordIdBsonType: 'int' })).toBe(-7);
    expect(() => addressId({ collectionId: 'c', recordId: '2147483648', recordIdBsonType: 'int' })).toThrow();
    const hex = '507f1f77bcf86cd799439011';
    expect(() =>
      addressId({ collectionId: 'c', recordId: hex.toUpperCase(), recordIdBsonType: 'objectId' }),
    ).toThrow();
    expect(addressId({ collectionId: 'c', recordId: hex, recordIdBsonType: 'objectId' })).toEqual(
      new ObjectId(hex),
    );
    for (const bad of ['0x10', '010', '+5', '5.0', ''])
      expect(() => addressId({ collectionId: 'c', recordId: bad, recordIdBsonType: 'long' }), bad).toThrow();
  });

  it('maps every spelling of the same _id to one node key', () => {
    const number = nodeKey({ collectionId: 'c', recordId: 16, recordIdBsonType: 'int' });
    expect(nodeKey({ collectionId: 'c', recordId: '16', recordIdBsonType: 'int' })).toBe(number);
    expect(canonicalAddress({ collectionId: 'c', recordId: '16', recordIdBsonType: 'int' }).recordId).toBe(
      16,
    );
    const long = nodeKey({ collectionId: 'c', recordId: '9007199254740993', recordIdBsonType: 'long' });
    expect(long).not.toBe(
      nodeKey({ collectionId: 'c', recordId: '9007199254740993', recordIdBsonType: 'string' }),
    );
  });

  it('types the BSON wrappers a type-preserving read returns', () => {
    expect(typedAddress('c', new Int32(5))).toEqual({
      collectionId: 'c',
      recordId: 5,
      recordIdBsonType: 'int',
    });
    expect(typedAddress('c', new Double(7))).toEqual({
      collectionId: 'c',
      recordId: 7,
      recordIdBsonType: 'int',
    });
    expect(typedAddress('c', Long.fromString('5'))).toEqual({
      collectionId: 'c',
      recordId: '5',
      recordIdBsonType: 'long',
    });
    for (const bad of [new Double(0.5), new Double(2 ** 33), null, undefined, {}, [], true])
      expect(() => typedAddress('c', bad), String(bad)).toThrow('UnsupportedAddressType');
  });
});

describe('S3: generated predicates cannot carry server-side JavaScript', () => {
  it('rejects $where, $function and $accumulator anywhere in the predicate', () => {
    for (const hostile of [
      { $where: 'sleep(10000) || true' },
      { $or: [{ a: 1 }, { $where: 'true' }] },
      { a: { $elemMatch: { $where: 'true' } } },
      { $expr: { $function: { body: 'function(){return true}', args: [], lang: 'js' } } },
      { $expr: { $accumulator: { init: 'function(){}', accumulate: 'function(){}', lang: 'js' } } },
    ])
      expect(() => worldFilter(actor, 'w', hostile), JSON.stringify(hostile)).toThrow('UnsafePredicate');
  });

  it('still conjoins the trusted binding with an ordinary predicate and leaves BSON values alone', () => {
    const id = new ObjectId();
    expect(worldFilter(actor, 'w', { _id: id, 'data.x': { $in: ['a', 'b'] } })).toEqual({
      $and: [
        { tenantId: actor.tenantId, env: actor.env, worldId: 'w' },
        { _id: id, 'data.x': { $in: ['a', 'b'] } },
      ],
    });
  });
});

describe('approval requirement derivation', () => {
  const table: Array<[MutationClass, boolean, boolean]> = [
    ['authority_expansion', true, true],
    ['authority_expansion', false, true],
    ['tightening', true, false],
    ['tightening', false, false],
    ['behavioral', true, true],
    ['behavioral', false, false],
  ];
  it.each(table)('%s with behavioralRequiresApproval=%s needs a grant: %s', (cls, policy, required) => {
    expect(approvalRequired(cls, { behavioralRequiresApproval: policy })).toBe(required);
  });
  it('rejects a class it does not know', () => {
    expect(() => approvalRequired('whatever' as never, { behavioralRequiresApproval: false })).toThrow(
      'UnknownMutationClass',
    );
  });
  it('lets only the setup principal write policy, and only the proposer propose, before any I/O', async () => {
    const promoter = createPrincipalService({ uris: { promoter: 'mongodb://127.0.0.1:1' } }, 'promoter');
    const executor = createPrincipalService(
      { uris: { domain_executor: 'mongodb://127.0.0.1:1' } },
      'domain_executor',
    );
    const key = { tenantId: 't', env: 'demo', scopeId: 's', target: 'worker' } as const;
    await expect(new AuthorityPolicyRepository(promoter).install(key, false)).rejects.toThrow(
      'PrincipalBoundary',
    );
    await expect(new AuthorityPolicyRepository(promoter).replace(key, false)).rejects.toThrow(
      'PrincipalBoundary',
    );
    await expect(
      new CandidateRepository(executor).propose(
        proposalOf({ candidateId: 'c', parentHash: HASH, childHash: HASH }),
      ),
    ).rejects.toThrow('PrincipalBoundary');
    await promoter.close();
    await executor.close();
  });
});

describe('job kinds belong to one worker principal', () => {
  const kinds: JobKind[] = [
    'cleanup',
    'observe',
    'propose',
    'evaluate',
    'promote',
    'rollback',
    'redact',
    'external_delete',
    'adversarial_generate',
    'meta_evaluate',
  ];
  it('covers every job kind with at least one principal, and never gives a cleanup job to a grader', () => {
    for (const kind of kinds) expect(JOB_KIND_PRINCIPALS[kind].length, kind).toBeGreaterThan(0);
    expect(Object.keys(JOB_KIND_PRINCIPALS).sort()).toEqual([...kinds].sort());
    expect(JOB_KIND_PRINCIPALS.cleanup).toEqual(['domain_executor']);
    for (const principals of Object.values(JOB_KIND_PRINCIPALS))
      for (const principal of principals) expect(PRINCIPALS).toContain(principal);
  });
});

describe('derived effect identity', () => {
  const base = intent('job-1', {
    targets: [{ collectionId: 'c', recordId: 'a', recordIdBsonType: 'string' }],
  });
  it('ignores the tool call, lease fence and world revision', () => {
    const retried = intent('job-1', {
      targets: base.targetAddresses,
      toolCallId: 'call-9',
      worldRevision: 7,
    });
    expect(retried.effectKey).toBe(base.effectKey);
    expect(retried.argsDigest).toBe(base.argsDigest);
    expect(retried.intentId).not.toBe(base.intentId);
  });
  it('changes with job, plan step, batch ordinal and target set', () => {
    expect(deriveEffectKey({ ...base, jobId: 'job-2' })).not.toBe(base.effectKey);
    expect(deriveEffectKey({ ...base, stepId: 'other' })).not.toBe(base.effectKey);
    expect(deriveEffectKey({ ...base, batchOrdinal: 1 })).not.toBe(base.effectKey);
    expect(deriveEffectKey({ ...base, approvedPlanHash: 'b'.repeat(64) })).not.toBe(base.effectKey);
    const other = [{ collectionId: 'c', recordId: 'b', recordIdBsonType: 'string' as const }];
    expect(deriveArgsDigest({ ...base, targetAddresses: other })).not.toBe(base.argsDigest);
    expect(deriveArgsDigest({ ...base, effectKind: 'redact' })).not.toBe(base.argsDigest);
  });
  it('binds the record versions the plan approved: the same targets at other versions are another action', () => {
    const versioned = intent('job-1', { targets: base.targetAddresses, versions: [3] });
    expect(versioned.argsDigest).not.toBe(base.argsDigest);
    expect(versioned.effectKey).toBe(base.effectKey);
    expect(
      deriveArgsDigest({
        ...versioned,
        expectedDocumentVersions: versioned.expectedDocumentVersions.map((entry) => ({
          ...entry,
          version: 4,
        })),
      }),
    ).not.toBe(versioned.argsDigest);
    // Spelling an address another way (`5` versus `'5'` for an int id) does not change the digest.
    const spelled = [{ collectionId: 'c', recordId: '5', recordIdBsonType: 'int' as const }];
    const plain = [{ collectionId: 'c', recordId: 5, recordIdBsonType: 'int' as const }];
    const digestOf = (targets: typeof plain | typeof spelled) =>
      deriveArgsDigest({
        ...base,
        targetAddresses: targets,
        expectedDocumentVersions: targets.map((address) => ({ address, version: 2 })),
      });
    expect(digestOf(spelled)).toBe(digestOf(plain));
  });
  it('canonicalizes target spellings and binds the decision to the intent', () => {
    const spelled = [{ collectionId: 'c', recordId: '5', recordIdBsonType: 'int' as const }];
    const plain = [{ collectionId: 'c', recordId: 5, recordIdBsonType: 'int' as const }];
    expect(deriveTargetHash(spelled)).toBe(deriveTargetHash(plain));
    expect(deriveDecisionId(base)).toBe(base.decisionId);
    expect(deriveDecisionId({ ...base, argsDigest: HASH })).not.toBe(base.decisionId);
    expect(
      deriveDecisionId({ ...base, policyDecision: { ...base.policyDecision, result: 'deny' } }),
    ).not.toBe(base.decisionId);
    expect(
      deriveDecisionId({ ...base, policyDecision: { ...base.policyDecision, authorizationRevision: 2 } }),
    ).not.toBe(base.decisionId);
  });
});

describe('role manifests: structural negatives (offline mirror of rbac.integration.test.ts)', () => {
  it('gives the gate, fault, refusal and campaign-permit collections exactly these holders (PKT-61)', () => {
    // Not only manifest equality: the exact holders, so a widened grant fails here by name.
    const fixed: Array<[string, Partial<Record<'FIND' | 'INSERT' | 'UPDATE' | 'REMOVE', Principal[]>>]> = [
      ['campaign_freezes', { FIND: ['fixture_builder', 'grader'], INSERT: ['fixture_builder'] }],
      ['gate_claims', { FIND: ['grader'], INSERT: ['grader'], UPDATE: ['grader'] }],
      ['gate_attempts', { FIND: ['grader'], INSERT: ['grader'], UPDATE: ['grader'] }],
      ['gate_held_runs', { FIND: ['grader'], INSERT: ['grader'] }],
      ['world_faults', { FIND: ['domain_executor', 'grader'], INSERT: ['fixture_builder'] }],
      ['rollback_refusals', { FIND: ['domain_executor', 'projection_reader'], INSERT: ['promoter'] }],
      ['campaign_artifact_permits', { FIND: ['domain_executor', 'grader'], INSERT: ['grader'] }],
      // PKT-62: campaign results, the meta draw record, world splits and the privacy stores.
      [
        'campaign_artifacts',
        { FIND: ['domain_executor', 'grader', 'projection_reader'], INSERT: ['grader'] },
      ],
      [
        'campaign_artifact_rows',
        { FIND: ['domain_executor', 'grader', 'projection_reader'], INSERT: ['grader'] },
      ],
      ['adversary_campaigns', { FIND: ['grader'], INSERT: ['grader'] }],
      ['adversary_trials', { FIND: ['grader'], INSERT: ['grader'] }],
      ['meta_draw_commitments', { FIND: ['fixture_builder', 'grader'], INSERT: ['fixture_builder'] }],
      ['world_splits', { FIND: ['grader', 'observer'], INSERT: ['fixture_builder'] }],
      [
        'erasure_suppressions',
        {
          FIND: ['domain_executor', 'observer', 'privacy_controller'],
          INSERT: ['privacy_controller'],
          UPDATE: ['privacy_controller'],
        },
      ],
      [
        'raw_artifacts',
        {
          FIND: ['privacy_controller'],
          INSERT: ['privacy_controller'],
          UPDATE: ['privacy_controller'],
          REMOVE: ['privacy_controller'],
        },
      ],
      [
        'subject_tokens',
        { FIND: ['privacy_controller'], INSERT: ['privacy_controller'], REMOVE: ['privacy_controller'] },
      ],
      [
        'lessons',
        {
          FIND: ['privacy_controller', 'proposer'],
          INSERT: ['privacy_controller'],
          UPDATE: ['privacy_controller'],
        },
      ],
    ];
    for (const [collection, expected] of fixed)
      for (const verb of ['FIND', 'INSERT', 'UPDATE', 'REMOVE'] as const)
        expect(holders(verb, collection).sort(), `${verb} ${collection}`).toEqual(
          (expected[verb] ?? []).sort(),
        );
    // The domain service (domain_executor) reads what it serves; it writes only its own projection appends.
    for (const collection of ['promotions', 'projection_events', 'projection_sequences'])
      expect(holders('FIND', collection), `FIND ${collection}`).toContain('domain_executor');
    expect(holders('INSERT', 'promotions')).toEqual(['promoter']);
    expect(holders('UPDATE', 'promotions')).toEqual([]);
    // The export gate reads erasure_suppressions; nobody but the privacy controller reads the erasure jobs themselves.
    expect(holders('FIND', 'external_deletions')).toEqual(['privacy_controller']);
    // domain_steps is the gateway's own log: the grader reads the fault attestation, never writes it.
    expect(holders('FIND', 'domain_steps').sort()).toEqual(['domain_executor', 'grader']);
    expect(holders('INSERT', 'domain_steps')).toEqual(['domain_executor']);
    expect(holders('UPDATE', 'domain_steps')).toEqual([]);
    // The grader may not write the eligibility rows production context loading reads.
    for (const verb of ['INSERT', 'UPDATE', 'REMOVE'])
      expect(holders(verb, 'artifact_eligibility'), `${verb} artifact_eligibility`).not.toContain('grader');
  });
  it('keeps authority rows with their owners', () => {
    expect(holders('INSERT', 'authority_revisions')).toEqual([]);
    // The fixture builder's campaign authority is a separate collection the fence reads only for env 'evaluation'.
    expect(holders('INSERT', 'campaign_authority')).toEqual(['fixture_builder']);
    // The floor and revision are insert-only; the fence counter is a separate collection, as for the standing authority.
    expect(holders('UPDATE', 'campaign_authority')).toEqual([]);
    expect(holders('REMOVE', 'campaign_authority')).toEqual([]);
    expect(holders('INSERT', 'campaign_authority_touches')).toEqual(['fixture_builder']);
    expect(holders('UPDATE', 'campaign_authority_touches').sort()).toEqual(['domain_executor', 'promoter']);
    expect(holders('REMOVE', 'campaign_authority_touches')).toEqual([]);
    expect(holders('UPDATE', 'authority_revisions')).toEqual(['approval_issuer']);
    expect(holders('UPDATE', 'authority_touches').sort()).toEqual([
      'approval_issuer',
      'domain_executor',
      'promoter',
    ]);
    expect(holders('UPDATE', 'authority_policies')).toEqual([]);
    expect(holders('INSERT', 'authority_policies')).toEqual([]);
  });
  it('keeps the world binding, registry and retained data away from the worker', () => {
    expect(holders('UPDATE', 'world_scope_bindings')).toEqual(['fixture_builder']);
    expect(holders('INSERT', 'world_scope_bindings')).toEqual(['fixture_builder']);
    expect(holders('INSERT', 'schema_registry')).toEqual(['fixture_builder']);
    expect(holders('UPDATE', 'schema_registry')).toEqual(['fixture_builder']);
    expect(can('domain_executor', 'UPDATE', 'world_revisions')).toBe(true);
    expect(can('domain_executor', 'UPDATE', 'retained_invoices')).toBe(false);
    expect(can('domain_executor', 'REMOVE', 'retained_invoices')).toBe(false);
  });
  it('makes grants, gate reports, decisions and candidates insert-only for their single writers', () => {
    expect(holders('INSERT', 'approvals')).toEqual(['approval_issuer']);
    expect(holders('UPDATE', 'approvals')).toEqual([]);
    expect(holders('INSERT', 'grant_consumptions')).toEqual(['promoter']);
    expect(holders('UPDATE', 'grant_consumptions')).toEqual([]);
    expect(holders('INSERT', 'gate_reports')).toEqual(['grader']);
    expect(holders('UPDATE', 'gate_reports')).toEqual([]);
    expect(holders('INSERT', 'decisions')).toEqual(['domain_executor']);
    expect(holders('UPDATE', 'decisions')).toEqual([]);
    expect(holders('REMOVE', 'decisions')).toEqual([]);
    expect(holders('INSERT', 'candidates')).toEqual(['proposer']);
    expect(holders('UPDATE', 'candidates')).toEqual(['promoter']);
  });
  it('lets the grader read the world revision counter and write none of it', () => {
    expect(holders('FIND', 'world_revisions')).toContain('grader');
    expect(holders('UPDATE', 'world_revisions')).not.toContain('grader');
    expect(holders('INSERT', 'world_revisions')).not.toContain('grader');
  });

  it('keeps run attestations and guard exports insert-only with named writers and readers', () => {
    expect(holders('INSERT', 'run_attestations')).toEqual(['domain_executor']);
    expect(holders('FIND', 'run_attestations').sort()).toEqual([
      'domain_executor',
      'grader',
      'projection_reader',
    ]);
    expect(holders('INSERT', 'guard_exports')).toEqual(['privacy_controller']);
    expect(holders('FIND', 'guard_exports').sort()).toEqual(['observer', 'privacy_controller']);
    // The subject-set generation is bumped by the privacy controller when it registers subjects; the observer only reads it.
    expect(holders('INSERT', 'subject_set_generations')).toEqual(['privacy_controller']);
    expect(holders('UPDATE', 'subject_set_generations')).toEqual(['privacy_controller']);
    expect(holders('REMOVE', 'subject_set_generations')).toEqual([]);
    expect(holders('FIND', 'subject_set_generations').sort()).toEqual(['observer', 'privacy_controller']);
    for (const collection of ['run_attestations', 'guard_exports']) {
      expect(holders('UPDATE', collection), collection).toEqual([]);
      expect(holders('REMOVE', collection), collection).toEqual([]);
    }
  });

  it('keeps the gateway step log insert-only and with the worker alone', () => {
    for (const collection of [
      'job_subjects',
      'domain_steps',
      'preview_plans',
      'verification_sweeps',
      'diagnostics',
    ]) {
      expect(holders('INSERT', collection), collection).toEqual(['domain_executor']);
      expect(holders('UPDATE', collection), collection).toEqual([]);
      expect(holders('REMOVE', collection), collection).toEqual([]);
      // The grader additionally reads domain_steps (the fault attestation row) and preview_plans (episode evidence). Nothing else.
      expect(holders('FIND', collection).sort(), collection).toEqual(
        collection === 'domain_steps' || collection === 'preview_plans'
          ? ['domain_executor', 'grader']
          : ['domain_executor'],
      );
    }
    // Subject literals live in job_subjects; the projection reader must never see them.
    expect(can('projection_reader', 'FIND', 'job_subjects')).toBe(false);
  });
  it('keeps campaign keys insert-only and visible to the fixture builder and grader alone', () => {
    expect(holders('INSERT', 'campaign_keys')).toEqual(['fixture_builder']);
    expect(holders('UPDATE', 'campaign_keys')).toEqual([]);
    expect(holders('REMOVE', 'campaign_keys')).toEqual([]);
    expect(holders('FIND', 'campaign_keys').sort()).toEqual(['fixture_builder', 'grader']);
  });
  it('never grants bypassDocumentValidation, collMod or role administration', () => {
    const forbidden = [
      'BYPASS_DOCUMENT_VALIDATION',
      'COLL_MOD',
      'CREATE_ROLE',
      'CREATE_USER',
      'DROP_COLLECTION',
    ];
    for (const manifest of Object.values(roles))
      for (const action of manifest!.actions) expect(forbidden).not.toContain(action.action);
  });
  it('lists no inherited roles', () => {
    for (const manifest of Object.values(roles)) expect(manifest!.inheritedRoles).toEqual([]);
  });
});

describe('validators carry the structural halves of the boundaries', () => {
  const properties = (name: string) =>
    CONTROL_VALIDATORS[name]!.$jsonSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
  it('accepts no computedClass on a candidate row and rejects unknown properties', () => {
    expect(properties('candidates').properties).not.toHaveProperty('computedClass');
    expect(properties('candidates').additionalProperties).toBe(false);
  });
  it('lets a gate report carry the class but not require it for older reports', () => {
    const schema = CONTROL_VALIDATORS.gate_reports!.$jsonSchema as { properties: object; required: string[] };
    expect(schema.properties).toHaveProperty('computedClass');
    expect(schema.required).not.toContain('computedClass');
  });
  it('keeps the world counter and binding in separate strict schemas', () => {
    const counter = WORLD_VALIDATORS.world_revisions!.$jsonSchema as { properties: object };
    const binding = WORLD_VALIDATORS.world_scope_bindings!.$jsonSchema as { properties: object };
    expect(counter.properties).not.toHaveProperty('scopeRevision');
    expect(counter.properties).not.toHaveProperty('maintenanceMode');
    expect(binding.properties).toHaveProperty('scopeRevision');
    expect(binding.properties).toHaveProperty('maintenanceMode');
  });
  it('rejects a succeeded job with no output refs through a query-operator validator', () => {
    expect(CONTROL_VALIDATORS.jobs).toHaveProperty('$jsonSchema');
    expect(CONTROL_VALIDATORS.jobs!.$nor).toEqual([{ status: 'succeeded', outputRefs: { $size: 0 } }]);
  });
});

describe('setup seed from the environment', () => {
  const scopeEnv = { EXPUNGE_TENANT_ID: 'demo', EXPUNGE_ENV: 'demo', EXPUNGE_SCOPE_ID: 'synthetic-company' };
  it('seeds nothing without a floor hash, so promotion and effects fail closed', () => {
    expect(seedOptionsFromEnv({ ...scopeEnv })).toEqual({});
  });
  it('seeds the named scope with an authority row and a policy per target, defaulting to approval-gated', () => {
    const options = seedOptionsFromEnv({ ...scopeEnv, EXPUNGE_AUTHORITY_FLOOR_HASH: HASH });
    expect(options.authorities).toEqual([
      { key: { tenantId: 'demo', env: 'demo', scopeId: 'synthetic-company' }, floorHash: HASH },
    ]);
    expect(options.authorityPolicies?.map((p) => p.key.target)).toEqual(['worker', 'improver', 'hider']);
    expect(options.authorityPolicies?.every((p) => p.behavioralRequiresApproval)).toBe(true);
    const relaxed = seedOptionsFromEnv({
      ...scopeEnv,
      EXPUNGE_AUTHORITY_FLOOR_HASH: HASH,
      EXPUNGE_BEHAVIORAL_REQUIRES_APPROVAL: '0',
    });
    expect(relaxed.authorityPolicies?.every((p) => !p.behavioralRequiresApproval)).toBe(true);
    // Anything other than the exact string "0" keeps the safe default.
    const odd = seedOptionsFromEnv({
      ...scopeEnv,
      EXPUNGE_AUTHORITY_FLOOR_HASH: HASH,
      EXPUNGE_BEHAVIORAL_REQUIRES_APPROVAL: 'false',
    });
    expect(odd.authorityPolicies?.every((p) => p.behavioralRequiresApproval)).toBe(true);
  });
  it('rejects a malformed floor hash or an incomplete scope', () => {
    expect(() => seedOptionsFromEnv({ ...scopeEnv, EXPUNGE_AUTHORITY_FLOOR_HASH: 'nope' })).toThrow(
      'InvalidSetupSeed',
    );
    expect(() => seedOptionsFromEnv({ EXPUNGE_AUTHORITY_FLOOR_HASH: HASH })).toThrow('InvalidSetupSeed');
    expect(() =>
      seedOptionsFromEnv({ ...scopeEnv, EXPUNGE_ENV: 'prod', EXPUNGE_AUTHORITY_FLOOR_HASH: HASH }),
    ).toThrow('InvalidSetupSeed');
  });
});
