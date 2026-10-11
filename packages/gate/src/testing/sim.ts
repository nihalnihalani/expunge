/**
 * SCRIPTED / FAKE EPISODE PORT. A deterministic stand-in for the worker, for protocol tests of the gate only.
 *
 * It is NOT the worker: it never runs a model, a runtime or the domain gateway. It solves a world with the grader's own
 * reference solver, or damages it on purpose, depending on what a test tells it to do for a bundle. Its output is not
 * model evidence and not evidence about the real worker path. By default it declares itself `fake`, which makes the
 * gate hold. A test that needs the admission rule to be applied end to end can have it DECLARE committed evidence; that
 * declaration is the same self-attestation the real rule must not trust, so such a port is labeled accordingly and never
 * leaves tests.
 */
import { faultPlanHash } from '@expunge/domain';
import { addressKey, COLLECTION_IDS, type VisibleWorld } from '@expunge/fixtures';
import { runReference } from '@expunge/grader';
import {
  ZERO_COST,
  type EpisodePort,
  type EpisodeRequest,
  type EpisodeResult,
  type WorkerProfile,
} from '../types.js';

export const SCRIPTED_PORT_LABEL =
  'SCRIPTED/FAKE EPISODE PORT: deterministic stand-in for the worker; not a model';
export const SCRIPTED_COMMITTED_LABEL =
  'SCRIPTED/FAKE EPISODE PORT DECLARING COMMITTED EVIDENCE: admission-rule protocol tests only; not the worker';

export type Behavior =
  | 'solve'
  /** Leaves the world as it was and claims completion: the false completion of a harness that never verifies. */
  | 'claim_without_work'
  | 'blanket_delete'
  | 'blanket_refuse'
  | 'half_solve'
  | 'collateral'
  | 'fail'
  | 'cancel'
  | 'timeout'
  | 'throw'
  | 'hang'
  /** A failed run that nevertheless left a perfect world and claims completion (must never count as a success). */
  | 'failed_but_correct'
  | 'infra_failure'
  /** Damages a record the cleanup must not touch, then ends with a provider server error. */
  | 'collateral_then_infra';

export type ScriptedOptions = {
  /** Decides the behavior of each run from the request (bundle hash, run label, ...). */
  behavior: (request: EpisodeRequest) => Behavior;
  profile?: Partial<WorkerProfile>;
  /** What the port claims about itself. The default is the honest one: a fake. */
  declare?: { kind: 'worker'; modelKind: 'provider'; evidence: 'committed' };
  /** The runtime hash the stand-in attests per run (default none). A function can attest differently per run. */
  runtimeHash?: string | ((request: EpisodeRequest) => string | undefined);
  /** How the fault attestation misbehaves, if at all. */
  faultDefect?: (request: EpisodeRequest) => 'mismatch' | 'not_injected' | undefined;
  cost?: (request: EpisodeRequest) => Partial<EpisodeResult['cost']>;
  /** Writes the stored facts a real worker would have committed for this run (a job row). Tests supply it. */
  recordJob?: (request: EpisodeRequest, result: EpisodeResult, jobId: string) => Promise<void>;
  delayMs?: number;
  /** Awaited at the start of every run: lets a test hold runs until it has observed real overlap. */
  gate?: (request: EpisodeRequest) => Promise<void>;
};

