import { contentHash } from '@expunge/contracts';
import type {
  FieldDescriptor,
  ReferenceDeclaration,
  ScopeRegistry,
  ScopeKey,
  WorldSpec,
} from '@expunge/contracts';
import { assignRecipePath } from './paths.js';
import { effectFor, identityTokens, seededId, validateWorldSpec } from './recipes.js';
import { resolveScopeKey, worldIdFor } from './scope.js';
import {
  COLLECTION_IDS,
  WorldSpecError,
  type CollectionId,
  type FixtureDocument,
  type FixtureFamily,
  type JsonObject,
  type VisibleWorld,
  type WorldCollections,
} from './types.js';

export { WorldSpecError } from './types.js';

type CollectionLayout = WorldSpec['collectionLayouts'][number];

/** This topology is a visible recipe; no function in this module imports an expected target manifest. */
function topology(
  family: FixtureFamily,
  ids: Record<CollectionId, string>,
  cyclic: boolean,
): Record<CollectionId, string[]> {
  const edges: Record<CollectionId, string[]> = {
    customers: [],
    accounts: [ids.customers],
    messages: [ids.accounts],
    events: [ids.accounts],
    notes: [ids.messages],
    archives: [ids.notes],
  };
  if (family === 'direct_nested' || family === 'shared_array') {
    edges.messages = [];
    edges.events = [ids.customers];
    edges.notes = [];
    edges.archives = [ids.accounts];
  }
  if (family === 'reverse_reference') {
    edges.customers = [ids.accounts];
    edges.accounts = [ids.messages];
    edges.messages = [ids.events];
    edges.events = [ids.notes];
    edges.notes = [ids.archives];
    edges.archives = [];
  }
  if (family === 'archive_bridge') {
    edges.accounts = [ids.customers];
    edges.archives = [ids.accounts];
    edges.events = [ids.archives];
    edges.notes = [ids.events];
    edges.messages = [ids.notes];
  }
  if (family === 'diamond_alias') {
    edges.notes = [ids.messages, ids.events];
    edges.archives = [ids.notes, ids.accounts];
  }
  if (cyclic) {
    edges.notes.push(ids.archives);
    edges.archives.push(ids.notes);
  }
  return edges;
}

/**
 * Each collection holds `documentsPerCollection` records, one per "chain". Chain 0 is the subject's chain; every
 * other chain is a decoy built by the very same recipe from its own identity tokens and its own record IDs.
 * Decoys therefore have the same fields, nesting, array lengths, null patterns, reference counts and value
 * formats as the targets. What separates a target from a decoy is only that its identity values and reference
 * chain resolve, through exact matching, to the authorized subject.
 */
interface BuildContext {
  spec: WorldSpec;
  seed: string;
  family: FixtureFamily;
  scope: ScopeKey;
  worldId: string;
  chainCount: number;
  /** Identity tokens `[id, email, ...aliases]` of one chain. Chain 0 belongs to the subject. */
  tokens(chain: number): string[];
  /** Record IDs of one chain, one per collection. */
  ids(chain: number): Record<CollectionId, string>;
  /** Display name shared by all records of one chain. */
  displayName(chain: number): string;
  edges(chain: number): Record<CollectionId, string[]>;
  /**
   * The unrelated bystander each chain mentions inside its mixed arrays. Every chain, the subject's included, has
   * exactly one: a standalone identity token and a record ID that no other chain holds. Cross-chain links would make
   * the subject chain the only chain nobody mentions, which is a statistical tell.
   */
  bystanderToken(chain: number): string;
  bystanderRecord(chain: number): string;
}

const NAME_WORDS = [
  'Amber',
  'Birch',
  'Cobalt',
  'Dune',
  'Ember',
  'Fjord',
  'Garnet',
  'Harbor',
  'Indigo',
  'Juniper',
  'Kestrel',
  'Lumen',
  'Meadow',
  'Nimbus',
  'Onyx',
  'Prairie',
  'Quartz',
  'Ridge',
  'Saffron',
  'Tundra',
  'Umber',
  'Vale',
  'Willow',
  'Xenon',
  'Yarrow',
  'Zephyr',
  'Aspen',
  'Basalt',
  'Cinder',
  'Delta',
  'Echo',
  'Flint',
];

