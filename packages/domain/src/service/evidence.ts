import type { ScopeKey } from '@expunge/contracts';
import type { DomainEnv } from '../env.js';

export type EvidenceStatus = {
  configured: boolean;
  writeProvenAt: string | null;
  readBackProvenAt: string | null;
  deadLetters: number;
};
type OutboxRow = {
  status?: string;
  attained?: Record<string, { at?: Date } | undefined>;
};

/**
 * What the committed telemetry outbox says about the observability pipeline for this owner's scope, read with the service's own
 * principal; nothing here is configuration the service invents.
 * - `configured`: the scope has enqueued at least one evidence operation, i.e. a worker with a live evidence path has run.
 * - `writeProvenAt`: the latest time a row was accepted by the provider's ingest.
 * - `readBackProvenAt`: the latest time a row was read back through the provider's query (`query_visible` or `evidence_ready`).
 * - `deadLetters`: rows that exhausted their retries.
 * A scope that never enqueued anything is reported unconfigured, never ready.
 */
export async function evidenceStatus(env: DomainEnv, scope: ScopeKey): Promise<EvidenceStatus> {
  const rows = env.service.control.collection<OutboxRow>('telemetry_outbox');
  const filter = { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId };
  const latest = async (path: string): Promise<string | null> => {
    const row = await rows
      .find(
        { ...filter, [path]: { $exists: true } },
        { projection: { [path]: 1 }, sort: { [path]: -1 }, limit: 1 },
      )
      .next();
    const key = path.split('.');
    const at = (key.reduce<unknown>(
      (cursor, part) => (cursor as Record<string, unknown> | undefined)?.[part],
      row,
    ) ?? null) as Date | null;
    return at instanceof Date ? at.toISOString() : null;
  };
  const [any, deadLetters, accepted, visible, ready] = await Promise.all([
    rows.findOne(filter, { projection: { _id: 1 } }),
    rows.countDocuments({ ...filter, status: 'dead_letter' }),
    latest('attained.ingest_accepted.at'),
    latest('attained.query_visible.at'),
    latest('attained.evidence_ready.at'),
  ]);
  const readBack =
    [visible, ready]
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1) ?? null;
  return { configured: any !== null, writeProvenAt: accepted, readBackProvenAt: readBack, deadLetters };
}
