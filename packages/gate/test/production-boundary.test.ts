/**
 * DA-11 F-7. The scripted port is a test stand-in that can declare committed evidence; nothing that ships may be able to
 * reach it. The package exports its entry point alone, and no production source anywhere imports the scripted port.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const SCRIPTED =
  /(['"])(@expunge\/gate\/testing|(\.\.?\/)+[^'"]*\bgate\/test\/[^'"]*|(\.\.?\/)+[^'"]*\bscripted(\/[^'"]*)?)\1/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test' || name === 'tests') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}
const importLines = (text: string) =>
  text.split('\n').filter((line) => /\b(import|export)\b.*\bfrom\b|\bimport\(|\brequire\(/.test(line));

describe('the scripted port does not ship', () => {
  it('the detector catches each form (positive controls)', () => {
    for (const line of [
      `import { ScriptedEpisodePort } from '@expunge/gate/testing';`,
      `import { x } from '../../gate/test/scripted/index.js';`,
      `import { y } from "./scripted/sim.js";`,
      `const m = await import('../gate/test/support.js');`,
    ])
      expect(SCRIPTED.test(line), line).toBe(true);
    expect(SCRIPTED.test(`import { a } from '@expunge/gate';`)).toBe(false);
  });
  it('the gate package exports its entry point alone', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages/gate/package.json'), 'utf8')) as {
      exports: unknown;
    };
    expect(manifest.exports).toEqual({ '.': './src/index.ts' });
  });
  it('the package exports no checkpoint-stamp reader and no scripted or hook seam', async () => {
    const pkg = await import('../src/index.js');
    const names = Object.keys(pkg);
    for (const forbidden of [
      'MongoJobEvidence',
      'ScriptedEpisodePort',
      'SCRIPTED_PORT_LABEL',
      'betweenAttemptAndInsert',
    ])
      expect(names, forbidden).not.toContain(forbidden);
    // The one reader the gate builds takes its stamps from run_attestations alone.
    expect(names).toContain('AttestedJobEvidence');
    const source = readFileSync(join(root, 'packages/gate/src/job-evidence.ts'), 'utf8');
    expect(source).not.toMatch(/checkpoint[^\n]*attestedModels|attestedModels[^\n]*checkpoint/);
  });
  it('there is no scripted port among the gate package sources', () => {
    const files = sources(join(root, 'packages/gate/src'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => /scripted|sim\.ts/i.test(file))).toEqual([]);
    expect(files.filter((file) => /class ScriptedEpisodePort/.test(readFileSync(file, 'utf8')))).toEqual([]);
  });
  it('no production source in any workspace imports it', () => {
    const roots = [
      ...readdirSync(join(root, 'packages')).map((name) => join(root, 'packages', name, 'src')),
      join(root, 'apps/worker/src'),
    ].filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
    expect(roots.length).toBeGreaterThan(5);
    const offenders = roots.flatMap((dir) =>
      sources(dir).filter((file) =>
        importLines(readFileSync(file, 'utf8')).some((line) => SCRIPTED.test(line)),
      ),
    );
    expect(offenders.map((file) => file.replace(root, ''))).toEqual([]);
  });
});
