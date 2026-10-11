import { contentHash, type RetractionProgressPayload, type ScopeKey } from '@expunge/contracts';
import { randomUUID } from 'node:crypto';
import { PrivacyError } from './errors.js';
import type { ClosureBounds, RevokeResult } from '@expunge/mongo';
import type {
  ArtifactCatalog,
  ArtifactKind,
  EligibilityStore,
  ProjectionSink,
  ProvenancePort,
  ContentPurger,
  RawArtifactStore,
  RegenerationQueue,
  RunObserver,
  SourceKind,
} from './ports.js';

/**
 * Source retraction as a state machine. The protocol:
 *  1. CLOSING: the source is marked ineligible and the bounded provenance closure runs until it is complete. Until it
 *     is, `permitted` (in the repository) denies the source, everything already reached, AND every descendant whose
 *     ancestry is not fully read. Incomplete never means "nothing more to revoke".
 *  2. DISPOSING (only once the closure is complete): each affected artifact is disposed of according to the owner policy
 *     (delete, regenerate, or keep revoked and flag for the owner), raw sources are replaced by non-personal tombstones, and
 *     `source_deleted` edges are written.
 *  3. COMPLETE only when both are finished. `failClosed` is true in every other phase.
 * The transitions are pure functions; the runner only performs the effects and feeds the results back in.
 */

export type OwnerPolicy = {
  policyHash: string;
  /** What happens to an affected artifact of this kind. */
  disposition(kind: ArtifactKind): 'delete' | 'regenerate' | 'keep_revoked';
};

/** Conservative default: raw material and bundles are deleted, derived learning is regenerated, anything else waits for its owner. */
export const DEFAULT_OWNER_POLICY = (policyHash: string): OwnerPolicy => ({
  policyHash,
  disposition: (kind) =>
    kind === 'raw_source' || kind === 'evidence_bundle'
      ? 'delete'
      : kind === 'lesson' || kind === 'candidate'
        ? 'regenerate'
        : 'keep_revoked',
});

export type RetractionPhase = 'closing' | 'disposing' | 'complete';

/**
 * The only reasons a retraction, a scan revocation or a tombstone may carry. A closed set so the stored `reasonCode` can
 * never hold free text (and so mongodb-authority's tombstone validator can enumerate it).
 */
export const RETRACTION_REASONS = [
  'source_retracted',
  'subject_erasure_request',
  'owner_withdrawal',
  'scan_SubjectLiteral',
  'scan_HeldOutLeak',
  'scan_PrivateIdLeak',
  'scan_raw_retention',
] as const;
export type RetractionReason = (typeof RETRACTION_REASONS)[number];

/** Reasons that mean prohibited content was FOUND in retained bytes: the bytes are removed, whatever the disposition. */
export const LEAK_REASONS: ReadonlySet<RetractionReason> = new Set<RetractionReason>([
  'scan_SubjectLiteral',
  'scan_HeldOutLeak',
  'scan_PrivateIdLeak',
]);

export type RetractionState = {
  retractionId: string;
  scope: ScopeKey;
  sourceId: string;
  policyHash: string;
  reasonCode: RetractionReason;
  /** The provenance_closures `_id` the repository returned, once the closure has started; recorded on tombstones. */
  closureId: string | null;
  /** Identifies one `run()` call. Progress event ids carry it, so a resumed run never reuses an id with new content. */
  runId: string;
  phase: RetractionPhase;
  step: number;
  closureComplete: boolean;
  closureRounds: number;
  /** Nodes revoked so far for this source, including the source. */
  discovered: number;
  frontierSize: number;
  stalledReason: string | null;
  /** Disposal progress within this run. Disposal is idempotent, so a restart simply repeats it. */
  disposalCursor: string | null;
  deleted: number;
  regenerated: number;
  keptRevoked: number;
  /** Ids the owner policy refused to decide (unknown kind, harness): they stay revoked and are listed here. */
  needsOwner: string[];
  cancelledJobs: string[];
};

export const NEEDS_OWNER_LIMIT = 1000;
export const CANCELLED_JOBS_LIMIT = 10_000;

export function retractionIdOf(scope: ScopeKey, sourceId: string): string {
  return contentHash(
    { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, sourceId },
    'retraction',
  );
}

