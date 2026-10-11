import type { ObserverQueryIdentity, ScopeKey } from '@expunge/contracts';
import {
  IngestClient,
  raindropQueryConfigFromEnv,
  raindropWriteConfigFromEnv,
  type LeakGuard,
} from '@expunge/observability';
import {
  ObserverCursorRepository,
  OutboxRepository,
  PRINCIPAL_URI_VARIABLES,
  ProjectionRepository,
  createPrincipalService,
  mongoConfigFromEnv,
  type MongoService,
} from '@expunge/mongo';
import { MongoEvidenceStore } from './evidence.js';
import {
  OutboxDispatcher,
  type DispatchOutcome,
  type DispatcherOptions,
  type ExportSuppression,
} from './outbox-dispatcher.js';
import { RaindropQueryClient } from './query-client.js';
import { ObserverRunner, buildQueryIdentity, type ScanOptions, type ScanResult } from './scan.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whether the Raindrop evidence path can run in this process, stated from configuration alone.
 *  - `blocked`: something it needs is missing. The blockers are NAMES (variables or sources), never values.
 *  - `live`: every key is present and no endpoint is overridden. Configured is not delivered: nothing here proves a
 *    byte reached Raindrop until a run reads it back.
 *  - `local_fake`: an ingest or query URL is overridden, so the process talks to something that is NOT Raindrop
 *    (a labeled FAKE server in tests). Its output is never evidence of Raindrop delivery.
 */
export type EvidenceReadiness = {
  status: 'READY' | 'BLOCKED';
  mode: 'live' | 'local_fake' | 'blocked';
  blockers: Array<{ name: string; detail: string }>;
  lines: string[];
};

export type EvidenceSources = {
  /**
   * The leak guard the observer and dispatcher run with: subject literals and the grader's private-id set. It comes from
   * the privacy controller; the observer principal cannot read the subject map itself.
   */
  guard?: LeakGuard;
  /** The provider-organization export suppression source (erasure_suppressions read, PKT-62). Absent => BLOCKED. */
  suppression?: ExportSuppression;
};

export function evidenceReadiness(env: Env, sources: EvidenceSources = {}): EvidenceReadiness {
  const blockers: EvidenceReadiness['blockers'] = [];
  const write = raindropWriteConfigFromEnv(env);
  const query = raindropQueryConfigFromEnv(env);
  for (const name of write.ok ? [] : write.missing)
    blockers.push({ name, detail: 'Raindrop ingestion (write) credential or project' });
  for (const name of query.ok ? [] : query.missing)
    if (!blockers.some((b) => b.name === name))
      blockers.push({ name, detail: 'Raindrop Query (read-back) credential or project' });
  if (!env[PRINCIPAL_URI_VARIABLES.observer]?.trim())
    blockers.push({
      name: PRINCIPAL_URI_VARIABLES.observer,
      detail: 'the observer principal; no fallback to another URI',
    });
  for (const name of ['EXPUNGE_TENANT_ID', 'EXPUNGE_ENV', 'EXPUNGE_SCOPE_ID'])
    if (!env[name]?.trim()) blockers.push({ name, detail: 'the one scope this process serves' });
  if (!env.RAINDROP_ORGANIZATION_ID?.trim())
    blockers.push({
      name: 'RAINDROP_ORGANIZATION_ID',
      detail:
        'the provider organization the export suppression is read for (configured, not provider-verified)',
    });
  if (!sources.suppression)
    blockers.push({
      name: 'export suppression source',
      detail: 'erasure_suppressions read (PKT-62); until it exists event intents are HELD, never sent',
    });
  if (!sources.guard)
    blockers.push({
      name: 'leak guard source',
      detail: 'forbidden literals and private ids exported by the privacy controller',
    });
  const overridden = Boolean(env.RAINDROP_INGEST_URL?.trim() || env.RAINDROP_QUERY_URL?.trim());
  const mode: EvidenceReadiness['mode'] = blockers.length ? 'blocked' : overridden ? 'local_fake' : 'live';
  const lines = blockers.length
    ? blockers.map((b) => `BLOCKED: evidence (${b.name}: ${b.detail})`)
    : mode === 'local_fake'
      ? [
          'READY (LOCAL FAKE): endpoints are overridden, so this talks to a stand-in, not Raindrop; no Raindrop delivery is claimed.',
        ]
      : ['READY (configured): keys present. Delivery to Raindrop is not verified until a run is read back.'];
  return { status: blockers.length ? 'BLOCKED' : 'READY', mode, blockers, lines };
}

export type EvidenceLog = (entry: {
  level: 'info' | 'warn' | 'error';
  message: string;
  code?: string;
}) => void;

export type ObserverWindow = {
  filter: { eventName?: string; properties?: Record<string, string | number | boolean> };
  windowStart: string;
  windowEnd: string;
  observerVersion?: string;
  overlapMs?: number;
};

export type EvidenceProcessDeps = {
  dispatcher: OutboxDispatcher;
  observer?: { runner: ObserverRunner; identity: ObserverQueryIdentity; options: ScanOptions };
  log?: EvidenceLog;
};

/**
 * The running evidence path: drains the telemetry outbox through the dispatcher (the delivery ladder) and pages the
 * Query API through the observer under its fixed identity. Neither step can throw out of the loop: a failure is logged
 * by class name and retried on the next tick; the durable state (outbox rows, cursor revisions) is what carries on.
 */
export class EvidenceProcess {
  private dispatchTimer?: ReturnType<typeof setInterval>;
  private scanTimer?: ReturnType<typeof setInterval>;
  private busy = { dispatch: false, scan: false };
  constructor(private readonly deps: EvidenceProcessDeps) {}

