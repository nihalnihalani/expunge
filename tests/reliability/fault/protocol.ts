/**
 * Shared types and the intent builder for the E1 worker fault-injection harness.
 *
 * The harness runs the PRODUCT's Dispatcher, JobRepository, EffectRepository and ProjectionRepository in child
 * processes against a real local replica set. Stand-ins are labeled: the model is FakeChatModel (scripted), the tool
 * provider is FakeToolProvider and the single tool performs a real fenced effect through EffectRepository.commitEffect.
 * Faults are injected from outside the product, by wrapping the repository methods the Dispatcher calls and the tool
 * body at named points; no product code carries a failpoint.
 */
import type { ActionIntent, Environment } from '@expunge/contracts';
import { deriveArgsDigest, deriveDecisionId, deriveEffectKey, deriveTargetHash } from '@expunge/mongo';

export type FaultAction = 'kill' | 'stop' | 'exit';
export type FaultSpec = {
  /** Point name, e.g. `before-effect`, `after-commit-before-ack`, `before-finish`, `after-claim`, `before-projection`. */
  point: string;
  action: FaultAction;
  /** Fire on the n-th time the point is reached (default 1). */
  nth?: number;
  /** Exit code for `exit`. */
  code?: number;
};

export type ChildConfig = {
  uri: string;
  worldDb: string;
  controlDb: string;
  privateDb: string;
  jobId: string;
  harnessHash: string;
  workerId: string;
  leaseMs: number;
  scope: { tenantId: string; env: Environment; scopeId: string };
  /** `run`: claim and run the named job directly. `poll`: rely on the dispatcher's recovery poll to find it. */
  mode: 'run' | 'poll';
  faults: FaultSpec[];
  /** Milliseconds a `poll` child waits for a result before giving up. */
  pollTimeoutMs?: number;
};

export type ChildEvent =
  | { event: 'ready'; pid: number; workerId: string }
  | { event: 'point'; name: string; n: number; pid: number }
  | { event: 'effect'; receiptId: string; replayed: boolean }
  | { event: 'repaired'; count: number }
  | { event: 'tool-error'; message: string }
  | { event: 'result'; outcome: string; errorCode?: string; reason?: string }
  | { event: 'fatal'; message: string };

/** The one effect the harness tool commits: the same logical effect for a job, whoever runs it. */
export function buildIntent(jobId: string, harnessHash: string): ActionIntent {
  const base = {
    jobId,
    runId: `run-${jobId}`,
    harnessHash,
    stepId: 'delete',
    approvedPlanHash: 'a'.repeat(64),
    batchOrdinal: 0,
    targetAddresses: [],
    effectKind: 'delete' as const,
  };
  const argsDigest = deriveArgsDigest(base);
  const policyDecision = { result: 'allow' as const, ruleIds: [], authorizationRevision: 1 };
  return {
    intentId: `intent-call-1-${base.stepId}-${base.batchOrdinal}-${jobId}`,
    ...base,
    targetHash: deriveTargetHash(base.targetAddresses),
    expectedDocumentVersions: [],
    worldRevision: 0,
    policyDecision,
    effectKey: deriveEffectKey(base),
    argsDigest,
    decisionId: deriveDecisionId({ ...base, argsDigest, policyDecision }),
  };
}
