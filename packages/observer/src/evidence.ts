import { createHash } from 'node:crypto';
import { contentHash, type ScopeKey } from '@expunge/contracts';
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

export function observeEvent(
  projectId: string,
  event: RaindropEvent,
  traces?: { spans: RaindropSpan[]; potentiallyTruncated: boolean },
  now: Date = new Date(),
): EvidenceObservation {
  const { $context: _context, ...properties } = event.properties as Record<string, unknown>;
  const spans: SpanSummary[] = (traces?.spans ?? [])
    .map((span) => ({
      spanId: span.span_id,
      parentSpanId: span.parent_span_id ?? null,
      name: span.span_name,
      type: span.span_type,
      status: span.status ?? null,
      model: span.model ?? null,
      provider: span.provider ?? null,
      inputTokens: span.input_tokens ?? null,
      outputTokens: span.output_tokens ?? null,
    }))
    .sort((a, b) => a.spanId.localeCompare(b.spanId));
  const summary: EvidenceObservation['event'] = {
    eventName: event.event_name,
    timestamp: event.timestamp,
    userId: event.user_id ?? null,
    convoId: event.convo_id ?? null,
    properties,
    featureFlags: event.feature_flags,
    userInputSha: sha(event.user_input),
    assistantOutputSha: sha(event.assistant_output),
    signals: (event.signals ?? [])
      .map((s) => ({ id: s.id, name: s.name, score: s.score ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    toolCallNames: (event.tool_calls ?? []).map((t) => t.name),
    errorSpanCount: event.error_spans?.length ?? 0,
    topicCount: event.topics?.length ?? 0,
  };
  const potentiallyTruncated = traces?.potentiallyTruncated ?? false;
  return {
    provider: 'raindrop',
    projectId,
    externalEventId: event.id,
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
        _id: `raindrop:${observation.projectId}:${observation.externalEventId}:${revision}` as never,
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