/**
 * One format for every name: `Synthetic <Word> <Word>`. The subject and its namesake chains share a name; every
 * other chain gets a distinct one, so the only name signal is the intended namesake collision.
 */
function chainNames(seed: string, count: number, namesakeCount: number): string[] {
  const pool = NAME_WORDS.length * NAME_WORDS.length;
  const nameAt = (slot: number): string =>
    `Synthetic ${NAME_WORDS[Math.floor(slot / NAME_WORDS.length) % NAME_WORDS.length]} ${NAME_WORDS[slot % NAME_WORDS.length]}`;
  const slotFor = (chain: number): number =>
    Number.parseInt(contentHash({ seed, chain }, 'synthetic-name').slice(0, 8), 16) % pool;
  const used = new Set<number>();
  const claim = (chain: number): number => {
    let slot = slotFor(chain);
    while (used.has(slot)) slot = (slot + 1) % pool;
    used.add(slot);
    return slot;
  };
  const shared = nameAt(claim(0));
  return Array.from({ length: count }, (_, chain) =>
    chain <= namesakeCount ? shared : nameAt(claim(chain)),
  );
}

function createContext(spec: WorldSpec, seed: string, scope: ScopeKey, worldId: string): BuildContext {
  const family = spec.family as FixtureFamily;
  const chainCount = spec.unrelatedRecipes.documentsPerCollection;
  const { subjectOrdinal, aliasCount } = spec.identityRecipe;
  const names = chainNames(seed, chainCount, spec.unrelatedRecipes.namesakeCount);
  const tokenCache = new Map<number, string[]>();
  const idCache = new Map<number, Record<CollectionId, string>>();
  const edgeCache = new Map<number, Record<CollectionId, string[]>>();
  const context: BuildContext = {
    spec,
    seed,
    family,
    scope,
    worldId,
    chainCount,
    tokens: (chain) => {
      if (!tokenCache.has(chain)) {
        const ordinal = chain === 0 ? subjectOrdinal : subjectOrdinal + 1_000_001 + chain;
        tokenCache.set(chain, identityTokens(seed, ordinal, aliasCount, worldId));
      }
      return tokenCache.get(chain)!;
    },
    ids: (chain) => {
      if (!idCache.has(chain)) {
        const role = recordRole(chain);
        idCache.set(
          chain,
          Object.fromEntries(
            COLLECTION_IDS.map((collection) => [collection, seededId(seed, collection, role, worldId)]),
          ) as Record<CollectionId, string>,
        );
      }
      return idCache.get(chain)!;
    },
    displayName: (chain) => names[chain]!,
    bystanderToken: (chain) => identityTokens(seed, subjectOrdinal + 2_000_001 + chain, 1, worldId)[0]!,
    bystanderRecord: (chain) => seededId(seed, 'accounts', `bystander-${chain}`, worldId),
    edges: (chain) => {
      if (!edgeCache.has(chain)) {
        edgeCache.set(chain, topology(family, context.ids(chain), spec.referenceTopology.includeCycles));
      }
      return edgeCache.get(chain)!;
    },
  };
  return context;
}

function recordRole(chain: number): string {
  return chain === 0 ? 'primary' : `unrelated-${chain}`;
}

/** Visible identity bindings for one document. A wildcard identity array also gets an unrelated element. */
function identityBindings(
  context: BuildContext,
  layout: CollectionLayout,
  collection: CollectionId,
  chain: number,
): string[] {
  const { family } = context;
  const own = context.tokens(chain);
  let bindings: string[] = [];
  if (collection === 'customers') {
    bindings = [own[0]!];
  } else if (['direct_nested', 'shared_array'].includes(family)) {
    bindings = [own[COLLECTION_IDS.indexOf(collection) % own.length]!];
  } else if (collection === 'messages' && family !== 'reverse_reference' && family !== 'archive_bridge') {
    bindings = [own[2]!];
  } else if (family === 'mixed_eligibility' && collection === 'notes') {
    bindings = [own[1]!];
  }
  if (layout.identityPath.includes('*')) bindings.push(context.bystanderToken(chain));
  return bindings;
}