export function initialState(
  scope: ScopeKey,
  sourceId: string,
  policy: OwnerPolicy,
  reasonCode: RetractionReason,
): RetractionState {
  return {
    retractionId: retractionIdOf(scope, sourceId),
    scope,
    sourceId,
    policyHash: policy.policyHash,
    reasonCode,
    closureId: null,
    runId: 'run0',
    phase: 'closing',
    step: 0,
    closureComplete: false,
    closureRounds: 0,
    discovered: 1,
    frontierSize: 1,
    stalledReason: null,
    disposalCursor: null,
    deleted: 0,
    regenerated: 0,
    keptRevoked: 0,
    needsOwner: [],
    cancelledJobs: [],
  };
}

/** A closure round finished. The phase moves on only when the repository reports the closure COMPLETE. */
export function afterClosure(
  state: RetractionState,
  result: RevokeResult,
  cancelledJobIds: string[],
): RetractionState {
  const cancelled = [...new Set([...state.cancelledJobs, ...cancelledJobIds])].slice(0, CANCELLED_JOBS_LIMIT);
  return {
    ...state,
    step: state.step + 1,
    closureId: result.closureId,
    phase: result.complete ? 'disposing' : 'closing',
    closureComplete: result.complete,
    closureRounds: result.rounds,
    discovered: result.discovered,
    frontierSize: result.frontier.length,
    stalledReason: result.complete ? null : result.stalledReason,
    cancelledJobs: cancelled,
  };
}

export type DisposalOutcome = {
  deleted: number;
  regenerated: number;
  keptRevoked: number;
  needsOwner: string[];
  /** Last row handled in this batch, or null when the listing is exhausted. */
  cursor: string | null;
  exhausted: boolean;
};

export function afterDisposal(state: RetractionState, outcome: DisposalOutcome): RetractionState {
  return {
    ...state,
    step: state.step + 1,
    phase: outcome.exhausted ? 'complete' : 'disposing',
    disposalCursor: outcome.cursor,
    deleted: state.deleted + outcome.deleted,
    regenerated: state.regenerated + outcome.regenerated,
    keptRevoked: state.keptRevoked + outcome.keptRevoked,
    needsOwner: [...new Set([...state.needsOwner, ...outcome.needsOwner])].slice(0, NEEDS_OWNER_LIMIT),
  };
}

/** True in every phase but `complete`: retrieval must stay closed to the affected set. */
export const failClosed = (state: RetractionState): boolean => state.phase !== 'complete';

export function progressPayload(state: RetractionState): RetractionProgressPayload {
  return {
    retractionId: state.retractionId,
    sourceId: state.sourceId,
    frontierSize: state.frontierSize,
    visited: state.discovered,
    closureComplete: state.closureComplete,
    revoked: state.discovered,
    regenerated: state.regenerated,
    runsCancelled: state.cancelledJobs.length,
    failClosed: failClosed(state),
  };
}

export type RetractionDeps = {
  provenance: ProvenancePort;
  eligibility: EligibilityStore;
  catalog: ArtifactCatalog;
  raw: RawArtifactStore;
  /** REQUIRED: removes bytes for the leak reasons whatever the owner disposition says. */
  purger: ContentPurger;
  runs: RunObserver;
  regeneration: RegenerationQueue;
  projection?: ProjectionSink;
  policy: OwnerPolicy;
  now?: () => Date;
  /** Identifier for one run; default is random. */
  runNonce?: () => string;
  /** Rows disposed per batch. */
  disposalBatch?: number;
};

export type RunOptions = { bounds?: ClosureBounds; maxSteps?: number };

export class RetractionRunner {
  constructor(private readonly deps: RetractionDeps) {}

  /**
   * Runs the protocol for one source until it completes or `maxSteps` is spent. Call it again to resume: the closure's
   * frontier is persisted by the repository, and disposal is idempotent. Returns the final state; it is `complete` only
   * if the closure finished AND every affected artifact was disposed of.
   */
  async run(
    scope: ScopeKey,
    sourceId: string,
    reasonCode: RetractionReason,
    options: RunOptions = {},
  ): Promise<RetractionState> {
    if (!(RETRACTION_REASONS as readonly string[]).includes(reasonCode))
      throw new PrivacyError('InvalidSource', 'reason');
    let state: RetractionState = {
      ...initialState(scope, sourceId, this.deps.policy, reasonCode),
      runId: (this.deps.runNonce ?? (() => randomUUID().slice(0, 12)))(),
    };
    for (let spent = 0; spent < (options.maxSteps ?? 64) && state.phase !== 'complete'; spent++) {
      state =
        state.phase === 'closing'
          ? await this.closeStep(state, options.bounds)
          : await this.disposeStep(state);
      await this.report(state);
    }
    return state;
  }

