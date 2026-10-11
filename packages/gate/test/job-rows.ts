import { contentHash, type Job } from '@expunge/contracts';
import type { MongoService } from '@expunge/mongo';
import type { EpisodeRequest, EpisodeResult } from '../src/index.js';
const RUNTIME_HASH = 'c'.repeat(64);

export type StampOptions = {
  /** Store this job status whatever the port reports (to test a port that disagrees with the stored job). */
  status?: Job['status'];
  runtimeHash?: string | null;
  model?: unknown;
};
export const PROVIDER_STAMP = {
  fence: 1,
  source: 'provider',
  provider: 'scripted-provider',
  modelId: 'scripted-model',
  spec: 'scripted/model',
  endpoint: 'default',
};

/**
 * TEST-ONLY. Writes the job row a real worker would have committed for a scripted run, so the gate has stored facts to
 * read. These are fabricated rows for rule tests; the real-path test proves the same fields from the real worker.
 */
export function jobRecorder(
  setup: MongoService,
  options: StampOptions | ((request: EpisodeRequest) => StampOptions) = {},
) {
  return async (request: EpisodeRequest, result: EpisodeResult, jobId: string): Promise<void> => {
    const stamp = typeof options === 'function' ? options(request) : options;
    const runtimeHash = stamp.runtimeHash === undefined ? RUNTIME_HASH : stamp.runtimeHash;
    const model = 'model' in stamp ? stamp.model : [PROVIDER_STAMP];
    const status: Job['status'] =
      stamp.status ??
      (result.outcome === 'completed'
        ? 'succeeded'
        : result.outcome === 'cancelled'
          ? 'cancelled'
          : 'failed');
    const now = new Date();
    const job: Job = {
      _id: jobId,
      kind: 'cleanup',
      actor: { ...request.instanceScope, actorId: 'owner', authorizationRevision: 1 },
      binding: {
        jobId,
        runId: request.runId,
        worldId: request.world.worldId,
        harnessHash: request.bundleHash,
        scopeRevision: request.world.scope.revision,
        workerProfileHash: 'a'.repeat(64),
      },
      parentJobId: null,
      checkpoint: {
        v: 1,
        ...(runtimeHash ? { attestedRuntimeHash: runtimeHash } : {}),
      } as never,
      status,
      cancellationRequested: false,
      lease: { ownerId: 'scripted', fence: 1, until: now, heartbeatAt: now },
      commitSeq: 0,
      eventSeq: 0,
      attempt: 1,
      priority: 0,
      inputRefs: [],
      outputRefs: status === 'succeeded' ? ['scripted-receipt'] : [],
      createdAt: now,
      updatedAt: now,
    };
    await setup.control.collection('jobs').insertOne(job as never);
    // The authoritative stamps live in insert-only run_attestations rows, one per fence, as the worker writes them.
    const stamps = Array.isArray(model) ? model : [];
    for (const stampRow of stamps as Array<Record<string, unknown>>) {
      const scope = request.instanceScope;
      await setup.control.collection('run_attestations').insertOne({
        _id: contentHash({ ...scope, jobId, fence: stampRow.fence }, 'run-attestation-row'),
        ...scope,
        jobId,
        runId: request.runId,
        at: now,
        createdAt: now,
        ...stampRow,
      } as never);
    }
  };
}
