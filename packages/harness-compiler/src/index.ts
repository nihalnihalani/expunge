// C2 work in progress (PARTIAL): only the trusted vocabulary and its source commitment exist so far.
// The compiler proper (guardrail compilation, workflow analysis, mutation classes) lands in the resumed C2 task.
export {
  ARTIFACT_PRODUCER,
  BINDING_ID_SET,
  FACTS_BY_ID,
  IDENTIFIER_FORMAT,
  LOOP_NODE_MAX_VISITS,
  MAX_EDITS,
  TOOL_ID_SET,
  VOCABULARY_HASH,
  comparatorsFor,
  enumDomainsOf,
  sameEnumDomain,
} from './vocabulary.js';
export type { FactSpec, FactType, OperandType } from './vocabulary.js';
export { sourceCommitment } from './source.js';
