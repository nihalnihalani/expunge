// The trusted vocabulary the compiler enforces. The values are the human-authored primitives disclosed by
// `@expunge/baselines`; this module resolves them into lookup tables and commits to them by value and by source.
import {
  BINDING_IDS,
  BINDING_STATUSES,
  COMPARATORS_BY_TYPE,
  ENUM_DOMAINS,
  FACT_CATALOG,
  FORBIDDEN_ROUTE_TOKENS,
  PATCH_PATHS,
  WORKER_TOOL_IDS,
  WORKFLOW_INPUT_SOURCES,
  type FactSpec,
  type FactType,
} from '@expunge/baselines';
import { contentHash } from '@expunge/contracts';
import { sourceCommitment } from './source.js';

export { WORKER_TOOL_IDS, BINDING_IDS, FORBIDDEN_ROUTE_TOKENS };
export type { FactSpec, FactType };

export const FACTS_BY_ID: ReadonlyMap<string, FactSpec> = new Map(
  FACT_CATALOG.map((fact) => [fact.id, fact]),
);
export const TOOL_ID_SET: ReadonlySet<string> = new Set(WORKER_TOOL_IDS);
export const BINDING_ID_SET: ReadonlySet<string> = new Set(BINDING_IDS);
export const BINDING_STATUS_VALUES: readonly string[] = BINDING_STATUSES;

/** The static type of one operand: a number, a boolean, or an enum with a closed set of members. */
export type OperandType =
  { kind: 'number' } | { kind: 'boolean' } | { kind: 'enum'; values: readonly string[] };

export function comparatorsFor(type: OperandType): readonly string[] {
  return COMPARATORS_BY_TYPE[type.kind];
}
export function sameEnumDomain(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
/** Enum domains an enumerated constant can belong to, for constant-vs-constant analysis. */
export function enumDomainsOf(value: string): string[] {
  return Object.entries(ENUM_DOMAINS)
    .filter(([, members]) => (members as readonly string[]).includes(value))
    .map(([name]) => name);
}

/** Largest number of visits any node on a cycle may declare. Larger values are treated as unbounded loops. */
export const LOOP_NODE_MAX_VISITS = 8;
/** At most this many independently justified edits per candidate (docs/expunge/ACCEPTANCE.md). */
export const MAX_EDITS = 3;
/** Producer of each prerequisite artifact: a tool cannot depend on an artifact only it can create. */
export const ARTIFACT_PRODUCER: Readonly<Record<string, string | null>> = {
  preview_plan: 'preview_cleanup',
  action_receipt: 'apply_cleanup_batch',
  completion_receipt: 'verify_registered_scope',
  approval_grant: null,
};
export const PATCH_PATH_TABLE = PATCH_PATHS;
export const WORKFLOW_INPUT_SOURCE_TABLE = WORKFLOW_INPUT_SOURCES;

/** Free identifiers (rule IDs, node IDs, module IDs, export names) are lowercase snake_case, bounded. */
export const IDENTIFIER_FORMAT = /^[a-z][a-z0-9_]{0,63}$/;

/** The resolved vocabulary by value, so the hash changes when a primitive changes even if no byte of this file does. */
const RESOLVED = {
  tools: WORKER_TOOL_IDS,
  facts: FACT_CATALOG,
  bindings: BINDING_IDS,
  statuses: BINDING_STATUSES,
  comparators: COMPARATORS_BY_TYPE,
  enums: ENUM_DOMAINS,
  inputSources: WORKFLOW_INPUT_SOURCES,
  forbiddenRouteTokens: FORBIDDEN_ROUTE_TOKENS,
  patchPaths: PATCH_PATHS,
  loopNodeMaxVisits: LOOP_NODE_MAX_VISITS,
  maxEdits: MAX_EDITS,
  artifactProducer: ARTIFACT_PRODUCER,
};
export const VOCABULARY_HASH = contentHash(
  {
    resolved: RESOLVED,
    sources: sourceCommitment(
      ['vocabulary.ts', '../../baselines/src/primitives.ts', '../../contracts/src/index.ts'],
      'harness-vocabulary-source',
    ),
  },
  'harness-vocabulary',
);
