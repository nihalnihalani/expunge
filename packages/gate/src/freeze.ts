import { contentHash, type ResourceLimits } from '@expunge/contracts';
import { fail, requirePrincipal, type MongoService } from '@expunge/mongo';
import type { WorkerProfile } from './types.js';

/**
 * The commitments a campaign is run under, written ONCE by the fixture builder before any episode and only read by the
 * gate (DA-8 D8-2). Every "frozen" value the gate compares against comes from this stored row, never from the caller
 * of `runGate`. The row carries its own hash, which the reader recomputes.
 */
export type CampaignFreeze = {
  campaignId: string;
  evaluatorHash: string;
  fixtureGeneratorHash: string;
  /** The runtime hash the worker build attests; each run's own attestation must equal it. */
  runtimeHash: string;
  compilerHash: string;
  workerProfileHash: string;
  budgetHash: string;
  /** How many distinct candidates one parent may put through a gate before the cap refuses another. */
  maxAttemptsPerParent: number;
  splitManifestCommitment: string;
  /** The measured, predeclared dollar ceiling per episode. Null until baseline probes set it: the gate then holds. */
  costCeilingMicrousd: number | null;
  freezeHash: string;
};

export type FreezeInput = Omit<CampaignFreeze, 'freezeHash'>;
const HEX64 = /^[a-f0-9]{64}$/;
const isInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export const profileHashOf = (profile: WorkerProfile): string =>
  contentHash(profile as never, 'worker-profile');
export const budgetHashOf = (budget: ResourceLimits): string => contentHash(budget as never, 'gate-budget');
export const freezeHashOf = (input: FreezeInput): string => contentHash(input as never, 'campaign-freeze');

export function assertFreezeInput(input: FreezeInput): void {
  const hashes = [
    input.evaluatorHash,
    input.fixtureGeneratorHash,
    input.runtimeHash,
    input.compilerHash,
    input.workerProfileHash,
    input.budgetHash,
    input.splitManifestCommitment,
  ];
  if (
    !input.campaignId ||
    !hashes.every((hash) => typeof hash === 'string' && HEX64.test(hash)) ||
    !isInt(input.maxAttemptsPerParent) ||
    input.maxAttemptsPerParent < 1 ||
    !(input.costCeilingMicrousd === null || isInt(input.costCeilingMicrousd))
  )
    fail('InvalidCampaignFreeze');
}

export class FreezeStore {
  constructor(readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<CampaignFreeze & { _id: string }>('campaign_freezes');
  }

  /** Writes the freeze once. The fixture builder only; a second write of different bytes is refused. */
  async write(input: FreezeInput): Promise<CampaignFreeze> {
    requirePrincipal(this.service, ['fixture_builder']);
    assertFreezeInput(input);
    const row: CampaignFreeze = { ...input, freezeHash: freezeHashOf(input) };
    try {
      await this.rows.insertOne({ _id: input.campaignId, ...row });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error;
      const existing = await this.read(input.campaignId).catch(() => null);
      if (!existing || existing.freezeHash !== row.freezeHash) fail('CampaignFreezeConflict');
    }
    return row;
  }

  /** The stored freeze, with its hash recomputed. A row that was edited, or never written, is refused. */
  async read(campaignId: string): Promise<CampaignFreeze> {
    requirePrincipal(this.service, ['grader', 'fixture_builder']);
    const found = await this.rows.findOne({ _id: campaignId });
    if (!found) fail('CampaignFreezeMissing');
    const { _id, freezeHash, ...fields } = found;
    if (_id !== campaignId || fields.campaignId !== campaignId) fail('CampaignFreezeTampered');
    const input = fields as FreezeInput;
    assertFreezeInput(input);
    if (freezeHashOf(input) !== freezeHash) fail('CampaignFreezeTampered');
    return { ...input, freezeHash };
  }
}
