import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { BSON, Decimal128, Double, Int32, Long, ObjectId, Timestamp, type Document } from 'mongodb';
import {
  ENVIRONMENTS,
  nativeSourceRegistrationSchema,
  type NativeSourceRegistration,
  type ResourceLimits,
} from '@expunge/contracts';
import {
  decodeNativeScalar,
  encodeNativeScalar,
  nativeScalarKey,
  nativeBsonDigest,
  nativePathValues,
  nativePreimagePredicate,
  nativeScalarPredicate,
  nativeTenantPredicate,
  cloneNativeDocument,
  replaceNativePath,
  NATIVE_BSON_OPTIONS,
} from '../src/native-source-bson.js';
import {
  deriveNativeBudgetCaps,
  nativeRuntimeBudgetProfileHash,
  nextNativeBudget,
  captureNativeRuntimeBudgetProfile,
  decodeNativeRuntimeBudgetProfile,
} from '../src/native-source-budgets.js';
import {
  NATIVE_SOURCE_COLLECTIONS,
  NATIVE_SOURCE_VALIDATORS,
  nativeDomainExecutorAtlasRoleManifest,
  nativeSourceAtlasActions,
} from '../src/native-source-metadata.js';
import { CONTROL_COLLECTIONS, CONTROL_INDEXES, seedOptionsFromEnv } from '../src/setup.js';
import { CONTROL_VALIDATORS, assertSupportedMongoSchema } from '../src/validators.js';
import { atlasRoleManifests } from '../src/roles.js';
import {
  assertNativePreimageRowBinding,
  assertNativeSharedRootEffect,
  assertNativeExclusiveOwnership,
  type NativeTarget,
} from '../src/native-source-adapter.js';
import { nativeSourceHeadId } from '../src/native-source-registry.js';
import { validateProjectionPayload } from '@expunge/contracts';

// This is authority/schema metadata only. No business records, fake service or acceptance dataset is produced.
const registration = (): NativeSourceRegistration =>
  nativeSourceRegistrationSchema.parse({
    contractVersion: 2,
    sourceId: 'scope-source',
    deploymentId: 'deployment-bound',
    scope: { tenantId: 'owner-scope', env: 'staging', scopeId: 'approved-scope' },
    revision: 1,
    policyRevision: 1,
    authorizationRevision: 1,
    sourceKind: 'original',
    namespaces: [{ namespaceId: 'n', database: 'owner_db', collection: 'owner_collection' }],
    fields: [
      {
        fieldId: 'tenant',
        namespaceId: 'n',
        path: ['tenant'],
        bsonTypes: ['string'],
        identity: false,
        protected: true,
      },
      {
        fieldId: 'id',
        namespaceId: 'n',
        path: ['_id'],
        bsonTypes: ['objectId'],
        identity: true,
        protected: true,
      },
      {
        fieldId: 'state',
        namespaceId: 'n',
        path: ['state'],
        bsonTypes: ['string'],
        identity: false,
        protected: false,
      },
      {
        fieldId: 'flag',
        namespaceId: 'n',
        path: ['flag'],
        bsonTypes: ['bool'],
        identity: false,
        protected: false,
      },
    ],
    tenantBoundaries: [
      { namespaceId: 'n', fieldId: 'tenant', equals: { bsonType: 'string', value: 'exact-boundary' } },
    ],
    subjectIdentityFieldIds: ['id'],
    references: [],
    rules: [
      {
        ruleId: 'owner-rule',
        namespaceId: 'n',
        all: [{ fieldId: 'state', equals: { bsonType: 'string', value: 'eligible' } }],
        effect: 'restrict',
        fieldIds: ['flag'],
        replacement: { bsonType: 'bool', value: false },
      },
    ],
    retainedFieldIds: [],
    consistency: { kind: 'conditional_preimage', changeStreamRequired: true },
    limits: {
      maxScanned: 10,
      maxChanged: 10,
      maxBatch: 3,
      maxHops: 3,
      maxTotalScanned: 100,
      maxTotalChanged: 20,
      maxOperations: 16,
    },
    ownerReview: {
      reviewId: 'review-bound',
      actorId: 'owner-actor',
      reviewedAt: '2026-10-11T00:00:00.000Z',
      provenanceDigest: 'a'.repeat(64),
      writeScopeDigest: 'b'.repeat(64),
    },
  });
