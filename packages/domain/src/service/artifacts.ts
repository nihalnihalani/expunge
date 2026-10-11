import {
  contentHash,
  deploymentIdentity,
  type ActionReceipt,
  type CompletionReceipt,
  type DeploymentKey,
  type MutationClass,
  type PromotionReceipt,
  type ScopeKey,
  type TargetKind,
} from '@expunge/contracts';
import type { DomainEnv } from '../env.js';
import type { ServiceConfig } from './config.js';
import { ServiceRefusal } from './errors.js';

/**
 * Committed, immutable artifacts and the deployment view, read for the operator under the read principal and the
 * configured owner scope. Shapes are what `apps/operator/src/server/expunge/schemas.ts` parses.
 *
 * Served today: the COMPLETION RECEIPT artifact (`GET artifacts/{receiptId}`) and the DEPLOYMENT view
 * (`GET deployments/{target}`). Not served yet, because the packets that define their stored form have not landed:
 * gate reports, candidates, evidence bundles, campaigns, retractions, approval descriptors (`proposals/{id}`), graph pages,
 * record details and model narratives. An id that is not a receipt of this scope is a 404, never a guess.
 */
const TARGETS: readonly TargetKind[] = ['worker', 'improver', 'hider'];
const MAX_ACTION_RECEIPTS = 200;
const MAX_VERSIONS = 100;
/** MongoDB `Unauthorized` (code 13) or the driver's name for it. */
const isUnauthorized = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { code?: unknown }).code === 13 ||
    (error as { codeName?: unknown }).codeName === 'Unauthorized');

/** The operator schema allows at most 50 refused rollbacks per deployment. */
const MAX_REFUSED_ROLLBACKS = 50;
const iso = (value: Date | string | undefined): string => new Date(value ?? 0).toISOString();

type StoredReceipt = CompletionReceipt & { _id: string; actor: ScopeKey; createdAt: Date };

/** GET .../artifacts/{id}: a completion receipt of this scope, with its registered coverage and committed effect counts. */
export async function readArtifact(env: DomainEnv, config: ServiceConfig, artifactId: string) {
  const scope = config.owner.scope;
  const stored = await env.service.control
    .collection<StoredReceipt>('completion_receipts')
    .findOne({ _id: artifactId } as never);
  // Another scope's receipt and a missing one are indistinguishable.
  if (
    !stored ||
    stored.actor.tenantId !== scope.tenantId ||
    stored.actor.env !== scope.env ||
    stored.actor.scopeId !== scope.scopeId
  )
    throw new ServiceRefusal(404, 'not_found');
  const { _id: _id, actor: _actor, createdAt, ...receipt } = stored;
  const registry = await env.scopes.read(scope, receipt.scopeRevision).catch(() => null);
  const actions = await env.service.control
    .collection<ActionReceipt & { _id: string }>('action_receipts')
    .find({ jobId: receipt.jobId, runId: receipt.runId } as never, {
      sort: { resultingWorldRevision: 1, _id: 1 },
      limit: MAX_ACTION_RECEIPTS,
      projection: { receiptId: 1, appliedEffects: 1 },
    })
    .toArray();
  const effectCounts: Record<string, number> = {};
  for (const action of actions)
    for (const effect of action.appliedEffects)
      effectCounts[effect.kind] = (effectCounts[effect.kind] ?? 0) + 1;
  const event = await env.service.control.collection<{ sequence: number }>('projection_events').findOne(
    {
      tenantId: scope.tenantId,
      env: scope.env,
      scopeId: scope.scopeId,
      jobId: receipt.jobId,
      kind: 'receipt_committed',
      'payload.receiptId': receipt.receiptId,
    } as never,
    { sort: { sequence: -1 } },
  );
  return {
    artifactId: receipt.receiptId,
    kind: 'completion_receipt' as const,
    jobId: receipt.jobId,
    committedAtSequence: event?.sequence ?? 0,
    contentHash: contentHash(receipt as never, 'completion-receipt'),
    payload: {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      runId: receipt.runId,
      harnessHash: receipt.harnessHash,
      scopeId: receipt.scopeId,
      scopeRevision: receipt.scopeRevision,
      verifiedWorldRevision: receipt.verifiedWorldRevision,
      verificationPlanHash: receipt.verificationPlanHash,
      inspectedCollectionIds: receipt.inspectedCollectionIds,
      discoveredFieldIds: receipt.discoveredFieldIds,
      operationalResiduals: receipt.operationalResiduals,
      excludedOrRetainedRecords: receipt.excludedOrRetainedRecords,
      limitations: receipt.limitations,
      domainStatus: receipt.domainStatus,
      externalErasureStatus: receipt.externalErasureStatus,
      registeredCollectionIds: registry?.collectionIds ?? [],
      effectCounts,
      actionReceiptIds: actions.map((a) => a.receiptId),
      committedAt: iso(createdAt),
    },
  };
}

/**
 * GET .../deployments/{target}: the pointer and the versions it has held, from the committed pointer row and the
 * insert-only promotion receipts (rollbacks are receipts whose gate report id is `rollback`). A version's authority class is
 * the stored candidate's computed class for that child, and null when no candidate is stored for it.
 */
