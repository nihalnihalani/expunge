import { randomUUID } from 'node:crypto';
import {
  BSON,
  Long,
  Int32,
  type ClientSession,
  type ChangeStream,
  type ChangeStreamDocument,
  type Collection,
  type Document,
  type MongoClient,
} from 'mongodb';
import {
  contentHash,
  nativeRegistrationHash,
  type ActorContext,
  type NativeScalar,
  type NativeSourceRegistration,
  type ScopeKey,
} from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import type { LeaseBinding } from './jobs.js';
import {
  NativeSourceRepository,
  nativeSourceHeadId,
  type NativeSourceHead,
  type NativePreviewApproval,
} from './native-source-registry.js';
import { NativeSourceBudgetRepository } from './native-source-budgets.js';
import {
  NATIVE_BSON_OPTIONS,
  assertNativeRegisteredShape,
  cloneNativeDocument,
  decodeNativeScalar,
  encodeNativeScalar,
  fieldValues,
  nativeBsonDigest,
  nativePreimagePredicate,
  nativeScalarKey,
  nativeTenantPredicate,
  replaceNativePath,
} from './native-source-bson.js';

export type NativeTarget = {
  namespaceId: string;
  identity: NativeScalar;
  ruleId: string;
  preimageDigest: string;
  postimageDigest: string | null;
  concretePaths: string[][];
};
export type NativePreview = ScopeKey & {
  _id: string;
  jobId: string;
  sourceId: string;
  registrationHash: string;
  subjectKey: string;
  previewHash: string;
  targets: NativeTarget[];
  snapshotDigest: string;
  scanned: number;
  sourceKind: NativeSourceRegistration['sourceKind'];
  snapshotRows: Array<{ namespaceId: string; identity: NativeScalar; digest: string }>;
  observedAt: Date;
  limitations: string[];
};
type PreviewRecord = {
  _id: string;
  previewId: string;
  ordinal: number;
  target: NativeTarget;
  preimage: Document;
  postimage: Document | null;
};
export type NativeEffectReceipt = ScopeKey & {
  _id: string;
  effectKey: string;
  jobId: string;
  sourceId: string;
  registrationHash: string;
  previewHash: string;
  argsDigest: string;
  sourceKind: NativeSourceRegistration['sourceKind'];
  leaseFence: number;
  targetCount: number;
  status: 'source_effect_committed' | 'held_cross_deployment';
  atomicity: 'same_deployment_transaction' | 'control_intent_only';
  limitations: string[];
  createdAt: Date;
};
export type NativeReadback = ScopeKey & {
  _id: string;
  receiptId: string;
  effectKey: string;
  status: 'verified' | 'diverged';
  inspected: number;
  observedAt: Date;
};
type SnapshotRow = { namespaceId: string; document: Document; key: string };
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_TARGETS = 1000;
const MAX_QUERY_MS = 5000;
const idOf = (namespaceId: string, value: unknown) =>
  `${namespaceId}:${nativeScalarKey(encodeNativeScalar(value))}`;

/** The ordinary-read approved target is authoritative; BSON-wrapped portable metadata in a row is not. */
export function assertNativePreimageRowBinding(
  approved: NativeTarget,
  expectedOrdinal: number,
  storedOrdinal: unknown,
  preimage: Document,
  postimage: Document | null,
): void {
  const ordinal =
    storedOrdinal instanceof Int32 || storedOrdinal instanceof Long || typeof storedOrdinal === 'number'
      ? Number(storedOrdinal.valueOf())
      : NaN;
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal !== expectedOrdinal ||
    nativeScalarKey(encodeNativeScalar(preimage._id)) !== nativeScalarKey(approved.identity) ||
    nativeBsonDigest(preimage) !== approved.preimageDigest ||
    (postimage ? nativeBsonDigest(postimage) : null) !== approved.postimageDigest
  )
    fail('NativePreviewCorrupt');
}

function identityConvert(
  value: NativeScalar,
  rule: NativeSourceRegistration['references'][number]['identityRule'],
): NativeScalar | null {
  if (rule === 'same_bson_type') return value;
  if (rule === 'string_to_objectId' && value.bsonType === 'string' && /^[a-fA-F0-9]{24}$/.test(value.value))
    return { bsonType: 'objectId', value: value.value.toLowerCase() };
  if (rule === 'objectId_to_string' && value.bsonType === 'objectId')
    return { bsonType: 'string', value: value.value.toLowerCase() };
  return null;
}

