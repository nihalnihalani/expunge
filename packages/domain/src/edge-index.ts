import {
  nodeKey,
  ProtocolError,
  type ScannedRecord,
  type ScopeRepository,
  type WorldKey,
} from '@expunge/mongo';
import type { ReferenceDeclaration, ScopeRegistry } from '@expunge/contracts';
import { IdentityEdgeRepository, registryHashOf, type EdgeRow } from './edge-repository.js';
import { referenceKeys, valuesAt, type ReferenceRule } from './values.js';

export type EdgeIndexStats = {
  worldRevision: number;
  scannedDocuments: number;
  edges: number;
  reused: boolean;
};

const PAGE = 200;

/** Every record of every registered collection, in `_id` order, paged and bounded by `maxDocuments`. */
export async function scanWorld(
  scopes: ScopeRepository,
  world: WorldKey,
  registry: ScopeRegistry,
  maxDocuments: number,
): Promise<Map<string, ScannedRecord[]>> {
  const byCollection = new Map<string, ScannedRecord[]>();
  let total = 0;
  for (const collectionId of registry.collectionIds) {
    const rows: ScannedRecord[] = [];
    let afterId: unknown;
    for (;;) {
      const page = await scopes.scan(world, registry, collectionId, {
        limit: PAGE,
        ...(afterId === undefined ? {} : { afterId }),
      });
      total += page.length;
      if (total > maxDocuments) throw new ProtocolError('ScanBudgetExceeded');
      rows.push(...page);
      if (page.length < PAGE) break;
      afterId = page[page.length - 1]!.document._id;
    }
    byCollection.set(collectionId, rows);
  }
  return byCollection;
}

/**
 * Edges implied by the registry's declarations over the records as they are now: record F references record T
 * through edge E when a value F holds at E's referencing field is a value T holds at E's referenced field. Only
 * registered, visible data is read; nothing here knows which records are targets.
 */
export function deriveEdges(
  registry: ScopeRegistry,
  records: ReadonlyMap<string, readonly ScannedRecord[]>,
): EdgeRow[] {
  const fields = new Map(registry.fields.map((field) => [field.fieldId, field]));
  const rows = new Map<string, EdgeRow>();
  for (const declaration of registry.referenceEdges) {
    const edge: ReferenceDeclaration = declaration;
    const fromField = fields.get(edge.fromFieldId);
    const toField = fields.get(edge.toFieldId);
    if (!fromField || !toField) continue;
    const rule = edge.identityRule as ReferenceRule;
    const targets = new Map<string, ScannedRecord[]>();
    for (const target of records.get(edge.toCollectionId) ?? []) {
      for (const found of valuesAt(target.document, toField))
        for (const key of referenceKeys(found.value, rule, 'to')) {
          const list = targets.get(key) ?? [];
          list.push(target);
          targets.set(key, list);
        }
    }
    for (const from of records.get(edge.fromCollectionId) ?? []) {
      for (const found of valuesAt(from.document, fromField)) {
        for (const key of referenceKeys(found.value, rule, 'from')) {
          for (const target of targets.get(key) ?? []) {
            const fromNode = nodeKey(from.address);
            const toNode = nodeKey(target.address);
            if (fromNode === toNode) continue;
            rows.set(`${edge.edgeId}|${fromNode}|${toNode}`, {
              edgeId: edge.edgeId,
              fieldId: edge.fromFieldId,
              from: from.address,
              to: target.address,
              fromNode,
              toNode,
            });
          }
        }
      }
    }
  }
  return [...rows.values()];
}

/**
 * Makes sure the edge index of this world revision exists, deriving and writing it when it does not. Writing is
 * idempotent and the completion marker goes last, so a crash leaves an index that is simply rebuilt.
 */
export async function ensureEdgeIndex(options: {
  edges: IdentityEdgeRepository;
  scopes: ScopeRepository;
  world: WorldKey;
  registry: ScopeRegistry;
  worldRevision: number;
  maxDocuments: number;
  /** Records already scanned at this revision, to avoid reading the world twice. */
  records?: ReadonlyMap<string, readonly ScannedRecord[]>;
}): Promise<EdgeIndexStats> {
  const { edges, scopes, world, registry, worldRevision, maxDocuments } = options;
  const registryHash = registryHashOf(registry);
  if (await edges.isComplete(world, worldRevision, undefined, registryHash)) {
    return {
      worldRevision,
      scannedDocuments: 0,
      edges: await edges.count(world, worldRevision),
      reused: true,
    };
  }
  const records = options.records ?? (await scanWorld(scopes, world, registry, maxDocuments));
  const derived = deriveEdges(registry, records);
  await edges.insertEdges(world, worldRevision, derived, registryHash);
  await edges.markComplete(world, worldRevision, registryHash);
  const scanned = [...records.values()].reduce((sum, list) => sum + list.length, 0);
  return { worldRevision, scannedDocuments: scanned, edges: derived.length, reused: false };
}
