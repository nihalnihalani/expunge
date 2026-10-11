import type { EvidenceBundle } from '@expunge/contracts';
import type { MongoService } from '@expunge/mongo';
import { buildRunBundle, type RunBundleInput, type StoredSplitReader } from './run-bundle-core.js';

/**
 * FAKE test seam. Builds a bundler whose split comes from a FAKE resolver. It is deliberately NOT exported from the
 * package index and the production process path (`createEvidenceProcess`, `evidenceMain`) never imports it.
 */
export function createRunBundler(options: {
  __fakeSplitResolverForTests: StoredSplitReader;
}): (service: MongoService, input: RunBundleInput) => Promise<EvidenceBundle> {
  return (service, input) => buildRunBundle(service, input, options.__fakeSplitResolverForTests);
}
