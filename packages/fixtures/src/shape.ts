/**
 * TRUSTED GENERATOR/GRADER ONLY. Shape-only adversaries used as a canary: a visible-world detector that never
 * resolves identity or follows a reference, only looks at how records are built. If any such detector picks
 * out the expected targets better than chance, the world leaks its answer through structure and is quarantined.
 */
import {
  COLLECTION_IDS,
  addressKey,
  type FixtureDocument,
  type JsonValue,
  type VisibleWorld,
} from './types.js';
import { valuesAtPath } from './paths.js';

/** Stated tolerance: a detector may exceed the target fraction among candidates by at most this much. */
export const SHAPE_PRECISION_TOLERANCE = 0.02;

type CollectionKey = (typeof COLLECTION_IDS)[number];
type Selector = (world: VisibleWorld, collectionId: CollectionKey) => FixtureDocument[];
interface ShapeDetector {
  id: string;
  /** The records the detector chooses among; chance is the target fraction of these. Default: the whole collection. */
  candidates?: Selector;
  select: Selector;
}

/** Port of the DA-1 repro rule: summary of the registry's identity/reference values for one document. */
function daSignature(
  world: VisibleWorld,
  collectionId: string,
  document: FixtureDocument,
  kindOf: (value: unknown) => string,
): string {
  const field = (id: string) => world.scope.fields.find((candidate) => candidate.fieldId === id);
  const identity = field(`${collectionId}.identity_binding`);
  const reference = field(`${collectionId}.record_reference`);
  const identityValues = identity ? valuesAtPath(document, identity.path).map((entry) => entry.value) : [];
  const referenceValues = reference ? valuesAtPath(document, reference.path).map((entry) => entry.value) : [];
  return JSON.stringify({
    idStrings: identityValues.filter((value) => typeof value === 'string').length,
    idNull: identityValues.some((value) => value === null),
    refs: referenceValues.length,
    refKinds: [...new Set(referenceValues.map(kindOf))].sort(),
  });
}
/** Verbatim from the DA-1 repro: the first two underscore-separated chunks of an ID. */
const daKind = (value: unknown): string =>
  typeof value === 'string' ? value.split('_').slice(0, 2).join('_') : String(value);
/** Reference kind with opaque hex runs collapsed, so only a readable prefix could carry information. */
const normalizedKind = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[0-9a-f]{12,}/g, '#') : String(value);

/**
 * Character-class format of a string: opaque hex runs, digit runs and letter runs collapse to one symbol each,
 * so the format records separators and layout but not which words or digits appear.
 */
function stringFormat(value: string): string {
  return value
    .replace(/[0-9a-f]{12,}/g, '#')
    .replace(/[0-9]+/g, 'N')
    .replace(/[A-Za-z]+/g, 'a');
}

/** Field presence, nesting, array lengths and value types. `formats` adds string formats. */
function structureFingerprint(value: JsonValue | undefined, formats: boolean): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.length}:${value.map((child) => structureFingerprint(child, formats)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== undefined) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${key}=${structureFingerprint(value[key], formats)}`).join(',')}}`;
  }
  if (typeof value === 'string') {
    return formats ? `s:${stringFormat(value)}` : 's';
  }
  return typeof value;
}
export function documentFingerprint(document: FixtureDocument, formats: boolean): string {
  // Record identifiers and world binding are instance values by construction; everything else is compared.
  const { _id: _ignored, worldId: _world, ...rest } = document;
  return structureFingerprint(rest as unknown as JsonValue, formats);
}

/** Documents outside the strictly most common group. With no strict mode there is no signal: select all. */
function outliersOf(
  documents: FixtureDocument[],
  key: (document: FixtureDocument) => string,
): FixtureDocument[] {
  const groups = new Map<string, FixtureDocument[]>();
  for (const document of documents) {
    const bucket = groups.get(key(document)) ?? [];
    bucket.push(document);
    groups.set(key(document), bucket);
  }
  const sizes = [...groups.values()].map((group) => group.length).sort((left, right) => right - left);
  if (sizes.length === 1 || sizes[0] === sizes[1] || sizes[0] === 1) return documents;
  const mode = [...groups.values()].find((group) => group.length === sizes[0])!;
  return documents.filter((document) => !mode.includes(document));
}

