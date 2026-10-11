import { MongoClient, ObjectId, type Collection, type Db, type Document } from 'mongodb';
import { FIELD_PATH_WILDCARD, type EffectKind } from '@expunge/contracts';
import { ProtocolError, fail } from './client.js';
import { bsonPreimageHash } from './hashes.js';
import {
  RAW_READ,
  applyModelWrites,
  bindingKey,
  cloneRaw,
  nativeAddress,
  nativeId,
  nativeNodeKey,
  nativeScalar,
  sameNativeValue,
  valuesAt,
  type BsonScalar,
  type ModelWrite,
  type NativeAddress,
  type NativeIdType,
} from './native-values.js';
import {
  compileOwnerSource,
  decodeScalar,
  sourceConnectionVariable,
  type CompiledField,
  type CompiledNamespace,
  type CompiledSource,
} from './owner-source.js';
import { assertStoredShape } from './scope.js';

/** A refusal that carries what a re-preview needs: why, and which document. Never carries a connection string. */
export class NativeSourceError extends ProtocolError {
  constructor(
    code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'NativeSourceError';
  }
}

export type ScannedNative = { address: NativeAddress; document: Document };
export type ScanCursor = { group: number; afterId?: unknown };
/** A typed value that names the subject or a record in the source, with its key. */
export type NativeBinding = { key: string; value: BsonScalar };
export type ClosureRecord = {
  address: NativeAddress;
  hop: number;
  /** `<referenceId>:<incoming|outgoing>` or `subject`. */
  via: string;
};
export type NativeEffect =
  | { kind: 'delete' }
  | { kind: 'restrict' }
  | { kind: 'redact' | 'tombstone'; writes: Array<{ fieldId: string; match: BsonScalar }> };
export type Assessment =
  | { ok: true; ruleId: string }
  | { ok: false; reason: 'effect_not_allowed' | 'rule_conditions_unmet'; detail: string };
export type NativeAppliedEffect = {
  address: NativeAddress;
  kind: EffectKind;
  ruleId: string;
  preHash: string;
  postHash: string | null;
  /** The owner's revision-field value before and after (as a typed key); null under `conditional_preimage`. */
  preRevision: string | null;
  postRevision: string | null;
  consistency: 'conditional_preimage' | 'native_revision';
  readback: 'verified';
  /** True when the write had already landed inside this call: the document equals the expected post-image. */
  replayed: boolean;
};
export type NativeAdapterOptions = {
  /** Isolated replay: the physical database and collection each namespace id resolves to. Defaults to the registration's. */
  physical?: ReadonlyMap<string, { database: string; collection: string }>;
};

const GROUP_ORDER: Array<{ types: NativeIdType[]; bson: string[] }> = [
  { types: ['int', 'long'], bson: ['int', 'long'] },
  { types: ['string'], bson: ['string'] },
  { types: ['uuid'], bson: ['binData'] },
  { types: ['objectId'], bson: ['objectId'] },
];
const OBJECT_ID_HEX = /^[a-f0-9]{24}$/;
const EFFECT_KINDS: EffectKind[] = ['delete', 'redact', 'restrict', 'tombstone'];
const exactlyScalar = (match: BsonScalar): Document => ({ $eq: match, $not: { $type: 'array' } });
const dotted = (path: readonly string[]): string => path.filter((s) => s !== FIELD_PATH_WILDCARD).join('.');