const limits = (): ResourceLimits => ({
  modelCalls: 16,
  toolCalls: 16,
  scannedDocuments: 100,
  changedDocuments: 20,
  traversalDepth: 8,
  graphNodes: 20,
  graphEdges: 100,
  wallTimeMs: 10000,
  totalTokens: 10000,
  maxCostMicrousd: 100000,
});
const profileInput = () => ({
  spec: 'openai/configured-model',
  pricing: { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 },
  limits: limits(),
  runtimeHash: 'd'.repeat(64),
});
const profileMetadata = () => {
  const input = profileInput();
  const hash = nativeRuntimeBudgetProfileHash(input);
  return { _id: hash, ...input, profileDigest: hash, createdAt: new Date('2026-10-11T00:00:00.000Z') };
};

describe('native BSON and exact query invariants', () => {
  it.each([
    { bsonType: 'objectId' as const, value: '0123456789abcdef01234567' },
    { bsonType: 'int' as const, value: 1 },
    { bsonType: 'long' as const, value: '9223372036854775807' },
    { bsonType: 'double' as const, value: 1.5 },
    { bsonType: 'decimal' as const, value: '1.25' },
    { bsonType: 'date' as const, value: '2026-10-11T00:00:00.000Z' },
    { bsonType: 'bool' as const, value: false },
    { bsonType: 'null' as const, value: null },
  ])('round trips the explicit $bsonType type', (scalar) => {
    expect(encodeNativeScalar(decodeNativeScalar(scalar))).toEqual(scalar);
  });
  it('never conflates equal numeric values with different BSON types', () => {
    const types = [new Int32(1), Long.ONE, new Double(1), Decimal128.fromString('1')];
    expect(new Set(types.map((value) => nativeScalarKey(encodeNativeScalar(value)))).size).toBe(4);
  });
  it('rejects promoted JS numbers and timestamps as identities', () => {
    expect(() => encodeNativeScalar(1)).toThrow('UnsupportedOrPromotedNativeIdentity');
    expect(() => encodeNativeScalar(Timestamp.fromNumber(1))).toThrow('UnsupportedOrPromotedNativeIdentity');
  });
  it('distinguishes null from missing and scalar from an array containing a value', () => {
    const query = nativeScalarPredicate(['a'], { bsonType: 'null', value: null });
    expect(query.$and[0]).toEqual({ a: { $exists: true, $eq: null } });
    expect(query.$and[1].$expr.$and[0].$eq[1]).toBe('null');
    expect(query.$and[1].$expr.$and[0].$eq[0]).toHaveProperty('$type');
    expect(() => nativeScalarPredicate(['a', '*'], { bsonType: 'string', value: 'opaque' })).toThrow(
      'NativeScalarPathRequired',
    );
  });
  it('compiles the exact protected native tenant path with both EXISTS and type guards', () => {
    expect(nativeTenantPredicate(registration(), 'n').$and[0]).toEqual({
      tenant: { $exists: true, $eq: 'exact-boundary' },
    });
    expect(() => nativeTenantPredicate(registration(), 'unknown')).toThrow('NativeTenantBoundaryMissing');
  });
  it('preserves original BSON bytes through control preimage deserialization', () => {
    const value = {
      a: new Int32(2),
      b: Long.fromString('9007199254740993'),
      c: new Double(2),
      d: Decimal128.fromString('2'),
    };
    const restored = BSON.deserialize(BSON.serialize(value), NATIVE_BSON_OPTIONS);
    expect(nativeBsonDigest(restored)).toBe(nativeBsonDigest(value));
    expect(restored.a).toBeInstanceOf(Int32);
    expect(restored.b).toBeInstanceOf(Long);
    expect(restored.c).toBeInstanceOf(Double);
  });
  it('full-preimage CAS carries recursive int/long/array type tests, not numeric equality alone', () => {
    const query = nativePreimagePredicate({ a: [new Int32(1), Long.ONE] });
    const json = JSON.stringify(query);
    expect(json).toContain('$$ROOT');
    expect(json).toContain('$literal');
    expect(json).toContain('$arrayElemAt');
    expect(json).toContain('"int"');
    expect(json).toContain('"long"');
    expect(() => nativePreimagePredicate({ a: 1 })).toThrow('UnsupportedNativePreimageBsonType');
  });
  it('uses concrete array offsets and preserves the other element', () => {
    const value = { a: [{ b: new Int32(1) }, { b: Long.ONE }] };
    expect(nativePathValues(value, ['a', '*', 'b']).map((item) => item.concretePath)).toEqual([
      ['a', '0', 'b'],
      ['a', '1', 'b'],
    ]);
    const result = cloneNativeDocument(value);
    replaceNativePath(result, ['a', '0', 'b'], new Int32(0));
    expect(nativeBsonDigest({ value: result.a[1] })).toBe(nativeBsonDigest({ value: value.a[1] }));
    expect(value.a[0].b.valueOf()).toBe(1);
    expect(() => replaceNativePath(result, ['a', '*', 'b'], null)).toThrow('UnsupportedNativeEffectPath');
    expect(() => replaceNativePath(result, ['_id'], new ObjectId())).toThrow('UnsupportedNativeEffectPath');
  });
  it('rejects stored ordinal and BSON identity drift against the ordinary-read approved target', () => {
    const preimage = { _id: new Int32(1), a: new Int32(2) };
    const approved: NativeTarget = {
      namespaceId: 'n',
      identity: { bsonType: 'int', value: 1 },
      ruleId: 'rule',
      preimageDigest: nativeBsonDigest(preimage),
      postimageDigest: null,
      concretePaths: [],
    };
    expect(() => assertNativePreimageRowBinding(approved, 0, new Int32(0), preimage, null)).not.toThrow();
    expect(() => assertNativePreimageRowBinding(approved, 0, new Int32(1), preimage, null)).toThrow(
      'NativePreviewCorrupt',
    );
    expect(() =>
      assertNativePreimageRowBinding(
        { ...approved, identity: { bsonType: 'long', value: '1' } },
        0,
        new Int32(0),
        preimage,
        null,
      ),
    ).toThrow('NativePreviewCorrupt');
    expect(() => assertNativePreimageRowBinding(approved, 0, new Int32(0), preimage, preimage)).toThrow(
      'NativePreviewCorrupt',
    );
  });
});