  private async closeStep(state: RetractionState, bounds?: ClosureBounds): Promise<RetractionState> {
    const { scope, sourceId } = state;
    const result = await this.deps.provenance.revoke(
      scope,
      sourceId,
      state.policyHash,
      state.reasonCode,
      bounds,
    );
    const cancelled = await this.deps.runs.cancelledRuns(scope, result.ids);
    return afterClosure(state, result, cancelled);
  }

  private async disposeStep(state: RetractionState): Promise<RetractionState> {
    const { scope, sourceId } = state;
    const { eligibility, catalog, regeneration, provenance, policy } = this.deps;
    const batchSize = this.deps.disposalBatch ?? 100;
    const rows = await eligibility.listBySource(scope, sourceId, state.disposalCursor, batchSize);
    const outcome: DisposalOutcome = {
      deleted: 0,
      regenerated: 0,
      keptRevoked: 0,
      needsOwner: [],
      cursor: null,
      exhausted: rows.length < batchSize,
    };
    for (const row of rows) {
      outcome.cursor = row.artifactHash;
      if (row.state === 'source_deleted') continue; // already disposed in an earlier run
      const kind: ArtifactKind =
        row.artifactHash === sourceId ? 'raw_source' : await catalog.classify(scope, row.artifactHash);
      const leak = LEAK_REASONS.has(state.reasonCode);
      // A scan hit means prohibited content sits in these bytes: they are removed (or replaced by a non-personal
      // tombstone) before any owner disposition is considered, and `keep_revoked` never keeps them.
      if (leak) await this.deps.purger.purge(scope, row.artifactHash, kind, state.reasonCode);
      const disposition =
        leak && policy.disposition(kind) === 'keep_revoked' ? 'delete' : policy.disposition(kind);
      if (disposition === 'delete') {
        await this.tombstoneIfRaw(scope, row.artifactHash, kind, state);
        await eligibility.markSourceDeleted(scope, row.artifactHash, state.policyHash, state.reasonCode);
        await provenance.append(scope, sourceId, row.artifactHash, 'source_deleted');
        outcome.deleted++;
      } else if (disposition === 'regenerate') {
        await regeneration.enqueue(scope, {
          artifactHash: row.artifactHash,
          kind,
          sourceId,
          policyHash: state.policyHash,
        });
        outcome.regenerated++;
      } else {
        outcome.keptRevoked++;
        outcome.needsOwner.push(row.artifactHash);
      }
    }
    return afterDisposal(state, outcome);
  }

  private async tombstoneIfRaw(
    scope: ScopeKey,
    id: string,
    kind: ArtifactKind,
    state: RetractionState,
  ): Promise<void> {
    if (kind !== 'raw_source') return;
    const found = await this.deps.raw.get(scope, id);
    const sourceKind: SourceKind | null =
      found?.source.kind ?? (await this.deps.raw.getTombstone(scope, id))?.kind ?? null;
    if (!sourceKind) return; // not a registered raw source: nothing of ours to remove
    await this.deps.raw.tombstone(scope, {
      sourceId: id,
      kind: sourceKind,
      deletedAt: (this.deps.now ?? (() => new Date()))(),
      reasonCode: state.reasonCode,
      policyHash: state.policyHash,
      closureId: state.closureId,
    });
  }

  private async report(state: RetractionState): Promise<void> {
    if (!this.deps.projection) return;
    try {
      await this.deps.projection.append(state.scope, {
        eventId: `${state.retractionId}:${state.runId}:${state.step}`,
        jobId: state.retractionId,
        runId: state.retractionId,
        artifactIds: [],
        kind: 'retraction_progress',
        payload: progressPayload(state),
      });
    } catch {
      /* progress reporting never decides the retraction */
    }
  }
}
