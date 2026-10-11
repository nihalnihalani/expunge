import type { ScopeKey, WorldSpec } from '@expunge/contracts';
import { admitWorld } from '../src/index.js';

/** TEST-ONLY: the hand-written seeds used across these tests are guessable, so admission needs the explicit flag. */
export function admit(spec: WorldSpec, seed: string, binding?: ScopeKey) {
  return admitWorld(spec, seed, binding, { allowLowEntropySeed: true });
}
