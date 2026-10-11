/** Privileged evaluation service only. No runtime tool may import or expose this package. */
export {
  referenceSolve,
  applyReferenceAction,
  runReference,
  REFERENCE_SOLVER_VERSION,
  REFERENCE_SOLVER_HASH,
} from './reference.js';
export type { ReferencePlan } from './reference.js';
export {
  INDEXED_SOLVER_HASH,
  INDEXED_SOLVER_VERSION,
  plansAgree,
  referenceSolveIndexed,
} from './reference2.js';
export type { IndexedPlan } from './reference2.js';
export {
  gradeWorld,
  admitWorld,
  publicAdmissionVerdict,
  publicGradeReport,
  aggregateGradeReports,
  MIN_AGGREGATE_RUNS,
  EVALUATOR_VERSION,
  EVALUATOR_HASH,
} from './grade.js';
export type {
  AdmitOptions,
  GradeEvidence,
  GradeReport,
  PublicGradeReport,
  CampaignAggregate,
  ReportSplit,
  Admission,
  AdmissionVerdict,
} from './grade.js';
export { FaultSession, InjectedFault, runReferenceWithFaults } from './faults.js';
export type { FaultCode, SimulatedReceipt } from './faults.js';
