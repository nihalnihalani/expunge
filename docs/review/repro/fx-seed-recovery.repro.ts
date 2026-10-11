// DA-2 repro: target identity is protected only by seed entropy, and only the sealed split plan checks seed format.
// From the VISIBLE world alone (worldId on every document + subjectHandle) a worker that guesses the seed recomputes
// every target _id with the public derivation. Also: the master-seed check is format-only (64 zeros pass).
// Exit 0 = reproduced, 1 = not reproduced, 2 = error.   Run: npx tsx docs/review/repro/fx-seed-recovery.repro.ts
import { contentHash } from '@expunge/contracts';
import { COLLECTION_IDS, createWorldSpec } from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture } from '@expunge/fixtures/sealed';
import { admitWorld } from '@expunge/grader';

const out: Array<[string, boolean, string]> = [];
try {
  // R1: admission accepts an arbitrary low-entropy seed (Hider/demo path), and the visible world reveals it.
  const secretSeed = 'demo-3';
  const spec = createWorldSpec({ family: 'diamond_alias', seed: secretSeed });
  const admitted = admitWorld(spec, secretSeed);
  const { world, manifest } = generateSealedFixture(spec, secretSeed);
  const worldId = world.collections.customers[0]!.worldId; // visible on every document
  const derive = (seed: string, collection: string, role: string) =>
    `syn_${contentHash({ seed, collection, role, instance: worldId }, 'fixture-record').slice(0, 24)}`;
  const dictionary = [
    ...['seed', 'demo', 'test', 'hider', 'world'].flatMap((w) =>
      Array.from({ length: 50 }, (_, i) => `${w}-${i}`),
    ),
  ];
  const recovered = dictionary.find((guess) => derive(guess, 'customers', 'primary') === world.subjectHandle);
  const predicted = recovered ? COLLECTION_IDS.map((c) => derive(recovered, c, 'primary')).sort() : [];
  const actual = manifest.effects.map((e) => e.address.recordId).sort();
  out.push([
    'R1 low-entropy seed admitted; all targets recomputed from visible world',
    admitted.admitted && JSON.stringify(predicted) === JSON.stringify(actual),
    `admitted=${admitted.admitted}; recovered seed=${JSON.stringify(recovered)} after <=${dictionary.length} guesses; predicted==manifest targets ${JSON.stringify(predicted) === JSON.stringify(actual)}`,
  ]);

  // R2: master-seed validation is a format check, not an entropy check.
  let accepted = 'rejected';
  try {
    buildSealedSplitPlan('0'.repeat(64));
    accepted = 'accepted';
  } catch {
    // Rejected: the degenerate master seed is refused, so `accepted` stays 'rejected'.
  }
  out.push([
    'R2 buildSealedSplitPlan accepts 64 zero characters',
    accepted === 'accepted',
    `'0'x64 ${accepted}`,
  ]);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
for (const [id, ok, detail] of out)
  console.log(`${ok ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${id} :: ${detail}`);
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
