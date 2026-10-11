import type {
  ActorContext,
  Job,
  JobKind,
  JobPhase,
  JobStatus,
  ProjectionEvent,
  ScopeKey,
} from '@expunge/contracts';
import { ProtocolError, projectionStreamId } from '@expunge/mongo';
import type { Filter } from 'mongodb';
import type { DomainEnv } from '../env.js';
import type { ServiceConfig } from './config.js';
import { ServiceRefusal } from './errors.js';

/**
 * The read projection the operator renders: a job SNAPSHOT, ordered EVENT PAGES and a JOB LIST, all from committed state,
 * under the read principal and the owner scope the service is bound to by configuration. Nothing here takes a tenant,
 * actor or role from a request. Shapes are exactly what `apps/operator/src/server/expunge/schemas.ts` parses.
 *
 * What the snapshot is: the job row (status, binding, cancellation, checkpoint meter) folded with the job's COMMITTED
 * projection events up to a bounded number, so `sequence` names exactly the last event reflected and the client pages on
 * from it. A field with no committed source is empty or zero; it is never guessed. `subject` is not served yet (optional for
 * the operator); `artifacts` lists only the kinds `artifacts.ts` can serve (completion receipts).
 */
export const MAX_PAGE_EVENTS = 500;
const SNAPSHOT_FOLD_PAGES = 10;
export const MAX_LIST_ITEMS = 200;
const SAFE_CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

const PHASES: readonly JobPhase[] = [
  'inspect',
  'resolve',
  'discover',
  'preview',
  'apply',
  'verify',
  'complete',
];
const JOB_KINDS: readonly JobKind[] = [
  'cleanup',
  'observe',
  'propose',
  'evaluate',
  'promote',
  'rollback',
  'redact',
  'external_delete',
  'adversarial_generate',
  'meta_evaluate',
];
const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'waiting_evidence',
  'waiting_approval',
  'waiting_external',
  'succeeded',
  'failed',
  'cancelled',
];
type PhaseState = 'pending' | 'active' | 'committed' | 'skipped' | 'failed';

const iso = (value: Date | string | undefined): string => new Date(value ?? 0).toISOString();
const asInt = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

async function readActor(env: DomainEnv, config: ServiceConfig): Promise<ActorContext> {
  const stored = await env.authority.read(config.owner.scope).catch((error: unknown) => {
    if (error instanceof ProtocolError && error.code === 'AuthorityMissing')
      throw new ServiceRefusal(503, 'scope_not_authorized');
    throw error;
  });
  return {
    ...config.owner.scope,
    actorId: config.owner.ownerId,
    authorizationRevision: stored.authorizationRevision,
  };
}

/** The job, or a 404 for a job that does not exist or belongs to another scope (the two are indistinguishable). */
async function readJob(env: DomainEnv, config: ServiceConfig, jobId: string): Promise<Job> {
  const actor = await readActor(env, config);
  try {
    return await env.jobs.readAuthorized(actor, jobId);
  } catch (error) {
    if (error instanceof ProtocolError || (error instanceof Error && error.message === 'UnauthorizedJob'))
      throw new ServiceRefusal(404, 'not_found');
    throw error;
  }
}

/** The wire form of one stored event: exactly the envelope fields the operator parses. */
const wireEvent = (event: ProjectionEvent) => ({
  eventId: event.eventId,
  sequence: event.sequence,
  jobId: event.jobId,
  runId: event.runId,
  kind: event.kind,
  artifactIds: event.artifactIds,
  payload: event.payload,
});

/** GET .../jobs/:jobId/events?afterSequence=N&limit=M, from ONE epoch, in sequence order, bounded. */
export async function readEventsPage(
  env: DomainEnv,
  config: ServiceConfig,
  jobId: string,
  afterSequence: number,
  limit: number,
): Promise<{ events: ReturnType<typeof wireEvent>[]; nextSequence: number; streamEpoch?: string }> {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
    throw new ServiceRefusal(400, 'invalid_request');
  const bounded = Math.min(MAX_PAGE_EVENTS, Math.max(1, Math.trunc(limit)));
  await readJob(env, config, jobId);
  const page = await env.projections.readPage(config.owner.scope, afterSequence, jobId, bounded);
  const events = page.events.map(wireEvent);
  return {
    events,
    nextSequence: events.at(-1)?.sequence ?? afterSequence,
    ...(page.streamEpoch ? { streamEpoch: page.streamEpoch } : {}),
  };
}

