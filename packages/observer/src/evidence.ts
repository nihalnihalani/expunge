import { createHash } from 'node:crypto';
import { contentHash, type ScopeKey } from '@expunge/contracts';
import {
  DEFAULT_ALLOWED_STRING_KEYS,
  DEFAULT_SANITIZATION,
  detectLeak,
  isTelemetryUserId,
  requireGuard,
  sanitizeProperty,
  sanitizeValue,
  type LeakCode,
  type LeakGuard,
  type SanitizationPolicy,
} from '@expunge/observability';
import type { ClientSession, Document } from 'mongodb';
import type { MongoService } from '@expunge/mongo';
import type { RaindropEvent, RaindropSpan } from './query-client.js';

/** Remote fields an evidence consumer can require. `spans` means the trace was read (not truncated is separate). */
export const EVIDENCE_FIELDS = [
  'user_input',
  'assistant_output',
  'tool_calls',
  'signals',
  'error_spans',
  'topics',
  'spans',
] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

const sha = (text: string | null | undefined) =>
  text ? createHash('sha256').update(text).digest('hex').slice(0, 32) : null;

export type SpanSummary = {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  type: string;
  status: string | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

/**
 * What the observer remembers about one remote event at one moment. It holds HASHES and structure, never the remote
 * text: the evidence store is not a second copy of the telemetry, and witnesses are assembled from sanitized values
 * at bundle time, not read from here.
 */
export type EvidenceObservation = {
  provider: 'raindrop';
  projectId: string;
  externalEventId: string;
  observedAt: Date;
  contentHash: string;
  presentFields: EvidenceField[];
  potentiallyTruncated: boolean;
  /**
   * Set when the remote event tripped the leak guard (a held-out key, a subject literal or a private id anywhere in
   * it). A quarantined observation is structure only, has no present fields and can never become evidence.
   */
  quarantined?: LeakCode;
  event: {
    eventName: string;
    timestamp: string;
    userId: string | null;
    convoId: string | null;
    properties: Record<string, unknown>;
    featureFlags: Record<string, unknown>;
    userInputSha: string | null;
    assistantOutputSha: string | null;
    signals: Array<{ id: string; name: string; score: number | null }>;
    toolCallNames: string[];
    errorSpanCount: number;
    topicCount: number;
  };
  spans: SpanSummary[];
};

export function presentFieldsOf(event: RaindropEvent, spans?: RaindropSpan[]): EvidenceField[] {
  const present: EvidenceField[] = [];
  if (event.user_input) present.push('user_input');
  if (event.assistant_output) present.push('assistant_output');
  if (event.tool_calls?.length) present.push('tool_calls');
  if (event.signals?.length) present.push('signals');
  if (event.error_spans?.length) present.push('error_spans');
  if (event.topics?.length) present.push('topics');
  if (spans?.length) present.push('spans');
  return present;
}

export function missingFields(required: readonly string[], present: readonly string[]): string[] {
  return required.filter((field) => !present.includes(field));
}

/** Event property keys this system writes itself; their identifier-shaped values may be stored as they are. */
export const OBSERVED_STRING_KEYS: readonly string[] = [
  ...DEFAULT_ALLOWED_STRING_KEYS,
  'run_id',
  'job_id',
  'harness_hash',
  'worker_profile_hash',
  'world_id',
  'role',
  'attempt',
  'outcome',
  'ended_by',
  'error_code',
  'completion_policy',
  'evidence_arm',
  'origin',
  'evaluation_id',
  'proposal_id',
  'gate_report_id',
  'dedupe_key',
  'severity',
  'tool_call_id',
  'detail_sha256',
];

export function observationPolicy(guard: LeakGuard): SanitizationPolicy {
  return {
    ...DEFAULT_SANITIZATION,
    allowStringKeys: OBSERVED_STRING_KEYS,
    forbiddenLiterals: guard.forbiddenLiterals,
  };
}

/**
 * Reduces one remote event (and optionally its trace) to what the observer may remember: hashes and structure.
 * Remote properties are written by anyone holding the write key (or added by the vendor), so NOTHING is kept as
 * received: strings pass only as identifiers under keys this system writes, everything else becomes a hash; the user
 * id must be an opaque telemetry id. If the raw event trips the leak guard the result is a QUARANTINED, structure-only
 * observation instead of an error, so one poisoned event cannot stall the page transaction and the cursor behind it.
 */
export function observeEvent(
  projectId: string,
  event: RaindropEvent,
  options: {
    guard: LeakGuard;
    traces?: { spans: RaindropSpan[]; potentiallyTruncated: boolean };
    now?: Date;
  },
): EvidenceObservation {
  requireGuard(options.guard);
  const { guard, traces } = options;
  const now = options.now ?? new Date();
  const policy = observationPolicy(guard);
  const { $context: _context, ...rawProperties } = event.properties as Record<string, unknown>;
  const potentiallyTruncated = traces?.potentiallyTruncated ?? false;
  const finding = detectLeak(
    {
      eventName: event.event_name,
      userId: event.user_id,
      convoId: event.convo_id,
      properties: rawProperties,
      featureFlags: event.feature_flags,
      signals: (event.signals ?? []).map((s) => [s.id, s.name]),
      toolCalls: (event.tool_calls ?? []).map((t) => t.name),
      spans: (traces?.spans ?? []).map((span) => [span.span_name, span.span_type, span.model, span.provider]),
    },
    guard,
  );
  if (finding) {
    const structure = {
      eventName: 'quarantined',
      timestamp: event.timestamp,
      userId: null,
      convoId: null,
      properties: {},
      featureFlags: {},
      userInputSha: null,
      assistantOutputSha: null,
      signals: [] as Array<{ id: string; name: string; score: number | null }>,
      toolCallNames: [] as string[],
      errorSpanCount: event.error_spans?.length ?? 0,
      topicCount: event.topics?.length ?? 0,
    };
    return {
      provider: 'raindrop',
      projectId,
      externalEventId: sanitizeProperty(event.id, policy),
      observedAt: now,
      // The hash of the raw payload lets a later remote edit show up as a new quarantined revision, and nothing more.
      contentHash: contentHash(
        { reason: finding.code, structure, raw: sha(JSON.stringify([event.properties, event.event_name])) },
        'raindrop-observation-quarantined',
      ),
      presentFields: [],
      potentiallyTruncated,
      quarantined: finding.code,
      event: structure,
      spans: [],
    };
  }
  const spans: SpanSummary[] = (traces?.spans ?? [])
    .map((span) => ({
      spanId: sanitizeProperty(span.span_id, policy),
      parentSpanId: span.parent_span_id ? sanitizeProperty(span.parent_span_id, policy) : null,
      name: sanitizeProperty(span.span_name, policy),
      type: sanitizeProperty(span.span_type, policy),
      status: span.status ? sanitizeProperty(span.status, policy) : null,
      model: span.model ? sanitizeProperty(span.model, policy) : null,
      provider: span.provider ? sanitizeProperty(span.provider, policy) : null,
      inputTokens: span.input_tokens ?? null,
      outputTokens: span.output_tokens ?? null,
    }))
    .sort((a, b) => a.spanId.localeCompare(b.spanId));
  const summary: EvidenceObservation['event'] = {
    eventName: sanitizeProperty(event.event_name, policy),
    timestamp: event.timestamp,
    userId: event.user_id
      ? isTelemetryUserId(event.user_id)
        ? event.user_id
        : sanitizeProperty(`~${event.user_id}`, policy)
      : null,
    convoId: event.convo_id ? sanitizeProperty(event.convo_id, policy) : null,
    properties: sanitizeValue(rawProperties, policy) as Record<string, unknown>,
    featureFlags: sanitizeValue(event.feature_flags, policy) as Record<string, unknown>,
    userInputSha: sha(event.user_input),
    assistantOutputSha: sha(event.assistant_output),
    signals: (event.signals ?? [])
      .map((s) => ({
        id: sanitizeProperty(s.id, policy),
        name: sanitizeProperty(s.name, policy),
        score: s.score ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    toolCallNames: (event.tool_calls ?? []).map((t) => sanitizeProperty(t.name, policy)),
    errorSpanCount: event.error_spans?.length ?? 0,
    topicCount: event.topics?.length ?? 0,
  };
  return {
    provider: 'raindrop',
    projectId,
    externalEventId: sanitizeProperty(event.id, policy),
    observedAt: now,
    // Enrichment that arrives later changes this hash, which is what makes a new evidence revision.
    contentHash: contentHash({ event: summary, spans, potentiallyTruncated }, 'raindrop-observation'),
    presentFields: presentFieldsOf(event, traces?.spans),
    potentiallyTruncated,
    event: summary,
    spans,
  };
}

export type StoredRevision = {
  revision: number;
  contentHash: string;
  firstObservedAt: Date;
  presentFields: EvidenceField[];
};

export interface EvidenceStore {
  /** Stores a new REVISION when the content hash differs from the latest; an unchanged observation is a no-op. */
  put(
    observation: EvidenceObservation,
    scope: ScopeKey,
    session?: ClientSession,
  ): Promise<{ stored: boolean; revision: number }>;
  latest(
    projectId: string,
    eventId: string,
    scope: ScopeKey,
    session?: ClientSession,
  ): Promise<StoredRevision | null>;
}

const keyOf = (scope: ScopeKey, projectId: string, eventId: string) =>
  `${scope.tenantId}\u0000${scope.env}\u0000${scope.scopeId}\u0000${projectId}\u0000${eventId}`;

/** Process-local store for unit tests. */
export class InMemoryEvidenceStore implements EvidenceStore {
  readonly rows = new Map<string, Array<EvidenceObservation & { revision: number; firstObservedAt: Date }>>();
  async put(observation: EvidenceObservation, scope: ScopeKey) {
    const key = keyOf(scope, observation.projectId, observation.externalEventId);
    const list = this.rows.get(key) ?? [];
    const last = list.at(-1);
    if (last && last.contentHash === observation.contentHash)
      return { stored: false, revision: last.revision };
    const revision = (last?.revision ?? 0) + 1;
    list.push({ ...observation, revision, firstObservedAt: last?.firstObservedAt ?? observation.observedAt });
    this.rows.set(key, list);
    return { stored: true, revision };
  }
  async latest(projectId: string, eventId: string, scope: ScopeKey) {
    const last = this.rows.get(keyOf(scope, projectId, eventId))?.at(-1);
    return last
      ? {
          revision: last.revision,
          contentHash: last.contentHash,
          firstObservedAt: last.firstObservedAt,
          presentFields: last.presentFields,
        }
      : null;
  }
}

/** `evidence` collection in the control database (observer principal: FIND + INSERT; revisions are new rows). */
export class MongoEvidenceStore implements EvidenceStore {
  constructor(private readonly service: MongoService) {}
  private get rows() {
    return this.service.control.collection<Document>('evidence');
  }
  async latest(projectId: string, eventId: string, scope: ScopeKey, session?: ClientSession) {
    const row = await this.rows.findOne(
      {
        tenantId: scope.tenantId,
        env: scope.env,
        scopeId: scope.scopeId,
        provider: 'raindrop',
        projectId,
        externalEventId: eventId,
      },
      { sort: { evidenceRevision: -1 }, session },
    );
    return row
      ? {
          revision: row.evidenceRevision as number,
          contentHash: row.contentHash as string,
          firstObservedAt: row.firstObservedAt as Date,
          presentFields: row.presentFields as EvidenceField[],
        }
      : null;
  }
  async put(observation: EvidenceObservation, scope: ScopeKey, session?: ClientSession) {
    const last = await this.latest(observation.projectId, observation.externalEventId, scope, session);
    if (last && last.contentHash === observation.contentHash)
      return { stored: false, revision: last.revision };
    const revision = (last?.revision ?? 0) + 1;
    await this.rows.insertOne(
      {
        _id: `raindrop:${scope.tenantId}:${scope.env}:${scope.scopeId}:${observation.projectId}:${observation.externalEventId}:${revision}` as never,
        tenantId: scope.tenantId,
        env: scope.env,
        scopeId: scope.scopeId,
        ...observation,
        evidenceRevision: revision,
        firstObservedAt: last?.firstObservedAt ?? observation.observedAt,
      },
      { session },
    );
    return { stored: true, revision };
  }
}
