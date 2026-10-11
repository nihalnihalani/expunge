import { createHash } from 'node:crypto';
import canonicalizeModule from 'canonicalize';
import { z } from 'zod';
import { Decimal128 } from 'bson';

const canonicalize = canonicalizeModule as unknown as (value: unknown) => string | undefined;
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const iso = z.string().datetime({ offset: true });
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Native sources require an explicit release environment, never an inferred demo binding. */
export const sourceEnvironmentSchema = z.enum(['staging', 'production']);
export type SourceEnvironment = z.infer<typeof sourceEnvironmentSchema>;

/** Portable, type-preserving scalar references. Decode only inside the trusted Mongo adapter. */
export const nativeScalarSchema = z.discriminatedUnion('bsonType', [
  z.object({ bsonType: z.literal('string'), value: z.string().max(4096) }).strict(),
  z.object({ bsonType: z.literal('objectId'), value: z.string().regex(/^[a-fA-F0-9]{24}$/) }).strict(),
  z.object({ bsonType: z.literal('int'), value: z.number().int().min(-2147483648).max(2147483647) }).strict(),
  z
    .object({
      bsonType: z.literal('long'),
      value: z
        .string()
        .max(20)
        .regex(/^-?(0|[1-9][0-9]*)$/)
        .refine((value) => {
          try {
            return BigInt(value) >= -(2n ** 63n) && BigInt(value) < 2n ** 63n;
          } catch {
            return false;
          }
        }, 'OutsideBsonInt64'),
    })
    .strict(),
  z.object({ bsonType: z.literal('double'), value: z.number().finite() }).strict(),
  z
    .object({
      bsonType: z.literal('decimal'),
      value: z
        .string()
        .max(128)
        .regex(/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/)
        .refine((value) => {
          try {
            Decimal128.fromString(value);
            return true;
          } catch {
            return false;
          }
        }, 'OutsideBsonDecimal128'),
    })
    .strict(),
  z
    .object({
      bsonType: z.literal('date'),
      value: iso.refine((value) => !/\.\d{4,}/.test(value), 'BsonDateRequiresMillisecondPrecision'),
    })
    .strict(),
  z.object({ bsonType: z.literal('bool'), value: z.boolean() }).strict(),
  z.object({ bsonType: z.literal('null'), value: z.null() }).strict(),
]);
export type NativeScalar = z.infer<typeof nativeScalarSchema>;

// Dotted/dollar-containing literal field names need a different query compiler. Refuse explicitly for now.
const segment = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const nativeFieldPathSchema = z
  .array(z.union([segment, z.literal('*')]))
  .min(1)
  .max(16)
  .refine(
    (path) => path[0] !== '*' && path.filter((part) => part === '*').length <= 1,
    'UnsupportedNativePath',
  );
const nativeNamespaceSchema = z
  .object({
    namespaceId: id,
    database: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[^/\\. "$]+$/)
      .refine((value) => !value.includes('\0'), 'UnsupportedNativeNamespace'),
    collection: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (value) => !value.includes('\0') && !value.startsWith('system.') && !value.includes('$'),
        'UnsupportedNativeNamespace',
      ),
  })
  .strict();
const fieldSchema = z
  .object({
    fieldId: id,
    namespaceId: id,
    path: nativeFieldPathSchema,
    bsonTypes: z
      .array(
        z.enum([
          'string',
          'objectId',
          'int',
          'long',
          'double',
          'decimal',
          'date',
          'bool',
          'null',
          'array',
          'object',
          'binData',
        ]),
      )
      .min(1)
      .max(12),
    identity: z.boolean(),
    protected: z.boolean(),
  })
  .strict();
const effect = z.enum(['delete', 'redact', 'restrict', 'tombstone']);
const condition = z.object({ fieldId: id, equals: nativeScalarSchema }).strict();