export class ScriptedEpisodePort implements EpisodePort {
  readonly kind: 'worker' | 'fake';
  readonly label: string;
  readonly profile: WorkerProfile;
  readonly requests: EpisodeRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly options: ScriptedOptions) {
    this.kind = options.declare ? 'worker' : 'fake';
    this.label = options.declare ? SCRIPTED_COMMITTED_LABEL : SCRIPTED_PORT_LABEL;
    this.profile = {
      profileId: 'scripted-profile',
      modelId: 'scripted-model',
      modelKind: options.declare ? 'provider' : 'fake',
      ...(options.declare ? { provider: 'scripted-provider' } : {}),
      params: { temperature: 0 },
      ...options.profile,
    };
  }

  async run(request: EpisodeRequest): Promise<EpisodeResult> {
    this.requests.push(request);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.options.gate?.(request);
      if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      const result = await this.execute(request);
      if (this.options.recordJob) {
        const jobId = `job_${request.runId}`;
        await this.options.recordJob(request, result, jobId);
        return { ...result, jobId };
      }
      return result;
    } finally {
      this.inFlight--;
    }
  }

  private execute(request: EpisodeRequest): EpisodeResult {
    const behavior = this.options.behavior(request);
    const evidence: EpisodeResult['evidence'] = this.options.declare ? 'committed' : 'fake';
    const planned = request.faults;
    const plannedCount =
      planned.transientFailures +
      planned.partialAcknowledgements +
      (planned.interruptAfterEffects === null ? 0 : 1);
    const defect = this.options.faultDefect?.(request);
    const attestedPlanHash =
      defect === 'mismatch'
        ? 'f'.repeat(64)
        : faultPlanHash(request.instanceScope, request.world.worldId, planned);
    const base = {
      cost: {
        ...ZERO_COST,
        modelCalls: 4,
        toolCalls: 6,
        inputTokens: 900,
        outputTokens: 300,
        wallTimeMs: 1200,
        ...this.options.cost?.(request),
      },
      retryFailures: 0,
      evidence,
      ...(this.runtimeValue(request) ? { runtimeHash: this.runtimeValue(request)! } : {}),
      faults: {
        attestedPlanHash,
        injected:
          defect === 'not_injected'
            ? { transient: 0, lostAck: 0, interrupted: 0 }
            : {
                transient: planned.transientFailures,
                lostAck: planned.partialAcknowledgements,
                interrupted: planned.interruptAfterEffects === null ? 0 : 1,
              },
      },
    };
    void plannedCount;
    const solved = () => runReference(request.world).world;
    const done = (
      world: VisibleWorld | null,
      over: Partial<EpisodeResult> & Pick<EpisodeResult, 'outcome' | 'terminal'>,
    ): EpisodeResult => ({ ...base, world, ...over });
    const complete = { status: 'complete', claim: 'all_targets' } as const;
    const incomplete = { status: 'incomplete', claim: 'all_targets' } as const;
    switch (behavior) {
      case 'solve':
        return done(solved(), { outcome: 'completed', terminal: complete });
      case 'claim_without_work':
        return done(structuredClone(request.world), { outcome: 'completed', terminal: complete });
      case 'blanket_delete':
        return done(blanketDelete(request.world), { outcome: 'completed', terminal: complete });
      case 'blanket_refuse':
        return done(structuredClone(request.world), {
          outcome: 'refused',
          terminal: { status: 'refused', claim: 'all_targets' },
        });
      case 'half_solve':
        return done(halfSolve(request.world), { outcome: 'completed', terminal: complete });
      case 'collateral':
        return done(collateral(solved()), { outcome: 'completed', terminal: complete });
      case 'fail':
        return done(structuredClone(request.world), {
          outcome: 'failed',
          failureCode: 'JobFailed',
          terminal: incomplete,
        });
      case 'infra_failure':
        return done(null, {
          outcome: 'failed',
          failureCode: 'CommittedStateUnreadable',
          terminal: incomplete,
        });
      case 'collateral_then_infra':
        return done(collateral(solved()), {
          outcome: 'failed',
          failureCode: 'ProviderServerError',
          terminal: incomplete,
        });
      case 'cancel':
        return done(structuredClone(request.world), {
          outcome: 'cancelled',
          failureCode: 'RunCancelled',
          terminal: incomplete,
        });
      case 'timeout':
        return done(structuredClone(request.world), {
          outcome: 'timed_out',
          failureCode: 'WallTimeExceeded',
          terminal: incomplete,
        });
      case 'failed_but_correct':
        return done(solved(), { outcome: 'failed', failureCode: 'JobFailed', terminal: complete });
      case 'throw':
        throw Object.assign(new Error('scripted port failure with detail that must not be echoed'), {
          name: 'ScriptedPortFailure',
        });
      case 'hang':
        return new Promise<EpisodeResult>(() => undefined) as unknown as EpisodeResult;
    }
  }

  private runtimeValue(request: EpisodeRequest): string | undefined {
    const value = this.options.runtimeHash;
    return typeof value === 'function' ? value(request) : value;
  }
}

function blanketDelete(world: VisibleWorld): VisibleWorld {
  const copy = structuredClone(world);
  for (const id of COLLECTION_IDS) copy.collections[id] = [];
  return copy;
}
function halfSolve(world: VisibleWorld): VisibleWorld {
  const full = runReference(world);
  const half = structuredClone(world);
  const keep = new Set(
    full.plan.actions
      .slice(0, Math.ceil(full.plan.actions.length / 2))
      .map((action) => addressKey(action.address)),
  );
  const applied = runReference(world).world;
  for (const id of COLLECTION_IDS)
    half.collections[id] = world.collections[id].map((document) => {
      const key = addressKey({ collectionId: id, recordId: document._id });
      if (!full.plan.actions.some((action) => addressKey(action.address) === key)) return document;
      if (!keep.has(key)) return document;
      return applied.collections[id].find((candidate) => candidate._id === document._id) ?? document;
    });
  // A delete removes the record entirely: drop records the kept actions delete.
  for (const id of COLLECTION_IDS)
    half.collections[id] = half.collections[id].filter(
      (document) =>
        !full.plan.actions.some(
          (action) =>
            action.address.collectionId === id &&
            action.address.recordId === document._id &&
            action.effect === 'delete' &&
            keep.has(addressKey(action.address)),
        ),
    );
  return half;
}
function collateral(world: VisibleWorld): VisibleWorld {
  const copy = structuredClone(world);
  // Damage a record the cleanup must not touch: its display name.
  const victim = copy.collections.customers.find((document) => document.data.displayName !== undefined);
  const untouched = copy.collections.customers.slice(-1)[0] ?? victim;
  if (untouched) untouched.data = { ...untouched.data, displayName: 'changed-by-scripted-collateral' };
  return copy;
}
