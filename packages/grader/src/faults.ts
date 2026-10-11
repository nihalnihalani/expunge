import { contentHash } from '@expunge/contracts';
import type { WorldSpec } from '@expunge/contracts';
import { addressKey, type ExpectedEffect, type VisibleWorld } from '@expunge/fixtures';
import { applyReferenceAction, type ReferencePlan } from './reference.js';

export type FaultCode = 'transient_before_commit' | 'interrupt_before_commit' | 'ack_lost_after_commit';
export class InjectedFault extends Error {
  constructor(public readonly code: FaultCode) {
    super(code);
  }
}
export interface SimulatedReceipt {
  effectKey: string;
  argsDigest: string;
  addressKey: string;
  worldRevision: number;
  appliedOnce: true;
  receiptHash: string;
}
/** Deterministic local protocol simulator, not an assertion about Atlas transactions or crash durability. */
export class FaultSession {
  readonly world: VisibleWorld;
  readonly receipts = new Map<string, SimulatedReceipt>();
  readonly counters = {
    attempts: 0,
    effects: 0,
    replays: 0,
    transientFailures: 0,
    interrupted: 0,
    acknowledgementsLost: 0,
  };
  private faults: WorldSpec['faults'];
  private interruptConsumed = false;
  constructor(world: VisibleWorld, faults: WorldSpec['faults']) {
    this.world = structuredClone(world);
    this.faults = structuredClone(faults);
  }
  apply(effectKey: string, action: ExpectedEffect, exactBindings: readonly string[]): SimulatedReceipt {
    this.counters.attempts++;
    const argsDigest = contentHash({ action, exactBindings }, 'simulated-action');
    const committed = this.receipts.get(effectKey);
    if (committed) {
      if (committed.argsDigest !== argsDigest) throw new Error('IdempotencyConflict');
      this.counters.replays++;
      return committed;
    }
    if (this.faults.transientFailures > 0) {
      this.faults.transientFailures--;
      this.counters.transientFailures++;
      throw new InjectedFault('transient_before_commit');
    }
    if (
      !this.interruptConsumed &&
      this.faults.interruptAfterEffects !== null &&
      this.counters.effects >= this.faults.interruptAfterEffects
    ) {
      this.interruptConsumed = true;
      this.counters.interrupted++;
      throw new InjectedFault('interrupt_before_commit');
    }
    applyReferenceAction(this.world, action, exactBindings);
    this.counters.effects++;
    const payload = {
      effectKey,
      argsDigest,
      addressKey: addressKey(action.address),
      worldRevision: this.counters.effects + 1,
      appliedOnce: true as const,
    };
    const receipt = { ...payload, receiptHash: contentHash(payload, 'simulated-receipt') };
    this.receipts.set(effectKey, receipt);
    if (this.faults.partialAcknowledgements > 0) {
      this.faults.partialAcknowledgements--;
      this.counters.acknowledgementsLost++;
      throw new InjectedFault('ack_lost_after_commit');
    }
    return receipt;
  }
}
export function runReferenceWithFaults(
  world: VisibleWorld,
  plan: ReferencePlan,
  faults: WorldSpec['faults'],
  maxRetriesPerAction = 12,
): {
  session: FaultSession;
  retryFailures: number;
} {
  const session = new FaultSession(world, faults);
  let retryFailures = 0;
  for (const action of plan.actions) {
    let success = false;
    const effectKey = contentHash(
      { planHash: plan.planHash, address: action.address, effect: action.effect },
      'logical-fixture-effect',
    );
    for (let attempt = 0; attempt <= maxRetriesPerAction; attempt++) {
      try {
        session.apply(effectKey, action, plan.exactBindings);
        success = true;
        break;
      } catch (error) {
        if (!(error instanceof InjectedFault)) throw error;
      }
    }
    if (!success) retryFailures++;
  }
  return { session, retryFailures };
}
