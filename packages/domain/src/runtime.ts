import type {
  ActorContext,
  FieldDescriptor,
  HarnessBundle,
  Job,
  ProjectionEventKind,
  ProjectionPayloadByKind,
  ScopeRegistry,
} from '@expunge/contracts';
import type { WorldKey } from '@expunge/mongo';
import type { OwnerPolicy } from '@expunge/governance';
import type { LeaseBinding } from '@expunge/runtime';
import type { DomainEnv } from './env.js';
import type { DomainStore } from './store.js';
import type { FieldRole } from './fields.js';

/** A refusal the model can act on: a closed code and nothing else. Anything richer would leak state. */
export class ToolRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ToolRefusal';
  }
}

export type RunIdentity = {
  jobId: string;
  runId: string;
  harnessHash: string;
  worldId: string;
  scopeRevision: number;
};

/** What one tool implementation may use. Built from the stored job; nothing in it comes from the model. */
export interface ToolRuntime {
  readonly env: DomainEnv;
  /** The gateway's step log, fenced on this run's lease: a session that lost the lease cannot write to it. */
  readonly store: DomainStore;
  readonly job: Job;
  readonly bundle: HarnessBundle;
  readonly actor: ActorContext;
  readonly lease: LeaseBinding;
  readonly world: WorldKey;
  readonly run: RunIdentity;
  readonly signal: AbortSignal;
  registry(): Promise<ScopeRegistry>;
  ownerPolicy(): Promise<OwnerPolicy>;
  fieldRoles(): Promise<ReadonlyMap<string, FieldRole>>;
  /** Fields chosen through `inspect_scope` under `inspect_then_select`. */
  selection(): Promise<ReadonlySet<string>>;
  /** Fields and reference edges this run may see, as its context policy defines. */
  visible(): Promise<{ fields: FieldDescriptor[]; edgeIds: string[] }>;
  worldRevision(): Promise<number>;
  /** Appends a sanitized projection event after the action it describes. Never throws. */
  emit<K extends ProjectionEventKind>(
    kind: K,
    eventId: string,
    payload: ProjectionPayloadByKind[K],
    artifactIds?: string[],
  ): Promise<void>;
}