const PHASE_OF_TOOL: Record<string, JobPhase> = {
  inspect_scope: 'inspect',
  resolve_subject: 'resolve',
  discover_references: 'discover',
  preview_cleanup: 'preview',
  apply_cleanup_batch: 'apply',
  verify_registered_scope: 'verify',
  complete_cleanup: 'complete',
};

type Fold = {
  sequence: number;
  phase: JobPhase | null;
  phaseStates: Record<JobPhase, PhaseState>;
  changedDocuments: number;
  cancelRequestedAt: string | null;
  evidence: { outboxState: string | null; evidenceReady: boolean; truncated: boolean };
  approval: { state: string; proposalId: string | null; expiresAt: string | null };
  externalErasure: { status: string; providerStatus: string | null; dueBy: string | null } | null;
  failedPhase: JobPhase | null;
  /** Artifacts this service can serve (`GET artifacts/{id}`), in the order they were committed. */
  artifacts: Array<{ artifactId: string; kind: 'completion_receipt'; committedAtSequence: number }>;
};

function foldEvents(events: readonly ProjectionEvent[]): Fold {
  const fold: Fold = {
    sequence: 0,
    phase: null,
    phaseStates: Object.fromEntries(PHASES.map((p) => [p, 'pending'])) as Record<JobPhase, PhaseState>,
    changedDocuments: 0,
    cancelRequestedAt: null,
    evidence: { outboxState: null, evidenceReady: false, truncated: false },
    approval: { state: 'none', proposalId: null, expiresAt: null },
    externalErasure: null,
    failedPhase: null,
    artifacts: [],
  };
  for (const event of events) {
    fold.sequence = event.sequence;
    const p = event.payload as Record<string, unknown>;
    switch (event.kind) {
      case 'tool_decided': {
        const phase = (PHASE_OF_TOOL[String(p.toolId)] ?? p.phase) as JobPhase | undefined;
        if (!phase || !PHASES.includes(phase)) break;
        fold.phase = phase;
        if (p.decision === 'allow') fold.phaseStates[phase] = 'committed';
        else if (p.decision === 'ask') fold.phaseStates[phase] = 'active';
        else if (fold.phaseStates[phase] !== 'committed') fold.phaseStates[phase] = 'failed';
        break;
      }
      case 'effect_committed':
        fold.phaseStates.apply = 'committed';
        fold.changedDocuments += asInt(p.appliedCount);
        break;
      case 'receipt_committed':
        if (typeof p.receiptId === 'string' && fold.artifacts.length < 200)
          fold.artifacts.push({
            artifactId: p.receiptId,
            kind: 'completion_receipt',
            committedAtSequence: event.sequence,
          });
        break;
      case 'evidence_ready':
        fold.evidence = {
          outboxState: typeof p.outboxState === 'string' ? p.outboxState : null,
          evidenceReady: p.outboxState === 'evidence_ready',
          truncated: p.truncated === true,
        };
        break;
      case 'approval_required':
        fold.approval = {
          state: 'pending',
          proposalId: String(p.proposalId ?? ''),
          expiresAt: typeof p.expiresAt === 'string' ? p.expiresAt : null,
        };
        break;
      case 'approval_resolved':
        fold.approval = { ...fold.approval, state: String(p.decision ?? 'none') };
        break;
      case 'cancel_requested':
        fold.cancelRequestedAt = typeof p.requestedAt === 'string' ? p.requestedAt : null;
        break;
      case 'external_erasure_updated': {
        const provider = typeof p.providerStatus === 'string' ? p.providerStatus : null;
        fold.externalErasure = {
          status:
            provider === 'completed'
              ? 'confirmed'
              : provider === 'rejected'
                ? 'failed'
                : provider === 'cancelled'
                  ? 'not_required'
                  : 'pending',
          providerStatus: provider,
          dueBy: typeof p.dueBy === 'string' ? p.dueBy : null,
        };
        break;
      }
      case 'job_failed':
        fold.failedPhase =
          typeof p.phase === 'string' && PHASES.includes(p.phase as JobPhase)
            ? (p.phase as JobPhase)
            : fold.phase;
        break;
      default:
        break;
    }
  }
  return fold;
}