type Compiled = { filter: Document; set: Document; arrayFilters: Document[] };
/** One registered path and one exact value to a targeted `$set`; the wildcard never writes the bare array. */
function compileFieldWrite(
  path: readonly string[],
  match: BsonScalar,
  replacement: BsonScalar,
  identifier: string,
): Compiled {
  const wildcardIndex = path.indexOf(FIELD_PATH_WILDCARD);
  if (wildcardIndex === -1) {
    const key = path.join('.');
    return { filter: { [key]: exactlyScalar(match) }, set: { [key]: replacement }, arrayFilters: [] };
  }
  const arrayPath = path.slice(0, wildcardIndex).join('.');
  const tail = path.slice(wildcardIndex + 1).join('.');
  const element = `${arrayPath}.$[${identifier}]${tail ? `.${tail}` : ''}`;
  return {
    filter: { [dotted(path)]: match },
    set: { [element]: replacement },
    arrayFilters: [{ [tail ? `${identifier}.${tail}` : identifier]: exactlyScalar(match) }],
  };
}
function setAtPath(document: Document, segments: readonly string[], value: unknown): void {
  let cursor: Record<string, unknown> = document;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    if (next === undefined) cursor[segment] = {};
    else if (typeof next !== 'object' || next === null || Array.isArray(next) || '_bsontype' in next)
      fail('RestrictPathBlocked');
    cursor = cursor[segment] as Record<string, unknown>;
  });
}
function withoutPath(document: Document, path: readonly string[] | null): Document {
  const copy = cloneRaw(document);
  if (!path) return copy;
  let cursor: Record<string, unknown> | undefined = copy;
  for (const segment of path.slice(0, -1)) {
    const next: unknown = cursor?.[segment];
    cursor = next && typeof next === 'object' ? (next as Record<string, unknown>) : undefined;
  }
  if (cursor) delete cursor[path[path.length - 1]!];
  return copy;
}
const isObjectId = (v: unknown): v is ObjectId => v instanceof ObjectId;
function divergedKeys(expected: Document, actual: Document): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].filter((k) => bsonPreimageHash({ v: expected[k] }) !== bsonPreimageHash({ v: actual[k] }));
}
const revisionKey = (document: Document, path: readonly string[] | null): string | null => {
  if (!path) return null;
  const found = valuesAt(document, path);
  return found.length === 1 ? bindingKey(found[0]!.value) : null;
};

/**
 * Reads and conditional writes against the owner's own databases, driven by a compiled contract registration. It holds a
 * `Db` resolver for a role the owner provisioned (find on the registered namespaces; update/remove only where a rule allows).
 * It shares no transaction with the control plane, so every write is its own conditional operation followed by a read-back,
 * and a document that changed under the plan is a conflict, never an overwrite. Every query and write also carries the
 * namespace's tenant boundary, so another tenant's document in a shared collection is invisible.
 */
export class NativeSourceAdapter {
  constructor(
    readonly source: CompiledSource,
    readonly dbOf: (database: string) => Db,
    readonly options: NativeAdapterOptions = {},
  ) {}