/** Record IDs referenced by one document, including the duplicate and unrelated array elements. */
function referenceTargets(
  context: BuildContext,
  layout: CollectionLayout,
  collection: CollectionId,
  chain: number,
): string[] {
  const related = [...context.edges(chain)[collection]];
  if (context.spec.referenceTopology.duplicateReferences && related.length) related.push(related[0]!);
  if (layout.referencePath.includes('*')) {
    related.push(context.bystanderRecord(chain));
  }
  return related;
}

function buildDocument(
  context: BuildContext,
  layout: CollectionLayout,
  collection: CollectionId,
  chain: number,
): FixtureDocument {
  const { spec, seed, family, scope, worldId } = context;
  const own = context.tokens(chain);
  // Business values derive from the record's role, not its instance ID: worlds built from one recipe are
  // isomorphic and differ only through the instance translation of identifiers.
  const businessOrdinal = Number.parseInt(
    contentHash({ seed, collection, role: recordRole(chain) }, 'synthetic-business').slice(0, 6),
    16,
  );
  const data: JsonObject = {
    displayName: context.displayName(chain),
    payload: 'synthetic private payload; contains no real customer data',
    business: {
      ordinal: businessOrdinal,
      label: `fixture-${collection}`,
      balanceUnits: businessOrdinal * 17,
      preserved: true,
    },
  };

  const bindings = identityBindings(context, layout, collection, chain);
  assignRecipePath(data, layout.identityPath, bindings.length ? bindings : [null]);

  const related = referenceTargets(context, layout, collection, chain);
  if (layout.referencePath.includes('*')) assignRecipePath(data, layout.referencePath, related);
  else assignRecipePath(data, layout.referencePath, related.length ? [related[0]!] : [null]);

  if (collection === 'customers') {
    data.aliases = own.slice(1);
    data.identity = { id: own[0]!, email: own[1]! };
  }
  return {
    _id: context.ids(chain)[collection],
    tenantId: scope.tenantId,
    env: scope.env,
    worldId,
    _rev: 1,
    data,
    eligibility: { effect: effectFor(family, collection), policyId: spec.eligibilityPolicy.id },
    access: 'open',
    lifecycle: 'active',
  };
}

/** Registry descriptors and join declarations for one collection layout. */
function describeLayout(layout: CollectionLayout): {
  fields: FieldDescriptor[];
  edges: ReferenceDeclaration[];
  identityFieldId: string;
  referenceFieldId: string;
} {
  const collection = layout.collectionId;
  const identityFieldId = `${collection}.identity_binding`;
  const referenceFieldId = `${collection}.record_reference`;
  const fields: FieldDescriptor[] = [
    {
      fieldId: `${collection}.record_id`,
      collectionId: collection,
      path: ['_id'],
      bsonTypes: ['string'],
      isArray: false,
      sanitized: true,
    },
    {
      fieldId: identityFieldId,
      collectionId: collection,
      path: ['data', ...layout.identityPath],
      bsonTypes: ['string'],
      isArray: layout.identityPath.includes('*'),
      sanitized: true,
    },
    {
      fieldId: referenceFieldId,
      collectionId: collection,
      path: ['data', ...layout.referencePath],
      bsonTypes: ['string'],
      isArray: layout.referencePath.includes('*'),
      sanitized: true,
    },
    {
      fieldId: `${collection}.private_payload`,
      collectionId: collection,
      path: ['data', 'payload'],
      bsonTypes: ['string', 'null'],
      isArray: false,
      sanitized: true,
    },
  ];
  const edges: ReferenceDeclaration[] = COLLECTION_IDS.map((target) => ({
    edgeId: `${collection}.references.${target}`,
    fromCollectionId: collection,
    fromFieldId: referenceFieldId,
    toCollectionId: target,
    toFieldId: `${target}.record_id`,
    identityRule: 'same_bson_type',
  }));
  return { fields, edges, identityFieldId, referenceFieldId };
}

