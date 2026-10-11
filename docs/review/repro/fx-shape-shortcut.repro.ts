// DA-1 repro: a shape-only "anomaly" rule finds every hidden target without identity or reference discovery.
// Exit 0 = defect reproduced (shortcut earns usefulCompletion on >= 90% of worlds), 1 = not reproduced, 2 = error.
// Run: npx tsx docs/review/repro/fx-shape-shortcut.repro.ts
import { randomBytes } from 'node:crypto';
import { COLLECTION_IDS, FAMILIES, createWorldSpec, valuesAtPath, type VisibleWorld } from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture } from '@expunge/fixtures/sealed';
import { applyReferenceAction, gradeWorld } from '@expunge/grader';

/** Visible facts only: the registry's identity/reference field values per document. No subject tokens used. */
function signature(world: VisibleWorld, collectionId: string, doc: (typeof world.collections.customers)[number]) {
  const field = (id: string) => world.scope.fields.find((f) => f.fieldId === id);
  const ident = field(`${collectionId}.identity_binding`);
  const ref = field(`${collectionId}.record_reference`);
  const idVals = ident ? valuesAtPath(doc, ident.path).map((v) => v.value) : [];
  const refVals = ref ? valuesAtPath(doc, ref.path).map((v) => v.value) : [];
  const prefix = (v: unknown) => (typeof v === 'string' ? v.split('_').slice(0, 2).join('_') : String(v));
  return JSON.stringify({
    idStrings: idVals.filter((v) => typeof v === 'string').length,
    idNull: idVals.some((v) => v === null),
    refs: refVals.length,
    refKinds: [...new Set(refVals.map(prefix))].sort(),
  });
}

function shortcut(world: VisibleWorld): { world: VisibleWorld; picked: number } {
  const result = structuredClone(world);
  const picked: Array<{ collectionId: (typeof COLLECTION_IDS)[number]; id: string }> = [];
  for (const collectionId of COLLECTION_IDS) {
    if (collectionId === 'customers') {
      picked.push({ collectionId, id: world.subjectHandle });
      continue;
    }
    const docs = world.collections[collectionId];
    const counts = new Map<string, number>();
    for (const d of docs) counts.set(signature(world, collectionId, d), (counts.get(signature(world, collectionId, d)) ?? 0) + 1);
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    for (const d of docs) if (signature(world, collectionId, d) !== mode) picked.push({ collectionId, id: d._id });
  }
  // Exact bindings = the subject customer's own visible identity values + picked record IDs (no graph walk).
  const subject = world.collections.customers.find((d) => d._id === world.subjectHandle)!;
  const identity = subject.data.identity as { id: string; email: string };
  const bindings = [identity.id, identity.email, ...(subject.data.aliases as string[]), ...picked.map((p) => p.id)];
  for (const p of picked) {
    const doc = result.collections[p.collectionId].find((d) => d._id === p.id)!;
    applyReferenceAction(
      result,
      { address: { collectionId: p.collectionId, recordId: p.id, recordIdBsonType: 'string' }, effect: doc.eligibility.effect, expectedRevision: doc._rev },
      bindings,
    );
  }
  return { world: result, picked: picked.length };
}

try {
  const worlds: Array<{ label: string; spec: ReturnType<typeof createWorldSpec>; seed: string }> = [];
  for (const entry of buildSealedSplitPlan(randomBytes(32).toString('hex')))
    worlds.push({ label: `${entry.split}:${entry.spec.family}`, spec: entry.spec, seed: entry.seed });
  for (const family of FAMILIES)
    for (let n = 0; n < 5; n++) {
      const seed = randomBytes(16).toString('hex');
      worlds.push({ label: `family:${family}`, spec: createWorldSpec({ family, seed }), seed });
    }
  let useful = 0;
  const misses: string[] = [];
  const bySplit = new Map<string, [number, number]>();
  for (const w of worlds) {
    const fixture = generateSealedFixture(w.spec, w.seed);
    const { world } = shortcut(fixture.world);
    const grade = gradeWorld(fixture.manifest, world, { terminalStatus: 'complete' });
    const split = w.label.split(':')[0]!;
    const row = bySplit.get(split) ?? [0, 0];
    row[1]++;
    if (grade.usefulCompletion) {
      useful++;
      row[0]++;
    } else misses.push(`${w.label} ${grade.reasonCodes.join(',')}`);
    bySplit.set(split, row);
  }
  console.log(`shape-only shortcut usefulCompletion: ${useful}/${worlds.length}`);
  for (const [split, [ok, total]] of bySplit) console.log(`  ${split}: ${ok}/${total}`);
  if (misses.length) console.log(`  misses: ${misses.slice(0, 10).join(' | ')}`);
  const reproduced = useful / worlds.length >= 0.9;
  console.log(reproduced ? 'REPRODUCED' : 'NOT REPRODUCED');
  process.exit(reproduced ? 0 : 1);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
