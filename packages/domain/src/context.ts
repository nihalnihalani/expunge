import {
  contentHash,
  type Job,
  type ProjectionEventKind,
  type ProjectionPayloadByKind,
  type ScopeRegistry,
} from '@expunge/contracts';
import type { WorldKey } from '@expunge/mongo';
import { UnknownOwnerPolicy, ownerPolicyFor, type OwnerPolicy } from '@expunge/governance';
import type { HarnessBundle, ActorContext, FieldDescriptor } from '@expunge/contracts';
import type { LeaseBinding, ToolContext } from '@expunge/runtime';
import type { DomainEnv } from './env.js';
import type { DomainStore } from './store.js';
import { classifyFields, visibleEdgeIds, visibleFields, type FieldRole } from './fields.js';
import { ToolRefusal, type RunIdentity, type ToolRuntime } from './runtime.js';

const PHASE_BY_TOOL = {
  inspect_scope: 'inspect',
  resolve_subject: 'resolve',
  discover_references: 'discover',
  preview_cleanup: 'preview',
  apply_cleanup_batch: 'apply',
  verify_registered_scope: 'verify',
  complete_cleanup: 'complete',
  inspect_harness: 'inspect',
  report_diagnostic: 'inspect',
} as const;
export const phaseOf = (toolId: keyof typeof PHASE_BY_TOOL) => PHASE_BY_TOOL[toolId];

/**
 * What the tools of one run may use. Built from the runtime's `ToolContext`, which carries the stored job, the pinned
 * bundle and the lease; the world comes from the job's stored run binding (`worldKeyOf`), never from an argument.
 */
export class RunContext implements ToolRuntime {
  readonly job: Job;
  readonly bundle: HarnessBundle;
  readonly actor: ActorContext;
  readonly lease: LeaseBinding;
  readonly signal: AbortSignal;
  readonly store: DomainStore;
  readonly run: RunIdentity;
  private registryCache: Promise<ScopeRegistry> | null = null;
  private policyCache: OwnerPolicy | null = null;
  private rolesCache: ReadonlyMap<string, FieldRole> | null = null;

  private constructor(
    readonly env: DomainEnv,
    context: ToolContext,
    stored: Job,
    readonly world: WorldKey,
  ) {
    this.store = env.store.fenced((session) =>
      env.jobs.fence(context.actor, context.lease, session).then(() => undefined),
    );
    // Everything about the run comes from the job row as stored; the object the runtime passed only carries the lease.
    this.job = stored;
    this.bundle = context.bundle;
    this.actor = context.actor;
    this.lease = context.lease;
    this.signal = context.signal;
    this.run = {
      jobId: stored._id,
      runId: stored.binding.runId,
      harnessHash: stored.binding.harnessHash,
      worldId: stored.binding.worldId,
      scopeRevision: stored.binding.scopeRevision,
    };
  }

  /**
   * The world capability is minted from the job row as stored, not from the job object the runtime handed over, and
   * the bundle must be the one the stored job is pinned to.
   */
  static async open(env: DomainEnv, context: ToolContext): Promise<RunContext> {
    const stored = await env.jobs.readAuthorized(context.actor, context.job._id);
    if (contentHash(context.bundle) !== stored.binding.harnessHash)
      throw new ToolRefusal('BundleBindingMismatch');
    const world = await env.jobs.worldKey(context.actor, stored._id);
    return new RunContext(env, context, stored, world);
  }

  registry(): Promise<ScopeRegistry> {
    // The registry revision is the one the run was bound to; a newer revision never reaches a running job.
    this.registryCache ??= this.env.scopes.read(this.actor, this.run.scopeRevision);
    return this.registryCache;
  }
  async ownerPolicy(): Promise<OwnerPolicy> {
    if (this.policyCache) return this.policyCache;
    try {
      this.policyCache = ownerPolicyFor(await this.registry());
    } catch (error) {
      if (error instanceof UnknownOwnerPolicy) throw new ToolRefusal('UnknownOwnerPolicy');
      throw error;
    }
    return this.policyCache;
  }
  async fieldRoles(): Promise<ReadonlyMap<string, FieldRole>> {
    this.rolesCache ??= classifyFields(await this.registry(), await this.ownerPolicy());
    return this.rolesCache;
  }
  async selection(): Promise<ReadonlySet<string>> {
    const step = await this.store.latestStep(this.actor, this.job._id, 'scope_selection');
    return new Set(step?.payload.fieldIds ?? []);
  }
  async visible(): Promise<{ fields: FieldDescriptor[]; edgeIds: string[] }> {
    const registry = await this.registry();
    const fields = visibleFields(
      registry,
      this.bundle.contextPolicy,
      await this.fieldRoles(),
      await this.selection(),
    );
    return { fields, edgeIds: visibleEdgeIds(registry, fields) };
  }
  async worldRevision(): Promise<number> {
    return (await this.env.worlds.read(this.actor, this.run.worldId)).revision;
  }
  async emit<K extends ProjectionEventKind>(
    kind: K,
    eventId: string,
    payload: ProjectionPayloadByKind[K],
    artifactIds: string[] = [],
  ): Promise<void> {
    try {
      await this.env.projections.append(this.actor, {
        eventId,
        jobId: this.run.jobId,
        runId: this.run.runId,
        artifactIds,
        kind,
        payload,
      } as never);
    } catch (error) {
      // A projection is a view of committed state; failing to write one never changes what happened.
      this.env.report?.({ kind: 'projection_failed', eventKind: kind, error });
    }
  }
}
