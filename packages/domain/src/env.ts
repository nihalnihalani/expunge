import {
  ArtifactRepository,
  AuthorityRepository,
  DecisionRepository,
  EffectRepository,
  JobRepository,
  OutboxRepository,
  ProjectionRepository,
  ScopeRepository,
  WorldRepository,
  ProtocolError,
  requirePrincipal,
  type MongoService,
} from '@expunge/mongo';
import { DecisionLedger, type AuthorityFloor } from '@expunge/governance';
import { IdentityEdgeRepository } from './edge-repository.js';
import { DomainStore } from './store.js';

/**
 * The principals the gateway may run as: the worker's `domain_executor`, and `setup` for the local evidence and
 * administration scripts that drive the same code. Any other principal's client is refused at construction, so a
 * credential with different rights (a grader that can read the private database, a promoter) can never be wrapped in
 * the model-facing gateway.
 */
export const GATEWAY_PRINCIPALS = ['domain_executor', 'setup'] as const;

/** Everything the gateway touches, built from one principal's client. The worker's is `domain_executor`. */
export interface DomainEnv {
  readonly service: MongoService;
  /** The owner floors this process knows, by hash. A run's floor is the one its bundle names, or the run cannot start. */
  readonly floors: readonly AuthorityFloor[];
  floorFor(hash: string): AuthorityFloor;
  readonly clock: () => Date;
  readonly jobs: JobRepository;
  readonly effects: EffectRepository;
  readonly scopes: ScopeRepository;
  readonly worlds: WorldRepository;
  readonly edges: IdentityEdgeRepository;
  readonly store: DomainStore;
  readonly decisions: DecisionRepository;
  readonly ledger: DecisionLedger;
  readonly authority: AuthorityRepository;
  readonly artifacts: ArtifactRepository;
  readonly projections: ProjectionRepository;
  readonly outbox: OutboxRepository;
  /** Operational reports that never reach a model: a projection that could not be written, an unexpected failure. */
  readonly report?: (event: DomainReport) => void;
}

export type DomainReport =
  | { kind: 'projection_failed'; eventKind: string; error: unknown }
  | { kind: 'tool_failed'; toolId: string; error: unknown }
  | { kind: 'job_cancelled_for_authority'; jobId: string; code: string };

export function createDomainEnv(
  service: MongoService,
  options: { floors: readonly AuthorityFloor[]; clock?: () => Date; report?: (event: DomainReport) => void },
): DomainEnv {
  requirePrincipal(service, [...GATEWAY_PRINCIPALS]);
  // No default floor: an environment without one cannot decide anything, which is a configuration error.
  if (!options.floors || options.floors.length === 0) throw new ProtocolError('AuthorityFloorUnknown');
  const clock = options.clock ?? (() => new Date());
  const decisions = new DecisionRepository(service);
  const floors = [...options.floors];
  return {
    service,
    floors,
    floorFor(hash: string): AuthorityFloor {
      const found = floors.find((floor) => floor.hash === hash);
      if (!found) throw new ProtocolError('AuthorityFloorUnknown');
      return found;
    },
    clock,
    jobs: new JobRepository(service),
    effects: new EffectRepository(service),
    scopes: new ScopeRepository(service),
    worlds: new WorldRepository(service),
    edges: new IdentityEdgeRepository(service),
    store: new DomainStore(service),
    decisions,
    ledger: new DecisionLedger(decisions, clock),
    authority: new AuthorityRepository(service),
    artifacts: new ArtifactRepository(service),
    projections: new ProjectionRepository(service),
    outbox: new OutboxRepository(service),
    ...(options.report ? { report: options.report } : {}),
  };
}
