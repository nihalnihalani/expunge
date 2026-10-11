import { contentHash } from '@expunge/contracts';
import { readFileSync } from 'node:fs';
import type { WorldSpec } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  addressKey,
  valuesAtPath,
  type CollectionId,
  type DocumentAddress,
  type ExpectedEffect,
  type FixtureDocument,
  type JsonValue,
  type VisibleWorld,
} from '@expunge/fixtures';

export const REFERENCE_SOLVER_VERSION = 'expunge.visible-reference.v1';
export const REFERENCE_SOLVER_HASH = contentHash(
  {
    version: REFERENCE_SOLVER_VERSION,
    discovery: 'exact-visible-identity-plus-declared-reference-fixed-point',
    sources: [
      'reference.ts',
      '../../fixtures/src/paths.ts',
      '../../fixtures/src/types.ts',
      '../../contracts/src/index.ts',
    ]
      .sort()
      .map((moduleId) => ({ moduleId, source: readFileSync(new URL(moduleId, import.meta.url), 'utf8') })),
    maxDocuments: 500,
    maxHops: 5,
    names: 'display-name-is-never-authority',
  },
  'reference-solver',
);
export interface ReferencePlan {
  worldId: string;
  scopeRevision: number;
  actions: ExpectedEffect[];
  exactBindings: string[];
  scannedDocuments: number;
  traversalDepth: number;
  planHash: string;
}

type Selection = Map<string, { address: DocumentAddress; document: FixtureDocument; depth: number }>;

function inWorldScope(world: VisibleWorld, document: FixtureDocument): boolean {
  return (
    document.tenantId === world.scope.tenantId &&
    document.env === world.scope.env &&
    document.worldId === world.worldId
  );
}

/** Exact identity strings of the authorized subject: record ID, identity fields, aliases and e-mail. */
function subjectBindings(world: VisibleWorld, root: FixtureDocument): Set<string> {
  const bindings = new Set<string>([root._id]);
  const rootFields = world.scope.fields.filter(
    (field) =>
      field.collectionId === 'customers' &&
      (world.schema.identityFieldIds.includes(field.fieldId) ||
        field.fieldId === world.schema.aliasFieldId ||
        field.fieldId === 'customers.identity_email'),
  );
  for (const field of rootFields) {
    for (const result of valuesAtPath(root, field.path)) {
      if (typeof result.value === 'string') bindings.add(result.value);
    }
  }
  return bindings;
}

function includeDocument(
  world: VisibleWorld,
  selected: Selection,
  collectionId: CollectionId,
  document: FixtureDocument,
  depth: number,
): void {
  if (!inWorldScope(world, document)) throw new Error('ReferenceCrossScope');
  const address = { collectionId, recordId: document._id, recordIdBsonType: 'string' as const };
  if (!selected.has(addressKey(address))) selected.set(addressKey(address), { address, document, depth });
}

/** One expansion round over every declared edge. Returns true when it selected a new document. */
function expandOnce(world: VisibleWorld, selected: Selection, depth: number): boolean {
  let grew = false;
  const existing = new Map(selected);
  for (const edge of world.scope.referenceEdges) {
    if (edge.identityRule !== 'same_bson_type') throw new Error('UnsupportedSyntheticReferenceRule');
    const fromField = world.scope.fields.find(
      (field) => field.fieldId === edge.fromFieldId && field.collectionId === edge.fromCollectionId,
    );
    const toField = world.scope.fields.find(
      (field) => field.fieldId === edge.toFieldId && field.collectionId === edge.toCollectionId,
    );
    if (!fromField || !toField) throw new Error('ReferenceFieldMissing');
    const fromCollection = edge.fromCollectionId as CollectionId;
    const toCollection = edge.toCollectionId as CollectionId;
    if (!world.collections[fromCollection] || !world.collections[toCollection]) {
      throw new Error('ReferenceCollectionMissing');
    }
    for (const from of world.collections[fromCollection]) {
      const values = valuesAtPath(from, fromField.path)
        .filter((entry) => typeof entry.value === 'string')
        .map((entry) => entry.value);
      for (const to of world.collections[toCollection]) {
        if (!valuesAtPath(to, toField.path).some((entry) => values.includes(entry.value))) continue;
        const sourceSelected = existing.has(addressKey({ collectionId: fromCollection, recordId: from._id }));
        const targetSelected = existing.has(addressKey({ collectionId: toCollection, recordId: to._id }));
        let candidate: { collection: CollectionId; document: FixtureDocument } | null = null;
        if (world.schema.referenceExpansion === 'outgoing') {
          if (sourceSelected) candidate = { collection: toCollection, document: to };
        } else if (targetSelected) {
          candidate = { collection: fromCollection, document: from };
        }
        if (!candidate) continue;
        const key = addressKey({ collectionId: candidate.collection, recordId: candidate.document._id });
        if (selected.has(key)) continue;
        includeDocument(world, selected, candidate.collection, candidate.document, depth);
        grew = true;
      }
    }
  }
  return grew;
}

