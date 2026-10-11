/**
 * Static boundary: the FAKE split seam (`run-bundle-testing.ts`) is imported by tests only. No production module of the
 * observer package may import it, by static import, re-export, side-effect import or dynamic import, and the package
 * index must not export it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const modules = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
const SEAM = 'run-bundle-testing';
const mentions = (source: string): string[] => [
  ...new Set(
    [
      ...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
      ...source.matchAll(/export\s+\*?[^;]*?from\s*['"]([^'"]+)['"]/g),
    ]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.includes(SEAM)),
  ),
];

describe('observer production modules do not reach the FAKE split seam', () => {
  it('has the seam file and the production modules it scans', () => {
    expect(modules).toContain(`${SEAM}.ts`);
    expect(modules.length).toBeGreaterThan(8);
  });

  it('no module other than the seam imports, re-exports or dynamically imports it', () => {
    for (const name of modules.filter((m) => m !== `${SEAM}.ts`))
      expect({ name, hits: mentions(readFileSync(join(SRC, name), 'utf8')) }).toEqual({ name, hits: [] });
  });

  it('the scan catches each import form (so the check cannot pass vacuously)', () => {
    for (const form of [
      `import { createRunBundler } from './${SEAM}.js';`,
      `import './${SEAM}.js';`,
      `export * from './${SEAM}.js';`,
      `const m = await import('./${SEAM}.js');`,
    ])
      expect(mentions(form)).toHaveLength(1);
  });
});
