import { Decimal128, Int32, Long, ObjectId, type ClientSession, type Document } from 'mongodb';
import {
  nativeRegistrationHash,
  nativeSourceRegistrationSchema,
  type NativeScalar as PortableScalar,
  type NativeSourceRegistration,
  type SourceEnvironment,
} from '@expunge/contracts';
import { fail, requirePrincipal, type MongoService } from './client.js';
import type { BsonScalar, NativeIdType } from './native-values.js';

/**
 * A native owner source is the owner's own database, registered as it is: any database and collection names, documents at
 * top level, the owner's `_id` types, written by the owner's applications at any time. The registration is the CONTRACT's
 * (`NativeSourceRegistration`, `@expunge/contracts` source.ts); this module adds only what the contract leaves to the Mongo
 * layer: reserved-database refusal, a key field per namespace, an `_id` type per namespace, the per-deployment connection
 * variable, the stored (insert-only, hashed) registration rows and a compiled lookup model for the adapter.
 */

export type { NativeSourceRegistration };
export type StoredOwnerSource = {
  _id: string;
  tenantId: string;
  env: SourceEnvironment;
  scopeId: string;
  sourceId: string;
  deploymentId: string;
  revision: number;
  registrationHash: string;
  registration: NativeSourceRegistration;
  createdAt: Date;
};
export type SourceScope = { tenantId: string; env: SourceEnvironment; scopeId: string };

const SYSTEM_DATABASES = ['admin', 'local', 'config'];
/** System databases, anything under the `expunge_` prefix and every configured `EXPUNGE_*_DB` name (case-insensitive). */
export function isReservedDatabase(database: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = database.toLowerCase();
  if (SYSTEM_DATABASES.includes(name) || name.startsWith('expunge_')) return true;
  return Object.entries(env).some(
    ([variable, value]) =>
      /^EXPUNGE_[A-Z0-9_]*_DB$/.test(variable) && typeof value === 'string' && value.toLowerCase() === name,
  );
}
/** The environment variable that holds the role-scoped connection string of one deployment. The value is never stored. */
export function sourceConnectionVariable(deploymentId: string): string {
  return `EXPUNGE_SOURCE_${deploymentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URI`;
}

/** Decodes a portable scalar into the exact BSON value the adapter compares and writes. */
export function decodeScalar(scalar: PortableScalar): BsonScalar {
  switch (scalar.bsonType) {
    case 'string':
    case 'bool':
      return scalar.value;
    case 'null':
      return null;
    case 'objectId':
      return new ObjectId(scalar.value.toLowerCase());
    case 'int':
      return new Int32(scalar.value);
    case 'long':
      return Long.fromString(scalar.value);
    case 'double':
      return scalar.value;
    case 'decimal':
      return Decimal128.fromString(scalar.value);
    case 'date':
      return new Date(scalar.value);
  }
}

export type CompiledField = {
  fieldId: string;
  namespaceId: string;
  path: string[];
  identity: boolean;
  protected: boolean;
  retained: boolean;
  isKey: boolean;
  isArray: boolean;
  /** Referencing side of a declared reference. */
  referencing: boolean;
};
export type CompiledNamespace = {
  namespaceId: string;
  database: string;
  collection: string;
  key: CompiledField;
  idTypes: NativeIdType[];
  tenant: { path: string[]; value: BsonScalar };
  /** The owner's revision field, when the source's consistency is `native_revision`. */
  revisionPath: string[] | null;
};
export type CompiledSource = {
  registration: NativeSourceRegistration;
  hash: string;
  namespaces: Map<string, CompiledNamespace>;
  fields: Map<string, CompiledField>;
};
const ID_TYPES: Record<string, NativeIdType> = {
  string: 'string',
  objectId: 'objectId',
  int: 'int',
  long: 'long',
  // The contract has no UUID scalar: a `binData` key is accepted only as a subtype-4 UUID.
  binData: 'uuid',
};

/**
 * Parses an untrusted registration with the contract's schema and adds the Mongo layer's own checks: no reserved database,
 * exactly one protected key field (`_id`) per namespace with a supported id type. Throws `InvalidOwnerSource` for anything else.
 */
