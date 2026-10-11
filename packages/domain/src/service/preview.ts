import { z } from 'zod';
import { OWNER_EPISODE_LIMITS } from '@expunge/baselines';
import { contentHash, type DomainAddress, type EffectKind } from '@expunge/contracts';
import { ProtocolError, addressId } from '@expunge/mongo';
import { UnknownOwnerPolicy, eligibilityOf, ownerPolicyFor } from '@expunge/governance';
import { closureOf } from '../closure.js';
import type { DomainEnv } from '../env.js';
import { classifyFields } from '../fields.js';
import { identityHashOf, maskSubject } from '../keys.js';
import type { SubjectIdType } from '../rows.js';
import { scalarsAt } from '../values.js';
import { idBinding } from '../tools/preview-cleanup.js';
import type { ServiceConfig } from './config.js';
import { ServiceRefusal } from './errors.js';

const identifier = z.string().min(1).max(128);
export const subjectRequestSchema = z
  .object({ idType: z.enum(['objectId', 'string', 'int', 'long']), value: z.string().min(1).max(256) })
  .strict();
export const previewRequestSchema = z.object({ worldId: identifier, subject: subjectRequestSchema }).strict();
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

/** What the operator sees before submitting: shaped by the operator's `CleanupPreview` contract. */
export type OperatorPreview = {
  previewId: string;
  basis: 'expert_static_discovery';
  worldId: string;
  worldRevision: number;
  scopeRevision: number;
  subject: { display: string; identityHash: string; idType: SubjectIdType };
  perCollection: Array<{
    collectionId: string;
    exactIdentityMatches: number;
    eligibleEffects: Partial<Record<EffectKind, number>>;
    retained: number;
    notInspected: boolean;
  }>;
  limitations: string[];
  expiresAt: string;
};

/**
 * The model-free preview an owner sees before submitting a cleanup. It runs resolution and discovery exactly as the
 * expert-static procedure would (every registered field, both reference directions, the owner's widest depth and scan
 * limits) and counts what the owner policy would do to each record in reach. It is a count, not a plan:
 * - no model runs, and the result is labeled `expert_static_discovery`;
 * - it writes no preview plan, so `apply_cleanup_batch` (which acts only on the worker's own `preview_cleanup` plan)
 *   cannot use it, and it carries no record ids or values, only counts per collection;
 * - the id is a digest of what it shows, so the same world state gives the same id and a changed world gives another.
 */
export async function operatorPreview(
  env: DomainEnv,
  config: ServiceConfig,
  request: PreviewRequest,
): Promise<OperatorPreview> {
  const scope = config.owner.scope;
  let state;
  let world;
  try {
    world = await env.worlds.bind(scope, request.worldId);
    state = await env.worlds.read(scope, request.worldId);
  } catch (error) {
    if (error instanceof ProtocolError && error.code === 'UnknownWorld')
      throw new ServiceRefusal(404, 'not_found');
    throw error;
  }
  if (state.maintenanceMode) throw new ServiceRefusal(409, 'world_in_maintenance');
  const registry = await env.scopes.read(scope, state.scopeRevision);
  let policy;
  try {
    policy = ownerPolicyFor(registry);
  } catch (error) {
    if (error instanceof UnknownOwnerPolicy) throw new ServiceRefusal(422, 'unknown_owner_policy');
    throw error;
  }
  const roles = classifyFields(registry, policy);

  const { idType, value } = request.subject;
  const rootAddress: DomainAddress = {
    collectionId: policy.subjectCollectionId,
    recordId: idType === 'int' ? Number(value) : value,
    recordIdBsonType: idType,
  };
  try {
    addressId(rootAddress);
  } catch {
    throw new ServiceRefusal(400, 'invalid_request');
  }
  const root = await env.scopes.readRecord(world, registry, rootAddress);
  const subject = {
    display: maskSubject(value),
    identityHash: identityHashOf(idType, value),
    idType,
  } as const;
  const limitations = [
    'Model-free preview from the expert-static discovery over registered fields. It is an estimate, not a plan.',
    'The worker previews and applies its own plan under its own harness; this preview cannot be applied.',
    ...registry.discoveryCompleteness.limitations,
  ].slice(0, 20);

  const perCollection = new Map(
    registry.collectionIds.map((collectionId) => [
      collectionId,
      {
        collectionId,
        exactIdentityMatches: 0,
        eligibleEffects: {} as Partial<Record<EffectKind, number>>,
        retained: 0,
        notInspected: false,
      },
    ]),
  );
  if (!root) limitations.push('No record with this identifier exists in the subject collection.');
  else {
    const identityBindings = new Set<string>();
    const rootKey = idBinding(rootAddress);
    if (rootKey !== null) identityBindings.add(rootKey);
    for (const field of registry.fields)
      if (field.collectionId === rootAddress.collectionId && roles.get(field.fieldId) === 'identity')
        for (const { key } of scalarsAt(root, field)) identityBindings.add(key);
    let members;
    try {
      members = await closureOf(
        {
          scopes: env.scopes,
          edges: env.edges,
          world,
          registry,
          roles,
          worldRevision: state.revision,
          ceiling: OWNER_EPISODE_LIMITS,
        },
        { root: { address: rootAddress }, identityBindings: [...identityBindings] },
      );
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'ScanBudgetExceeded')
        throw new ServiceRefusal(422, 'scan_budget_exceeded');
      throw error;
    }
    if (members.truncated)
      limitations.push('The reach was cut at a limit, so the counts below are a lower bound.');
    for (const member of members.members) {
      const row = perCollection.get(member.address.collectionId);
      if (!row) continue;
      row.exactIdentityMatches += 1;
      const document = await env.scopes.readRecord(world, registry, member.address);
      const verdict = document ? eligibilityOf(registry, document as never) : null;
      if (verdict?.eligible)
        row.eligibleEffects[verdict.effect] = (row.eligibleEffects[verdict.effect] ?? 0) + 1;
      else row.retained += 1;
    }
  }
  const counts = [...perCollection.values()];
  const previewId = contentHash(
    {
      kind: 'operator-preview',
      worldId: request.worldId,
      worldRevision: state.revision,
      scopeRevision: state.scopeRevision,
      identityHash: subject.identityHash,
      ownerPolicyHash: policy.hash,
      perCollection: counts,
    },
    'operator-preview',
  );
  return {
    previewId,
    basis: 'expert_static_discovery',
    worldId: request.worldId,
    worldRevision: state.revision,
    scopeRevision: state.scopeRevision,
    subject,
    perCollection: counts,
    limitations,
    expiresAt: new Date(env.clock().getTime() + config.previewTtlMs).toISOString(),
  };
}
