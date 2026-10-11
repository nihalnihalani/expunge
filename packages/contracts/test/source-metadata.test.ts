import { describe, expect, it } from 'vitest';
import {
  assertCaseMatchesRegistration,
  assertSeparateCaseArms,
  authenticCaseManifestSchema,
  nativeRegistrationHash,
  nativeScalarSchema,
  nativeSourceRegistrationSchema,
  publicCaseReference,
  type AuthenticCaseManifest,
  type NativeSourceRegistration,
} from '../src/source.js';

// Configuration grammar only: no business records, service responses or asserted owner authorization.
const hash = 'a'.repeat(64);
function metadata(): NativeSourceRegistration {
  return {
    contractVersion: 2,
    sourceId: 'source-registration',
    deploymentId: 'deployment-registration',
    scope: { tenantId: 'scope-tenant', env: 'staging', scopeId: 'scope-registration' },
    revision: 1,
    policyRevision: 1,
    authorizationRevision: 1,
    sourceKind: 'original',
    namespaces: [
      { namespaceId: 'namespace', database: 'registered_source', collection: 'registered_collection' },
    ],
    fields: [
      {
        fieldId: 'tenant',
        namespaceId: 'namespace',
        path: ['tenant'],
        bsonTypes: ['string'],
        identity: false,
        protected: true,
      },
      {
        fieldId: 'identity',
        namespaceId: 'namespace',
        path: ['_id'],
        bsonTypes: ['objectId'],
        identity: true,
        protected: true,
      },
      {
        fieldId: 'mutable',
        namespaceId: 'namespace',
        path: ['mutable'],
        bsonTypes: ['string'],
        identity: false,
        protected: false,
      },
      {
        fieldId: 'version',
        namespaceId: 'namespace',
        path: ['version'],
        bsonTypes: ['long'],
        identity: false,
        protected: true,
      },
    ],
    tenantBoundaries: [
      { namespaceId: 'namespace', fieldId: 'tenant', equals: { bsonType: 'string', value: 'scope-tenant' } },
    ],
    subjectIdentityFieldIds: ['identity'],
    references: [],
    retainedFieldIds: [],
    rules: [
      {
        ruleId: 'owner-rule',
        namespaceId: 'namespace',
        all: [{ fieldId: 'tenant', equals: { bsonType: 'string', value: 'scope-tenant' } }],
        effect: 'redact',
        fieldIds: ['mutable'],
        replacement: { bsonType: 'string', value: '[owner-replacement]' },
      },
    ],
    consistency: {
      kind: 'native_revision',
      bindings: [{ namespaceId: 'namespace', revisionFieldId: 'version' }],
      changeStreamRequired: true,
    },
    limits: {
      maxScanned: 100,
      maxChanged: 10,
      maxBatch: 10,
      maxHops: 2,
      maxTotalScanned: 500,
      maxTotalChanged: 10,
      maxOperations: 16,
    },
    ownerReview: {
      reviewId: 'review-reference',
      actorId: 'actor-reference',
      reviewedAt: '2026-10-12T00:00:00Z',
      provenanceDigest: hash,
      writeScopeDigest: hash,
    },
  };
}
function arm(database: string): AuthenticCaseManifest {
  const source = metadata();
  return {
    contractVersion: 2,
    caseId: 'case-reference',
    sourceId: source.sourceId,
    registrationHash: nativeRegistrationHash(source),
    cleanupRequestId: 'request-reference',
    provenanceDigest: hash,
    snapshotId: 'snapshot-reference',
    snapshotDigest: hash,
    snapshotObservedAt: '2026-10-12T00:00:00Z',
    boundaryDigest: hash,
    reviewId: 'review-reference',
    reviewedAt: '2026-10-12T00:00:00Z',
    expectedEffectsDigest: hash,
    preservationDigest: hash,
    replayAuthorizationId: 'authorization-reference',
    namespaceMap: [
      {
        namespaceId: 'namespace',
        originDatabase: 'registered_source',
        originCollection: 'registered_collection',
        replayDatabase: database,
        replayCollection: 'registered_collection',
      },
    ],
  };
}

