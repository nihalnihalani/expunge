import type {
  CostSummary,
  EvidenceBundle,
  EvidenceReference,
  ProjectionEvent,
  ScopeKey,
} from '@expunge/contracts';
import type { MongoService } from '@expunge/mongo';
import type { LeakGuard } from '@expunge/observability';
import { assembleEvidenceBundle, BundleError, type BundleSplit } from './bundle.js';
import type { EvidenceObservation } from './evidence.js';
import { deliveryOf } from './outbox-dispatcher.js';

/** Maximum `tool_decided` events read for one run; a longer trace is marked truncated, never silently cut. */
export const TOOL_EVENT_READ_LIMIT = 200;

/**
 * Reads the split the STORED state assigns to a run's world. Internal: the public `bundleForRun` always uses
 * `storedSplitOfJob` and accepts no resolver, so a caller can never choose the split.
 */
export type StoredSplitReader = (input: {
  service: MongoService;
  scope: ScopeKey;
  jobId: string;
  worldId: string;
}) => BundleSplit | undefined | Promise<BundleSplit | undefined>;

/**
 * The production reader. No collection holds a world's committed split yet (PKT-62 adds a read-only `splitOfJob` that the
 * observer principal can FIND), so it returns undefined and the bundle is built withheld and gate-only.
 */
export const storedSplitOfJob: StoredSplitReader = () => undefined;

/** Split label for a bundle with no stored split: the most restrictive one (values withheld, `gate_only`). */
const UNRECORDED_SPLIT: BundleSplit = 'protected';

const asInt = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export type RunBundleInput = {
  scope: ScopeKey;
  jobId: string;
  /** Optional assertion only: a value that differs from the stored split is refused (`SplitMismatch`). */
  expectedSplit?: BundleSplit;
  projectId: string;
  guard: LeakGuard;
};

/** Shared by `bundleForRun` and the FAKE test seam (`run-bundle-testing.ts`); not exported from the package index. */
export async function buildRunBundle(
  service: MongoService,
  input: RunBundleInput,
  readSplit: StoredSplitReader,
): Promise<EvidenceBundle> {
  const { scope, jobId } = input;
  const control = service.control;
  const job = await control
    .collection<{
      _id: string;
      actor: ScopeKey & { authorizationRevision: number };
      binding: EvidenceBundle['binding'];
      checkpoint: unknown;
    }>('jobs')
    .findOne({
      _id: jobId,
      'actor.tenantId': scope.tenantId,
      'actor.env': scope.env,
      'actor.scopeId': scope.scopeId,
    } as never);
  if (!job) throw new BundleError('EmptySources', 'unknown_job');
  const stored = await readSplit({ service, scope, jobId, worldId: job.binding.worldId });
  if (stored !== undefined && input.expectedSplit !== undefined && input.expectedSplit !== stored)
    throw new BundleError('SplitMismatch', 'expected_split_differs_from_stored');
  // No stored split: fail closed. The bundle is withheld and gate-only, never training-permitted.
  const split = stored ?? UNRECORDED_SPLIT;
  const outbox = await control
    .collection<{ operationId: string; status: string; payload: { eventId?: string }; attained: never }>(
      'telemetry_outbox',
    )
    .findOne({
      tenantId: scope.tenantId,
      env: scope.env,
      scopeId: scope.scopeId,
      jobId,
      kind: 'sdk_event',
    } as never);
  const eventId = outbox?.payload?.eventId;
  if (!outbox || outbox.status !== 'evidence_ready' || !eventId)
    throw new BundleError('EmptySources', 'evidence_not_ready');

  const row = await control
    .collection<EvidenceObservation & { evidenceRevision: number }>('evidence')
    .findOne(
      {
        tenantId: scope.tenantId,
        env: scope.env,
        scopeId: scope.scopeId,
        provider: 'raindrop',
        projectId: input.projectId,
        externalEventId: eventId,
      } as never,
      { sort: { evidenceRevision: -1 } },
    );
  if (!row) throw new BundleError('EmptySources', 'no_stored_evidence');
  const observation = row as EvidenceObservation;

  const events = await control
    .collection<ProjectionEvent>('projection_events')
    .find(
      {
        tenantId: scope.tenantId,
        env: scope.env,
        scopeId: scope.scopeId,
        jobId,
        kind: 'tool_decided',
      } as never,
      { sort: { sequence: 1 }, limit: TOOL_EVENT_READ_LIMIT + 1 },
    )
    .toArray();
  const truncated = events.length > TOOL_EVENT_READ_LIMIT;
  const tools = events.slice(0, TOOL_EVENT_READ_LIMIT).map((event) => {
    const p = event.payload as unknown as {
      toolId: string;
      decision: 'allow' | 'ask' | 'deny';
      ruleIds: string[];
      summary: string;
      targetCount?: number;
    };
    return {
      toolId: p.toolId,
      input: { targetCount: p.targetCount ?? 0 },
      output: { summary: p.summary },
      decision: {
        result: p.decision,
        ruleIds: p.ruleIds,
        authorizationRevision: job.actor.authorizationRevision,
      },
    };
  });

  const meter = ((job.checkpoint as { meter?: Record<string, unknown> } | null)?.meter ?? {}) as Record<
    string,
    unknown
  >;
  const cost: CostSummary = {
    modelCalls: asInt(meter.modelCalls),
    toolCalls: Math.max(tools.length, asInt(meter.toolCalls)),
    inputTokens: asInt(meter.inputTokens),
    outputTokens: asInt(meter.outputTokens),
    costMicrousd: asInt(meter.costMicrousd),
    unpricedCalls: asInt(meter.unpricedCalls),
    mongoOperations: 0,
    wallTimeMs: asInt(meter.wallTimeMs),
  };
  const source: EvidenceReference = {
    provider: 'raindrop',
    externalEventId: eventId,
    externalSignalIds: observation.event.signals.map((signal) => signal.id),
    localSourceIds: [jobId],
    origin: 'agent_self_report',
    redactionPolicy: 'expunge-observation-v1',
    retrievedAt: new Date(observation.observedAt).toISOString(),
    contentHash: observation.contentHash,
    permittedUse: split === 'train' ? 'training' : 'gate_only',
    delivery: deliveryOf(outbox.attained),
  };
  return assembleEvidenceBundle({
    evidenceId: `ev:${outbox.operationId}`,
    actor: scope,
    binding: job.binding,
    split,
    observation,
    tools,
    diagnostics: [],
    failureWitnesses: [],
    ...(observation.event.assistantOutputSha
      ? { modelOutputSha256: observation.event.assistantOutputSha }
      : {}),
    cost,
    // Constant 1 while the trace is complete; 0.5 when the 200-decision cap truncated it (no other signal is derived).
    confidence: truncated ? 0.5 : 1,
    sources: [source],
    guard: input.guard,
  });
}
