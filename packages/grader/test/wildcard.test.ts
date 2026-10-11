import { describe, expect, it } from 'vitest';
import { isRegistryFieldPath, parseFieldPath } from '@expunge/contracts';
import {
  FAMILIES,
  createWorldSpec,
  valuesAtPath,
  type FixtureDocument,
  type VisibleWorld,
} from '@expunge/fixtures';
import { generateSealedFixture } from '@expunge/fixtures/sealed';
import { gradeWorld, runReference } from '../src/index.js';

/** Wildcard paths end to end on the fixture/grader side. The Mongo write compile is tested in packages/mongo. */
function carries(value: unknown, bindings: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return bindings.has(value);
  if (Array.isArray(value)) return value.some((child) => carries(child, bindings));
  if (value && typeof value === 'object')
    return Object.values(value).some((child) => carries(child, bindings));
  return false;
}
function arrayAt(document: FixtureDocument | undefined, path: readonly string[]): unknown[] {
  const found = document ? valuesAtPath(document, path) : [];
  expect(found, `array at ${path.join('.')}`).toHaveLength(1);
  expect(Array.isArray(found[0]!.value)).toBe(true);
  return found[0]!.value as unknown[];
}
function setAt(root: unknown, path: readonly string[], value: unknown): void {
  let cursor = root as Record<string, unknown>;
  for (const part of path.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  cursor[path[path.length - 1]!] = value;
}
function documentOf(
  world: VisibleWorld,
  collectionId: string,
  recordId: string,
): FixtureDocument | undefined {
  return world.collections[collectionId as keyof VisibleWorld['collections']].find(
    (row) => row._id === recordId,
  );
}

const NO_LAYOUT_WILDCARD: readonly string[] = ['alias_two_hop', 'reverse_reference'];

describe('mixed-array wildcard paths: registry descriptors, reference effect and grader preservation', () => {
  let mixedArrays = 0;
  let wildcardFamilies = 0;

  it.each(FAMILIES)(
    '%s: the targeted effect rewrites only the subject element and leaves neighbours byte-identical',
    (family) => {
      const seed = `wildcard-${family}`;
      const fixture = generateSealedFixture(createWorldSpec({ family, seed }), seed);
      const { world: solved, plan } = runReference(fixture.world);
      const bindings = new Set(plan.exactBindings);
      const wildcardFields = fixture.world.scope.fields.filter((field) => field.path.includes('*'));

      // 1. Every registry descriptor passes the shared contracts grammar; wildcard fields parse to one position.
      for (const field of fixture.world.scope.fields) {
        expect(isRegistryFieldPath(field.path), field.fieldId).toBe(true);
      }
      for (const field of wildcardFields) {
        const parsed = parseFieldPath(field.path);
        expect(parsed.wildcardIndex, field.fieldId).toBeGreaterThan(0);
        expect(field.isArray).toBe(true);
      }
      expect(wildcardFields.length).toBeGreaterThan(0);
      // alias_two_hop and reverse_reference use scalar layouts: their only wildcard field is the subject's alias list.
      const layoutWildcards = wildcardFields.filter((field) => !field.fieldId.endsWith('aliases'));
      if (!layoutWildcards.length) {
        expect(NO_LAYOUT_WILDCARD).toContain(family);
        return;
      }
      wildcardFamilies++;

      // 2. For each wildcard field of each rewritten target: only subject-bearing elements change.
      const redactions = fixture.manifest.effects.filter(
        (effect) => effect.effect === 'redact' || effect.effect === 'tombstone',
      );
      let checkedArrays = 0;
      const unrelatedElementPaths: Array<{ collectionId: string; recordId: string; path: string[] }> = [];
      for (const effect of redactions) {
        const { collectionId, recordId } = effect.address;
        for (const field of wildcardFields.filter(
          (candidate) => candidate.collectionId === collectionId && !candidate.fieldId.endsWith('aliases'),
        )) {
          const arrayPath = field.path.slice(0, field.path.indexOf('*'));
          const before = arrayAt(documentOf(fixture.world, collectionId, recordId), arrayPath);
          const after = arrayAt(documentOf(solved, collectionId, recordId), arrayPath);
          checkedArrays++;
          expect(after, `${collectionId} ${field.fieldId} array kept, not deleted wholesale`).toHaveLength(
            before.length,
          );
          let subjectElements = 0;
          let unrelatedElements = 0;
          before.forEach((element, index) => {
            if (carries(element, bindings)) {
              subjectElements++;
              expect(carries(after[index], bindings), 'subject element still carries a binding').toBe(false);
              expect(JSON.stringify(after[index])).not.toBe(JSON.stringify(element));
            } else {
              unrelatedElements++;
              expect(JSON.stringify(after[index]), 'unrelated element bytes').toBe(JSON.stringify(element));
              unrelatedElementPaths.push({ collectionId, recordId, path: [...arrayPath, String(index)] });
            }
          });
          if (subjectElements > 0 && unrelatedElements > 0) mixedArrays++;
        }
      }
      expect(checkedArrays).toBeGreaterThan(0);

      // 3. The sealed preservation hashes cover every unrelated element, by concrete position.
      const hashed = new Set(
        fixture.manifest.preservationHashes.map(
          (entry) => `${entry.address.collectionId}/${entry.address.recordId}/${entry.path.join('.')}`,
        ),
      );
      for (const element of unrelatedElementPaths) {
        expect(
          hashed.has(`${element.collectionId}/${element.recordId}/${element.path.join('.')}`),
          element.path.join('.'),
        ).toBe(true);
      }
      expect(gradeWorld(fixture.manifest, solved, { terminalStatus: 'complete' })).toMatchObject({
        usefulCompletion: true,
        preservationViolations: 0,
      });

      // 4. The grader's preservation hashes catch every way of damaging a neighbour.
      for (const element of unrelatedElementPaths.slice(0, 6)) {
        const arrayPath = element.path.slice(0, -1);
        const index = Number(element.path[element.path.length - 1]);
        const variants: Array<[string, (world: VisibleWorld) => void, number]> = [
          [
            'neighbour redacted',
            (w) => setAt(documentOf(w, element.collectionId, element.recordId), element.path, '[redacted]'),
            1,
          ],
          [
            'neighbour removed (array shifts)',
            (w) => arrayAt(documentOf(w, element.collectionId, element.recordId), arrayPath).splice(index, 1),
            1,
          ],
          [
            'array deleted wholesale',
            (w) => setAt(documentOf(w, element.collectionId, element.recordId), arrayPath, []),
            unrelatedElementPaths.filter(
              (other) =>
                other.recordId === element.recordId &&
                other.path.slice(0, -1).join('.') === arrayPath.join('.'),
            ).length,
          ],
        ];
        for (const [name, damage, minimum] of variants) {
          const damaged = structuredClone(solved);
          damage(damaged);
          const report = gradeWorld(fixture.manifest, damaged, { terminalStatus: 'complete' });
          expect(report.preservationViolations, `${family} ${name}`).toBeGreaterThanOrEqual(minimum);
          expect(report.usefulCompletion, `${family} ${name}`).toBe(false);
          expect(report.falseCompletion, `${family} ${name}`).toBe(true);
        }
      }
    },
  );

  it('the families together exercise real mixed arrays (a subject element beside unrelated elements)', () => {
    expect(wildcardFamilies).toBe(FAMILIES.length - NO_LAYOUT_WILDCARD.length);
    expect(mixedArrays).toBeGreaterThanOrEqual(FAMILIES.length);
  });

  it('a wildcard-blind executor that rewrites the whole array is caught', () => {
    const seed = 'wildcard-blind';
    const fixture = generateSealedFixture(createWorldSpec({ family: 'shared_array', seed }), seed);
    const { world: solved } = runReference(fixture.world);
    const target = fixture.manifest.effects.find((effect) => effect.effect === 'redact')!;
    const field = fixture.world.scope.fields.find(
      (candidate) =>
        candidate.collectionId === target.address.collectionId &&
        candidate.path.includes('*') &&
        candidate.fieldId.endsWith('identity_binding'),
    )!;
    const arrayPath = field.path.slice(0, field.path.indexOf('*'));
    const blind = structuredClone(solved);
    const row = documentOf(blind, target.address.collectionId, target.address.recordId)!;
    const length = arrayAt(row, arrayPath).length;
    setAt(row, arrayPath, new Array(length).fill({ [field.path[field.path.length - 1]!]: '[redacted]' }));
    const report = gradeWorld(fixture.manifest, blind, { terminalStatus: 'complete' });
    expect(report.usefulCompletion).toBe(false);
    expect(report.preservationViolations).toBeGreaterThanOrEqual(1);
  });
});