/** Owner-authored policy. This is a validated proposal; a stored owner grant still authorizes installation. */
export const nativeSourceRegistrationSchema = z
  .object({
    contractVersion: z.literal(2),
    sourceId: id,
    deploymentId: id,
    scope: z.object({ tenantId: id, env: sourceEnvironmentSchema, scopeId: id }).strict(),
    revision,
    policyRevision: revision,
    authorizationRevision: revision,
    sourceKind: z.enum(['original', 'isolated_replay']),
    namespaces: z.array(nativeNamespaceSchema).min(1).max(64),
    /** Explicit owner-approved metadata location for source-side effect stamps across deployments. */
    effectJournal: nativeNamespaceSchema.omit({ namespaceId: true }).optional(),
    fields: z.array(fieldSchema).min(1).max(1024),
    tenantBoundaries: z
      .array(z.object({ namespaceId: id, fieldId: id, equals: nativeScalarSchema }).strict())
      .min(1)
      .max(64),
    subjectIdentityFieldIds: z.array(id).min(1).max(32),
    references: z
      .array(
        z
          .object({
            referenceId: id,
            fromFieldId: id,
            toFieldId: id,
            owner: z.enum(['from', 'to', 'none']),
            identityRule: z.enum(['same_bson_type', 'string_to_objectId', 'objectId_to_string']),
          })
          .strict(),
      )
      .max(256),
    rules: z
      .array(
        z
          .object({
            ruleId: id,
            namespaceId: id,
            all: z.array(condition).min(1).max(32),
            effect,
            fieldIds: z.array(id).max(64),
            replacement: nativeScalarSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    retainedFieldIds: z.array(id).max(1024),
    consistency: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('native_revision'),
          bindings: z
            .array(
              z
                .object({
                  namespaceId: id,
                  revisionFieldId: id,
                })
                .strict(),
            )
            .min(1)
            .max(64),
          changeStreamRequired: z.literal(true),
        })
        .strict(),
      z.object({ kind: z.literal('conditional_preimage'), changeStreamRequired: z.literal(true) }).strict(),
    ]),
    limits: z
      .object({
        maxScanned: z.number().int().min(1).max(100000),
        maxChanged: z.number().int().min(1).max(100000),
        maxBatch: z.number().int().min(1).max(100),
        maxHops: z.number().int().min(0).max(16),
        maxTotalScanned: z.number().int().min(1).max(1000000),
        maxTotalChanged: z.number().int().min(1).max(100000),
        maxOperations: z.number().int().min(1).max(10000),
      })
      .strict(),
    ownerReview: z
      .object({
        reviewId: id,
        actorId: id,
        reviewedAt: iso,
        provenanceDigest: digest,
        writeScopeDigest: digest,
      })
      .strict(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const namespaces = new Map(source.namespaces.map((value) => [value.namespaceId, value]));
    const fields = new Map(source.fields.map((value) => [value.fieldId, value]));
    if (namespaces.size !== source.namespaces.length || fields.size !== source.fields.length)
      issue([], 'DuplicateSourceIdentifier');
    if (new Set(source.namespaces.map((n) => `${n.database}\0${n.collection}`)).size !== namespaces.size)
      issue(['namespaces'], 'DuplicatePhysicalNamespace');
    if (
      source.effectJournal &&
      source.namespaces.some(
        (n) =>
          n.database === source.effectJournal!.database && n.collection === source.effectJournal!.collection,
      )
    )
      issue(['effectJournal'], 'JournalOverlapsBusinessNamespace');
    const fieldKeys = source.fields.map((f) => `${f.namespaceId}\0${f.path.join('\0')}`);
    if (new Set(fieldKeys).size !== fieldKeys.length) issue(['fields'], 'DuplicateNativeField');
    source.fields.forEach((f, index) => {
      if (!namespaces.has(f.namespaceId)) issue(['fields', index], 'UnknownNamespace');
    });
    const boundaryNamespaces = new Set(source.tenantBoundaries.map((boundary) => boundary.namespaceId));
    if (
      boundaryNamespaces.size !== source.tenantBoundaries.length ||
      boundaryNamespaces.size !== namespaces.size
    )
      issue(['tenantBoundaries'], 'EveryNamespaceRequiresOneTenantBoundary');
    for (const boundary of source.tenantBoundaries) {
      const tenant = fields.get(boundary.fieldId);
      if (
        !namespaces.has(boundary.namespaceId) ||
        !tenant ||
        tenant.namespaceId !== boundary.namespaceId ||
        tenant.path.includes('*') ||
        !tenant.protected ||
        boundary.equals.bsonType === 'null' ||
        tenant.bsonTypes.length !== 1 ||
        tenant.bsonTypes[0] !== boundary.equals.bsonType
      )
        issue(['tenantBoundaries'], 'TenantBoundaryMustBeProtectedScalar');
    }
    for (const identityId of source.subjectIdentityFieldIds)
      if (!fields.get(identityId)?.identity) issue(['subjectIdentityFieldIds'], 'UnregisteredIdentity');
    for (const retained of source.retainedFieldIds)
      if (!fields.has(retained)) issue(['retainedFieldIds'], 'UnknownRetainedField');
    const retained = new Set(source.retainedFieldIds);
    source.references.forEach((reference, index) => {
      const from = fields.get(reference.fromFieldId);
      const to = fields.get(reference.toFieldId);
      if (!from || !to) issue(['references', index], 'UnknownReferenceField');
      else if (
        reference.identityRule === 'same_bson_type'
          ? !from.bsonTypes.some((type) => to.bsonTypes.includes(type))
          : reference.identityRule === 'string_to_objectId'
            ? !from.bsonTypes.includes('string') || !to.bsonTypes.includes('objectId')
            : !from.bsonTypes.includes('objectId') || !to.bsonTypes.includes('string')
      )
        issue(['references', index], 'IncompatibleReferenceTypes');
    });
    if (new Set(source.references.map((r) => r.referenceId)).size !== source.references.length)
      issue(['references'], 'DuplicateReference');
    if (new Set(source.rules.map((r) => r.ruleId)).size !== source.rules.length)
      issue(['rules'], 'DuplicatePolicyRule');
    source.rules.forEach((rule, index) => {
      if (!namespaces.has(rule.namespaceId)) issue(['rules', index], 'UnknownNamespace');
      for (const predicate of rule.all) {
        const f = fields.get(predicate.fieldId);
        if (
          !f ||
          f.namespaceId !== rule.namespaceId ||
          f.path.includes('*') ||
          !f.bsonTypes.includes(predicate.equals.bsonType)
        )
          issue(['rules', index, 'all'], 'UnsupportedPolicyPredicate');
      }
      if (rule.effect !== 'delete' && rule.fieldIds.length === 0)
        issue(['rules', index, 'fieldIds'], 'ExactEffectFieldsRequired');
      if (rule.effect === 'delete' && rule.fieldIds.length !== 0)
        issue(['rules', index, 'fieldIds'], 'DeleteIsRecordEffect');
      for (const fieldId of rule.fieldIds) {
        const f = fields.get(fieldId);
        if (
          !f ||
          f.namespaceId !== rule.namespaceId ||
          f.protected ||
          retained.has(fieldId) ||
          f.path[0] === '_id'
        )
          issue(['rules', index, 'fieldIds'], 'ProtectedOrUnknownEffectField');
        if (
          f &&
          source.fields.some(
            (p) =>
              (p.protected || retained.has(p.fieldId)) &&
              p.namespaceId === f.namespaceId &&
              pathsOverlap(p.path, f.path),
          )
        )
          issue(['rules', index, 'fieldIds'], 'EffectOverlapsRetainedField');
        if (f && rule.replacement && !f.bsonTypes.includes(rule.replacement.bsonType))
          issue(['rules', index, 'replacement'], 'IncompatibleReplacementType');
      }
      if (
        rule.effect === 'delete' &&
        source.fields.some((f) => f.namespaceId === rule.namespaceId && retained.has(f.fieldId))
      )
        issue(['rules', index], 'DeleteWouldRemoveRetainedField');
      if (rule.effect !== 'delete' && rule.replacement === undefined)
        issue(['rules', index, 'replacement'], 'ExplicitEffectReplacementRequired');
      if (rule.effect === 'delete' && rule.replacement !== undefined)
        issue(['rules', index, 'replacement'], 'DeleteHasNoReplacement');
    });
    if (source.limits.maxChanged > source.limits.maxScanned) issue(['limits'], 'ChangesExceedInspectedBound');
    if (
      source.limits.maxTotalScanned < source.limits.maxScanned ||
      source.limits.maxTotalChanged < source.limits.maxChanged ||
      source.limits.maxTotalChanged > source.limits.maxTotalScanned
    )
      issue(['limits'], 'InconsistentCumulativeBounds');
    if (source.consistency.kind === 'native_revision') {
      const bindings = source.consistency.bindings;
      if (
        new Set(bindings.map((binding) => binding.namespaceId)).size !== bindings.length ||
        bindings.length !== namespaces.size
      )
        issue(['consistency'], 'EveryNamespaceRequiresVersionBinding');
      for (const binding of bindings) {
        const f = fields.get(binding.revisionFieldId);
        if (
          !namespaces.has(binding.namespaceId) ||
          !f ||
          f.namespaceId !== binding.namespaceId ||
          f.path.includes('*') ||
          !f.protected ||
          f.bsonTypes.some((type) => !['string', 'int', 'long', 'date'].includes(type))
        )
          issue(['consistency'], 'RevisionMustBeProtectedScalar');
      }
    }
  });

