import { deploymentIdentity, projectionHash, type ScopeKey } from '@expunge/contracts';
import { ArtifactRepository } from './artifacts.js';
import { fail, scopeFilter, type MongoService } from './client.js';

/** The row a gate claim stores for one (parent, executable child) pair; see packages/gate/src/freeze.ts. */
export type CampaignClaim = {
  parentHash: string;
  childProjectionHash: string;
  campaignId: string;
  state: string;
};

/**
 * The open claim of a campaign whose freeze row exists. Both rows are written before any episode runs (the freeze by
 * the fixture builder, the claim by the gate), so a campaign that has neither is not a campaign.
 */
export async function openCampaignClaim(service: MongoService, campaignId: string): Promise<CampaignClaim> {
  const control = service.control;
  if (!(await control.collection('campaign_freezes').findOne({ _id: campaignId as never })))
    fail('NotCampaignWorld');
  const claim = await control.collection<CampaignClaim>('gate_claims').findOne({ campaignId, state: 'open' });
  if (!claim) fail('HarnessNotInCampaign');
  return claim;
}

/**
 * Whether `hash` is a harness the claim owns: its parent, or an artifact whose parent is the claim's parent and whose
 * executable projection is the child the claim names. Derived from the stored artifact, never from a caller's word.
 */
export async function assertCampaignHarness(
  service: MongoService,
  claim: CampaignClaim,
  hash: string,
): Promise<void> {
  if (hash === claim.parentHash) return;
  const artifact = await new ArtifactRepository(service).read(hash).catch(() => null);
  const isChild =
    artifact !== null &&
    artifact.payload.parentHash === claim.parentHash &&
    projectionHash(artifact.payload) === claim.childProjectionHash;
  if (!isChild) fail('HarnessNotInCampaign');
}

/** A world in `scope` built for this campaign (its stored binding names it). */
export async function assertScopeHoldsCampaignWorld(
  service: MongoService,
  scope: ScopeKey,
  campaignId: string,
): Promise<void> {
  const found = await service.world
    .collection('world_scope_bindings')
    .findOne({ ...scopeFilter(scope), campaignId });
  if (!found) fail('NotCampaignWorld');
}

/**
 * A campaign runs only in an evaluation scope that no production deployment points into. A scope that has a worker
 * deployment pointer, or any env but `evaluation`, is a place real data can live, so a campaign permit or a campaign
 * job there is refused even when a freeze and an open claim exist.
 */
export async function assertCampaignScope(service: MongoService, scope: ScopeKey): Promise<void> {
  if (scope.env !== 'evaluation') fail('NotCampaignWorld');
  const key = { ...scopeFilter(scope), target: 'worker' as const };
  const pointer = await service.control
    .collection('deployments')
    .findOne({ _id: deploymentIdentity(key) as never, ...key });
  if (pointer) fail('NotCampaignWorld');
}
