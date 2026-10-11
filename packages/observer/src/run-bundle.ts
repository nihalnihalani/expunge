import type { EvidenceBundle } from '@expunge/contracts';
import type { MongoService } from '@expunge/mongo';
import { buildRunBundle, storedSplitOfJob, type RunBundleInput } from './run-bundle-core.js';

export type { RunBundleInput } from './run-bundle-core.js';
export { TOOL_EVENT_READ_LIMIT } from './run-bundle-core.js';

/**
 * The sanitized EvidenceBundle for one finished worker run, assembled ONLY from committed local state and the stored
 * read-back of the run's Raindrop episode event: the job row (binding, meter), its `tool_decided` projection events
 * (toolId and the gateway's decision), the telemetry outbox row (which must have reached `evidence_ready`) and the latest
 * stored evidence revision of that event. Tool inputs and outputs are not stored here, so the bundle carries the gateway's
 * fixed-vocabulary summary instead; the model's narrative is a hash. The leak guard is REQUIRED and runs over the result.
 */
export function bundleForRun(service: MongoService, input: RunBundleInput): Promise<EvidenceBundle> {
  return buildRunBundle(service, input, storedSplitOfJob);
}