/** Slow full-scope reference walk. Uses visible schema/evidence only, never fixture manifest. */
export function referenceSolve(
  world: VisibleWorld,
  bounds: WorldSpec['resourceBounds'] = { maxDocuments: 500, maxReferenceHops: 5 },
): ReferencePlan {
  const documents = COLLECTION_IDS.flatMap((collectionId) =>
    world.collections[collectionId].map((document) => ({ collectionId, document })),
  );
  if (documents.length > bounds.maxDocuments || bounds.maxDocuments > 500) {
    throw new Error('ReferenceDocumentBudget');
  }
  const root = world.collections.customers.find((document) => document._id === world.subjectHandle);
  if (!root) throw new Error('ReferenceSubjectMissing');
  if (!inWorldScope(world, root)) throw new Error('ReferenceSubjectScope');
  const bindings = subjectBindings(world, root);

  const selected: Selection = new Map();
  includeDocument(world, selected, 'customers', root, 0);
  for (const { collectionId, document } of documents) {
    const identityFields = world.scope.fields.filter(
      (field) => field.collectionId === collectionId && world.schema.identityFieldIds.includes(field.fieldId),
    );
    const carriesSubject = identityFields.some((field) =>
      valuesAtPath(document, field.path).some(
        (result) => typeof result.value === 'string' && bindings.has(result.value),
      ),
    );
    if (carriesSubject) includeDocument(world, selected, collectionId, document, 0);
  }
  let traversalDepth = 0;
  for (let depth = 1; depth <= bounds.maxReferenceHops; depth++) {
    if (!expandOnce(world, selected, depth)) break;
    traversalDepth = depth;
  }

  const actions = [...selected.values()]
    .map(({ address, document }) => {
      const eligible =
        document.eligibility.policyId === world.scope.eligibilityPolicyId &&
        world.scope.allowedEffectKinds.includes(document.eligibility.effect);
      if (!eligible) throw new Error('ReferenceEligibility');
      return { address, effect: document.eligibility.effect, expectedRevision: document._rev };
    })
    .sort((left, right) => addressKey(left.address).localeCompare(addressKey(right.address), 'en'));
  const exactBindings = [
    ...new Set([...bindings, ...actions.map((action) => action.address.recordId)]),
  ].sort();
  const payload = {
    worldId: world.worldId,
    scopeRevision: world.scope.revision,
    actions,
    exactBindings,
    scannedDocuments: documents.length,
    traversalDepth,
  };
  return { ...payload, planHash: contentHash(payload, 'reference-plan') };
}

function replaceBinding(value: JsonValue, bindings: ReadonlySet<string>, replacement: JsonValue): JsonValue {
  if (typeof value === 'string') return bindings.has(value) ? replacement : value;
  if (Array.isArray(value)) return value.map((item) => replaceBinding(item, bindings, replacement));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceBinding(item, bindings, replacement)]),
    );
  }
  return value;
}
/** Reference execution is independent from oracle construction. Scope policy authorizes each effect. */
export function applyReferenceAction(
  world: VisibleWorld,
  action: ExpectedEffect,
  exactBindings: readonly string[],
): void {
  const collection = world.collections[action.address.collectionId];
  const index = collection.findIndex((document) => document._id === action.address.recordId);
  if (index < 0) throw new Error('ReferenceTargetMissing');
  const initial = collection[index]!;
  if (initial._rev !== action.expectedRevision) throw new Error('ReferenceStaleVersion');
  if (
    initial.eligibility.effect !== action.effect ||
    initial.eligibility.policyId !== world.scope.eligibilityPolicyId
  ) {
    throw new Error('ReferenceEffectIneligible');
  }
  if (!inWorldScope(world, initial)) throw new Error('ReferenceTargetScope');
  if (action.effect === 'delete') {
    collection.splice(index, 1);
    return;
  }
  const result = structuredClone(initial);
  result._rev++;
  if (action.effect === 'restrict') {
    result.access = 'restricted';
  } else {
    const replacement = action.effect === 'redact' ? '[redacted]' : null;
    result.data = replaceBinding(result.data, new Set(exactBindings), replacement) as FixtureDocument['data'];
    result.data.payload = replacement;
    if (action.effect === 'tombstone') result.lifecycle = 'tombstoned';
  }
  collection[index] = result;
}
export function runReference(
  world: VisibleWorld,
  bounds?: WorldSpec['resourceBounds'],
): { world: VisibleWorld; plan: ReferencePlan } {
  const result = structuredClone(world);
  const plan = referenceSolve(result, bounds);
  for (const action of plan.actions) applyReferenceAction(result, action, plan.exactBindings);
  return { world: result, plan };
}
