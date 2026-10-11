// A SECOND, differently implemented reference solver, used only to check the first one at admission.
//
// reference.ts runs a fixed point over declared edges with nested scans and the shared `valuesAtPath` walker. This
// one builds value indexes and runs a breadth-first closure from the subject, with its own path walker, its own
// subject-binding rule (registry field names, not the schema hints) and its own depth accounting. The two share
// no traversal code. If they disagree about which records a subject's erasure covers, the world is ambiguous or one
// of the solvers is wrong, and either way it must not be admitted.
import { contentHash } from '@expunge/contracts';
import { readFileSync } from 'node:fs';
import type { WorldSpec } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  addressKey,
  type CollectionId,
  type ExpectedEffect,
  type FixtureDocument,
  type VisibleWorld,
} from '@expunge/fixtures';

export const INDEXED_SOLVER_VERSION = 'expunge.indexed-reference.v1';
export const INDEXED_SOLVER_HASH = contentHash(
  {
    version: INDEXED_SOLVER_VERSION,
    discovery: 'value-index-plus-breadth-first-closure',
    sources: ['reference2.ts', '../../fixtures/src/types.ts', '../../contracts/src/index.ts']
      .sort()
      .map((moduleId) => ({
        moduleId,
        source: readFileSync(new URL(moduleId, import.meta.url), 'utf8'),
      })),
  },
  'indexed-reference-solver',
);

export interface IndexedPlan {
  worldId: string;
  scopeRevision: number;
  actions: ExpectedEffect[];
  exactBindings: string[];
  scannedDocuments: number;
  /** Deepest breadth-first level that added a document. */
  levels: number;
}

/** Leaf values at a registered path; `*` fans out over an array and anything absent yields nothing. */
function leaves(node: unknown, path: readonly string[]): unknown[] {
  if (!path.length) return [node];
  const [head, ...tail] = path;
  if (head === '*') return Array.isArray(node) ? node.flatMap((item) => leaves(item, tail)) : [];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return [];
  const record = node as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, head!) ? leaves(record[head!], tail) : [];
}
const strings = (node: unknown, path: readonly string[]): string[] =>
  leaves(node, path).filter((value): value is string => typeof value === 'string');
const keyOf = (collection: CollectionId, document: FixtureDocument): string =>
  addressKey({ collectionId: collection, recordId: document._id });

function indexBy(
  world: VisibleWorld,
  pick: (collection: CollectionId) => readonly (readonly string[])[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const collection of COLLECTION_IDS) {
    const paths = pick(collection);
    for (const document of world.collections[collection]) {
      for (const path of paths) {
        for (const value of strings(document, path)) {
          const holders = index.get(value) ?? new Set<string>();
          holders.add(keyOf(collection, document));
          index.set(value, holders);
        }
      }
    }
  }
  return index;
}