describe('native-source configuration and case metadata invariants', () => {
  it('rejects envelope coercion and does not treat proposal validation as an approval', () => {
    const source = metadata();
    expect(nativeSourceRegistrationSchema.parse(source)).toEqual(source);
    expect(source.fields[1].path).toEqual(['_id']);
    expect(nativeSourceRegistrationSchema.safeParse({ ...source, credential: 'unregistered' }).success).toBe(
      false,
    );
  });
  it.each(['null', 'array', 'wrong_type'] as const)('rejects the unsafe tenant boundary %s', (kind) => {
    const source = metadata();
    if (kind === 'null') source.tenantBoundaries[0].equals = { bsonType: 'null', value: null };
    if (kind === 'array') source.fields[0].bsonTypes = ['array'];
    if (kind === 'wrong_type') source.tenantBoundaries[0].equals = { bsonType: 'bool', value: true };
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
  });
  it('requires a tenant and revision binding for each native namespace', () => {
    const source = metadata();
    source.namespaces.push({
      namespaceId: 'second',
      database: 'registered_source',
      collection: 'second_collection',
    });
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
    source.fields.push({ ...source.fields[0], fieldId: 'second-tenant', namespaceId: 'second' });
    source.tenantBoundaries.push({
      ...source.tenantBoundaries[0],
      fieldId: 'second-tenant',
      namespaceId: 'second',
    });
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
  });
  it('rejects unsafe revisions and unrepresentable BSON scalars', () => {
    expect(nativeSourceRegistrationSchema.safeParse({ ...metadata(), revision: 2 ** 53 }).success).toBe(
      false,
    );
    expect(nativeScalarSchema.safeParse({ bsonType: 'long', value: '9223372036854775808' }).success).toBe(
      false,
    );
    expect(nativeScalarSchema.safeParse({ bsonType: 'decimal', value: '1e99999' }).success).toBe(false);
    expect(
      nativeScalarSchema.safeParse({ bsonType: 'date', value: '2026-10-12T00:00:00.0001Z' }).success,
    ).toBe(false);
    expect(
      nativeScalarSchema.safeParse({ bsonType: 'date', value: '2026-10-12T00:00:00.123Z' }).success,
    ).toBe(true);
    expect(nativeScalarSchema.parse({ bsonType: 'long', value: '9223372036854775807' }).value).toBe(
      '9223372036854775807',
    );
  });
  it('rejects reference conversions and policy values that contradict registered BSON types', () => {
    const source = metadata();
    source.references = [
      {
        referenceId: 'reference',
        fromFieldId: 'tenant',
        toFieldId: 'mutable',
        owner: 'none',
        identityRule: 'string_to_objectId',
      },
    ];
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
    source.references = [];
    source.rules[0].all[0].equals = { bsonType: 'bool', value: true };
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
    source.rules[0].all[0].equals = { bsonType: 'string', value: 'scope-tenant' };
    source.rules[0].replacement = { bsonType: 'bool', value: false };
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
  });
  it('refuses writes over protected or retained ancestors and deletion of retained contents', () => {
    const source = metadata();
    source.fields.push({
      fieldId: 'retained-parent',
      namespaceId: 'namespace',
      path: ['mutable', 'retained'],
      bsonTypes: ['string'],
      identity: false,
      protected: true,
    });
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
    source.fields.pop();
    source.retainedFieldIds = ['mutable'];
    source.rules[0].effect = 'delete';
    source.rules[0].fieldIds = [];
    delete source.rules[0].replacement;
    expect(nativeSourceRegistrationSchema.safeParse(source).success).toBe(false);
  });
  it('binds every authority-bearing registration change into the digest', () => {
    const source = metadata();
    const original = nativeRegistrationHash(source);
    const { scope, ...rest } = source;
    expect(nativeRegistrationHash({ scope, ...rest })).toBe(original);
    const changes: Array<(value: NativeSourceRegistration) => void> = [
      (value) => {
        value.namespaces[0].collection = 'different_collection';
      },
      (value) => {
        value.scope.scopeId = 'different-scope';
      },
      (value) => {
        value.fields[2].path = ['different_field'];
      },
      (value) => {
        value.policyRevision++;
      },
      (value) => {
        value.authorizationRevision++;
      },
      (value) => {
        value.tenantBoundaries[0].equals = { bsonType: 'string', value: 'different-tenant' };
      },
      (value) => {
        value.consistency = { kind: 'conditional_preimage', changeStreamRequired: true };
      },
    ];
    for (const change of changes) {
      const next = structuredClone(source);
      change(next);
      expect(nativeRegistrationHash(next)).not.toBe(original);
    }
  });
  it('requires exact stored source mapping and minimizes the public case handle', () => {
    const value = arm('replay_arm');
    expect(() => assertCaseMatchesRegistration(value, metadata())).not.toThrow();
    const changed = structuredClone(value);
    changed.namespaceMap[0].originCollection = 'other_collection';
    expect(() => assertCaseMatchesRegistration(changed, metadata())).toThrow('CaseNamespaceMismatch');
    expect(Object.keys(publicCaseReference(value)).sort()).toEqual([
      'caseId',
      'provenanceDigest',
      'sourceId',
    ]);
  });
  it('rejects sibling replay databases, cross-arm original collisions and changed source commitments', () => {
    const a = arm('replay_alpha');
    const b = arm('replay_beta');
    expect(() => assertSeparateCaseArms([a, b])).not.toThrow();
    expect(() => assertSeparateCaseArms([a, a])).toThrow('CaseArmsSharePhysicalDatabase');
    const collided = structuredClone(b);
    collided.namespaceMap[0].originDatabase = 'replay_alpha';
    expect(() => assertSeparateCaseArms([a, collided])).toThrow();
    for (const key of [
      'snapshotDigest',
      'expectedEffectsDigest',
      'preservationDigest',
      'boundaryDigest',
    ] as const) {
      const different = structuredClone(b);
      different[key] = 'b'.repeat(64);
      expect(() => assertSeparateCaseArms([a, different])).toThrow('CaseArmCommitmentMismatch');
    }
    expect(
      authenticCaseManifestSchema.safeParse({
        ...a,
        namespaceMap: [{ ...a.namespaceMap[0], replayDatabase: a.namespaceMap[0].originDatabase }],
      }).success,
    ).toBe(false);
  });
});