export function compileOwnerSource(input: unknown, env: NodeJS.ProcessEnv = process.env): CompiledSource {
  const parsed = nativeSourceRegistrationSchema.safeParse(input);
  if (!parsed.success) return fail('InvalidOwnerSource');
  const registration = parsed.data;
  for (const namespace of registration.namespaces)
    if (isReservedDatabase(namespace.database, env)) return fail('InvalidOwnerSource');
  if (registration.effectJournal && isReservedDatabase(registration.effectJournal.database, env))
    return fail('InvalidOwnerSource');
  const referencing = new Set(registration.references.map((r) => r.fromFieldId));
  const retained = new Set(registration.retainedFieldIds);
  const fields = new Map<string, CompiledField>();
  for (const field of registration.fields)
    fields.set(field.fieldId, {
      fieldId: field.fieldId,
      namespaceId: field.namespaceId,
      path: [...field.path],
      identity: field.identity,
      protected: field.protected,
      retained: retained.has(field.fieldId),
      isKey: field.path.length === 1 && field.path[0] === '_id',
      isArray: field.path.includes('*'),
      referencing: referencing.has(field.fieldId),
    });
  const namespaces = new Map<string, CompiledNamespace>();
  for (const namespace of registration.namespaces) {
    const keys = [...fields.values()].filter((f) => f.namespaceId === namespace.namespaceId && f.isKey);
    if (keys.length !== 1 || !keys[0]!.protected) return fail('InvalidOwnerSource');
    const keyFieldDef = registration.fields.find((f) => f.fieldId === keys[0]!.fieldId)!;
    const idTypes = keyFieldDef.bsonTypes.map((t) => ID_TYPES[t]);
    if (idTypes.length === 0 || idTypes.some((t) => t === undefined)) return fail('InvalidOwnerSource');
    const boundary = registration.tenantBoundaries.find((b) => b.namespaceId === namespace.namespaceId)!;
    const tenantField = fields.get(boundary.fieldId)!;
    const revisionBinding =
      registration.consistency.kind === 'native_revision'
        ? registration.consistency.bindings.find((b) => b.namespaceId === namespace.namespaceId)
        : undefined;
    namespaces.set(namespace.namespaceId, {
      namespaceId: namespace.namespaceId,
      database: namespace.database,
      collection: namespace.collection,
      key: keys[0]!,
      idTypes: idTypes as NativeIdType[],
      tenant: { path: tenantField.path, value: decodeScalar(boundary.equals) },
      revisionPath: revisionBinding ? fields.get(revisionBinding.revisionFieldId)!.path : null,
    });
  }
  return { registration, hash: nativeRegistrationHash(registration), namespaces, fields };
}

/** Owner-source registrations: insert-only per revision, hashed, written by setup or the fixture builder only. */
export class OwnerSourceRepository {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.world.collection<StoredOwnerSource & Document>('owner_sources');
  }

  /**
   * Stores one revision. The registration's own `scope` and `revision` identify the row, and the revision must be the
   * next one for its source. Storing a registration does not authorize it: owner approval (`ownerReview`) is evidence
   * carried in the registration, and a separate owner grant remains the thing that authorizes installation.
   */
  async register(input: unknown): Promise<StoredOwnerSource> {
    requirePrincipal(this.service, ['fixture_builder', 'setup']);
    const compiled = compileOwnerSource(input);
    const registration = compiled.registration;
    return this.service.transaction(async (session) => {
      const latest = await this.rows.findOne(
        { ...registration.scope, sourceId: registration.sourceId },
        { sort: { revision: -1 }, session },
      );
      if (registration.revision !== (latest?.revision ?? 0) + 1) return fail('OwnerSourceRevisionConflict');
      const row: StoredOwnerSource = {
        _id: '',
        ...registration.scope,
        sourceId: registration.sourceId,
        deploymentId: registration.deploymentId,
        revision: registration.revision,
        registrationHash: compiled.hash,
        registration,
        createdAt: new Date(),
      };
      row._id = nativeRowId(row);
      await this.rows.insertOne(row as never, { session });
      return row;
    });
  }

  /** The latest (or an exact) revision, re-hashed and re-validated on read: a row edited behind the repository is refused. */
  async read(
    scope: SourceScope,
    sourceId: string,
    revision?: number,
    session?: ClientSession,
  ): Promise<{ row: StoredOwnerSource; compiled: CompiledSource }> {
    const row = await this.rows.findOne(
      {
        tenantId: scope.tenantId,
        env: scope.env,
        scopeId: scope.scopeId,
        sourceId,
        ...(revision === undefined ? {} : { revision }),
      },
      { sort: { revision: -1 }, session },
    );
    if (!row) return fail('OwnerSourceNotFound');
    const compiled = compileOwnerSource(row.registration);
    if (compiled.hash !== row.registrationHash) fail('OwnerSourceTampered');
    return { row, compiled };
  }
}
function nativeRowId(
  row: Pick<StoredOwnerSource, 'tenantId' | 'env' | 'scopeId' | 'sourceId' | 'revision'>,
): string {
  return [row.tenantId, row.env, row.scopeId, row.sourceId, String(row.revision)].join('|');
}