  get registration() {
    return this.source.registration;
  }
  namespaceOf(namespaceId: string): CompiledNamespace {
    return this.source.namespaces.get(namespaceId) ?? fail('UnauthorizedCollection');
  }
  private field(fieldId: string): CompiledField {
    return this.source.fields.get(fieldId) ?? fail('UnknownFieldId');
  }
  private fieldsOf(namespaceId: string): CompiledField[] {
    return [...this.source.fields.values()].filter((f) => f.namespaceId === namespaceId);
  }
  /** The physical databases and collections in play, e.g. for a change stream. */
  physicalNamespaces(): Array<{
    database: string;
    collection: string;
    /** The namespace's tenant boundary as a dotted path and value, for filtering a change stream. */
    tenant: { path: string; value: BsonScalar };
  }> {
    return [...this.source.namespaces.values()].map((ns) => ({
      ...this.physical(ns),
      tenant: { path: ns.tenant.path.join('.'), value: ns.tenant.value },
    }));
  }
  private physical(ns: CompiledNamespace): { database: string; collection: string } {
    return this.options.physical?.get(ns.namespaceId) ?? { database: ns.database, collection: ns.collection };
  }
  private coll(ns: CompiledNamespace): Collection<Document> {
    const target = this.physical(ns);
    return this.dbOf(target.database).collection<Document>(target.collection, {
      readConcern: { level: 'majority' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
  }
  private tenant(ns: CompiledNamespace): Document {
    return { [ns.tenant.path.join('.')]: ns.tenant.value };
  }
  private scoped(ns: CompiledNamespace, filter: Document): Document {
    return { $and: [this.tenant(ns), filter] };
  }

  // ---- reads ----------------------------------------------------------------------------------------------

  /** Records whose registered field holds exactly `value` (in any array element). Bounded. */
  async findByField(fieldId: string, value: unknown, limit = 100): Promise<NativeAddress[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('InvalidScanLimit');
    const field = this.field(fieldId);
    const ns = this.namespaceOf(field.namespaceId);
    const rows = await this.coll(ns)
      .find(this.scoped(ns, { [dotted(field.path)]: nativeScalar(value) }), {
        projection: { _id: 1 },
        limit,
        sort: { _id: 1 },
        ...RAW_READ,
      })
      .toArray();
    return rows.map((row) => this.checkedAddress(ns, row._id));
  }

  /** One page in `_id` order, grouped by BSON type bracket so mixed `_id` types page correctly. */
  async scanPage(
    namespaceId: string,
    cursor: ScanCursor | null = null,
    limit = 100,
  ): Promise<{ records: ScannedNative[]; next: ScanCursor | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('InvalidScanLimit');
    const ns = this.namespaceOf(namespaceId);
    const groups = GROUP_ORDER.filter((g) => g.types.some((t) => ns.idTypes.includes(t)));
    let at = cursor?.group ?? 0;
    const after = cursor?.afterId;
    if (at >= groups.length) return { records: [], next: null };
    const idFilter: Document = { $type: groups[at]!.bson, ...(after === undefined ? {} : { $gt: after }) };
    const docs = await this.coll(ns)
      .find(this.scoped(ns, { _id: idFilter }), { sort: { _id: 1 }, limit, ...RAW_READ })
      .toArray();
    const records = docs.map((document) => ({ address: this.checkedAddress(ns, document._id), document }));
    if (docs.length === limit) return { records, next: { group: at, afterId: docs[docs.length - 1]!._id } };
    at += 1;
    return { records, next: at < groups.length ? { group: at } : null };
  }

  /** Every record of one namespace, bounded by `maxDocuments` (default the registration's `maxScanned`). */
  async scanAll(
    namespaceId: string,
    maxDocuments = this.registration.limits.maxScanned,
  ): Promise<ScannedNative[]> {
    const out: ScannedNative[] = [];
    let cursor: ScanCursor | null = null;
    do {
      const page: { records: ScannedNative[]; next: ScanCursor | null } = await this.scanPage(
        namespaceId,
        cursor,
        200,
      );
      out.push(...page.records);
      if (out.length > maxDocuments) fail('ScanBudgetExceeded');
      cursor = page.next;
    } while (cursor);
    return out;
  }

  /** Documents of the tenant whose `_id` type the registration did not declare. Non-zero means the registration is incomplete. */
  async undeclaredIdCount(namespaceId: string): Promise<number> {
    const ns = this.namespaceOf(namespaceId);
    const bson = GROUP_ORDER.filter((g) => g.types.some((t) => ns.idTypes.includes(t))).flatMap(
      (g) => g.bson,
    );
    return this.coll(ns).countDocuments(this.scoped(ns, { _id: { $not: { $type: bson } } }));
  }

  async read(address: NativeAddress): Promise<Document | null> {
    const ns = this.namespaceOf(address.collectionId);
    this.assertDeclaredIdType(ns, address);
    return this.coll(ns).findOne(this.scoped(ns, { _id: nativeId(address) }), RAW_READ);
  }

  /** The record as it is now and the hash a later write is conditional on. */
  async preimage(address: NativeAddress): Promise<{ document: Document; hash: string } | null> {
    const document = await this.read(address);
    return document ? { document, hash: bsonPreimageHash(document) } : null;
  }

  /**
   * The subject, by one exact identity value of a registered subject identity field. Zero or several matches is a refusal.
   * Bindings are the record's key and every identity value it holds.
   */
  async resolveSubject(
    fieldId: string,
    value: unknown,
  ): Promise<{ address: NativeAddress; hash: string; bindings: NativeBinding[] }> {
    const field = this.field(fieldId);
    if (!this.registration.subjectIdentityFieldIds.includes(field.fieldId)) fail('NotAnIdentityField');
    const matches = await this.findByField(fieldId, value, 2);
    if (matches.length === 0) return fail('SubjectNotFound');
    if (matches.length > 1) return fail('SubjectAmbiguous');
    const address = matches[0]!;
    const pre = await this.preimage(address);
    if (!pre) return fail('SubjectNotFound');
    const bindings = new Map<string, NativeBinding>();
    const add = (v: unknown) => {
      const key = bindingKey(v);
      if (key !== null && !bindings.has(key)) bindings.set(key, { key, value: nativeScalar(v) });
    };
    add(pre.document._id);
    for (const f of this.fieldsOf(field.namespaceId))
      if (f.identity && !f.isKey) for (const found of valuesAt(pre.document, f.path)) add(found.value);
    return { address, hash: pre.hash, bindings: [...bindings.values()] };
  }

  /**
   * The records the subject owns, following declared ownership only and never turning back up an edge: `owner: 'to'` walks
   * from the referenced record to the records that point at it, `owner: 'from'` from the referencing record to the one it
   * points at, `owner: 'none'` (a shared parent or lookup) is never walked. Every hop is an indexed lookup on the source.
   */
  async ownedClosure(
    root: NativeAddress,
    options: { maxDepth?: number; maxRecords?: number } = {},
  ): Promise<{ records: ClosureRecord[]; truncated: boolean }> {
    const limits = this.registration.limits;
    const maxDepth = Math.min(options.maxDepth ?? limits.maxHops, limits.maxHops);
    if (!Number.isInteger(maxDepth) || maxDepth < 0) fail('TraversalBounds');
    const maxRecords = Math.min(options.maxRecords ?? limits.maxScanned, limits.maxScanned);
    const records: ClosureRecord[] = [{ address: root, hop: 0, via: 'subject' }];
    const seen = new Set([nativeNodeKey(root)]);
    let frontier = [root];
    let truncated = false;
    for (let hop = 1; hop <= maxDepth && frontier.length > 0 && !truncated; hop++) {
      const next: NativeAddress[] = [];
      for (const current of frontier) {
        const document = await this.read(current);
        if (!document) continue;
        for (const reference of this.registration.references) {
          if (reference.owner === 'none') continue;
          for (const found of await this.neighbours(
            reference,
            current,
            document,
            maxRecords - records.length + 1,
          )) {
            const key = nativeNodeKey(found.address);
            if (seen.has(key)) continue;
            if (records.length >= maxRecords) {
              truncated = true;
              break;
            }
            seen.add(key);
            records.push({ address: found.address, hop, via: `${reference.referenceId}:${found.direction}` });
            next.push(found.address);
          }
        }
      }
      frontier = next;
    }
    // A frontier left over at the depth limit may own more: say so rather than claim a complete closure.
    if (frontier.length > 0) truncated = true;
    return { records, truncated };
  }

  private async neighbours(
    reference: CompiledSource['registration']['references'][number],
    current: NativeAddress,
    document: Document,
    limit: number,
  ): Promise<Array<{ address: NativeAddress; direction: 'incoming' | 'outgoing' }>> {
    const from = this.field(reference.fromFieldId);
    const to = this.field(reference.toFieldId);
    // `owner: to`: the TO record owns the FROM records, so from a TO record we go incoming.
    // `owner: from`: the FROM record owns the TO record, so from a FROM record we go outgoing.
    const incoming = reference.owner === 'to' && to.namespaceId === current.collectionId;
    const outgoing = reference.owner === 'from' && from.namespaceId === current.collectionId;
    if (!incoming && !outgoing) return [];
    const here = incoming ? to : from;
    const there = incoming ? from : to;
    const values: unknown[] = [];
    for (const found of valuesAt(document, here.path)) {
      const converted = this.convert(found.value, reference.identityRule, incoming ? 'to-from' : 'from-to');
      if (converted !== undefined) values.push(converted);
    }
    if (values.length === 0) return [];
    const target = this.namespaceOf(there.namespaceId);
    const rows = await this.coll(target)
      .find(this.scoped(target, { [dotted(there.path)]: { $in: values } }), {
        projection: { _id: 1 },
        limit,
        sort: { _id: 1 },
        ...RAW_READ,
      })
      .toArray();
    return rows.map((row) => ({
      address: this.checkedAddress(target, row._id),
      direction: incoming ? ('incoming' as const) : ('outgoing' as const),
    }));
  }

  /** The value to look for on the other side of a reference, per the declared identity rule. */
  private convert(
    value: unknown,
    rule: 'same_bson_type' | 'string_to_objectId' | 'objectId_to_string',
    way: 'to-from' | 'from-to',
  ): unknown {
    if (value === null || value === undefined) return undefined;
    if (rule === 'same_bson_type') {
      try {
        return nativeScalar(value);
      } catch {
        return undefined;
      }
    }
    const fromIsString = rule === 'string_to_objectId';
    const hex = (v: unknown) =>
      typeof v === 'string' && OBJECT_ID_HEX.test(v) ? new ObjectId(v) : undefined;
    if (way === 'to-from')
      return fromIsString ? (isObjectId(value) ? value.toHexString() : undefined) : hex(value);
    return fromIsString ? hex(value) : isObjectId(value) ? value.toHexString() : undefined;
  }

  // ---- policy rules and planning --------------------------------------------------------------------------

  private conditionHolds(
    document: Document,
    fieldId: string,
    equals: Parameters<typeof decodeScalar>[0],
  ): boolean {
    const field = this.field(fieldId);
    const want = decodeScalar(equals);
    return valuesAt(document, field.path).some((found) => sameNativeValue(found.value, want));
  }
  private select(namespaceId: string, document: Document, kind: EffectKind) {
    const rules = this.registration.rules.filter((r) => r.namespaceId === namespaceId && r.effect === kind);
    const rule = rules.find((r) => r.all.every((c) => this.conditionHolds(document, c.fieldId, c.equals)));
    return { rule, declared: rules.length > 0 };
  }

  /**
   * Whether the owner's rules let `kind` touch this document: a rule of that effect for the namespace whose conditions all
   * hold. A document no rule selects (a legal hold expressed as a condition, a status the owner keeps) is retained.
   */
  assess(namespaceId: string, document: Document, kind: EffectKind): Assessment {
    this.namespaceOf(namespaceId);
    const { rule, declared } = this.select(namespaceId, document, kind);
    if (rule) return { ok: true, ruleId: rule.ruleId };
    return declared
      ? {
          ok: false,
          reason: 'rule_conditions_unmet',
          detail: `${kind} rule conditions not met on ${namespaceId}`,
        }
      : { ok: false, reason: 'effect_not_allowed', detail: `${kind} has no rule on ${namespaceId}` };
  }

  /**
   * What redact or tombstone must write on this document, from the selected rule's exact fields: in an identity or
   * referencing field every value that is one of the subject's bindings; in any other rule field every scalar it holds.
   * Protected and retained fields cannot appear in a rule (the contract refuses it), so none is ever written.
   */
  planEffect(
    namespaceId: string,
    document: Document,
    kind: EffectKind,
    bindings: ReadonlyMap<string, NativeBinding>,
  ): NativeEffect {
    if (kind === 'delete' || kind === 'restrict') return { kind };
    const { rule } = this.select(namespaceId, document, kind);
    if (!rule) return fail('EffectNotAllowed');
    const writes: Array<{ fieldId: string; match: BsonScalar }> = [];
    for (const fieldId of rule.fieldIds) {
      const field = this.field(fieldId);
      const seen = new Set<string>();
      for (const found of valuesAt(document, field.path)) {
        const key = bindingKey(found.value);
        if (key === null || seen.has(key)) continue;
        if ((field.identity || field.referencing) && !bindings.has(key)) continue;
        seen.add(key);
        writes.push({ fieldId, match: nativeScalar(found.value) });
      }
    }
    return { kind, writes };
  }

  /** Records that still hold one of the bindings in an identity or referencing field, and whether the owner retains them. */
  async residuals(
    bindings: ReadonlyMap<string, NativeBinding>,
    limit = 200,
  ): Promise<{
    residuals: Array<{ address: NativeAddress; fieldId: string; retained: boolean }>;
    truncated: boolean;
  }> {
    const values = [...bindings.values()].map((b) => b.value);
    const out: Array<{ address: NativeAddress; fieldId: string; retained: boolean }> = [];
    if (values.length === 0) return { residuals: out, truncated: false };
    for (const field of this.source.fields.values()) {
      if (field.isKey || (!field.identity && !field.referencing)) continue;
      const ns = this.namespaceOf(field.namespaceId);
      const docs = await this.coll(ns)
        .find(this.scoped(ns, { [dotted(field.path)]: { $in: values } }), {
          limit: limit + 1,
          sort: { _id: 1 },
          ...RAW_READ,
        })
        .toArray();
      for (const document of docs) {
        if (out.length >= limit) return { residuals: out, truncated: true };
        // Retained when the owner keeps the field, or when no rule would let any effect touch this document.
        const untouchable = EFFECT_KINDS.every((kind) => !this.assess(ns.namespaceId, document, kind).ok);
        out.push({
          address: this.checkedAddress(ns, document._id),
          fieldId: field.fieldId,
          retained: field.retained || untouchable,
        });
      }
    }
    return { residuals: out, truncated: false };
  }

  // ---- conditional effect with read-back ------------------------------------------------------------------

  /**
   * One owner-rule effect on one native document.
   *
   * The write is conditional on the document still being what the plan read: under `conditional_preimage` the filter carries
   * the whole preimage (`$expr` equality against `$$ROOT`); under `native_revision` the owner's revision field plus the exact
   * values being replaced (delete and restrict have no per-value guard there). A document an external writer changed since
   * the plan is `SourceConflict`: nothing is written and the caller re-previews. A precondition miss re-reads; a document
   * already equal to the expected post-image (a write that landed inside this call) is `replayed`. After the write the document
   * is read again and must equal the expected post-image, or `ReadbackMismatch`. Under `native_revision` the revision field is
   * excluded from that comparison: the owner's own writers may bump it.
   */
  async applyEffect(
    address: NativeAddress,
    effect: NativeEffect,
    expectedPreimageHash: string,
  ): Promise<NativeAppliedEffect> {
    const ns = this.namespaceOf(address.collectionId);
    this.assertDeclaredIdType(ns, address);
    if (!/^[a-f0-9]{64}$/.test(expectedPreimageHash)) fail('InvalidPreimageHash');
    const handle = this.coll(ns);
    const id = nativeId(address);
    const byId = this.scoped(ns, { _id: id });
    const pre = await handle.findOne(byId, RAW_READ);
    if (!pre) throw new NativeSourceError('SourceConflict', { reason: 'absent' });
    const preHash = bsonPreimageHash(pre);
    if (preHash !== expectedPreimageHash)
      throw new NativeSourceError('SourceConflict', { reason: 'preimage_changed' });
    const assessment = this.assess(address.collectionId, pre, effect.kind);
    if (!assessment.ok)
      throw new NativeSourceError(
        assessment.reason === 'rule_conditions_unmet' ? 'RetentionHold' : 'EffectNotAllowed',
        { detail: assessment.detail },
      );
    const rule = this.registration.rules.find((r) => r.ruleId === assessment.ruleId)!;
    const replacement = rule.replacement === undefined ? null : decodeScalar(rule.replacement);
    const revisionPath = ns.revisionPath;
    const preRevision = revisionKey(pre, revisionPath);
    if (revisionPath && preRevision === null) fail('RevisionMissing');

    // Build the update and its expected post-image.
    let expected: Document | null;
    let update: Document | null = null;
    const arrayFilters: Document[] = [];
    const guards: Document[] = [];
    if (effect.kind === 'delete') {
      expected = null;
    } else {
      const set: Document = {};
      let model: Document;
      if (effect.kind === 'restrict') {
        model = cloneRaw(pre);
        for (const fieldId of rule.fieldIds) {
          const field = this.field(fieldId);
          if (field.isArray) fail('RestrictWildcard');
          set[field.path.join('.')] = replacement;
          setAtPath(model, field.path, replacement);
        }
      } else {
        if (effect.writes.length === 0) fail('NothingToWrite');
        const modelWrites: ModelWrite[] = [];
        effect.writes.forEach((write, index) => {
          // A hand-assembled write can only name a field of the selected rule; protected and retained fields are not in one.
          if (!rule.fieldIds.includes(write.fieldId))
            throw new NativeSourceError('FieldNotInRule', { fieldId: write.fieldId });
          const field = this.field(write.fieldId);
          assertStoredShape(pre, { path: field.path });
          const match = nativeScalar(write.match);
          const compiled = compileFieldWrite(field.path, match, replacement, `t${index}`);
          for (const [path, value] of Object.entries(compiled.set)) {
            if (path in set) fail('ConflictingWrites');
            set[path] = value;
          }
          arrayFilters.push(...compiled.arrayFilters);
          guards.push(compiled.filter);
          modelWrites.push({ segments: field.path, match, replacement });
        });
        model = applyModelWrites(pre, modelWrites);
      }
      update = { $set: set };
      expected = model;
    }
    const compare = (doc: Document) => bsonPreimageHash(withoutPath(doc, revisionPath));
    const expectedHash = expected ? compare(expected) : null;

    const guard: Document = revisionPath
      ? {
          $and: [{ [revisionPath.join('.')]: valuesAt(pre, revisionPath)[0]!.value }, ...guards],
        }
      : { $expr: { $eq: ['$$ROOT', { $literal: pre }] } };
    const filter: Document = { $and: [byId, guard] };

    const matched =
      effect.kind === 'delete'
        ? (await handle.deleteOne(filter)).deletedCount
        : (await handle.updateOne(filter, update!, arrayFilters.length ? { arrayFilters } : {})).matchedCount;
    let replayed = false;
    if (matched !== 1) {
      // The precondition did not hold. Either an external writer got there first, or this effect already landed.
      const now = await handle.findOne(byId, RAW_READ);
      if (expectedHash !== null && now && compare(now) === expectedHash) replayed = true;
      else
        throw new NativeSourceError('SourceConflict', {
          reason: now ? 'changed_since_preview' : 'absent_at_write',
        });
    }
    // Read-back: the source, not the write result, is the evidence.
    const after = await handle.findOne(byId, RAW_READ);
    if (expected === null) {
      if (after) throw new NativeSourceError('ReadbackMismatch', { reason: 'still_present' });
    } else if (!after || compare(after) !== expectedHash) {
      throw new NativeSourceError('ReadbackMismatch', {
        reason: after ? 'differs' : 'absent',
        divergedKeys: after
          ? divergedKeys(withoutPath(expected, revisionPath), withoutPath(after, revisionPath))
          : [],
      });
    }
    return {
      address,
      kind: effect.kind,
      ruleId: rule.ruleId,
      preHash,
      postHash: expectedHash,
      preRevision,
      postRevision: after ? revisionKey(after, revisionPath) : null,
      consistency: this.registration.consistency.kind,
      readback: 'verified',
      replayed,
    };
  }

  private checkedAddress(ns: CompiledNamespace, id: unknown): NativeAddress {
    const address = nativeAddress(ns.namespaceId, id);
    this.assertDeclaredIdType(ns, address);
    return address;
  }
  private assertDeclaredIdType(ns: CompiledNamespace, address: NativeAddress): void {
    if (!ns.idTypes.includes(address.recordIdBsonType)) fail('UndeclaredIdType');
  }
}

/** Opens the owner's databases with the connection string named for the deployment. The string is never logged. */
export function connectOwnerSource(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: NativeAdapterOptions = {},
): { adapter: NativeSourceAdapter; client: MongoClient; close(): Promise<void> } {
  // Re-checked at connect time: the environment may name databases the registration was validated without.
  const source = compileOwnerSource(input, env);
  const variable = sourceConnectionVariable(source.registration.deploymentId);
  const uri = env[variable];
  if (!uri) throw new Error(`MissingConfiguration:${variable}`);
  const client = new MongoClient(uri, {
    appName: `expunge:source:${source.registration.sourceId}`,
    maxPoolSize: 4,
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
  });
  return {
    adapter: new NativeSourceAdapter(source, (database) => client.db(database), options),
    client,
    close: () => client.close(),
  };
}
