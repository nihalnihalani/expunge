import { contentHash } from '@expunge/contracts';

/** TEST-ONLY deterministic master seed: 256 bits of hex derived from a label. Never a real campaign secret. */
export function testMasterSeed(label: string): string {
  return contentHash({ label }, 'test-master-seed');
}
