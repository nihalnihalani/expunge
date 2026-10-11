// DA-2 repro: a fifth subject-free detector over cross-document value co-occurrence (no identity resolution,
// no reference walk from the subject) beats chance. It counts, for every string a document holds and for the
// document's own _id, how many OTHER documents in the world contain that string, then takes per-collection outliers.
// Exit 0 = defect reproduced (pooled precision > chance + 0.02 on at least one family), 1 = not reproduced, 2 = error.
// Run: npx tsx docs/review/repro/fx-cooccurrence.repro.ts
import { randomBytes } from 'node:crypto';
import { COLLECTION_IDS, FAMILIES, addressKey, createWorldSpec, type FixtureDocument, type VisibleWorld } from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture } from '@expunge/fixtures/sealed';

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}
/** Number of documents (other than `self`) whose data contains `value`. */
function frequencyIndex(world: VisibleWorld) {
  const holders = new Map<string, Set<string>>();
  for (const c of COLLECTION_IDS)
    for (const d of world.collections[c])
      for (const v of new Set(strings(d.data))) {
        const set = holders.get(v) ?? new Set<string>();
        set.add(`${c}/${d._id}`);
        holders.set(v, set);
      }
  return (value: string, self: string) => [...(holders.get(value) ?? [])].filter((h) => h !== self).length;
}
function outliers(docs: FixtureDocument[], key: (d: FixtureDocument) => string): FixtureDocument[] {
  const groups = new Map<string, FixtureDocument[]>();
  for (const d of docs) groups.set(key(d), [...(groups.get(key(d)) ?? []), d]);
  const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => b - a);
  if (sizes.length === 1 || sizes[0] === sizes[1] || sizes[0] === 1) return docs;
  const mode = [...groups.values()].find((g) => g.length === sizes[0])!;
  return docs.filter((d) => !mode.includes(d));
}
/** Signature = own in-degree + sorted frequencies of the strings it holds (display/payload/label text excluded). */
function signature(world: VisibleWorld, collectionId: string, d: FixtureDocument, freq: (v: string, self: string) => number) {
  const self = `${collectionId}/${d._id}`;
  const held = new Set(strings(d.data).filter((v) => v.startsWith('syn_') || v.includes('@')));
  return JSON.stringify({ indeg: freq(d._id, self), held: [...held].map((v) => freq(v, self)).sort((a, b) => a - b) });
}

try {
  const worlds: Array<{ family: string; spec: ReturnType<typeof createWorldSpec>; seed: string }> = [];
  for (const e of buildSealedSplitPlan(randomBytes(32).toString('hex'))) worlds.push({ family: e.spec.family, spec: e.spec, seed: e.seed });
  for (const family of FAMILIES)
    for (let n = 0; n < 6; n++) {
      const seed = randomBytes(16).toString('hex');
      worlds.push({ family, spec: createWorldSpec({ family, seed }), seed });
    }
  const perFamily = new Map<string, { selected: number; hits: number; candidates: number; targets: number; exact: number; worlds: number }>();
  for (const w of worlds) {
    const { world, manifest } = generateSealedFixture(w.spec, w.seed);
    const targets = new Set(manifest.effects.map((e) => addressKey(e.address)));
    const freq = frequencyIndex(world);
    const row = perFamily.get(w.family) ?? { selected: 0, hits: 0, candidates: 0, targets: 0, exact: 0, worlds: 0 };
    let exactWorld = true;
    for (const c of COLLECTION_IDS) {
      if (c === 'customers') continue;
      const docs = world.collections[c];
      const picked = outliers(docs, (d) => signature(world, c, d, freq));
      const hits = picked.filter((d) => targets.has(addressKey({ collectionId: c, recordId: d._id }))).length;
      const tgt = docs.filter((d) => targets.has(addressKey({ collectionId: c, recordId: d._id }))).length;
      row.selected += picked.length;
      row.hits += hits;
      row.candidates += docs.length;
      row.targets += tgt;
      if (!(picked.length === tgt && hits === tgt)) exactWorld = false;
    }
    row.worlds++;
    if (exactWorld) row.exact++;
    perFamily.set(w.family, row);
  }
  // Namesake discrimination without identity resolution: among records sharing the subject's display name, pick
  // the one holding the most frequent syn_ value (the subject chain carries the sibling token two chains share).
  let nsSets = 0, nsSize = 0, nsPicks = 0, nsHits = 0;
  for (const w of worlds) {
    const { world, manifest } = generateSealedFixture(w.spec, w.seed);
    const targets = new Set(manifest.effects.map((e) => addressKey(e.address)));
    const count = new Map<string, number>();
    for (const c of COLLECTION_IDS) for (const d of world.collections[c]) for (const v of new Set(strings(d.data))) count.set(v, (count.get(v) ?? 0) + 1);
    const name = world.collections.customers.find((d) => d._id === world.subjectHandle)!.data.displayName;
    for (const c of COLLECTION_IDS) {
      if (c === 'customers') continue;
      const same = world.collections[c].filter((d) => d.data.displayName === name);
      if (same.length < 2) continue;
      const score = (d: FixtureDocument) => Math.max(0, ...strings(d.data).filter((v) => v.startsWith('syn_')).map((v) => count.get(v) ?? 0));
      const top = Math.max(...same.map(score));
      const best = same.filter((d) => score(d) === top);
      nsSets++; nsSize += same.length; nsPicks += best.length;
      nsHits += best.filter((d) => targets.has(addressKey({ collectionId: c, recordId: d._id }))).length;
    }
  }
  const nsPrecision = nsHits / nsPicks, nsChance = nsSets / nsSize;
  console.log(`namesake sets=${nsSets} precision=${nsPrecision.toFixed(3)} chance=${nsChance.toFixed(3)}`);
  let leak = nsPrecision > nsChance + 0.02;
  for (const [family, r] of [...perFamily].sort()) {
    const precision = r.hits / r.selected;
    const chance = r.targets / r.candidates;
    if (precision > chance + 0.02) leak = true;
    console.log(`${family.padEnd(18)} precision=${precision.toFixed(3)} chance=${chance.toFixed(3)} selected=${r.selected} exact-target-set worlds=${r.exact}/${r.worlds}`);
  }
  console.log(leak ? 'REPRODUCED' : 'NOT REPRODUCED');
  process.exit(leak ? 0 : 1);
} catch (error) {
  console.error('ERROR', error);
  process.exit(2);
}
