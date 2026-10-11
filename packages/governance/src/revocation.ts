import type { ClientSession } from 'mongodb';
import type { ActorContext } from '@expunge/contracts';
import {
  ProtocolError,
  type ArtifactRepository,
  type AuthorityRepository,
  type JobRepository,
} from '@expunge/mongo';

/**
 * A `validate` callback for `EffectRepository.commitEffect` and `complete`. Inside the effect transaction it loads
 * the job as stored, takes the bundle named by the job's pinned `binding.harnessHash` from the artifact store, and
 * refuses the effect unless the scope's stored owner floor is the floor that bundle names. Tightening or replacing
 * the floor therefore stops the next action of a run pinned to the old one, and a caller cannot satisfy the check
 * with a bundle of its own choosing: it passes the job id and nothing else.
 * (The authorization revision itself is fenced by the repositories; this adds the floor identity.)
 */
export function liveFloorValidator(
  repositories: {
    authority: AuthorityRepository;
    jobs: Pick<JobRepository, 'readAuthorized'>;
    artifacts: Pick<ArtifactRepository, 'readPermitted'>;
  },
  actor: ActorContext,
  jobId: string,
): (session: ClientSession) => Promise<void> {
  return async (session) => {
    const job = await repositories.jobs.readAuthorized(actor, jobId, session);
    const pinned = await repositories.artifacts.readPermitted(actor, job.binding.harnessHash, session);
    const stored = await repositories.authority.read(actor, session);
    if (stored.floorHash !== pinned.payload.authorityFloorHash)
      throw new ProtocolError('AuthorityFloorMismatch');
  };
}
