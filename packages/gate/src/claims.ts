import { contentHash, type HarnessBundle } from '@expunge/contracts';
import { executableProjection, projectionHash } from '@expunge/contracts';
import { fail, requirePrincipal, type MongoService } from '@expunge/mongo';

/**
 * One gate run per (parent, executable child). The claim is inserted BEFORE any episode, so abandoning a campaign
 * early and starting another never gives a candidate a second roll (DA-8 D8-4, D8-16). The child is named by its
 * executable projection, not its bytes: reordering the non-executable evidence list does not make a new candidate.
 */
export const childProjectionOf = (child: HarnessBundle): string => projectionHash(child);
export { executableProjection };
export const candidateKeyOf = (parentHash: string, childProjectionHash: string): string =>
  contentHash({ parentHash, childProjectionHash }, 'gate-candidate');
/** The id of a gate report: one per (parent, executable child), so a second report can never be inserted. */
export const reportIdOf = (parentHash: string, childProjectionHash: string): string =>
  contentHash({ parentHash, childProjectionHash }, 'gate-report-id');

export type ClaimState = 'open' | 'held' | 'decided' | 'failed';
export type StoredClaim = {
  _id: string;
  parentHash: string;
  childProjectionHash: string;
  campaignId: string;
  state: ClaimState;
  ordinal?: number;
};
export type ClaimTicket = {
  claimKey: string;
  campaignId: string;
  parentHash: string;
  childProjectionHash: string;
  /** This candidate's ordinal among the parent's attempts, fixed when the claim was first inserted. */
  ordinal: number;
  /** How many candidates the parent has put through a gate, including this one, when the claim was taken. */
  parentAttempts: number;
  /** How many held campaigns this candidate's claim has been through before this one. */
  resumeCount: number;
};

const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

export class ClaimStore {
  constructor(readonly service: MongoService) {}
  private get claims() {
    return this.service.control.collection<StoredClaim>('gate_claims');
  }
  private get attempts() {
    return this.service.control.collection<{ _id: string; attempts: number }>('gate_attempts');
  }
  private get heldRuns() {
    return this.service.control.collection<HeldRunRow>('gate_held_runs');
  }

  /**
   * Takes the claim for a campaign, or refuses. A new pair takes one of the parent's attempts atomically (a conditional
   * upsert-increment: past the cap it collides, `AttemptCapReached`); a held pair is taken over by this campaign;
   * an open, decided or failed pair is refused (`CandidateGateRerun`). Concurrent callers on the same pair: exactly
   * one inserts the claim, the loser's attempt is given back and it is refused.
   */
  async claim(input: {
    campaignId: string;
    parentHash: string;
    childProjectionHash: string;
    maxAttemptsPerParent: number;
    /** TEST HOOK: runs between taking an attempt and inserting the claim, to force a real interleaving. */
    betweenAttemptAndInsert?: () => Promise<void>;
  }): Promise<ClaimTicket> {
    requirePrincipal(this.service, ['grader']);
    const claimKey = candidateKeyOf(input.parentHash, input.childProjectionHash);
    const existing = await this.claims.findOne({ _id: claimKey });
    if (existing) return this.takeHeld(existing, input.campaignId);
    const parentAttempts = await this.takeAttempt(input.parentHash, input.maxAttemptsPerParent);
    await input.betweenAttemptAndInsert?.();
    try {
      await this.claims.insertOne({
        _id: claimKey,
        parentHash: input.parentHash,
        childProjectionHash: input.childProjectionHash,
        campaignId: input.campaignId,
        state: 'open',
        ordinal: parentAttempts,
      });
    } catch (error) {
      // Lost the race (or the same pair was claimed meanwhile): give the attempt back and refuse.
      await this.attempts.updateOne({ _id: input.parentHash }, { $inc: { attempts: -1 } });
      if (isDuplicate(error)) fail('CandidateGateRerun');
      throw error;
    }
    return {
      claimKey,
      campaignId: input.campaignId,
      parentHash: input.parentHash,
      childProjectionHash: input.childProjectionHash,
      ordinal: parentAttempts,
      parentAttempts,
      resumeCount: 0,
    };
  }