describe('native cumulative resource and metadata authority', () => {
  it('does not grant whole-child authority through an alternative path around a shared selected root', () => {
    const selected = new Set(['owned-analysis-root', 'shared-analysis-root', 'analysis-child']);
    const adjacency = new Map([
      ['owned-analysis-root', new Set(['analysis-child'])],
      ['shared-analysis-root', new Set(['analysis-child'])],
    ]);
    expect(() =>
      assertNativeExclusiveOwnership(selected, new Set(['shared-analysis-root']), adjacency),
    ).toThrow('NativeSharedOwnershipAmbiguous');
    expect(() => assertNativeExclusiveOwnership(selected, new Set(), adjacency)).not.toThrow();
    // An exact element-only root with no owned descendants remains eligible for its narrow effect derivation.
    expect(() =>
      assertNativeExclusiveOwnership(
        new Set(['shared-analysis-root']),
        new Set(['shared-analysis-root']),
        new Map(),
      ),
    ).not.toThrow();
  });
  it('durable CDC gap/audit/source-block writes share one session-bound transaction in the source', () => {
    const source = ts.createSourceFile(
      'native-source-adapter.ts',
      readFileSync(new URL('../src/native-source-adapter.ts', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const nodes = (node: ts.Node): ts.Node[] => {
      const result = [node];
      node.forEachChild((child) => {
        result.push(...nodes(child));
      });
      return result;
    };
    const tracker = nodes(source).find(
      (node) => ts.isClassDeclaration(node) && node.name?.text === 'NativeSourceChangeTracker',
    )!;
    const poll = nodes(tracker).find(
      (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'poll',
    )!;
    const clause = nodes(poll).find(ts.isCatchClause)!;
    const transactions = nodes(clause).filter(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'transaction',
    ) as ts.CallExpression[];
    expect(transactions).toHaveLength(1);
    const callback = transactions[0].arguments[0] as ts.ArrowFunction;
    const writes = nodes(clause).filter(
      (node) =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['updateOne', 'insertOne'].includes(node.expression.name.text),
    ) as ts.CallExpression[];
    expect(writes).toHaveLength(4);
    const collections: string[] = [];
    for (const write of writes) {
      expect(write.pos).toBeGreaterThan(callback.body.pos);
      expect(write.end).toBeLessThanOrEqual(callback.body.end);
      const options = write.arguments.at(-1)!;
      expect(
        ts.isObjectLiteralExpression(options) &&
          options.properties.some((property) => property.name?.getText(source) === 'session'),
      ).toBe(true);
      const receiver = (write.expression as ts.PropertyAccessExpression).expression as ts.CallExpression;
      collections.push((receiver.arguments[0] as ts.StringLiteral).text);
    }
    expect(collections).toEqual([
      'native_source_heads',
      'native_source_consistency',
      'native_source_consistency_events',
      'native_source_gap_barriers',
    ]);
  });
  it('shared wildcard roots allow only exact identity-element effects, never record or unrelated-field authority', () => {
    expect(() => assertNativeSharedRootEffect(true, ['ids', '*'], 'delete', [])).toThrow(
      'NativeSharedSubjectRoot',
    );
    expect(() => assertNativeSharedRootEffect(true, ['ids', '*'], 'restrict', [['flag']])).toThrow(
      'NativeSharedSubjectRoot',
    );
    expect(() => assertNativeSharedRootEffect(true, ['ids', '*'], 'redact', [['other', '*']])).toThrow(
      'NativeSharedSubjectRoot',
    );
    expect(() => assertNativeSharedRootEffect(true, ['ids', '*'], 'redact', [['ids', '*']])).not.toThrow();
  });
  it('v2 source/profile hashes use supported domains and bind all immutable model, budget and runtime bytes', () => {
    const input = {
      spec: 'openai/configured-model',
      pricing: { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 2 },
      limits: limits(),
      runtimeHash: 'd'.repeat(64),
    };
    const base = nativeRuntimeBudgetProfileHash(input);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    const hashes = [
      base,
      nativeRuntimeBudgetProfileHash({ ...input, runtimeHash: 'e'.repeat(64) }),
      nativeRuntimeBudgetProfileHash({ ...input, limits: { ...input.limits, toolCalls: 15 } }),
      nativeRuntimeBudgetProfileHash({ ...input, pricing: { ...input.pricing, inputMicrousdPerMillion: 3 } }),
      nativeRuntimeBudgetProfileHash({ ...input, spec: 'anthropic/configured-model' }),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(nativeSourceHeadId(registration().scope, 'source')).toMatch(/^[a-f0-9]{64}$/);
  });
  it('deeply captures only immutable profile fields before any later caller mutation', () => {
    const input = {
      ...profileInput(),
      _id: 'caller-id',
      profileDigest: 'caller-digest',
      createdAt: new Date(0),
    };
    const captured = captureNativeRuntimeBudgetProfile(input);
    const digest = nativeRuntimeBudgetProfileHash(captured);
    input.spec = 'anthropic/configured-model';
    input.runtimeHash = 'e'.repeat(64);
    input.pricing.inputMicrousdPerMillion = 3;
    input.limits.toolCalls = 15;
    expect(Object.keys(captured).sort()).toEqual(['limits', 'pricing', 'runtimeHash', 'spec']);
    expect(captured).toEqual(profileInput());
    expect(nativeRuntimeBudgetProfileHash(captured)).toBe(digest);
    expect(captured.pricing).not.toBe(input.pricing);
    expect(captured.limits).not.toBe(input.limits);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.pricing)).toBe(true);
    expect(Object.isFrozen(captured.limits)).toBe(true);
  });
  it('fully validates saved profile metadata and preserves its server-independent recorded timestamp', () => {
    const saved = profileMetadata();
    const decoded = decodeNativeRuntimeBudgetProfile(saved, saved._id);
    expect(decoded).toEqual(saved);
    expect(decoded.pricing).not.toBe(saved.pricing);
    expect(decoded.limits).not.toBe(saved.limits);
    expect(decoded.createdAt).not.toBe(saved.createdAt);
    saved.pricing.inputMicrousdPerMillion = 3;
    saved.limits.toolCalls = 15;
    saved.createdAt.setTime(0);
    expect(decoded).toEqual(profileMetadata());
  });
  it.each([
    { spec: 'anthropic/configured-model' },
    { runtimeHash: 'e'.repeat(64) },
    { pricing: { inputMicrousdPerMillion: 3, outputMicrousdPerMillion: 2 } },
    { limits: { ...limits(), toolCalls: 15 } },
    { _id: 'b'.repeat(64) },
    { profileDigest: 'b'.repeat(64) },
  ])('refuses a saved identity whose immutable bytes changed %#', (override) => {
    expect(() => decodeNativeRuntimeBudgetProfile({ ...profileMetadata(), ...override })).toThrow(
      'NativeBudgetProfileCorrupt',
    );
  });
  it.each([
    { spec: 'unsupported/configured-model' },
    { runtimeHash: 'invalid' },
    { pricing: { inputMicrousdPerMillion: -1, outputMicrousdPerMillion: 2 } },
    { pricing: { inputMicrousdPerMillion: 1.5, outputMicrousdPerMillion: 2 } },
    { limits: { ...limits(), toolCalls: 0 } },
    { limits: { ...limits(), maxCostMicrousd: -1 } },
  ])('revalidates saved values even if both saved hashes were recomputed %#', (override) => {
    const invalid = { ...profileMetadata(), ...override };
    const hash = nativeRuntimeBudgetProfileHash(invalid);
    expect(() => decodeNativeRuntimeBudgetProfile({ ...invalid, _id: hash, profileDigest: hash })).toThrow(
      'NativeBudgetProfileCorrupt',
    );
  });
  it.each([
    { extra: 'unknown' },
    { pricing: { ...profileInput().pricing, extra: 1 } },
    { limits: { ...limits(), extra: 1 } },
    { createdAt: new Date(Number.NaN) },
    { createdAt: '2026-10-11T00:00:00.000Z' },
  ])('refuses unknown or malformed saved schema metadata %#', (override) => {
    expect(() => decodeNativeRuntimeBudgetProfile({ ...profileMetadata(), ...override })).toThrow(
      'NativeBudgetProfileCorrupt',
    );
  });
  it('requires the expected stored profile ID, both prices and every limit counter', () => {
    expect(() => decodeNativeRuntimeBudgetProfile(profileMetadata(), 'b'.repeat(64))).toThrow(
      'NativeBudgetProfileCorrupt',
    );
    const saved = profileMetadata();
    const pricing: Record<string, unknown> = { ...saved.pricing };
    delete pricing.outputMicrousdPerMillion;
    expect(() => decodeNativeRuntimeBudgetProfile({ ...saved, pricing })).toThrow(
      'NativeBudgetProfileCorrupt',
    );
    for (const counter of Object.keys(saved.limits)) {
      const incomplete: Record<string, unknown> = { ...saved.limits };
      delete incomplete[counter];
      expect(() => decodeNativeRuntimeBudgetProfile({ ...saved, limits: incomplete })).toThrow(
        'NativeBudgetProfileCorrupt',
      );
    }
  });
  it('preserves all previously permitted zero prices and counter caps without raising them', () => {
    const input = {
      ...profileInput(),
      pricing: { inputMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 },
      limits: {
        ...limits(),
        modelCalls: 0,
        changedDocuments: 0,
        traversalDepth: 0,
        graphEdges: 0,
        wallTimeMs: 0,
        totalTokens: 0,
        maxCostMicrousd: 0,
      },
    };
    const captured = captureNativeRuntimeBudgetProfile(input);
    const hash = nativeRuntimeBudgetProfileHash(captured);
    expect(
      decodeNativeRuntimeBudgetProfile({
        ...captured,
        _id: hash,
        profileDigest: hash,
        createdAt: new Date(0),
      }).limits,
    ).toEqual(input.limits);
    expect(deriveNativeBudgetCaps(registration(), limits(), captured.limits)).toMatchObject({
      changed: 0,
      hops: 0,
      edges: 0,
    });
  });
  it('checks the existing 256-character stored spec bound without changing the v2 hash domain', () => {
    const accepted = { ...profileInput(), spec: `openai/${'a'.repeat(249)}` };
    expect(captureNativeRuntimeBudgetProfile(accepted).spec).toHaveLength(256);
    expect(() => captureNativeRuntimeBudgetProfile({ ...accepted, spec: `${accepted.spec}a` })).toThrow(
      'NativeBudgetProfileInvalid',
    );
  });
  it('wires explicit immutable installer capture and full replay decoding before persistence', () => {
    const source = ts.createSourceFile(
      'native-source-budgets.ts',
      readFileSync(new URL('../src/native-source-budgets.ts', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const nodes = (node: ts.Node): ts.Node[] => {
      const result = [node];
      node.forEachChild((child) => {
        result.push(...nodes(child));
      });
      return result;
    };
    const installer = nodes(source).find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'installNativeRuntimeBudgetProfile',
    )!;
    const installerNodes = nodes(installer);
    const calls = installerNodes.filter(ts.isCallExpression);
    const capture = calls.find(
      (call) => call.expression.getText(source) === 'captureNativeRuntimeBudgetProfile',
    )!;
    const hash = calls.find((call) => call.expression.getText(source) === 'nativeRuntimeBudgetProfileHash')!;
    const firstAwait = Math.min(
      ...installerNodes.filter(ts.isAwaitExpression).map((node) => node.getStart(source)),
    );
    expect(capture.getStart(source)).toBeLessThan(hash.getStart(source));
    expect(hash.arguments[0].getText(source)).toBe('captured');
    expect(capture.getStart(source)).toBeLessThan(firstAwait);
    expect(installerNodes.filter(ts.isSpreadAssignment)).toHaveLength(0);
    expect(
      installerNodes.filter(
        (node) => ts.isIdentifier(node) && node.text === 'input' && node.getStart(source) > firstAwait,
      ),
    ).toHaveLength(0);
    const row = installerNodes.find(
      (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'row',
    ) as ts.VariableDeclaration;
    expect(ts.isObjectLiteralExpression(row.initializer!)).toBe(true);
    const properties = (row.initializer as ts.ObjectLiteralExpression).properties;
    expect(properties.map((property) => property.name?.getText(source)).sort()).toEqual([
      '_id',
      'createdAt',
      'limits',
      'pricing',
      'profileDigest',
      'runtimeHash',
      'spec',
    ]);
    for (const key of ['spec', 'pricing', 'limits', 'runtimeHash']) {
      const property = properties.find(
        (property) => property.name?.getText(source) === key,
      ) as ts.PropertyAssignment;
      expect(property.initializer.getText(source)).toBe(`captured.${key}`);
    }
    expect(
      calls
        .find((call) => call.expression.getText(source) === 'decodeNativeRuntimeBudgetProfile')
        ?.arguments.map((argument) => argument.getText(source)),
    ).toEqual(['saved', '_id']);
    const state = nodes(source).find(
      (node) => ts.isMethodDeclaration(node) && node.name.getText(source) === 'state',
    )!;
    const stateCalls = nodes(state).filter(ts.isCallExpression);
    expect(
      stateCalls
        .find((call) => call.expression.getText(source) === 'decodeNativeRuntimeBudgetProfile')
        ?.arguments.map((argument) => argument.getText(source)),
    ).toEqual(['rawProfile', 'job.binding.workerProfileHash']);
  });
  it('reserves snapshot, overflow probe and independent reads without shrinking the graph-node bound', () => {
    const caps = { scanned: 100, changed: 10, operations: 10, hops: 1, nodes: 10, edges: 10 };
    const state = nextNativeBudget(
      { caps, scannedReserved: 10, changed: 0, operations: 1 },
      { scanned: 10 + 3 + 1 },
    );
    expect(state.scannedReserved).toBe(24);
    expect(caps.nodes).toBe(10);
  });
  it('source-scoped gap and common revocation barriers are strict, persisted control collections', () => {
    expect(CONTROL_COLLECTIONS).toContain('native_source_gap_barriers');
    expect(CONTROL_COLLECTIONS).toContain('provenance_scope_barriers');
    expect(NATIVE_SOURCE_VALIDATORS.native_source_gap_barriers.$jsonSchema.required).toContain('blocked');
    const properties = NATIVE_SOURCE_VALIDATORS.native_source_gap_barriers.$jsonSchema.properties;
    expect(properties).not.toHaveProperty('jobId');
    expect(properties).toHaveProperty('registrationRevision');
    const role = nativeDomainExecutorAtlasRoleManifest(registration(), 'control_db');
    expect(
      role.actions
        .filter((action) => action.action === 'UPDATE')
        .flatMap((action) => action.resources.map((value) => value.collection)),
    ).toContain('provenance_scope_barriers');
  });
  it('Mongo held-out payload guards match the strict worker-readable contract parser', () => {
    const keys = [
      'split',
      'fixtureId',
      'parentUseful',
      'candidateUseful',
      'useful',
      'outcome',
      'outcomes',
      'admitted',
    ];
    expect(CONTROL_VALIDATORS.projection_events.$or[1].$and).toEqual(
      keys.map((key) => ({ [`payload.${key}`]: { $exists: false } })),
    );
    const allowed = {
      reportId: null,
      candidateId: 'candidate',
      pairId: 'pair',
      family: 'family',
      verdict: null,
    };
    for (const key of keys)
      expect(() =>
        validateProjectionPayload('trial_completed', { ...allowed, [key]: 'denied' } as never),
      ).toThrow();
  });
  it('intersects owner, stored harness and trusted profile caps', () => {
    const harness = {
      ...limits(),
      scannedDocuments: 40,
      changedDocuments: 7,
      toolCalls: 12,
      traversalDepth: 2,
    };
    const profile = {
      ...limits(),
      scannedDocuments: 60,
      changedDocuments: 9,
      toolCalls: 8,
      graphNodes: 5,
      graphEdges: 10,
    };
    expect(deriveNativeBudgetCaps(registration(), harness, profile)).toEqual({
      scanned: 40,
      changed: 7,
      operations: 8,
      hops: 2,
      nodes: 5,
      edges: 10,
    });
  });
  it('counts repeated failed/retried scans cumulatively and never resets changed budget', () => {
    const caps = { scanned: 10, changed: 2, operations: 3, hops: 1, nodes: 10, edges: 10 };
    const first = nextNativeBudget(
      { caps, scannedReserved: 0, changed: 0, operations: 0 },
      { scanned: 6, operations: 1 },
    );
    expect(() => nextNativeBudget({ caps, ...first }, { scanned: 6 })).toThrow('NativeJobBudgetExceeded');
    const second = nextNativeBudget({ caps, ...first }, { scanned: 4, changed: 2, operations: 2 });
    expect(() => nextNativeBudget({ caps, ...second }, { changed: 1 })).toThrow('NativeJobBudgetExceeded');
    expect(() => nextNativeBudget({ caps, ...second }, { operations: 1 })).toThrow('NativeJobBudgetExceeded');
    expect(() => nextNativeBudget({ caps, ...first }, { scanned: -1 })).toThrow('NativeBudgetChargeInvalid');
  });
  it('installs all native metadata with strict envelopes and indexes', () => {
    for (const collection of NATIVE_SOURCE_COLLECTIONS) {
      expect(CONTROL_COLLECTIONS).toContain(collection);
      expect(CONTROL_VALIDATORS[collection]).toEqual(NATIVE_SOURCE_VALIDATORS[collection]);
      expect(NATIVE_SOURCE_VALIDATORS[collection].$jsonSchema.additionalProperties).toBe(false);
      assertSupportedMongoSchema(NATIVE_SOURCE_VALIDATORS[collection]);
    }
    expect(
      CONTROL_INDEXES.some((index) => index.collection === 'native_source_budgets' && index.options?.unique),
    ).toBe(true);
  });
  it('grants only exact native namespaces and never source INSERT or private data', () => {
    const source = registration();
    const actions = nativeSourceAtlasActions(source);
    expect(actions.map((value) => value.action)).toEqual(['FIND', 'CHANGE_STREAM', 'UPDATE']);
    expect(
      actions.every((value) =>
        value.resources.every(
          (resource) => resource.db === 'owner_db' && resource.collection === 'owner_collection',
        ),
      ),
    ).toBe(true);
    const role = nativeDomainExecutorAtlasRoleManifest(source, 'control_db');
    expect(
      role.actions
        .flatMap((value) => value.resources)
        .some((value) => value.db === 'expunge_world' || value.db === 'expunge_private'),
    ).toBe(false);
    expect(
      role.actions
        .filter((value) => value.action === 'INSERT')
        .flatMap((value) => value.resources)
        .every((value) => value.db === 'control_db'),
    ).toBe(true);
    expect(() => nativeDomainExecutorAtlasRoleManifest(source, 'owner_db')).toThrow(
      'NativeSourceCollidesWithAuthorityStorage',
    );
  });
  it('projection principals never receive native subject/preimage read grants', () => {
    const role = atlasRoleManifests().projection_reader!;
    const reads = role.actions
      .filter((value) => value.action === 'FIND')
      .flatMap((value) => value.resources.map((resource) => resource.collection));
    expect(reads).not.toContain('native_source_preimage_rows');
    expect(reads).not.toContain('native_source_cleanup_requests');
    expect(reads).not.toContain('native_source_job_bindings');
    expect(reads).toContain('native_source_heads');
    const issuer = atlasRoleManifests().approval_issuer!;
    const issuerReads = issuer.actions
      .filter((value) => value.action === 'FIND')
      .flatMap((value) => value.resources.map((resource) => resource.collection));
    expect(issuerReads).toContain('native_source_previews');
    expect(issuerReads).toContain('native_source_job_bindings');
    expect(issuerReads).not.toContain('native_source_preimage_rows');
    const executor = atlasRoleManifests().domain_executor!;
    const executorInserts = executor.actions
      .filter((value) => value.action === 'INSERT')
      .flatMap((value) => value.resources.map((resource) => resource.collection));
    expect(executorInserts).toContain('native_source_preview_consumptions');
    expect(executorInserts).not.toContain('native_source_preview_approvals');
  });
  it.each(['staging', 'production'])('accepts the real %s setup environment', (env) => {
    expect(
      seedOptionsFromEnv({
        EXPUNGE_AUTHORITY_FLOOR_HASH: 'c'.repeat(64),
        EXPUNGE_TENANT_ID: 'owner',
        EXPUNGE_ENV: env,
        EXPUNGE_SCOPE_ID: 'scope',
      }).authorities?.[0]?.key.env,
    ).toBe(env);
  });
  it('uses every shared environment for legacy control envelopes and only release envs for native source envelopes', () => {
    for (const [name, validator] of Object.entries(CONTROL_VALIDATORS)) {
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!value || typeof value !== 'object') return;
        const item = value as Document;
        if (item.env?.enum)
          expect(item.env.enum).toEqual(
            name.startsWith('native_source_') ? ['staging', 'production'] : [...ENVIRONMENTS],
          );
        Object.values(item).forEach(visit);
      };
      visit(validator);
    }
  });
});