/** GET .../jobs/:jobId: the job row folded with its committed events (bounded), plus the committed receipt reference. */
export async function readSnapshot(env: DomainEnv, config: ServiceConfig, jobId: string) {
  const job = await readJob(env, config, jobId);
  const scope = config.owner.scope;
  const events: ProjectionEvent[] = [];
  let epoch: string | null = null;
  for (let page = 0, after = 0; page < SNAPSHOT_FOLD_PAGES; page++) {
    const result = await env.projections.readPage(scope, after, jobId, MAX_PAGE_EVENTS);
    epoch = result.streamEpoch;
    events.push(...result.events);
    if (result.events.length < MAX_PAGE_EVENTS) break;
    after = result.events.at(-1)!.sequence;
  }
  const fold = foldEvents(events);
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(job.status);
  if (job.status === 'succeeded')
    for (const phase of PHASES)
      if (fold.phaseStates[phase] === 'pending') fold.phaseStates[phase] = 'skipped';
  if (job.status === 'failed' && fold.failedPhase && fold.phaseStates[fold.failedPhase] !== 'committed')
    fold.phaseStates[fold.failedPhase] = 'failed';

  const receipt = await env.projections.receiptReference(scope, jobId);
  const world = await env.worlds.read(scope, job.binding.worldId).catch(() => null);
  const registry = await env.scopes.read(scope, job.binding.scopeRevision).catch(() => null);
  const completion = receipt
    ? await env.service.control
        .collection<{ inspectedCollectionIds?: string[]; discoveredFieldIds?: string[] }>(
          'completion_receipts',
        )
        .findOne({ _id: receipt.receiptId } as never)
        .catch(() => null)
    : null;
  const deployment = await env.service.control
    .collection<{ activeHash: string; revision: number }>('deployments')
    .findOne({ tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, target: 'worker' } as never)
    .catch(() => null);
  const bundle = await env.artifacts.read(job.binding.harnessHash).then(
    (e) => e.payload,
    () => null,
  );

  // Durable control state: the gateway's own call and discovery rows, the source of truth for what a job has spent.
  const steps = env.service.control.collection<{ kind: string; payload: Record<string, unknown> }>(
    'domain_steps',
  );
  const stepFilter = (kind: string) =>
    ({ tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, jobId, kind }) as Filter<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
  const toolCalls = await steps.countDocuments(stepFilter('call'));
  const discoveries = await steps
    .find(stepFilter('discovery'), { sort: { ordinal: 1 }, limit: 200 })
    .toArray();
  const scanned = discoveries.reduce((sum, row) => sum + asInt(row.payload.scannedDocuments), 0);
  const depth = discoveries.reduce((max, row) => Math.max(max, asInt(row.payload.depth)), 0);
  const selected = (discoveries.at(-1)?.payload.selected as Array<{ via?: string }> | undefined) ?? [];
  const edges = selected.filter((s) => typeof s.via === 'string' && s.via.startsWith('edge:')).length;
  const truncated = discoveries.at(-1)?.payload.truncated === true;

  const meter = ((job.checkpoint as { meter?: Record<string, unknown> } | null)?.meter ?? {}) as Record<
    string,
    unknown
  >;
  const limits = bundle?.limits;
  const counter = (used: number, cap: unknown) => ({ used, cap: asInt(cap) });
  const tokens = asInt(meter.inputTokens) + asInt(meter.outputTokens);

  return {
    schemaVersion: 2 as const,
    jobId: job._id,
    kind: job.kind,
    status: job.status,
    sequence: fold.sequence,
    ...(epoch ? { streamEpoch: epoch } : {}),
    runId: job.binding.runId,
    ...(deployment && deployment.activeHash === job.binding.harnessHash
      ? { harness: { hash: job.binding.harnessHash, parentHash: null, activeRevision: deployment.revision } }
      : {}),
    scope: { scopeId: scope.scopeId, scopeRevision: job.binding.scopeRevision, env: scope.env },
    ...(world
      ? {
          world: { worldId: world.worldId, revision: world.revision, maintenanceMode: world.maintenanceMode },
        }
      : {}),
    phase: terminal ? null : fold.phase,
    phaseStates: fold.phaseStates,
    cancellation: {
      requested: job.cancellationRequested,
      requestedAt: job.cancellationRequested ? fold.cancelRequestedAt : null,
    },
    coverage: {
      registeredCollectionIds: registry?.collectionIds ?? [],
      inspectedCollectionIds: completion?.inspectedCollectionIds ?? [],
      discoveredFieldIds: completion?.discoveredFieldIds ?? [],
      completeness: registry?.discoveryCompleteness.kind ?? 'declared',
      limitations: registry?.discoveryCompleteness.limitations ?? [],
    },
    limits: {
      modelCalls: counter(asInt(meter.modelCalls), limits?.modelCalls),
      toolCalls: counter(toolCalls, limits?.toolCalls),
      scannedDocuments: counter(scanned, limits?.scannedDocuments),
      changedDocuments: counter(fold.changedDocuments, limits?.changedDocuments),
      traversalDepth: counter(depth, limits?.traversalDepth),
      graphNodes: counter(selected.length, limits?.graphNodes),
      graphEdges: counter(edges, limits?.graphEdges),
      wallTimeMs: counter(asInt(meter.wallTimeMs), limits?.wallTimeMs),
      totalTokens: counter(tokens, limits?.totalTokens),
      costMicrousd: counter(asInt(meter.costMicrousd), limits?.maxCostMicrousd),
      unpricedCalls: asInt(meter.unpricedCalls),
    },
    graph: {
      artifactId: null,
      nodeCount: selected.length,
      edgeCount: edges,
      truncated,
      byState: {
        discovered: selected.length,
        inspected: 0,
        previewed: 0,
        applied: fold.changedDocuments,
        retained: 0,
        excluded: 0,
        residual: 0,
        not_inspected: 0,
      },
    },
    evidence: fold.evidence,
    approval: fold.approval,
    receipt: receipt ? { receiptId: receipt.receiptId, sequence: receipt.receiptSequence } : null,
    artifacts: fold.artifacts,
    externalErasure: fold.externalErasure,
    cost: {
      modelCalls: asInt(meter.modelCalls),
      toolCalls,
      inputTokens: asInt(meter.inputTokens),
      outputTokens: asInt(meter.outputTokens),
      costMicrousd: asInt(meter.costMicrousd),
      unpricedCalls: asInt(meter.unpricedCalls),
      mongoOperations: 0,
      wallTimeMs: asInt(meter.wallTimeMs),
    },
    updatedAt: iso(job.updatedAt),
  };
}