  private log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
    this.deps.log?.({ level, message, ...(error instanceof Error ? { code: error.name } : {}) });
  }

  /** Processes due outbox rows until none is due or `max` rows were handled. */
  async drain(max = 100): Promise<DispatchOutcome[]> {
    const outcomes: DispatchOutcome[] = [];
    for (let i = 0; i < max; i++) {
      let outcome: DispatchOutcome | null;
      try {
        outcome = await this.deps.dispatcher.runOnce();
      } catch (error) {
        this.log('warn', 'outbox dispatch failed; retried on the next tick', error);
        break;
      }
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** One pass over the fixed observer window. Null when no observer is configured. */
  async scan(): Promise<ScanResult | null> {
    const observer = this.deps.observer;
    if (!observer) return null;
    try {
      return await observer.runner.runOnce(observer.identity, observer.options);
    } catch (error) {
      this.log('warn', 'observer scan failed; resumed from the committed cursor on the next tick', error);
      return null;
    }
  }

  start(everyMs: { dispatch: number; scan: number }): void {
    if (this.dispatchTimer) return;
    const guarded = (key: 'dispatch' | 'scan', work: () => Promise<unknown>) => () => {
      if (this.busy[key]) return;
      this.busy[key] = true;
      void work().finally(() => void (this.busy[key] = false));
    };
    this.dispatchTimer = setInterval(
      guarded('dispatch', () => this.drain()),
      everyMs.dispatch,
    );
    this.scanTimer = setInterval(
      guarded('scan', () => this.scan()),
      everyMs.scan,
    );
    this.dispatchTimer.unref?.();
    this.scanTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.dispatchTimer);
    clearInterval(this.scanTimer);
    this.dispatchTimer = undefined;
    this.scanTimer = undefined;
  }
}

export type StartedEvidence =
  | { status: 'BLOCKED'; readiness: EvidenceReadiness }
  | { status: 'READY'; readiness: EvidenceReadiness; process: EvidenceProcess; service: MongoService };

/**
 * Builds the process from the environment: its own `observer` principal (no fallback), the write key for ingestion and the
 * SEPARATE read key for the Query API, one scope, the REQUIRED suppression source and leak guard. With anything missing it
 * returns BLOCKED with the blocker names and builds nothing, so a missing source can never become an empty list.
 */
export function createEvidenceProcess(
  env: Env,
  sources: EvidenceSources,
  options: {
    ownerId?: string;
    /** Tests inject an already-connected observer service; production builds its own from `MONGODB_OBSERVER_URI`. */
    service?: MongoService;
    window?: ObserverWindow;
    scan?: Partial<ScanOptions>;
    /** Dispatcher tuning (lease, attempt bound, backoff, hold timeout). Defaults are the dispatcher's own. */
    dispatcher?: Partial<Omit<DispatcherOptions, 'ownerId'>>;
    log?: EvidenceLog;
  } = {},
): StartedEvidence {
  const readiness = evidenceReadiness(env, sources);
  if (readiness.status === 'BLOCKED' || !sources.guard || !sources.suppression)
    return { status: 'BLOCKED', readiness };
  const write = raindropWriteConfigFromEnv(env);
  const query = raindropQueryConfigFromEnv(env);
  if (!write.ok || !query.ok) return { status: 'BLOCKED', readiness };
  const scope: ScopeKey = {
    tenantId: env.EXPUNGE_TENANT_ID!.trim(),
    env: env.EXPUNGE_ENV!.trim() as ScopeKey['env'],
    scopeId: env.EXPUNGE_SCOPE_ID!.trim(),
  };
  const service = options.service ?? createPrincipalService(mongoConfigFromEnv(env), 'observer');
  const queryClient = new RaindropQueryClient({
    queryKey: query.config.queryKey,
    projectId: query.config.projectId,
    ...(query.config.baseUrl ? { baseUrl: query.config.baseUrl } : {}),
  });
  const evidence = new MongoEvidenceStore(service);
  const dispatcher = new OutboxDispatcher(
    {
      outbox: new OutboxRepository(service),
      ingest: new IngestClient({
        writeKey: write.config.writeKey,
        projectId: write.config.projectId,
        ...(write.config.endpoint ? { baseUrl: write.config.endpoint } : {}),
      }),
      query: queryClient,
      evidence,
      transaction: (work) => service.transaction(work),
      scope,
      projectId: query.config.projectId,
      guard: sources.guard,
      suppression: sources.suppression,
      providerOrganizationId: env.RAINDROP_ORGANIZATION_ID!.trim(),
      projection: new ProjectionRepository(service),
    },
    { ...options.dispatcher, ownerId: options.ownerId ?? `evidence-${process.pid}` },
  );
  const window = options.window;
  const observer = window
    ? {
        runner: new ObserverRunner({
          client: queryClient,
          cursors: new ObserverCursorRepository(service),
          evidence,
          transaction: (work) => service.transaction(work),
          scope,
          guard: sources.guard,
        }),
        identity: buildQueryIdentity({
          projectId: query.config.projectId,
          observerVersion: window.observerVersion ?? 'v1',
          filter: window.filter,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          overlapMs: window.overlapMs ?? 60_000,
        }),
        options: { requiredFields: ['assistant_output'], ...options.scan },
      }
    : undefined;
  return {
    status: 'READY',
    readiness,
    service,
    process: new EvidenceProcess({
      dispatcher,
      ...(observer ? { observer } : {}),
      ...(options.log ? { log: options.log } : {}),
    }),
  };
}
