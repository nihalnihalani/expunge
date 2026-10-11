import type { ClientSession, Collection } from 'mongodb';
import {
  contentHash,
  validateHarnessBundle,
  type ArtifactEnvelope,
  type HarnessBundle,
  type ScopeKey,
} from '@expunge/contracts';
import {
  assertCampaignHarness,
  assertCampaignScope,
  assertScopeHoldsCampaignWorld,
  openCampaignClaim,
} from './campaign.js';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';

export class ArtifactRepository {
  readonly collection: Collection<ArtifactEnvelope>;
  constructor(readonly service: MongoService) {
    this.collection = service.control.collection<ArtifactEnvelope>('artifacts');
  }
  async insert(payload: HarnessBundle, sourceBlobIds: string[] = []): Promise<ArtifactEnvelope> {
    requirePrincipal(this.service, ['proposer', 'promoter', 'fixture_builder', 'setup']);
    validateHarnessBundle(payload);
    const envelope: ArtifactEnvelope = {
      _id: contentHash(payload),
      payload,
      createdAt: new Date(),
      sourceBlobIds,
    };
    const existing = await this.collection.findOne({ _id: envelope._id });
    if (existing) {
      this.verify(existing);
      return existing;
    }
    try {
      await this.collection.insertOne(envelope);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
      const raced = await this.collection.findOne({ _id: envelope._id });
      if (!raced) throw error;
      this.verify(raced);
      return raced;
    }
    return envelope;
  }
  verify(envelope: ArtifactEnvelope): void {
    validateHarnessBundle(envelope.payload);
    if (contentHash(envelope.payload) !== envelope._id) fail('ArtifactHashMismatch');
  }
  async read(hash: string, session?: ClientSession): Promise<ArtifactEnvelope> {
    const envelope = await this.collection.findOne({ _id: hash }, { session });
    if (!envelope) fail('ArtifactNotFound');
    this.verify(envelope);
    return envelope;
  }
  /**
   * The artifact, if it is currently permitted for this scope. With a `session` the eligibility row is read in that
   * transaction's snapshot, so a revocation that lands before the transaction commits conflicts with it instead of
   * slipping past a read made outside it.
   */
  async readPermitted(key: ScopeKey, hash: string, session?: ClientSession): Promise<ArtifactEnvelope> {
    const eligibility = this.service.control.collection('artifact_eligibility');
    const row = await eligibility.findOne({ ...scopeFilter(key), artifactHash: hash }, { session });
    if (row) {
      // An eligibility row decides, permitted or not: a campaign permit never overrides a revoked or deleted artifact.
      if (row.state !== 'permitted') fail('ArtifactIneligible');
    } else if (!(await this.campaignPermitted(key, hash, session))) fail('ArtifactIneligible');
    return this.read(hash, session);
  }
  /**
   * A campaign permit applies only in a campaign scope (evaluation env, no worker deployment pointer), so a production
   * scope never consults one even if a row were somehow written there.
   */
  private async campaignPermitted(key: ScopeKey, hash: string, session?: ClientSession): Promise<boolean> {
    const permit = await this.service.control
      .collection('campaign_artifact_permits')
      .findOne({ ...scopeFilter(key), artifactHash: hash }, { session });
    if (!permit) return false;
    try {
      await assertCampaignScope(this.service, key);
    } catch {
      return false;
    }
    return true;
  }
  /**
   * Permits one artifact for the run of a gate campaign, in the scope the campaign's world lives in. Only the grader,
   * and only for what stored rows say belongs to the campaign: an evaluation scope with no production deployment, a
   * freeze row, a world in this scope bound to the campaign, an open claim, and a hash that is the claim's parent or
   * its exact child. The permit is recorded in `campaign_artifact_permits`, not in `artifact_eligibility`: the grader
   * holds no write on the eligibility collection, so a campaign permit can never make an artifact eligible for
   * production context loading, and `readPermitted` consults permits only in a campaign scope. Insert-only: a second
   * call is a no-op.
   */
  async permitForCampaign(
    actor: ScopeKey,
    campaignId: string,
    artifactHash: string,
  ): Promise<'permitted' | 'exists'> {
    requirePrincipal(this.service, ['grader']);
    await assertCampaignScope(this.service, actor);
    const claim = await openCampaignClaim(this.service, campaignId);
    await assertScopeHoldsCampaignWorld(this.service, actor, campaignId);
    await assertCampaignHarness(this.service, claim, artifactHash);
    const freeze = await this.service.control
      .collection<{ freezeHash: string }>('campaign_freezes')
      .findOne({ _id: campaignId as never });
    try {
      await this.service.control.collection('campaign_artifact_permits').insertOne({
        _id: `${campaignId}:${artifactHash}`,
        ...scopeFilter(actor),
        campaignId,
        artifactHash,
        freezeHash: freeze!.freezeHash,
        createdAt: new Date(),
      } as never);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) return 'exists';
      throw error;
    }
    return 'permitted';
  }
}
