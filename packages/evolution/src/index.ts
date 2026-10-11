export { EVIDENCE_ARMS, EvidenceNotPermitted, buildEvidencePacket } from './evidence.js';
export type { EvidenceArm, EvidenceItem, EvidencePacket } from './evidence.js';
export {
  PROPOSAL_JSON_SCHEMA,
  buildProposalPrompt,
  createStructuredEvolverModel,
  proposalSchema,
  toTypedPatch,
} from './model.js';
export type {
  EvolverModel,
  ModelProposal,
  ProposalRequest,
  ProposedPatch,
  StructuredClient,
} from './model.js';
export { createLabeledFakeEvolverModel, diagnose } from './fake-model.js';
export type { FakeMode } from './fake-model.js';
export {
  REPLAY_STATEMENT,
  ReplayScopeMissing,
  attributingEvidence,
  changedGuardrails,
  replayCandidate,
} from './replay.js';
export type { ReplayFlip, ReplayReport, ReplayScope, Sample, SampleCounts, Verdict } from './replay.js';
export { compileAndReplay, evidenceLevelOf, isGoodCandidate, proposeCandidate } from './propose.js';
export type {
  CandidateProposal,
  EvidenceLevel,
  ProposalRecord,
  ProposalStatus,
  ProposeInput,
} from './propose.js';
export { pruneRules, retestAccumulated } from './critic.js';
export type { PruneResult, RuleMarginal } from './critic.js';
export { DEFAULT_BUDGET, ROUND_DIGEST, runControlledRounds, runEvolutionRound } from './search.js';
export type { LoserRecord, RoundResult, SearchBudget } from './search.js';
