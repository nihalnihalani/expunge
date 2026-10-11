/** Development-side visible fixtures only. Runtime images must exclude both fixture and grader packages. */
export type {
  JsonValue,
  JsonObject,
  CollectionId,
  FixtureFamily,
  FixtureDocument,
  FixtureOptions,
  WorldCollections,
  VisibleWorld,
  DocumentAddress,
  ExpectedEffect,
} from './types.js';
export { COLLECTION_IDS, FAMILIES, cloneWorld, addressKey } from './types.js';
export {
  createWorldSpec,
  validateWorldSpec,
  seedCommitment,
  FIXTURE_GENERATOR_VERSION,
  FIXTURE_GENERATOR_HASH,
  FIXTURE_BOUNDS,
  ELIGIBILITY_POLICY_ID,
  ELIGIBILITY_POLICY_HASH,
} from './recipes.js';
export { generateWorld, WorldSpecError } from './generator.js';
export type { GenerateOptions } from './generator.js';
export { DEFAULT_SCOPE_KEY, resolveScopeKey, worldIdFor, deriveWorldScopeKey } from './scope.js';
export { valuesAtPath, isRecipePath, RECIPE_PATH_MAX_SEGMENTS } from './paths.js';
export { structuralSignature, publicSplitCommitment } from './splits.js';
