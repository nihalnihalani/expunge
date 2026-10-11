import { Binary } from 'mongodb';
import { fail, requirePrincipal, type MongoService } from '@expunge/mongo';
import {
  assertDerivationKey,
  keyedDerivation,
  mintDerivationKey,
  type Derivation,
} from '@expunge/fixtures/sealed';
import { labeler, type Labeler } from './labels.js';

export type CampaignKey = { keyId: string; key: Uint8Array };
type KeyRow = { _id: string; keyId: string; key: Binary; createdAt: Date };
const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

/**
 * The per-campaign HMAC key behind instance-scoped record ids and the run labels. Insert-only in `expunge_private`:
 * the fixture builder mints it before the campaign, the grader reads it. No other principal has a grant on the
 * collection, so a worker or a proposer cannot read it, and nobody can replace it.
 */
export class CampaignKeyStore {
  constructor(readonly service: MongoService) {}
  private get rows() {
    if (!this.service.privateDb) fail('PrivateDatabaseUnavailable');
    return this.service.privateDb.collection<KeyRow>('campaign_keys');
  }

  /** Mints the key once. A second call for the same campaign returns the stored key, never a new one. */
  async mint(campaignId: string): Promise<CampaignKey> {
    requirePrincipal(this.service, ['fixture_builder']);
    if (!campaignId) fail('InvalidCampaignId');
    const fresh = mintDerivationKey();
    try {
      await this.rows.insertOne({
        _id: campaignId,
        keyId: fresh.keyId,
        key: new Binary(Buffer.from(fresh.key)),
        createdAt: new Date(),
      });
      return fresh;
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      return this.read(campaignId);
    }
  }

  async read(campaignId: string): Promise<CampaignKey> {
    requirePrincipal(this.service, ['grader', 'fixture_builder']);
    const row = await this.rows.findOne({ _id: campaignId });
    if (!row) fail('CampaignKeyMissing');
    const key = new Uint8Array(row.key.buffer);
    assertDerivationKey(key);
    return { keyId: row.keyId, key };
  }
}

/** The derivation and labeler of one campaign. */
export function campaignCrypto(stored: CampaignKey): { derivation: Derivation; label: Labeler } {
  return { derivation: keyedDerivation(stored.key, stored.keyId), label: labeler(stored.key) };
}