type Cursor = { updatedAtMs: number; jobId: string };
const encodeCursor = (job: Job): string =>
  Buffer.from(JSON.stringify([new Date(job.updatedAt).getTime(), job._id])).toString('base64url');
function decodeCursor(raw: string | null): Cursor | null {
  if (raw === null) return null;
  if (!SAFE_CURSOR.test(raw)) throw new ServiceRefusal(400, 'invalid_request');
  try {
    const [updatedAtMs, jobId] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as [
      unknown,
      unknown,
    ];
    if (!Number.isSafeInteger(updatedAtMs) || typeof jobId !== 'string' || jobId.length > 128)
      throw new Error('shape');
    return { updatedAtMs: updatedAtMs as number, jobId };
  } catch {
    throw new ServiceRefusal(400, 'invalid_request');
  }
}

/**
 * GET .../jobs?cursor&limit&kind&status: newest first by last update, bounded pages. Receipt fields (`receiptId`,
 * `receiptSequence`, `verifiedWorldRevision`, `receiptDomainStatus`) are present only for a job with a COMMITTED receipt.
 */
export async function listJobs(
  env: DomainEnv,
  config: ServiceConfig,
  query: { cursor: string | null; limit: number; kind: string | null; status: string | null },
) {
  const scope: ScopeKey = config.owner.scope;
  if (query.kind !== null && !JOB_KINDS.includes(query.kind as JobKind))
    throw new ServiceRefusal(400, 'invalid_request');
  if (query.status !== null && !JOB_STATUSES.includes(query.status as JobStatus))
    throw new ServiceRefusal(400, 'invalid_request');
  const limit = Math.min(MAX_LIST_ITEMS, Math.max(1, Math.trunc(query.limit)));
  const cursor = decodeCursor(query.cursor);
  const filter: Record<string, unknown> = {
    'actor.tenantId': scope.tenantId,
    'actor.env': scope.env,
    'actor.scopeId': scope.scopeId,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(cursor
      ? {
          $or: [
            { updatedAt: { $lt: new Date(cursor.updatedAtMs) } },
            { updatedAt: new Date(cursor.updatedAtMs), _id: { $lt: cursor.jobId } },
          ],
        }
      : {}),
  };
  const rows = await env.service.control
    .collection<Job>('jobs')
    .find(filter as never, { sort: { updatedAt: -1, _id: -1 }, limit: limit + 1 })
    .toArray();
  const page = rows.slice(0, limit);
  const items = [];
  for (const job of page) {
    const [receipt, sequenceRow] = await Promise.all([
      env.projections.receiptReference(scope, job._id),
      env.service.control
        .collection<{ _id: string; sequence?: number }>('projection_sequences')
        .findOne({ _id: projectionStreamId(scope, job._id) }, { projection: { sequence: 1 } }),
    ]);
    const completion = receipt
      ? await env.service.control
          .collection<{ domainStatus?: string }>('completion_receipts')
          .findOne({ _id: receipt.receiptId } as never)
      : null;
    items.push({
      jobId: job._id,
      kind: job.kind,
      status: job.status,
      sequence: asInt(sequenceRow?.sequence),
      worldId: job.binding.worldId,
      harnessHash: job.binding.harnessHash,
      ...(receipt
        ? {
            receiptId: receipt.receiptId,
            receiptSequence: receipt.receiptSequence,
            verifiedWorldRevision: receipt.verifiedWorldRevision,
            ...(completion?.domainStatus === 'complete_in_registered_scope' ||
            completion?.domainStatus === 'incomplete'
              ? { receiptDomainStatus: completion.domainStatus }
              : {}),
          }
        : {}),
      updatedAt: iso(job.updatedAt),
    });
  }
  return { items, nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null };
}

