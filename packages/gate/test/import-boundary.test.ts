/**
 * DA-8 D8-9. Worker and proposer images must exclude the sealed fixtures, the grader, the gate and the deployment
 * package. A source scan of every candidate-side workspace (production `src` only), with positive controls.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const CANDIDATE_SIDE = [
  'apps/worker/src',
  'packages/runtime/src',
  'packages/domain/src',
  'packages/evolution/src',
  'packages/observer/src',
  'packages/observability/src',
  'packages/governance/src',
  'packages/harness-compiler/src',
  'packages/baselines/src',
  'packages/vendor-openmuse/src',
];
// A candidate-side module may not name any of these, by package specifier or by relative path.
const FORBIDDEN =
  /(['"])(@expunge\/(grader|gate|deployment)(\/[^'"]*)?|@expunge\/fixtures(\/[^'"]*)?|(\.\.?\/)+[^'"]*\b(fixtures|grader|gate|deployment)\/src[^'"]*)\1/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}
const importLines = (text: string) =>
  text.split('\n').filter((line) => /\b(import|export)\b.*\bfrom\b|\bimport\(|\brequire\(/.test(line));

describe('candidate-side code cannot import the evaluator side', () => {
  it('the detector catches each form (positive controls)', () => {
    for (const line of [
      `import { x } from '@expunge/fixtures/sealed';`,
      `import { y } from "@expunge/grader";`,
      `import { z } from '@expunge/gate';`,
      `const m = await import('@expunge/deployment');`,
      `import { w } from '../../fixtures/src/sealed.js';`,
    ])
      expect(FORBIDDEN.test(line), line).toBe(true);
    expect(FORBIDDEN.test(`import { a } from '@expunge/contracts';`)).toBe(false);
  });
  for (const dir of CANDIDATE_SIDE)
    it(`${dir} imports none of them`, () => {
      const base = join(root, dir);
      const files = sources(base);
      expect(files.length).toBeGreaterThan(0);
      const offenders = files.filter((file) =>
        importLines(readFileSync(file, 'utf8')).some((l) => FORBIDDEN.test(l)),
      );
      expect(offenders.map((file) => file.replace(root, ''))).toEqual([]);
    });
  it('no candidate-side manifest depends on them', () => {
    for (const dir of CANDIDATE_SIDE) {
      const manifest = JSON.parse(readFileSync(join(root, dir, '../package.json'), 'utf8')) as Record<
        string,
        Record<string, string>
      >;
      const deps = Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      });
      expect(
        deps.filter((name) => /^@expunge\/(fixtures|grader|gate|deployment)$/.test(name)),
        dir,
      ).toEqual([]);
    }
  });
});