/** Every edge is owner-declared. Matching aliases never turns an unowned shared parent into a cleanup target. */
export function discoverNativeOwnedNodes(
  source: NativeSourceRegistration,
  rows: readonly SnapshotRow[],
  subjectFieldId: string,
  subject: NativeScalar,
  graphEdgeLimit: number,
): Set<string> {
  const rootField = source.fields.find((field) => field.fieldId === subjectFieldId);
  if (!rootField?.identity || !source.subjectIdentityFieldIds.includes(subjectFieldId))
    fail('NativeSubjectFieldInvalid');
  const selected = new Set(
    rows
      .filter(
        (row) =>
          row.namespaceId === rootField.namespaceId &&
          fieldValues(row.document, rootField).some(
            ({ value }) => nativeScalarKey(encodeNativeScalar(value)) === nativeScalarKey(subject),
          ),
      )
      .map((row) => row.key),
  );
  if (!selected.size) fail('NativeSubjectNotFound');
  const sharedRoots = new Set(
    rows
      .filter(
        (row) =>
          selected.has(row.key) &&
          rootField.path.includes('*') &&
          fieldValues(row.document, rootField).some(
            ({ value }) => nativeScalarKey(encodeNativeScalar(value)) !== nativeScalarKey(subject),
          ),
      )
      .map((row) => row.key),
  );
  const adjacency = new Map<string, Set<string>>();
  let edgeCount = 0;
  for (const reference of source.references) {
    if (reference.owner === 'none') continue;
    const fromField = source.fields.find((field) => field.fieldId === reference.fromFieldId)!;
    const toField = source.fields.find((field) => field.fieldId === reference.toFieldId)!;
    const destinations = new Map<string, string[]>();
    for (const row of rows.filter((value) => value.namespaceId === toField.namespaceId)) {
      for (const { value } of fieldValues(row.document, toField)) {
        const scalar = encodeNativeScalar(value);
        if (scalar.bsonType === 'null') continue;
        const key = nativeScalarKey(scalar);
        destinations.set(key, [...(destinations.get(key) ?? []), row.key]);
      }
    }
    for (const row of rows.filter((value) => value.namespaceId === fromField.namespaceId)) {
      for (const { value } of fieldValues(row.document, fromField)) {
        const scalar = identityConvert(encodeNativeScalar(value), reference.identityRule);
        if (!scalar || scalar.bsonType === 'null') continue;
        const matches = destinations.get(nativeScalarKey(scalar)) ?? [];
        if (matches.length > 1) fail('NativeReferenceIdentityAmbiguous');
        for (const destination of matches) {
          const owner = reference.owner === 'from' ? destination : row.key;
          const owned = reference.owner === 'from' ? row.key : destination;
          if (!adjacency.has(owner)) adjacency.set(owner, new Set());
          if (!adjacency.get(owner)!.has(owned) && ++edgeCount > graphEdgeLimit)
            fail('NativeDiscoveryEdgeBound');
          adjacency.get(owner)!.add(owned);
        }
      }
    }
  }
  let frontier = [...selected];
  for (let hop = 0; frontier.length && hop < source.limits.maxHops; hop++) {
    const next: string[] = [];
    for (const owner of frontier.filter((owner) => !sharedRoots.has(owner)))
      for (const child of adjacency.get(owner) ?? [])
        if (!selected.has(child)) {
          selected.add(child);
          next.push(child);
        }
    frontier = next;
  }
  if (
    frontier.some(
      (owner) =>
        !sharedRoots.has(owner) && [...(adjacency.get(owner) ?? [])].some((child) => !selected.has(child)),
    )
  )
    fail('NativeDiscoveryHopBound');
  assertNativeExclusiveOwnership(selected, sharedRoots, adjacency);
  return selected;
}

/** A shared selected root grants element authority only; it never becomes a full owner along another graph path. */
export function assertNativeExclusiveOwnership(
  selected: ReadonlySet<string>,
  sharedOwners: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const [owner, children] of adjacency)
    if (
      (!selected.has(owner) || sharedOwners.has(owner)) &&
      [...children].some((child) => selected.has(child))
    )
      fail('NativeSharedOwnershipAmbiguous');
}

function matchesRule(
  source: NativeSourceRegistration,
  document: Document,
  rule: NativeSourceRegistration['rules'][number],
): boolean {
  return rule.all.every((predicate) => {
    const field = source.fields.find((value) => value.fieldId === predicate.fieldId)!;
    const values = fieldValues(document, field);
    return (
      values.length === 1 &&
      nativeScalarKey(encodeNativeScalar(values[0].value)) === nativeScalarKey(predicate.equals)
    );
  });
}

function effectPaths(
  source: NativeSourceRegistration,
  document: Document,
  rule: NativeSourceRegistration['rules'][number],
  subject: NativeScalar,
  subjectFieldId: string,
): string[][] {
  const root = source.fields.find((field) => field.fieldId === subjectFieldId);
  if (root?.namespaceId === rule.namespaceId && root.path.includes('*')) {
    const shared = fieldValues(document, root).some(
      ({ value }) => nativeScalarKey(encodeNativeScalar(value)) !== nativeScalarKey(subject),
    );
    assertNativeSharedRootEffect(
      shared,
      root.path,
      rule.effect,
      rule.fieldIds.map((id) => source.fields.find((field) => field.fieldId === id)!.path),
    );
  }
  const result: string[][] = [];
  for (const fieldId of rule.fieldIds) {
    const field = source.fields.find((value) => value.fieldId === fieldId)!;
    if (!field.path.includes('*')) {
      if (fieldValues(document, field).length !== 1) fail('NativeEffectFieldMissing');
      result.push(field.path);
      continue;
    }
    // Until a reviewed element-level ownership relation exists, only the identity scalar itself can be replaced.
    if (!field.identity) fail('NativeArrayElementOwnershipUnsupported');
    const paths = fieldValues(document, field).filter(
      ({ value }) => nativeScalarKey(encodeNativeScalar(value)) === nativeScalarKey(subject),
    );
    if (!paths.length) fail('NativeArrayElementOwnershipUnsupported');
    result.push(...paths.map((value) => value.concretePath));
  }
  return result;
}