export type NativeSourceRegistration = z.infer<typeof nativeSourceRegistrationSchema>;
export type NativeNamespace = NativeSourceRegistration['namespaces'][number];
export type NativeField = NativeSourceRegistration['fields'][number];

export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a
    .slice(0, Math.min(a.length, b.length))
    .every((part, i) => part === b[i] || part === '*' || b[i] === '*');
}

/** A digest identifies approved configuration; it never establishes owner authorization by itself. */
export function nativeRegistrationHash(registration: NativeSourceRegistration): string {
  const value = nativeSourceRegistrationSchema.parse(registration);
  return createHash('sha256').update('expunge-native-source:v2\0').update(canonicalize(value)!).digest('hex');
}

/** Only trusted snapshot preparation sees this manifest. Never expose expected/preservation hashes to proposals. */
export const authenticCaseManifestSchema = z
  .object({
    contractVersion: z.literal(2),
    caseId: id,
    sourceId: id,
    registrationHash: digest,
    cleanupRequestId: id,
    provenanceDigest: digest,
    snapshotId: id,
    snapshotDigest: digest,
    snapshotObservedAt: iso,
    boundaryDigest: digest,
    reviewId: id,
    reviewedAt: iso,
    expectedEffectsDigest: digest,
    preservationDigest: digest,
    namespaceMap: z
      .array(
        z
          .object({
            namespaceId: id,
            originDatabase: z.string().min(1).max(63),
            originCollection: z.string().min(1).max(120),
            replayDatabase: z.string().min(1).max(63),
            replayCollection: z.string().min(1).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    replayAuthorizationId: id,
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const targets = value.namespaceMap.map((n) => `${n.replayDatabase}\0${n.replayCollection}`);
    if (new Set(targets).size !== targets.length) fail('ReplayNamespacesNotDistinct');
    if (new Set(value.namespaceMap.map((n) => n.namespaceId)).size !== value.namespaceMap.length)
      fail('DuplicateNamespaceBinding');
    // Each arm gets separate physical databases; even identical BSON _ids cannot overlap the original.
    const originalDatabases = new Set(value.namespaceMap.map((n) => n.originDatabase));
    if (value.namespaceMap.some((n) => originalDatabases.has(n.replayDatabase)))
      fail('ReplayTargetsOriginalDatabase');
  });
export type AuthenticCaseManifest = z.infer<typeof authenticCaseManifestSchema>;
export type AuthenticCaseReference = Pick<AuthenticCaseManifest, 'caseId' | 'sourceId' | 'provenanceDigest'>;

/** Resolve against the stored, owner-authorized version before accepting a private replay manifest. */
export function assertCaseMatchesRegistration(
  input: AuthenticCaseManifest,
  source: NativeSourceRegistration,
): void {
  const manifest = authenticCaseManifestSchema.parse(input);
  const registration = nativeSourceRegistrationSchema.parse(source);
  if (
    manifest.sourceId !== registration.sourceId ||
    manifest.registrationHash !== nativeRegistrationHash(registration)
  )
    throw new Error('CaseRegistrationMismatch');
  if (manifest.namespaceMap.length !== registration.namespaces.length)
    throw new Error('IncompleteCaseNamespaces');
  for (const namespace of registration.namespaces) {
    const mapping = manifest.namespaceMap.find((n) => n.namespaceId === namespace.namespaceId);
    if (
      !mapping ||
      mapping.originDatabase !== namespace.database ||
      mapping.originCollection !== namespace.collection
    )
      throw new Error('CaseNamespaceMismatch');
  }
}

export function publicCaseReference(manifest: AuthenticCaseManifest): AuthenticCaseReference {
  const value = authenticCaseManifestSchema.parse(manifest);
  return { caseId: value.caseId, sourceId: value.sourceId, provenanceDigest: value.provenanceDigest };
}

export function assertSeparateCaseArms(arms: readonly AuthenticCaseManifest[]): void {
  if (arms.length < 2 || arms.length > 8) throw new Error('InvalidCaseArmCount');
  const parsed = arms.map((arm) => authenticCaseManifestSchema.parse(arm));
  const originals = new Set(parsed.flatMap((arm) => arm.namespaceMap.map((n) => n.originDatabase)));
  const commitment = (arm: AuthenticCaseManifest) =>
    canonicalize({
      caseId: arm.caseId,
      sourceId: arm.sourceId,
      registrationHash: arm.registrationHash,
      provenanceDigest: arm.provenanceDigest,
      cleanupRequestId: arm.cleanupRequestId,
      snapshotId: arm.snapshotId,
      snapshotDigest: arm.snapshotDigest,
      boundaryDigest: arm.boundaryDigest,
      expectedEffectsDigest: arm.expectedEffectsDigest,
      preservationDigest: arm.preservationDigest,
      originNamespaces: arm.namespaceMap
        .map((n) => ({
          namespaceId: n.namespaceId,
          database: n.originDatabase,
          collection: n.originCollection,
        }))
        .sort((a, b) => a.namespaceId.localeCompare(b.namespaceId)),
    });
  const expected = commitment(parsed[0]);
  const databases = new Set<string>();
  for (const arm of parsed) {
    if (commitment(arm) !== expected) throw new Error('CaseArmCommitmentMismatch');
    const local = new Set(arm.namespaceMap.map((n) => n.replayDatabase));
    for (const database of local) {
      if (originals.has(database)) throw new Error('CaseArmTargetsOriginalDatabase');
      if (databases.has(database)) throw new Error('CaseArmsSharePhysicalDatabase');
      databases.add(database);
    }
  }
}
