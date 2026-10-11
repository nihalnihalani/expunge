// The trusted domain gateway: the nine typed, job-bound worker tools, their decision pipeline and the owner-policy
// effects they commit. Read docs in packages/domain/README.md for the semantics.
export { WORKER_TOOL_IDS, type WorkerToolId } from '@expunge/baselines';
export { createDomainEnv, GATEWAY_PRINCIPALS, type DomainEnv, type DomainReport } from './env.js';
export { createDomainToolProvider } from './provider.js';
export { JobGateway, TOOL_SPECS } from './gateway.js';
export { ToolRefusal, type RunIdentity, type ToolRuntime } from './runtime.js';
export { RunContext } from './context.js';
export { DomainStore } from './store.js';
export { IdentityEdgeRepository } from './edge-repository.js';
export { batchesOf, planHashOf, MAX_BATCH_DOCUMENTS } from './plan.js';
export { recordEffectFor } from './record-effects.js';
export { sweepRegisteredScope, heldBindings, effectCarriedOut, type SweepOutcome } from './sweep.js';
export { computeClosure, type ClosureMember } from './closure.js';
export { classifyFields, visibleFields, type FieldRole } from './fields.js';

export { inspectScope, inspectScopeInput } from './tools/inspect-scope.js';
export { resolveSubject, resolveSubjectInput } from './tools/resolve-subject.js';
export { discoverReferences, discoverReferencesInput } from './tools/discover-references.js';
export { previewCleanup, previewCleanupInput } from './tools/preview-cleanup.js';
export { applyCleanupBatch, applyCleanupBatchInput, prepareApply } from './tools/apply-cleanup-batch.js';
export { verifyRegisteredScope, verifyRegisteredScopeInput } from './tools/verify-registered-scope.js';
export { completeCleanup, completeCleanupInput } from './tools/complete-cleanup.js';
export { inspectHarness, inspectHarnessInput } from './tools/inspect-harness.js';
export { reportDiagnostic, reportDiagnosticInput } from './tools/report-diagnostic.js';
export * from './service/index.js';
export {
  faultPlanHash,
  storedFaultPlan,
  InMemoryFaultSource,
  MongoFaultSource,
  type FaultPlan,
  type FaultSource,
  type StoredFaultPlan,
} from './faults.js';