/**
 * Creation position must not become an answer channel, so documents are ordered by a seeded hash of their role.
 * The key excludes the instance ID so that every instance of one recipe orders its records identically.
 */
function orderByRole(
  seed: string,
  collection: CollectionId,
  documents: Array<{ role: string; document: FixtureDocument }>,
) {
  const key = (role: string) => contentHash({ seed, collection, role }, 'fixture-order');
  return documents
    .sort((left, right) => key(left.role).localeCompare(key(right.role), 'en'))
    .map((entry) => entry.document);
}

/**
 * Generate the visible world. `binding` must come from trusted server configuration. Only
 * {tenantId, env, scopeId} is read from it; the same resolved scope key is hashed into the world ID and
 * emitted on the registry and every document, so an implicit default equals its explicit equivalent.
 */
export function generateWorld(spec: WorldSpec, seed: string, binding?: ScopeKey): VisibleWorld {
  const problems = validateWorldSpec(spec, seed);
  if (problems.length) throw new WorldSpecError(problems);
  const scope = resolveScopeKey(binding);
  let specHash: string;
  try {
    specHash = contentHash(spec, 'world-spec');
  } catch {
    throw new WorldSpecError(['noncanonical_spec']);
  }
  const worldId = worldIdFor(specHash, seed, scope);
  const family = spec.family as FixtureFamily;
  const context = createContext(spec, seed, scope, worldId);
  const collections = Object.fromEntries(COLLECTION_IDS.map((id) => [id, []])) as unknown as WorldCollections;
  const fields: FieldDescriptor[] = [];
  const referenceEdges: ReferenceDeclaration[] = [];
  const identityFieldIds: string[] = [];
  const referenceFieldIds: string[] = [];

  for (const layout of spec.collectionLayouts) {
    const collection = layout.collectionId as CollectionId;
    const described = describeLayout(layout);
    identityFieldIds.push(described.identityFieldId);
    referenceFieldIds.push(described.referenceFieldId);
    fields.push(...described.fields);
    referenceEdges.push(...described.edges);
    const built: Array<{ role: string; document: FixtureDocument }> = [];
    for (let index = 0; index < spec.unrelatedRecipes.documentsPerCollection; index++) {
      built.push({ role: recordRole(index), document: buildDocument(context, layout, collection, index) });
    }
    collections[collection] = orderByRole(seed, collection, built);
  }
  fields.push(
    {
      fieldId: 'customers.aliases',
      collectionId: 'customers',
      path: ['data', 'aliases', '*'],
      bsonTypes: ['string'],
      isArray: true,
      sanitized: true,
    },
    {
      fieldId: 'customers.identity_email',
      collectionId: 'customers',
      path: ['data', 'identity', 'email'],
      bsonTypes: ['string'],
      isArray: false,
      sanitized: true,
    },
  );

  const registry: ScopeRegistry = {
    scopeId: scope.scopeId,
    revision: 1,
    tenantId: scope.tenantId,
    env: scope.env,
    collectionIds: [...COLLECTION_IDS],
    fields,
    referenceEdges,
    allowedEffectKinds: [...spec.eligibilityPolicy.effects],
    eligibilityPolicyId: spec.eligibilityPolicy.id,
    eligibilityPolicyHash: spec.eligibilityPolicy.hash,
    documentLimits: {
      maxScanned: spec.resourceBounds.maxDocuments,
      maxChanged: spec.resourceBounds.maxDocuments,
    },
    discoveryCompleteness: {
      kind: 'declared',
      limitations: ['Controlled synthetic writers only; no unregistered external collections.'],
    },
  };
  return {
    worldId,
    specHash,
    scope: registry,
    subjectHandle: context.ids(0).customers,
    collections,
    schema: {
      identityFieldIds,
      referenceFieldIds,
      referenceExpansion: family === 'reverse_reference' ? 'outgoing' : 'incoming',
      aliasFieldId: 'customers.aliases',
      redactPayloadFieldId: 'private_payload',
    },
  };
}