const intParam = (raw: string | null, fallback: number, name: string): number => {
  if (raw === null) return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new ServiceRefusal(400, 'invalid_request');
  void name;
  return Number(raw);
};

/**
 * The three read routes behind one entry point, so the HTTP handler only has to route to it. `key` is the handler's route
 * family (`GET jobs` with or without an id, or `GET events`); the id has already passed the handler's safe-id check.
 * Unknown query parameters are refused, so a client cannot smuggle a scope or an actor through the query string.
 */
export async function serveProjection(
  env: DomainEnv,
  config: ServiceConfig,
  route: { key: 'GET jobs' | 'GET events'; id?: string },
  url: URL,
): Promise<{ status: 200; body: unknown }> {
  const allowed =
    route.key === 'GET events'
      ? ['afterSequence', 'limit']
      : route.id
        ? []
        : ['cursor', 'limit', 'kind', 'status'];
  for (const name of url.searchParams.keys())
    if (!allowed.includes(name)) throw new ServiceRefusal(400, 'invalid_request');
  const params = url.searchParams;
  if (route.key === 'GET events')
    return {
      status: 200,
      body: await readEventsPage(
        env,
        config,
        route.id!,
        intParam(params.get('afterSequence'), 0, 'afterSequence'),
        intParam(params.get('limit'), MAX_PAGE_EVENTS, 'limit'),
      ),
    };
  if (route.id) return { status: 200, body: await readSnapshot(env, config, route.id) };
  return {
    status: 200,
    body: await listJobs(env, config, {
      cursor: params.get('cursor'),
      limit: intParam(params.get('limit'), 50, 'limit'),
      kind: params.get('kind'),
      status: params.get('status'),
    }),
  };
}
