/**
 * FAKE test doubles for the runtime's ports. Everything exported here is an in-memory stand-in used
 * only by protocol tests; none of it proves anything about MongoDB, Atlas or a model provider.
 */
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import {
  assertJobAccess,
  contentHash,
  type ActorContext,
  type ArtifactEnvelope,
  type HarnessBundle,
  type Job,
  type JobStatus,
  type JsonValue,
  type ScopeKey,
} from '@expunge/contracts';
import { ProtocolError } from '@expunge/mongo';
import { lastValueFrom, toArray, type Observable } from 'rxjs';
import { validBundle } from '../../contracts/test/valid-bundle.js';
import type {
  ArtifactReader,
  ExecutionDependencies,
  ExecutionHooks,
  JobPort,
  LeaseBinding,
  ModelResolver,
  ToolContext,
  ToolProvider,
  WaitStatus,
} from '../src/index.js';
import type { ToolDefinition } from '@expunge/vendor-openmuse';

export const ACTOR: ActorContext = {
  actorId: 'owner',
  tenantId: 'tenant-1',
  env: 'evaluation',
  scopeId: 'scope-1',
  authorizationRevision: 1,
};
export const OWNER_ID = 'worker-test-1';
export const FENCE = 3;

export function makeBundle(over: Partial<HarnessBundle> = {}): HarnessBundle {
  return { ...validBundle(), toolPolicy: { grants: ['probe', 'echo'], prerequisites: [] }, ...over };
}

export function makeJob(bundle: HarnessBundle, over: Partial<Job> = {}): Job {
  const harnessHash = contentHash(bundle);
  const now = new Date();
  return {
    _id: 'job-1',
    kind: 'cleanup',
    actor: ACTOR,
    binding: {
      jobId: 'job-1',
      runId: 'run-1',
      worldId: 'world-1',
      harnessHash,
      scopeRevision: 1,
      workerProfileHash: 'b'.repeat(64),
    },
    parentJobId: null,
    checkpoint: null,
    status: 'running',
    cancellationRequested: false,
    lease: { ownerId: OWNER_ID, fence: FENCE, until: new Date(now.getTime() + 60_000), heartbeatAt: now },
    commitSeq: 0,
    eventSeq: 0,
    attempt: 1,
    priority: 0,
    inputRefs: [],
    outputRefs: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Job;
}

export const LEASE: LeaseBinding = { jobId: 'job-1', ownerId: OWNER_ID, fence: FENCE };

let leaseCounter = 0;
/** A distinct lease per test rig: the agent keeps a process-wide single-run guard per (job, owner, fence). */
export function freshLease(): LeaseBinding {
  return { jobId: 'job-1', ownerId: `${OWNER_ID}-${++leaseCounter}`, fence: FENCE };
}
/** A running job held under exactly `lease`. */
export function makeJobFor(bundle: HarnessBundle, lease: LeaseBinding, over: Partial<Job> = {}): Job {
  const now = new Date();
  return makeJob(bundle, {
    lease: {
      ownerId: lease.ownerId,
      fence: lease.fence,
      until: new Date(now.getTime() + 60_000),
      heartbeatAt: now,
    },
    ...over,
  });
}

/** FAKE in-memory job store that enforces the same fence/cancel predicates as JobRepository. */
export class FakeJobStore implements JobPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly checkpoints: JsonValue[] = [];
  constructor(public job: Job) {}
  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  private live(lease: LeaseBinding) {
    if (
      this.job.status !== 'running' ||
      this.job.cancellationRequested ||
      this.job.lease.ownerId !== lease.ownerId ||
      this.job.lease.fence !== lease.fence
    )
      throw new ProtocolError('LostLease');
  }
  async readAuthorized(actor: ActorContext, jobId: string): Promise<Job> {
    this.record('readAuthorized', jobId);
    if (jobId !== this.job._id) throw new ProtocolError('JobNotFound');
    assertJobAccess(actor, this.job);
    return structuredClone(this.job);
  }
  async checkpoint(_actor: ActorContext, lease: LeaseBinding, checkpoint: JsonValue): Promise<void> {
    this.record('checkpoint', checkpoint);
    this.live(lease);
    this.checkpoints.push(checkpoint);
  }
  async yield(_actor: ActorContext, lease: LeaseBinding, status: WaitStatus): Promise<void> {
    this.record('yield', status);
    this.live(lease);
    this.job.status = status;
    this.job.lease.until = new Date(0);
  }
  async finish(
    _actor: ActorContext,
    lease: LeaseBinding,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    outputRefs: string[],
  ): Promise<void> {
    this.record('finish', status, outputRefs);
    if (status === 'cancelled') {
      if (!this.job.cancellationRequested) throw new ProtocolError('LostLease');
    } else this.live(lease);
    if (
      this.job.status !== 'running' ||
      this.job.lease.ownerId !== lease.ownerId ||
      this.job.lease.fence !== lease.fence
    )
      throw new ProtocolError('LostLease');
    this.job.status = status;
    this.job.outputRefs = outputRefs;
    this.job.lease.until = new Date(0);
  }
  named(method: string) {
    return this.calls.filter((call) => call.method === method);
  }
}

/** FAKE artifact reader keyed by hash; records which hashes were asked for and under which scope. */
export class FakeArtifactReader implements ArtifactReader {
  readonly reads: Array<{ key: ScopeKey; hash: string }> = [];
  private readonly store = new Map<string, HarnessBundle>();
  constructor(...bundles: HarnessBundle[]) {
    for (const bundle of bundles) this.store.set(contentHash(bundle), bundle);
  }
  async readPermitted(key: ScopeKey, hash: string): Promise<ArtifactEnvelope<HarnessBundle>> {
    this.reads.push({ key, hash });
    const payload = this.store.get(hash);
    if (!payload) throw new ProtocolError('ArtifactIneligible');
    return { _id: hash, payload, createdAt: new Date(), sourceBlobIds: [] };
  }
}

export class FakeToolProvider implements ToolProvider {
  readonly contexts: ToolContext[] = [];
  constructor(private readonly make: (context: ToolContext) => ToolDefinition[]) {}
  create(context: ToolContext): ToolDefinition[] {
    this.contexts.push(context);
    return this.make(context);
  }
}

export class FixedModelResolver implements ModelResolver {
  constructor(private readonly selection: ReturnType<ModelResolver['select']>) {}
  select() {
    return this.selection;
  }
}

export function runInput(over: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 'job-1',
    runId: 'run-1',
    state: {},
    messages: [{ id: 'm1', role: 'user', content: 'Begin cleanup job job-1.' }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...over,
  };
}

export const collect = (events: Observable<BaseEvent>) => lastValueFrom(events.pipe(toArray()));
export const typesOf = (events: BaseEvent[]) => events.map((event) => event.type as string);

export async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function baseDeps(
  parts: Pick<ExecutionDependencies, 'jobs' | 'artifacts' | 'tools' | 'models'> & {
    hooks?: ExecutionHooks;
  } & Partial<ExecutionDependencies>,
): ExecutionDependencies {
  return { ...parts };
}
