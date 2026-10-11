// DA-1 repro: public fixture commitments reveal sealed structure / seeds; checks that two snapshot defects are fixed.
import { randomBytes } from 'node:crypto';
// Prints one line per check. Exit 0 = every "defect" check reproduced, 1 = some did not, 2 = error.
// Run: npx tsx docs/review/repro/fx-commitments.repro.ts
import { contentHash } from '@expunge/contracts';
import { FAMILIES, createWorldSpec, generateWorld, publicSplitCommitment, structuralSignature } from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture } from '@expunge/fixtures/sealed';
import { admitWorld, gradeWorld, publicAdmissionVerdict, runReference } from '@expunge/grader';

const out: Array<[string, boolean, string]> = [];
try {
  // C1: every sealed entry's family + exact field paths are recoverable from the public structuralHash alone.
  const commitment = publicSplitCommitment(buildSealedSplitPlan(randomBytes(32).toString('hex')));
  const candidates: Array<{ label: string; hash: string }> = [];
  for (const family of FAMILIES)
    for (const namesakeCount of [1, 2, 3])
      for (const variant of ['none', 'validation', 'test'] as const)
        for (const k of variant === 'none' ? [0] : [0, 1, 2]) {
          const spec = createWorldSpec({ family, seed: 'any', namesakeCount });
          if (variant !== 'none')
            for (const layout of spec.collectionLayouts) {
              if (layout.collectionId !== 'customers') layout.identityPath = [variant === 'test' ? 'actors' : 'members', 'items', '*', `binding${k}`];
              layout.referencePath = [variant === 'test' ? 'history' : 'connections', 'entries', '*', `pointer${k}`];
            }
          candidates.push({ label: `${family}/${variant}${k}/n${namesakeCount}`, hash: structuralSignature(spec) });
        }
  const recovered = commitment.entries.filter((e) => candidates.some((c) => c.hash === e.structuralHash));
  const sample = commitment.entries.filter((e) => e.split === 'test').slice(0, 2).map((e) => `${e.fixtureId}=${candidates.find((c) => c.hash === e.structuralHash)?.label}`);
  out.push(['C1 held-out structure recovered from public structuralHash', recovered.length === commitment.entries.length, `${recovered.length}/${commitment.entries.length} entries from ${candidates.length} guesses; e.g. ${sample.join(', ')}`]);

  // C2: no entropy floor on masterSeed; a test-style master seed is recovered from public seedCommitments.
  let weakDetail = '';
  let weakOk = false;
  try {
    const weak = publicSplitCommitment(buildSealedSplitPlan('held-out-master'));
    const dictionary = ['', 'seed', 'master', 'expunge', 'split-admission', 'held-out-master', 'final', 'test'];
    const hit = dictionary.find((guess) => { try { return buildSealedSplitPlan(guess).every((entry, i) => entry.spec.seedCommitment === weak.entries[i]!.seedCommitment); } catch { return false; } });
    let empty = 'accepted';
    try { buildSealedSplitPlan(''); } catch { empty = 'rejected'; }
    weakOk = hit !== undefined && empty === 'accepted';
    weakDetail = `dictionary hit=${JSON.stringify(hit)}; empty masterSeed ${empty}`;
  } catch (error) {
    weakDetail = `weak masterSeed rejected: ${(error as Error).message}`;
  }
  out.push(['C2 weak masterSeed accepted and dictionary-recoverable from public commitment', weakOk, weakDetail]);

  // C3: the "safe" public admission verdict exposes the private grade reportHash, which commits to
  // manifestHash/expectedStateHash (the fields publicGradeReport withholds).
  const spec = createWorldSpec({ family: 'diamond_alias', seed: 'c3-seed' });
  const verdict = publicAdmissionVerdict(admitWorld(spec, 'c3-seed'));
  const fixture = generateSealedFixture(spec, 'c3-seed');
  const privateGrade = gradeWorld(fixture.manifest, runReference(fixture.world, spec.resourceBounds).world, { terminalStatus: 'complete' });
  const { reportHash, ...privatePayload } = privateGrade;
  out.push(['C3 publicAdmissionVerdict.referenceResultHash = private reportHash over expectedStateHash', verdict.referenceResultHash === reportHash && contentHash(privatePayload, 'grade-report') === reportHash && 'expectedStateHash' in privatePayload, `referenceResultHash=${verdict.referenceResultHash?.slice(0, 12)}…`]);

  // R1/R2 (snapshot defects; expected FIXED in current code): instance-scoped _id and default-binding equivalence.
  const s = createWorldSpec({ family: 'direct_nested', seed: 'r-seed' });
  const a = generateWorld(s, 'r-seed', { tenantId: 't1', env: 'evaluation', scopeId: 's1' });
  const b = generateWorld(s, 'r-seed', { tenantId: 't2', env: 'evaluation', scopeId: 's2' });
  const shared = a.collections.customers.filter((d) => b.collections.customers.some((e) => e._id === d._id)).length;
  console.log(`INFO R1 same seed, different scope: worldIds differ=${a.worldId !== b.worldId}, shared customer _ids=${shared} (snapshot: all shared; now ${shared === 0 ? 'FIXED' : 'STILL PRESENT'})`);
  const implicit = generateWorld(s, 'r-seed');
  const explicit = generateWorld(s, 'r-seed', { tenantId: 'synthetic-evaluation-tenant', env: 'evaluation', scopeId: 'synthetic-evaluation-scope' });
  const withActor = generateWorld(s, 'r-seed', { tenantId: 'synthetic-evaluation-tenant', env: 'evaluation', scopeId: 'synthetic-evaluation-scope', actorId: 'x', authorizationRevision: 9 } as never);
  const same = implicit.worldId === explicit.worldId && implicit.scope.scopeId === explicit.scope.scopeId && withActor.worldId === explicit.worldId;
  console.log(`INFO R2 implicit/explicit/extra-actor-keys binding equivalence: ${same ? 'FIXED' : 'STILL PRESENT'}`);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
for (const [id, ok, detail] of out) console.log(`${ok ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${id} :: ${detail}`);
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