export function assertNativeSharedRootEffect(
  shared: boolean,
  rootPath: readonly string[],
  effect: NativeSourceRegistration['rules'][number]['effect'],
  effectPaths: readonly (readonly string[])[],
): void {
  if (
    shared &&
    (effect === 'delete' ||
      effectPaths.length === 0 ||
      effectPaths.some((path) => path.join('\0') !== rootPath.join('\0')))
  )
    fail('NativeSharedSubjectRoot');
}

function postimageOf(
  source: NativeSourceRegistration,
  row: SnapshotRow,
  rule: NativeSourceRegistration['rules'][number],
  paths: string[][],
): Document | null {
  if (rule.effect === 'delete') return null;
  if (rule.replacement === undefined) fail('NativeEffectReplacementMissing');
  const postimage = cloneNativeDocument(row.document);
  for (const path of paths) replaceNativePath(postimage, path, decodeNativeScalar(rule.replacement));
  if (source.consistency.kind === 'native_revision') {
    const binding = source.consistency.bindings.find((value) => value.namespaceId === row.namespaceId);
    const field = source.fields.find((value) => value.fieldId === binding?.revisionFieldId);
    if (!field) fail('NativeRevisionBindingMissing');
    const revision = fieldValues(postimage, field)[0]?.value;
    let next: unknown;
    if (revision instanceof Int32 && revision.valueOf() < 2147483647)
      next = new Int32(revision.valueOf() + 1);
    else if (revision instanceof Long && revision.lessThan(Long.MAX_VALUE)) next = revision.add(Long.ONE);
    else fail('UnsupportedNativeRevision');
    replaceNativePath(postimage, field.path, next);
  }
  if (nativeBsonDigest(postimage) === nativeBsonDigest(row.document)) fail('NativePolicyNoOp');
  return postimage;
}

/** Source-native reads/effects. No model-supplied query, mutation, authorizer or callback enters this adapter. */
export class NativeSourceAdapter {
  readonly registry: NativeSourceRepository;
  readonly budgets: NativeSourceBudgetRepository;
  constructor(
    readonly service: MongoService,
    readonly sourceClient: MongoClient,
    readonly sourceDeploymentId: string,
  ) {
    this.registry = new NativeSourceRepository(service);
    this.budgets = new NativeSourceBudgetRepository(service);
  }
  private collection(source: NativeSourceRegistration, namespaceId: string): Collection<Document> {
    if (source.deploymentId !== this.sourceDeploymentId) fail('NativeDeploymentBindingMismatch');
    const namespace = source.namespaces.find((value) => value.namespaceId === namespaceId);
    if (!namespace) fail('NativeNamespaceNotRegistered');
    return this.sourceClient.db(namespace.database).collection(namespace.collection, NATIVE_BSON_OPTIONS);
  }
  private async snapshot(
    source: NativeSourceRegistration,
    session: ClientSession,
    scanLimit: number,
  ): Promise<SnapshotRow[]> {
    const rows: SnapshotRow[] = [];
    let bytes = 0;
    for (const namespace of source.namespaces) {
      const documents = await this.collection(source, namespace.namespaceId)
        .find(nativeTenantPredicate(source, namespace.namespaceId), {
          session,
          limit: scanLimit - rows.length + 1,
          maxTimeMS: MAX_QUERY_MS,
        })
        .toArray();
      if (documents.length + rows.length > scanLimit) fail('NativeDiscoveryScanBound');
      for (const document of documents) {
        assertNativeRegisteredShape(source, namespace.namespaceId, document);
        bytes += BSON.serialize(document).byteLength;
        if (bytes > MAX_SNAPSHOT_BYTES) fail('NativeSnapshotByteBound');
        rows.push({
          namespaceId: namespace.namespaceId,
          document,
          key: idOf(namespace.namespaceId, document._id),
        });
      }
    }
    return rows;
  }
  private async sourceTransaction<T>(
    actor: ActorContext,
    lease: LeaseBinding,
    source: NativeSourceRegistration,
    snapshotLimit: number,
    work: (session: ClientSession, scanLimit: number) => Promise<T>,
  ): Promise<T> {
    return this.sourceClient.withSession((session) =>
      session.withTransaction(
        async () => {
          const allowance = await this.budgets.reserveScan(actor, lease, source, snapshotLimit + 1);
          // One slot covers the over-bound probe. Unknown/retried reads conservatively keep the full reservation.
          if (allowance < 2) fail('NativeJobBudgetExceeded');
          return work(session, Math.min(snapshotLimit, allowance - 1));
        },
        {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10000,
        },
      ),
    );
  }

