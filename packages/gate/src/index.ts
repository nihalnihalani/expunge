// Privileged evaluation service only. No worker, proposer or runtime image may import this package.
export {
  ADMISSION_RULE,
  ADMISSION_RULE_HASH,
  PLANNED_PAIRS,
  REASON_CODES,
  REASON_KINDS,
  evaluateAdmission,
  evaluateIntegrity,
  summarize,
} from './admission.js';
export type { AdmissionDecision, AdmissionInput, AdmissionSummary, ReasonCode } from './admission.js';
export { DEFAULT_CONCURRENCY, DEFAULT_GRACE_MS, planPairs, pool, runCampaign } from './campaign.js';
export { ClaimStore, candidateKeyOf, childProjectionOf, executableProjection, reportIdOf } from './claims.js';
export type { ClaimState, ClaimTicket, HeldRunRow, StoredClaim } from './claims.js';
export { FreezeStore, assertFreezeInput, budgetHashOf, freezeHashOf, profileHashOf } from './freeze.js';
export type { CampaignFreeze, FreezeInput } from './freeze.js';
export { GATE_HASH, runGate } from './gate.js';
export type { GateConfig, GateOutcome } from './gate.js';
export { CampaignKeyStore, campaignCrypto } from './keys.js';
export type { CampaignKey } from './keys.js';
export { labeler } from './labels.js';
export type { Labeler } from './labels.js';
export { PublicTrialRows } from './public-rows.js';
export {
  GATE_CONTROLS_SCHEMA,
  authorityFlipsOf,
  buildGateReport,
  pairedTrialsOf,
  reportDigestOf,
  totalCost,
} from './report.js';
export type { AdmittedUnder, ControlRow, GateControls } from './report.js';
export { GateStore } from './store.js';
export { armLabels, runArm } from './trials.js';
export {
  GATE_SPLITS,
  INFRA_FAILURE_CODES,
  INFRA_INVALID_THRESHOLD,
  NON_RESULT_OUTCOMES,
  ZERO_COST,
  addCost,
} from './types.js';
export type {
  ArmName,
  EpisodeOutcome,
  EpisodePort,
  EpisodeRequest,
  EpisodeResult,
  GateSplit,
  HarnessDefect,
  TrialArm,
  TrialRow,
  TrustedReceiptEvidence,
  WorkerProfile,
} from './types.js';
export { GraderEpisodeHost, MongoEpisodePort, readFaults, readWorld } from './mongo-port.js';
export type {
  EpisodeHost,
  MongoPortDeps,
  SeededInstance,
  WorkerRunRequest,
  WorkerRunResult,
  WorkerRunner,
} from './mongo-port.js';