  private async takeAttempt(parentHash: string, cap: number): Promise<number> {
    try {
      const row = await this.attempts.findOneAndUpdate(
        { _id: parentHash, attempts: { $lt: cap } },
        { $inc: { attempts: 1 } },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false },
      );
      if (!row) fail('AttemptCapReached');
      return row.attempts;
    } catch (error) {
      // The conditional filter missed an existing row at the cap, so the upsert tried to insert the same _id.
      if (isDuplicate(error)) fail('AttemptCapReached');
      throw error;
    }
  }

  private async takeHeld(existing: StoredClaim, campaignId: string): Promise<ClaimTicket> {
    if (existing.state !== 'held') fail('CandidateGateRerun');
    // held -> open by compare-and-set on (_id, state): of two concurrent resumers exactly one wins.
    const taken = await this.claims.findOneAndUpdate(
      { _id: existing._id, state: 'held' },
      { $set: { state: 'open', campaignId } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    if (!taken) fail('CandidateGateRerun');
    const resumeCount = await this.heldRuns.countDocuments({ claimKey: existing._id });
    const attempts = await this.attempts.findOne({ _id: existing.parentHash });
    return {
      claimKey: existing._id,
      campaignId,
      parentHash: existing.parentHash,
      childProjectionHash: existing.childProjectionHash,
      ordinal: existing.ordinal ?? 1,
      parentAttempts: attempts?.attempts ?? existing.ordinal ?? 1,
      resumeCount,
    };
  }

  /** open -> decided | held | failed for this campaign only. A claim that is not open for it is not settled twice. */
  async settle(ticket: ClaimTicket, state: Exclude<ClaimState, 'open'>): Promise<void> {
    requirePrincipal(this.service, ['grader']);
    const done = await this.claims.updateOne(
      { _id: ticket.claimKey, campaignId: ticket.campaignId, state: 'open' },
      { $set: { state } },
    );
    if (done.modifiedCount !== 1) fail('ClaimNotOpen');
  }

  /**
   * Operator recovery for a claim a crashed process left `open` and that no campaign is running: open -> held, so the
   * pair can be taken over. Never changes a decided or failed claim.
   */
  async recover(claimKey: string): Promise<void> {
    requirePrincipal(this.service, ['grader']);
    const done = await this.claims.updateOne({ _id: claimKey, state: 'open' }, { $set: { state: 'held' } });
    if (done.modifiedCount !== 1) fail('ClaimNotOpen');
  }

  async read(claimKey: string): Promise<StoredClaim | null> {
    return this.claims.findOne({ _id: claimKey });
  }

  /** Keeps the executed trials of a campaign that ended HELD; insert-only. */
  async saveHeld(ticket: ClaimTicket, row: Omit<HeldRunRow, '_id' | 'claimKey' | 'campaignId' | 'attempt'>) {
    requirePrincipal(this.service, ['grader']);
    const attempt = ticket.resumeCount + 1;
    const _id = `${ticket.claimKey}:${ticket.campaignId}:${attempt}`;
    try {
      await this.heldRuns.insertOne({
        _id,
        claimKey: ticket.claimKey,
        campaignId: ticket.campaignId,
        attempt,
        ...row,
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
  }

  /** Every held run of this candidate, oldest first. */
  async heldRunsOf(claimKey: string): Promise<HeldRunRow[]> {
    return this.heldRuns.find({ claimKey }).sort({ attempt: 1 }).toArray();
  }
}

export type HeldRunRow = {
  _id: string;
  claimKey: string;
  campaignId: string;
  attempt: number;
  freezeHash: string;
  reasonCodes: string[];
  excluded: 'superseded_by_resume';
  trials: Array<Record<string, unknown>>;
};