  async preview(actor: ActorContext, lease: LeaseBinding): Promise<NativePreview> {
    requirePrincipal(this.service, ['domain_executor']);
    const source = await this.registry.forJob(actor, lease.jobId);
    const state = await this.budgets.beginOperation(actor, lease, source);
    const binding = await this.registry.jobBinding(actor, lease.jobId);
    const tracker = await NativeSourceChangeTracker.open(
      this.service,
      this.sourceClient,
      source,
      lease.jobId,
    );
    try {
      const rows = await this.sourceTransaction(
        actor,
        lease,
        source,
        Math.min(source.limits.maxScanned, state.caps.nodes),
        (session, limit) => this.snapshot(source, session, limit),
      );
      await tracker.poll();
      const selected = discoverNativeOwnedNodes(
        { ...source, limits: { ...source.limits, maxHops: state.caps.hops } },
        rows,
        binding.subjectFieldId,
        binding.subject,
        state.caps.edges,
      );
      const records: PreviewRecord[] = [];
      const previewId = randomUUID();
      for (const row of rows.filter((value) => selected.has(value.key))) {
        const rules = source.rules.filter(
          (rule) => rule.namespaceId === row.namespaceId && matchesRule(source, row.document, rule),
        );
        if (rules.length !== 1) fail(rules.length ? 'NativePolicyAmbiguous' : 'NativePolicyNoMatchingRule');
        const rule = rules[0];
        const paths = effectPaths(source, row.document, rule, binding.subject, binding.subjectFieldId);
        const postimage = postimageOf(source, row, rule, paths);
        const target: NativeTarget = {
          namespaceId: row.namespaceId,
          identity: encodeNativeScalar(row.document._id),
          ruleId: rule.ruleId,
          preimageDigest: nativeBsonDigest(row.document),
          postimageDigest: postimage ? nativeBsonDigest(postimage) : null,
          concretePaths: paths,
        };
        records.push({
          _id: `${previewId}:${records.length}`,
          previewId,
          ordinal: records.length,
          target,
          preimage: row.document,
          postimage,
        });
        if (BSON.serialize(records.at(-1)!).byteLength > 12 * 1024 * 1024)
          fail('NativePreviewPreimageStorageBound');
      }
      if (records.length > source.limits.maxChanged || records.length > MAX_PREVIEW_TARGETS)
        fail('NativePreviewChangeBound');
      const targets = records.map((record) => record.target);
      const snapshotDigest = contentHash(
        rows
          .map((row) => ({ key: row.key, digest: nativeBsonDigest(row.document) }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        'native-snapshot-v2',
      );
      const previewHash = contentHash(
        {
          registrationHash: nativeRegistrationHash(source),
          cleanupRequestId: binding.cleanupRequestId,
          subjectKey: nativeScalarKey(binding.subject),
          snapshotDigest,
          targets,
        },
        'native-preview-v2',
      );
      const preview: NativePreview = {
        _id: previewId,
        ...scopeFilter(actor),
        jobId: lease.jobId,
        sourceId: source.sourceId,
        registrationHash: nativeRegistrationHash(source),
        subjectKey: nativeScalarKey(binding.subject),
        previewHash,
        targets,
        snapshotDigest,
        scanned: rows.length,
        sourceKind: source.sourceKind,
        snapshotRows: rows.map((row) => ({
          namespaceId: row.namespaceId,
          identity: encodeNativeScalar(row.document._id),
          digest: nativeBsonDigest(row.document),
        })),
        observedAt: new Date(),
        limitations: [
          'snapshot_only_external_writes_after_snapshot_possible',
          'wildcard_effects_require_exact_identity_element',
          'unregistered_namespaces_not_inspected',
          'unregistered_fields_not_classified',
        ],
      };
      if (BSON.serialize(preview).byteLength > 12 * 1024 * 1024) fail('NativePreviewMetadataStorageBound');
      await this.service.transaction(async (session) => {
        await this.registry.fence(actor, lease, preview.registrationHash, session);
        await this.service.control
          .collection<NativePreview>('native_source_previews')
          .insertOne(preview, { session });
        for (const record of records)
          await this.service.control
            .collection<PreviewRecord>('native_source_preimage_rows')
            .insertOne(record, { session });
      });
      return preview;
    } finally {
      await tracker.close();
    }
  }

  /** Effect identity is independent of lease fences and model tool-call IDs. */
  async applyBatch(
    actor: ActorContext,
    lease: LeaseBinding,
    previewId: string,
    batchOrdinal: number,
  ): Promise<{ receipt: NativeEffectReceipt; readback: NativeReadback | null }> {
    requirePrincipal(this.service, ['domain_executor']);
    if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 0) fail('NativeBatchOrdinalInvalid');
    const source = await this.registry.forJob(actor, lease.jobId);
    const state = await this.budgets.beginOperation(actor, lease, source);
    const preview = await this.service.control.collection<NativePreview>('native_source_previews').findOne({
      _id: previewId,
      ...scopeFilter(actor),
      jobId: lease.jobId,
      registrationHash: nativeRegistrationHash(source),
    });
    if (!preview) fail('NativePreviewMissingOrStale');
    const effectKey = contentHash(
      { jobId: lease.jobId, previewHash: preview.previewHash, batchOrdinal },
      'native-effect-v2',
    );
    const start = batchOrdinal * source.limits.maxBatch;
    const targets = preview.targets.slice(start, start + source.limits.maxBatch);
    if (!targets.length) fail('NativeBatchOutsidePreview');
    const argsDigest = contentHash(
      { registrationHash: preview.registrationHash, previewHash: preview.previewHash, targets },
      'native-effect-args-v2',
    );
    const receipts = this.service.control.collection<NativeEffectReceipt>('native_source_receipts');
    const saved = await receipts.findOne({ _id: effectKey, ...scopeFilter(actor), jobId: lease.jobId });
    if (saved) {
      if (saved.argsDigest !== argsDigest) fail('IdempotencyConflict');
      const readback = await this.service.control
        .collection<NativeReadback>('native_source_readbacks')
        .findOne({ effectKey, ...scopeFilter(actor) }, { sort: { observedAt: -1 } });
      return {
        receipt: saved,
        readback:
          saved.status === 'source_effect_committed'
            ? (readback ?? (await this.readback(actor, lease, saved, targets)))
            : null,
      };
    }
    if (this.sourceClient !== this.service.client) {
      // Without a source-side live authority reservation, source effects cannot atomically honor control revocation.
      // Persist the exact intent and hold it; a receipt never attributes an outside writer's deletion to Expunge.
      const receipt: NativeEffectReceipt = {
        _id: effectKey,
        ...scopeFilter(actor),
        effectKey,
        jobId: lease.jobId,
        sourceId: source.sourceId,
        registrationHash: preview.registrationHash,
        previewHash: preview.previewHash,
        argsDigest,
        sourceKind: source.sourceKind,
        leaseFence: lease.fence,
        targetCount: targets.length,
        status: 'held_cross_deployment',
        atomicity: 'control_intent_only',
        limitations: [
          source.effectJournal
            ? 'source_side_live_authority_reservation_not_provisioned'
            : 'approved_source_effect_journal_missing',
        ],
        createdAt: new Date(),
      };
      await this.service.transaction(async (session) => {
        await this.registry.fence(actor, lease, preview.registrationHash, session);
        await receipts.insertOne(receipt, { session });
      });
      return { receipt, readback: null };
    }
    const tracker = await NativeSourceChangeTracker.open(
      this.service,
      this.sourceClient,
      source,
      lease.jobId,
    );
    try {
      const receipt = await this.service.transaction(async (session) => {
        const allowance = await this.budgets.reserveScan(
          actor,
          lease,
          source,
          Math.min(source.limits.maxScanned, state.caps.nodes) + targets.length + 1,
        );
        if (allowance <= targets.length + 1) fail('NativeJobBudgetExceeded');
        const replay = await receipts.findOne({ _id: effectKey }, { session });
        if (replay) {
          if (replay.argsDigest !== argsDigest || replay.jobId !== lease.jobId) fail('IdempotencyConflict');
          return replay;
        }
        await this.registry.fence(actor, lease, preview.registrationHash, session);
        // Recompute the complete scoped snapshot immediately before acceptance. Prior committed batches are the
        // only permitted differences; an external insert, deletion, schema/type change or unrelated write refuses.
        const prior = await this.service.control
          .collection('native_source_effects')
          .find(
            {
              ...scopeFilter(actor),
              jobId: lease.jobId,
              previewHash: preview.previewHash,
              batchOrdinal: { $lt: batchOrdinal },
            },
            { session, sort: { batchOrdinal: 1 } },
          )
          .toArray();
        if (prior.length !== batchOrdinal || prior.some((row, index) => row.batchOrdinal !== index))
          fail('NativeBatchOrderMismatch');
        const expected = new Map(
          preview.snapshotRows.map((row) => [
            idOf(row.namespaceId, decodeNativeScalar(row.identity)),
            row.digest,
          ]),
        );
        for (const target of preview.targets.slice(0, start)) {
          const key = idOf(target.namespaceId, decodeNativeScalar(target.identity));
          if (target.postimageDigest === null) expected.delete(key);
          else expected.set(key, target.postimageDigest);
        }
        const fresh = await this.snapshot(
          source,
          session,
          Math.min(source.limits.maxScanned, state.caps.nodes, allowance - targets.length - 1),
        );
        if (
          fresh.length !== expected.size ||
          fresh.some((row) => expected.get(row.key) !== nativeBsonDigest(row.document))
        )
          fail('NativePreviewNoLongerCurrent');
        const approval = await this.service.control
          .collection<NativePreviewApproval>('native_source_preview_approvals')
          .findOne(
            {
              ...scopeFilter(actor),
              jobId: lease.jobId,
              sourceId: source.sourceId,
              registrationHash: preview.registrationHash,
              previewHash: preview.previewHash,
              targetsDigest: contentHash(preview.targets, 'native-preview-targets-v2'),
              ownerActorId: actor.actorId,
              authorizationRevision: actor.authorizationRevision,
              $expr: { $gt: ['$expiresAt', '$$NOW'] },
            },
            { session, sort: { createdAt: -1 } },
          );
        if (!approval) fail('NativePreviewOwnerApprovalMissingOrExpired');
        await this.service.control
          .collection<Document & { _id: string }>('native_source_preview_consumptions')
          .insertOne(
            {
              _id: effectKey,
              ...scopeFilter(actor),
              approvalId: approval._id,
              effectKey,
              jobId: lease.jobId,
              registrationHash: preview.registrationHash,
              previewHash: preview.previewHash,
              batchOrdinal,
              createdAt: new Date(),
            },
            { session },
          );
        const records = await this.service.control
          .collection<PreviewRecord>('native_source_preimage_rows', NATIVE_BSON_OPTIONS)
          .find(
            { previewId, ordinal: { $gte: start, $lt: start + targets.length } },
            { session, sort: { ordinal: 1 } },
          )
          .toArray();
        if (records.length !== targets.length) fail('NativePreviewPreimagesMissing');
        await this.budgets.chargeCommittedChanges(actor, lease, source, targets.length, session);
        for (let index = 0; index < records.length; index++) {
          const record = records[index];
          const { preimage, postimage } = record;
          const target = targets[index];
          assertNativePreimageRowBinding(target, start + index, record.ordinal, preimage, postimage);
          const rule = source.rules.find(
            (value) => value.ruleId === target.ruleId && value.namespaceId === target.namespaceId,
          );
          const binding = await this.registry.jobBinding(actor, lease.jobId, session);
          if (!rule || !matchesRule(source, preimage, rule)) fail('NativePolicyNoLongerCurrent');
          const derivedPaths = effectPaths(source, preimage, rule, binding.subject, binding.subjectFieldId);
          const derivedPostimage = postimageOf(
            source,
            {
              namespaceId: target.namespaceId,
              document: preimage,
              key: idOf(target.namespaceId, preimage._id),
            },
            rule,
            derivedPaths,
          );
          if (
            contentHash(derivedPaths, 'native-paths-v2') !==
              contentHash(target.concretePaths, 'native-paths-v2') ||
            (derivedPostimage ? nativeBsonDigest(derivedPostimage) : null) !== target.postimageDigest
          )
            fail('NativePreviewCorrupt');
          const collection = this.collection(source, target.namespaceId);
          const filter = {
            $and: [nativeTenantPredicate(source, target.namespaceId), nativePreimagePredicate(preimage)],
          };
          const result =
            postimage === null
              ? await collection.deleteOne(filter, { session })
              : await collection.replaceOne(filter, postimage, { session });
          if ('deletedCount' in result ? result.deletedCount !== 1 : result.matchedCount !== 1)
            fail('NativePreimageStale');
        }
        const result: NativeEffectReceipt = {
          _id: effectKey,
          ...scopeFilter(actor),
          effectKey,
          jobId: lease.jobId,
          sourceId: source.sourceId,
          registrationHash: preview.registrationHash,
          previewHash: preview.previewHash,
          argsDigest,
          sourceKind: source.sourceKind,
          leaseFence: lease.fence,
          targetCount: targets.length,
          status: 'source_effect_committed',
          atomicity: 'same_deployment_transaction',
          limitations: preview.limitations,
          createdAt: new Date(),
        };
        await receipts.insertOne(result, { session });
        await this.service.control.collection<Document & { _id: string }>('native_source_effects').insertOne(
          {
            _id: effectKey,
            ...scopeFilter(actor),
            effectKey,
            jobId: lease.jobId,
            sourceId: source.sourceId,
            registrationHash: preview.registrationHash,
            previewHash: preview.previewHash,
            argsDigest,
            batchOrdinal,
            targetCount: targets.length,
            createdAt: new Date(),
          },
          { session },
        );
        return result;
      });
      return { receipt, readback: await this.readback(actor, lease, receipt, targets, true) };
    } finally {
      await tracker.close();
    }
  }

  /** Separate majority primary reads verify the actual native namespace, never a replay copy labeled original. */
  private async readback(
    actor: ActorContext,
    lease: LeaseBinding,
    receipt: NativeEffectReceipt,
    targets: NativeTarget[],
    reserved = false,
  ): Promise<NativeReadback> {
    const source = await this.registry.forJob(actor, receipt.jobId);
    if (!reserved) {
      const allowance = await this.budgets.reserveScan(actor, lease, source, targets.length);
      if (allowance !== targets.length) fail('NativeJobBudgetExceeded');
    }
    let verified = true;
    for (const target of targets) {
      const document = await this.collection(source, target.namespaceId).findOne(
        {
          $and: [
            nativeTenantPredicate(source, target.namespaceId),
            { _id: decodeNativeScalar(target.identity) },
          ],
        },
        { readPreference: 'primary', readConcern: { level: 'majority' }, maxTimeMS: MAX_QUERY_MS },
      );
      if ((document ? nativeBsonDigest(document) : null) !== target.postimageDigest) verified = false;
    }
    const row: NativeReadback = {
      _id: randomUUID(),
      ...scopeFilter(actor),
      receiptId: receipt._id,
      effectKey: receipt.effectKey,
      status: verified ? 'verified' : 'diverged',
      inspected: targets.length,
      observedAt: new Date(),
    };
    await this.service.control.collection<NativeReadback>('native_source_readbacks').insertOne(row);
    return row;
  }

  /** Verify all batches and preservation against a new consistent native snapshot. This is point-in-time proof. */
  async verifyPreview(
    actor: ActorContext,
    lease: LeaseBinding,
    previewId: string,
  ): Promise<{
    status: 'verified_snapshot_in_registered_scope';
    sourceKind: NativeSourceRegistration['sourceKind'];
    snapshotDigest: string;
    inspected: number;
    externalWritesAfterSnapshotPossible: true;
    limitations: string[];
  }> {
    requirePrincipal(this.service, ['domain_executor']);
    const source = await this.registry.forJob(actor, lease.jobId);
    const state = await this.budgets.beginOperation(actor, lease, source);
    if (this.sourceClient !== this.service.client) fail('CrossDeploymentVerificationHeld');
    const tracker = await NativeSourceChangeTracker.open(
      this.service,
      this.sourceClient,
      source,
      lease.jobId,
    );
    try {
      const result = await this.service.transaction(async (session) => {
        const allowance = await this.budgets.reserveScan(
          actor,
          lease,
          source,
          Math.min(source.limits.maxScanned, state.caps.nodes) + 1,
        );
        if (allowance < 2) fail('NativeJobBudgetExceeded');
        await this.registry.fence(actor, lease, nativeRegistrationHash(source), session);
        const preview = await this.service.control
          .collection<NativePreview>('native_source_previews')
          .findOne(
            {
              _id: previewId,
              ...scopeFilter(actor),
              jobId: lease.jobId,
              registrationHash: nativeRegistrationHash(source),
            },
            { session },
          );
        if (!preview) fail('NativePreviewMissingOrStale');
        const expectedBatches = Math.ceil(preview.targets.length / source.limits.maxBatch);
        const effects = await this.service.control
          .collection<Document & { _id: string }>('native_source_effects')
          .find(
            { ...scopeFilter(actor), jobId: lease.jobId, previewHash: preview.previewHash },
            { session, sort: { batchOrdinal: 1 }, limit: expectedBatches + 1 },
          )
          .toArray();
        if (
          effects.length !== expectedBatches ||
          effects.some((effect, index) => effect.batchOrdinal !== index)
        )
          fail('NativeCleanupBatchesIncomplete');
        const expected = new Map(
          preview.snapshotRows.map((row) => [
            idOf(row.namespaceId, decodeNativeScalar(row.identity)),
            row.digest,
          ]),
        );
        for (const target of preview.targets) {
          const key = idOf(target.namespaceId, decodeNativeScalar(target.identity));
          if (target.postimageDigest === null) expected.delete(key);
          else expected.set(key, target.postimageDigest);
        }
        const rows = await this.snapshot(
          source,
          session,
          Math.min(source.limits.maxScanned, state.caps.nodes, allowance - 1),
        );
        if (
          rows.length !== expected.size ||
          rows.some((row) => expected.get(row.key) !== nativeBsonDigest(row.document))
        )
          fail('NativeVerificationResidualOrPreservationMismatch');
        return {
          status: 'verified_snapshot_in_registered_scope' as const,
          sourceKind: source.sourceKind,
          snapshotDigest: contentHash(
            rows
              .map((row) => ({ key: row.key, digest: nativeBsonDigest(row.document) }))
              .sort((a, b) => a.key.localeCompare(b.key)),
            'native-snapshot-v2',
          ),
          inspected: rows.length,
          externalWritesAfterSnapshotPossible: true as const,
          limitations: preview.limitations,
        };
      });
      await tracker.poll();
      return result;
    } finally {
      await tracker.close();
    }
  }
}

/** Actual resumable namespace streams. A healthy cursor is evidence of observation, never a completeness watermark. */
export class NativeSourceChangeTracker {
  private constructor(
    readonly service: MongoService,
    readonly source: NativeSourceRegistration,
    readonly jobId: string,
    readonly streams: Array<{
      namespaceId: string;
      stream: ChangeStream<Document, ChangeStreamDocument<Document>>;
    }>,
  ) {}
  static async open(
    service: MongoService,
    client: MongoClient,
    source: NativeSourceRegistration,
    jobId: string,
  ): Promise<NativeSourceChangeTracker> {
    const streams: NativeSourceChangeTracker['streams'] = [];
    try {
      for (const namespace of source.namespaces) {
        const _id = contentHash(
          { jobId, registrationHash: nativeRegistrationHash(source), namespaceId: namespace.namespaceId },
          'native-cdc-v2',
        );
        const stored = await service.control
          .collection<Document & { _id: string }>('native_source_consistency')
          .findOne({ _id });
        if (stored?.status === 'gap') fail('NativeChangeStreamGap');
        const stream = client
          .db(namespace.database)
          .collection<Document>(namespace.collection, NATIVE_BSON_OPTIONS)
          .watch<Document, ChangeStreamDocument<Document>>([], {
            maxAwaitTimeMS: 1000,
            batchSize: 100,
            ...(stored?.resumeToken ? { resumeAfter: stored.resumeToken } : {}),
          });
        streams.push({ namespaceId: namespace.namespaceId, stream });
      }
      const tracker = new NativeSourceChangeTracker(service, source, jobId, streams);
      await tracker.poll(true);
      return tracker;
    } catch (error) {
      for (const { stream } of streams) await stream.close();
      throw error;
    }
  }
  async poll(prime = false): Promise<void> {
    for (const { namespaceId, stream } of this.streams) {
      const _id = contentHash(
        { jobId: this.jobId, registrationHash: nativeRegistrationHash(this.source), namespaceId },
        'native-cdc-v2',
      );
      try {
        let changed = 0;
        for (; changed < 100; changed++) {
          const event = await stream.tryNext();
          if (!event) break;
          if (!['insert', 'update', 'replace', 'delete'].includes(event.operationType))
            fail('NativeChangeStreamInvalidated');
        }
        if (changed === 100) fail('NativeChangeStreamDrainBound');
        const token = stream.resumeToken;
        if (!token) fail('NativeChangeStreamTokenMissing');
        await this.service.control
          .collection<Document & { _id: string }>('native_source_consistency')
          .updateOne(
            { _id },
            {
              $set: {
                ...scopeFilter(this.source.scope),
                jobId: this.jobId,
                sourceId: this.source.sourceId,
                registrationHash: nativeRegistrationHash(this.source),
                namespaceId,
                resumeToken: token,
                status: changed ? 'changed' : 'observing',
                changed,
                coverage: 'watermark_unproven',
                updatedAt: new Date(),
              },
            },
            { upsert: true },
          );
        if (changed && !prime) fail('NativeSourceChangedDuringDiscovery');
      } catch (error) {
        if (error instanceof Error && error.message === 'NativeSourceChangedDuringDiscovery') throw error;
        const auditId = randomUUID();
        const observedAt = new Date();
        await this.service.transaction(async (session) => {
          const sourceKey = nativeSourceHeadId(this.source.scope, this.source.sourceId);
          const touched = await this.service.control
            .collection<NativeSourceHead>('native_source_heads')
            .updateOne(
              { _id: sourceKey, registrationHash: nativeRegistrationHash(this.source) },
              { $inc: { touches: 1 } },
              { session },
            );
          // A newer owner-reviewed registration makes this old observation stale. Nothing from this gap commits.
          if (touched.matchedCount !== 1) fail('NativeSourceRevisionStale');
          await this.service.control
            .collection<Document & { _id: string }>('native_source_consistency')
            .updateOne(
              { _id },
              {
                $set: {
                  ...scopeFilter(this.source.scope),
                  jobId: this.jobId,
                  sourceId: this.source.sourceId,
                  registrationHash: nativeRegistrationHash(this.source),
                  namespaceId,
                  status: 'gap',
                  gapReason: 'cursor_resume_invalidation_or_observation_bound',
                  coverage: 'watermark_unproven',
                  updatedAt: observedAt,
                },
              },
              { session, upsert: true },
            );
          await this.service.control
            .collection<Document & { _id: string }>('native_source_consistency_events')
            .insertOne(
              {
                _id: auditId,
                ...scopeFilter(this.source.scope),
                jobId: this.jobId,
                sourceId: this.source.sourceId,
                registrationHash: nativeRegistrationHash(this.source),
                namespaceId,
                kind: 'gap',
                reason: 'cursor_resume_invalidation_or_observation_bound',
                recovery: 'new_owner_reviewed_registration_and_fresh_job_snapshot_required',
                createdAt: observedAt,
              },
              { session },
            );
          await this.service.control
            .collection<Document & { _id: string }>('native_source_gap_barriers')
            .updateOne(
              { _id: sourceKey },
              {
                $set: {
                  ...scopeFilter(this.source.scope),
                  sourceId: this.source.sourceId,
                  ownerActorId: this.source.ownerReview.actorId,
                  namespaceId,
                  registrationHash: nativeRegistrationHash(this.source),
                  registrationRevision: this.source.revision,
                  blocked: true,
                },
                $currentDate: { updatedAt: true },
              },
              { session, upsert: true },
            );
        });
        throw error;
      }
    }
  }
  async close(): Promise<void> {
    for (const { stream } of this.streams) await stream.close();
  }
}