export async function readDeployment(env: DomainEnv, config: ServiceConfig, target: string) {
  if (!TARGETS.includes(target as TargetKind)) throw new ServiceRefusal(400, 'invalid_request');
  const scope = config.owner.scope;
  const key: DeploymentKey = { ...scope, target: target as TargetKind };
  const pointer = await env.service.control
    .collection<{
      activeHash: string;
      revision: number;
      scopeRevision: number;
      authorizationRevision: number;
    }>('deployments')
    .findOne({
      _id: deploymentIdentity(key),
      tenantId: scope.tenantId,
      env: scope.env,
      scopeId: scope.scopeId,
      target,
    } as never);
  if (!pointer) throw new ServiceRefusal(404, 'not_found');
  const filter = { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, target } as never;
  const promotions = env.service.control.collection<PromotionReceipt & { _id: string }>('promotions');
  const first = await promotions.findOne(filter, { sort: { toRevision: 1 } });
  const rows = (
    await promotions.find(filter, { sort: { toRevision: -1 }, limit: MAX_VERSIONS }).toArray()
  ).reverse();
  const initial = first ? first.fromHash : pointer.activeHash;

  const candidates = await env.service.control
    .collection<{
      childHash: string;
      computedClass: MutationClass;
      state: string;
      candidateId: string;
      target: string;
    }>('candidates')
    .find(
      {
        'actor.tenantId': scope.tenantId,
        'actor.env': scope.env,
        'actor.scopeId': scope.scopeId,
        target,
      } as never,
      { limit: 500 },
    )
    .toArray();
  const classOf = new Map(candidates.map((c) => [c.childHash, c.computedClass]));

  // Versions in the order they first became active; a rollback re-activates an older one without adding a version.
  const order: string[] = [initial];
  const parentOf = new Map<string, string | null>([[initial, null]]);
  const promotionOf = new Map<string, PromotionReceipt>();
  const rolledBackFrom = new Map<string, PromotionReceipt>();
  for (const row of rows) {
    if (row.gateReportId === 'rollback') {
      rolledBackFrom.set(row.fromHash, row);
      continue;
    }
    if (!order.includes(row.toHash)) {
      order.push(row.toHash);
      parentOf.set(row.toHash, row.fromHash);
      promotionOf.set(row.toHash, row);
    }
  }
  const versions = order.slice(-MAX_VERSIONS).map((hash) => {
    const promotion = promotionOf.get(hash);
    const rollback = rolledBackFrom.get(hash);
    return {
      hash,
      parentHash: parentOf.get(hash) ?? null,
      testedParentHash: promotion ? promotion.fromHash : null,
      authorityClass: classOf.get(hash) ?? null,
      state:
        hash === pointer.activeHash
          ? ('active' as const)
          : rollback
            ? ('rolled_back' as const)
            : ('previous' as const),
      promotion: promotion
        ? {
            promotionId: promotion.promotionId,
            gateReportId: promotion.gateReportId,
            consumedGrantId: promotion.consumedGrantId ?? null,
            at: iso(promotion.createdAt),
          }
        : null,
      rollback:
        rollback && hash !== pointer.activeHash
          ? {
              promotionId: rollback.promotionId,
              toHash: rollback.toHash,
              reason: rollback.reason.slice(0, 300),
              at: iso(rollback.createdAt),
            }
          : null,
    };
  });
  const rejected = candidates
    .filter((c) => ['schema_rejected', 'replay_rejected', 'behavior_rejected'].includes(c.state))
    .slice(0, 100)
    .map((c) => ({ candidateId: c.candidateId, childHash: c.childHash, reasonCodes: [c.state] }));

  // Refused rollbacks (insert-only audit). Omitted ONLY when the principal is not authorized to read the collection
  // ("the backend does not report them"); any other error fails the request instead of dropping the field silently.
  const refusedRollbacks = await env.service.control
    .collection<{ toHash: string; code: string; at: Date }>('rollback_refusals')
    .find(filter, { sort: { at: -1 }, limit: MAX_REFUSED_ROLLBACKS })
    .toArray()
    .then(
      (refusals) => refusals.map((r) => ({ toHash: r.toHash, code: r.code, at: iso(r.at) })),
      (error: unknown) => {
        if (isUnauthorized(error)) return undefined;
        throw error;
      },
    );

  return {
    target: target as TargetKind,
    activeHash: pointer.activeHash,
    revision: pointer.revision,
    scopeRevision: pointer.scopeRevision,
    authorizationRevision: pointer.authorizationRevision,
    initialBundleHash: initial,
    versions,
    rejected,
    ...(refusedRollbacks ? { refusedRollbacks } : {}),
  };
}

/** The two routes behind one entry point for the handler: `GET artifacts/{id}` and `GET deployments/{target}`. */
export async function serveArtifactRoute(
  env: DomainEnv,
  config: ServiceConfig,
  route: { key: 'GET artifacts' | 'GET deployments'; id: string },
  url: URL,
): Promise<{ status: 200; body: unknown }> {
  // `cursor` belongs to paged artifacts (graph pages), none of which is served yet: a cursor is refused, not ignored.
  for (const name of url.searchParams.keys())
    if (name !== 'cursor' || route.key !== 'GET artifacts') throw new ServiceRefusal(400, 'invalid_request');
  if (url.searchParams.has('cursor')) throw new ServiceRefusal(400, 'invalid_request');
  return {
    status: 200,
    body:
      route.key === 'GET artifacts'
        ? await readArtifact(env, config, route.id)
        : await readDeployment(env, config, route.id),
  };
}
