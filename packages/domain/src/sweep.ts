import { ProtocolError, nodeKey, type ScopeRepository, type WorldKey } from '@expunge/mongo';
import type { DomainAddress, EffectKind, ScopeRegistry } from '@expunge/contracts';
import { eligibilityOf, type OwnerPolicy } from '@expunge/governance';
import { scanWorld } from './edge-index.js';
import type { FieldRole } from './fields.js';
import { addressKey } from './keys.js';
import type { Residual } from './rows.js';
import { scalarsAt, stringValuesAt } from './values.js';

export const MAX_RESIDUAL_SAMPLES = 50;
const MAX_ATTEMPTS = 3;

export type SweepOutcome =
  | {
      valid: true;
      worldRevisionBefore: number;
      worldRevisionAfter: number;
      residuals: number;
      retainedOrExcluded: number;
      residualSamples: Residual[];
      scannedDocuments: number;
    }
  | {
      valid: false;
      reason: 'ScanBudgetExceeded' | 'WorldChangedDuringVerification';
      worldRevisionBefore: number;
      worldRevisionAfter: number;
    };

type RecordView = {
  registry: ScopeRegistry;
  roles: ReadonlyMap<string, FieldRole>;
  policy: OwnerPolicy;
  collectionId: string;
  document: Record<string, unknown>;
};

/** Registered fields (other than the record key, which stays what it was) that still hold one of the subject's values. */
export function heldBindings(view: RecordView, bindings: ReadonlySet<string>): string[] {
  const held: string[] = [];
  for (const field of view.registry.fields) {
    if (field.collectionId !== view.collectionId || view.roles.get(field.fieldId) === 'key') continue;
    if (scalarsAt(view.document, field).some((scalar) => bindings.has(scalar.key))) held.push(field.fieldId);
  }
  return held;
}

/**
 * Whether the effect the owner policy assigns this record has been carried out on it, judged from the record alone:
 * delete leaves nothing; restrict sets `access`; redact has replaced the private payload; tombstone has also marked
 * the record. A record that holds no payload has nothing private left to replace.
 */
export function effectCarriedOut(view: RecordView, effect: EffectKind): boolean {
  const payloadField = view.registry.fields.find(
    (field) => field.collectionId === view.collectionId && view.roles.get(field.fieldId) === 'payload',
  );
  const payloads = payloadField ? stringValuesAt(view.document, payloadField) : [];
  switch (effect) {
    case 'delete':
      return false; // the record still exists
    case 'restrict':
      return view.document.access === 'restricted';
    case 'redact':
      return payloads.every((value) => value === view.policy.redactionReplacement);
    case 'tombstone':
      return view.document.lifecycle === 'tombstoned' && payloads.length === 0;
  }
}

/**
 * Reads every registered collection at a stable world revision (captured before and after; a change retries) and
 * counts what is left of the subject:
 * - a record in the subject's reach (`closure`, fixed before any effect) that the owner policy covers and that has
 *   not had its effect carried out is an unprocessed residual;
 * - any other record that still holds one of the subject's exact values in a registered field, unless it is
 *   restricted or the policy keeps it, is a binding residual;
 * - a record the policy keeps by design (restrict once restricted, or another policy's record) is counted as retained,
 *   never as a residual; a record with no eligibility metadata is kept by nothing and is an `unclassified` residual.
 * Read only. A sweep that cannot finish inside the scan bound, or that never sees a stable revision, is reported as not
 * valid rather than as zero residuals.
 */
export async function sweepRegisteredScope(input: {
  scopes: ScopeRepository;
  world: WorldKey;
  registry: ScopeRegistry;
  roles: ReadonlyMap<string, FieldRole>;
  policy: OwnerPolicy;
  bindings: ReadonlySet<string>;
  closure: ReadonlyArray<{ address: DomainAddress }>;
  maxDocuments: number;
  worldRevision: () => Promise<number>;
}): Promise<SweepOutcome> {
  const inReach = new Set(input.closure.map((member) => nodeKey(member.address)));
  let before = await input.worldRevision();
  let after = before;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    before = await input.worldRevision();
    let records;
    try {
      records = await scanWorld(input.scopes, input.world, input.registry, input.maxDocuments);
    } catch (error) {
      if (error instanceof ProtocolError && error.code === 'ScanBudgetExceeded')
        return {
          valid: false,
          reason: 'ScanBudgetExceeded',
          worldRevisionBefore: before,
          worldRevisionAfter: before,
        };
      throw error;
    }
    after = await input.worldRevision();
    if (after !== before) continue;
    let residuals = 0;
    let retainedOrExcluded = 0;
    let scannedDocuments = 0;
    const samples: Residual[] = [];
    const flag = (address: DomainAddress, fieldId: string, reason: Residual['reason']) => {
      residuals += 1;
      if (samples.length < MAX_RESIDUAL_SAMPLES) samples.push({ address, fieldId, reason });
    };
    for (const collectionId of input.registry.collectionIds) {
      for (const record of records.get(collectionId) ?? []) {
        scannedDocuments += 1;
        const view: RecordView = {
          registry: input.registry,
          roles: input.roles,
          policy: input.policy,
          collectionId,
          document: record.document,
        };
        const verdict = eligibilityOf(input.registry, record.document as never);
        // What the owner policy keeps by design: a record whose effect is `restrict` once it is restricted, and a record
        // another policy or an effect outside the scope's list puts out of this cleanup's reach. A record with no
        // eligibility metadata, or one that is restricted but was due for another effect, is kept by nothing.
        const kept = verdict.eligible
          ? verdict.effect === 'restrict' && record.document.access === 'restricted'
          : verdict.reason !== 'missing_metadata';
        const held = heldBindings(view, input.bindings);
        if (inReach.has(nodeKey(record.address))) {
          if (!verdict.eligible) {
            if (kept) retainedOrExcluded += 1;
            else flag(record.address, 'eligibility', 'unclassified');
          } else if (!effectCarriedOut(view, verdict.effect)) flag(record.address, 'effect', 'unprocessed');
          else if (held.length > 0 && !kept) flag(record.address, held[0]!, 'binding');
          else if (held.length > 0) retainedOrExcluded += 1;
          continue;
        }
        if (held.length === 0) continue;
        if (kept) retainedOrExcluded += 1;
        else flag(record.address, held[0]!, 'binding');
      }
    }
    samples.sort((l, r) => addressKey(l.address).localeCompare(addressKey(r.address), 'en'));
    return {
      valid: true,
      worldRevisionBefore: before,
      worldRevisionAfter: after,
      residuals,
      retainedOrExcluded,
      residualSamples: samples,
      scannedDocuments,
    };
  }
  return {
    valid: false,
    reason: 'WorldChangedDuringVerification',
    worldRevisionBefore: before,
    worldRevisionAfter: after,
  };
}