/** Every string value held anywhere below a document's `data`. */
function heldStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((child) => heldStrings(child, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((child) => heldStrings(child, out));
  return out;
}
interface Cooccurrence {
  /** Documents (other than `self`) whose data contains `value`. */
  others(value: string, self: string): number;
  /** Documents (including the holder) whose data contains `value`. */
  holders(value: string): number;
}
const cooccurrenceCache = new WeakMap<VisibleWorld, Cooccurrence>();
/** Cross-document value co-occurrence: no identity resolution and no walk from the subject. */
function cooccurrence(world: VisibleWorld): Cooccurrence {
  const cached = cooccurrenceCache.get(world);
  if (cached) return cached;
  const holdersOf = new Map<string, Set<string>>();
  for (const collectionId of COLLECTION_IDS) {
    for (const document of world.collections[collectionId]) {
      const key = `${collectionId}/${document._id}`;
      for (const value of new Set(heldStrings(document.data))) {
        const set = holdersOf.get(value) ?? new Set<string>();
        set.add(key);
        holdersOf.set(value, set);
      }
    }
  }
  const index: Cooccurrence = {
    others: (value, self) => [...(holdersOf.get(value) ?? [])].filter((holder) => holder !== self).length,
    holders: (value) => holdersOf.get(value)?.size ?? 0,
  };
  cooccurrenceCache.set(world, index);
  return index;
}
const isIdentityString = (value: string): boolean => value.startsWith('syn_') || value.includes('@');
/** Own in-degree (documents containing this document's _id) and/or frequencies of the identity strings it holds. */
function cooccurrenceKey(
  world: VisibleWorld,
  collectionId: string,
  document: FixtureDocument,
  parts: { inDegree: boolean; tokens: boolean },
): string {
  const index = cooccurrence(world);
  const self = `${collectionId}/${document._id}`;
  const held = new Set(heldStrings(document.data).filter(isIdentityString));
  return JSON.stringify({
    indeg: parts.inDegree ? index.others(document._id, self) : null,
    held: parts.tokens ? [...held].map((value) => index.others(value, self)).sort((a, b) => a - b) : null,
  });
}
/** Records that share the subject's display name: the namesake candidate set. Empty when there is no collision. */
function sameNameAsSubject(world: VisibleWorld, collectionId: CollectionKey): FixtureDocument[] {
  const subject = world.collections.customers.find((document) => document._id === world.subjectHandle);
  const same = world.collections[collectionId].filter(
    (document) => document.data.displayName === subject?.data.displayName,
  );
  return same.length >= 2 ? same : [];
}

export const SHAPE_DETECTORS: ReadonlyArray<ShapeDetector> = [
  {
    id: 'da_signature_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) =>
        daSignature(world, collectionId, document, daKind),
      ),
  },
  {
    id: 'normalized_signature_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) =>
        daSignature(world, collectionId, document, normalizedKind),
      ),
  },
  {
    id: 'structure_fingerprint_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) => documentFingerprint(document, false)),
  },
  {
    id: 'format_fingerprint_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) => documentFingerprint(document, true)),
  },
  {
    id: 'cooccurrence_signature_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) =>
        cooccurrenceKey(world, collectionId, document, { inDegree: true, tokens: true }),
      ),
  },
  {
    id: 'degree_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) =>
        cooccurrenceKey(world, collectionId, document, { inDegree: true, tokens: false }),
      ),
  },
  {
    id: 'token_frequency_outlier',
    select: (world, collectionId) =>
      outliersOf(world.collections[collectionId], (document) =>
        cooccurrenceKey(world, collectionId, document, { inDegree: false, tokens: true }),
      ),
  },
  {
    // Among records that share the subject's name, pick the holder of the most widely shared identity string.
    id: 'namesake_frequency_pick',
    candidates: sameNameAsSubject,
    select: (world, collectionId) => {
      const same = sameNameAsSubject(world, collectionId);
      const index = cooccurrence(world);
      const score = (document: FixtureDocument): number =>
        Math.max(
          0,
          ...heldStrings(document.data)
            .filter((v) => v.startsWith('syn_'))
            .map((v) => index.holders(v)),
        );
      const top = Math.max(0, ...same.map(score));
      return same.filter((document) => score(document) === top);
    },
  },
];

export interface ShapeDetectorResult {
  detector: string;
  /** Records the detector would act on across the five non-subject collections. */
  selected: number;
  hits: number;
  precision: number;
  /** Target fraction among all candidate records: the precision of a uniformly random pick. */
  chance: number;
}

/** Pooled precision over the five non-subject collections; the subject record is handed to every detector. */
export function evaluateShapeDetectors(
  world: VisibleWorld,
  targetKeys: ReadonlySet<string>,
): ShapeDetectorResult[] {
  const collections = COLLECTION_IDS.filter((id) => id !== 'customers');
  const isTarget = (collectionId: CollectionKey, document: FixtureDocument): boolean =>
    targetKeys.has(addressKey({ collectionId, recordId: document._id }));
  return SHAPE_DETECTORS.map(({ id, select, candidates }) => {
    let selected = 0;
    let hits = 0;
    let candidateCount = 0;
    let candidateTargets = 0;
    for (const collectionId of collections) {
      const pool = candidates ? candidates(world, collectionId) : world.collections[collectionId];
      candidateCount += pool.length;
      candidateTargets += pool.filter((document) => isTarget(collectionId, document)).length;
      for (const document of select(world, collectionId)) {
        selected++;
        if (isTarget(collectionId, document)) hits++;
      }
    }
    return {
      detector: id,
      selected,
      hits,
      precision: selected ? hits / selected : 0,
      chance: candidateCount ? candidateTargets / candidateCount : 0,
    };
  });
}

/** Detectors that beat chance by more than the stated tolerance: each is a structural answer channel. */
export function shapeLeaks(results: readonly ShapeDetectorResult[]): string[] {
  return results
    .filter((row) => row.precision > row.chance + SHAPE_PRECISION_TOLERANCE)
    .map((row) => row.detector);
}
