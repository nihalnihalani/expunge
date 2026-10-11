import type { ClientSession } from 'mongodb';
import type { ActorContext, HarnessBundle } from '@expunge/contracts';
import { ProtocolError, type AuthorityRepository } from '@expunge/mongo';

/**
 * A `validate` callback for `EffectRepository.commitEffect` and `complete`. Inside the effect transaction it
 * re-reads the scope's stored authority and refuses the effect when the run's pinned bundle names a different
 * owner floor, so tightening or replacing the floor stops the next action of a run that was already pinned.
 * (The authorization revision itself is fenced by the repositories; this adds the floor identity.)
 */
export function liveFloorValidator(
  authority: AuthorityRepository,
  actor: ActorContext,
  bundle: Pick<HarnessBundle, 'authorityFloorHash'>,
): (session: ClientSession) => Promise<void> {
  return async (session) => {
    const stored = await authority.read(actor, session);
    if (stored.floorHash !== bundle.authorityFloorHash) throw new ProtocolError('AuthorityFloorMismatch');
  };
}