export function referenceSolveIndexed(
  world: VisibleWorld,
  bounds: WorldSpec['resourceBounds'] = { maxDocuments: 500, maxReferenceHops: 5 },
): IndexedPlan {
  const byKey = new Map<string, { collection: CollectionId; document: FixtureDocument }>();
  for (const collection of COLLECTION_IDS) {
    for (const document of world.collections[collection])
      byKey.set(keyOf(collection, document), { collection, document });
  }
  if (byKey.size > bounds.maxDocuments || bounds.maxDocuments > 500) throw new Error('IndexedDocumentBudget');
  const subject = world.collections.customers.find((document) => document._id === world.subjectHandle);
  if (!subject) throw new Error('IndexedSubjectMissing');
  const fields = new Map(world.scope.fields.map((field) => [field.fieldId, field]));
  const fieldPath = (fieldId: string): readonly string[] | null => fields.get(fieldId)?.path ?? null;

  // The subject's exact bindings: its own key plus the values of its registered identity, alias and e-mail fields.
  const bindings = new Set<string>([subject._id]);
  for (const field of world.scope.fields) {
    const isBinding =
      field.fieldId === 'customers.identity_binding' ||
      field.fieldId === 'customers.aliases' ||
      field.fieldId === 'customers.identity_email';
    if (field.collectionId === 'customers' && isBinding)
      for (const value of strings(subject, field.path)) bindings.add(value);
  }
  const identityPaths = (collection: CollectionId) => {
    const path = fieldPath(`${collection}.identity_binding`);
    return path ? [path] : [];
  };
  const identityIndex = indexBy(world, identityPaths);
  const depthOf = new Map<string, number>([[keyOf('customers', subject), 0]]);
  for (const binding of bindings)
    for (const key of identityIndex.get(binding) ?? []) if (!depthOf.has(key)) depthOf.set(key, 0);

  // Declared edges, each with the two sides indexed: who holds a value in the referencing field, who is keyed by it.
  const edges = world.scope.referenceEdges.map((edge) => {
    if (edge.identityRule !== 'same_bson_type') throw new Error('IndexedUnsupportedRule');
    const from = fieldPath(edge.fromFieldId);
    const to = fieldPath(edge.toFieldId);
    if (!from || !to) throw new Error('IndexedFieldMissing');
    const holdersOfReference = indexBy(world, (collection) =>
      collection === edge.fromCollectionId ? [from] : [],
    );
    const holdersOfKey = indexBy(world, (collection) => (collection === edge.toCollectionId ? [to] : []));
    return { edge, from, to, holdersOfReference, holdersOfKey };
  });

  let frontier = [...depthOf.keys()];
  let levels = 0;
  for (let level = 1; level <= bounds.maxReferenceHops && frontier.length; level++) {
    const discovered: string[] = [];
    for (const key of frontier) {
      const { collection, document } = byKey.get(key)!;
      for (const { edge, from, to, holdersOfReference, holdersOfKey } of edges) {
        const neighbours: string[] = [];
        if (world.schema.referenceExpansion === 'outgoing') {
          // Follow the referencing field of a selected document to the records it names.
          if (edge.fromCollectionId === collection)
            for (const value of strings(document, from)) neighbours.push(...(holdersOfKey.get(value) ?? []));
        } else if (edge.toCollectionId === collection) {
          // Select the records that reference a selected document's key.
          for (const value of strings(document, to))
            neighbours.push(...(holdersOfReference.get(value) ?? []));
        }
        for (const neighbour of neighbours) {
          if (!depthOf.has(neighbour)) {
            depthOf.set(neighbour, level);
            discovered.push(neighbour);
          }
        }
      }
    }
    if (discovered.length) levels = level;
    frontier = discovered;
  }

  const actions: ExpectedEffect[] = [...depthOf.keys()]
    .map((key) => {
      const { collection, document } = byKey.get(key)!;
      if (
        document.tenantId !== world.scope.tenantId ||
        document.env !== world.scope.env ||
        document.worldId !== world.worldId
      ) {
        throw new Error('IndexedCrossScope');
      }
      const permitted =
        document.eligibility.policyId === world.scope.eligibilityPolicyId &&
        world.scope.allowedEffectKinds.includes(document.eligibility.effect);
      if (!permitted) throw new Error('IndexedEligibility');
      return {
        address: { collectionId: collection, recordId: document._id, recordIdBsonType: 'string' as const },
        effect: document.eligibility.effect,
        expectedRevision: document._rev,
      };
    })
    .sort((left, right) => addressKey(left.address).localeCompare(addressKey(right.address), 'en'));
  const exactBindings = [
    ...new Set([...bindings, ...actions.map((action) => action.address.recordId)]),
  ].sort();
  return {
    worldId: world.worldId,
    scopeRevision: world.scope.revision,
    actions,
    exactBindings,
    scannedDocuments: byKey.size,
    levels,
  };
}

/** True when two solvers select exactly the same records, effects, revisions and bindings. */
export function plansAgree(
  first: { actions: ExpectedEffect[]; exactBindings: string[] },
  second: { actions: ExpectedEffect[]; exactBindings: string[] },
): boolean {
  const normalize = (plan: { actions: ExpectedEffect[]; exactBindings: string[] }) =>
    contentHash(
      {
        actions: plan.actions
          .map((action) => [
            action.address.collectionId,
            action.address.recordId,
            action.effect,
            action.expectedRevision,
          ])
          .sort(),
        bindings: [...plan.exactBindings].sort(),
      },
      'solver-plan',
    );
  return normalize(first) === normalize(second);
}
