import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Lock = { packages: Record<string, { version?: string }> };
const load = (relative: string): Lock =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')) as Lock;
const root = load('../../../package-lock.json');
const operator = load('../../../apps/operator/package-lock.json');

/** Every resolved version of `name` anywhere in the lock, as "location -> version". */
function versions(lock: Lock, name: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [location, entry] of Object.entries(lock.packages))
    if (location.endsWith(`node_modules/${name}`) && entry.version) found.set(location, entry.version);
  return found;
}
const distinct = (lock: Lock, name: string) => [...new Set(versions(lock, name).values())].sort();

describe('workspace dependency coherence with the operator lock (AG-UI / CopilotKit / TanStack)', () => {
  it('resolves exactly one @ag-ui/client version in the root tree: 0.0.59', () => {
    expect(distinct(root, '@ag-ui/client')).toEqual(['0.0.59']);
  });

  it('keeps the same single @ag-ui/client as the operator', () => {
    expect(distinct(operator, '@ag-ui/client')).toEqual(['0.0.59']);
  });

  it.each([
    '@ag-ui/core',
    '@ag-ui/encoder',
    '@ag-ui/proto',
    '@ag-ui/langgraph',
    '@copilotkit/core',
    '@copilotkit/shared',
    '@copilotkit/runtime',
    '@tanstack/ai',
    '@tanstack/ai-openai',
    '@tanstack/openai-base',
    '@tanstack/ai-utils',
    '@tanstack/ai-event-client',
  ])('resolves %s to the same version(s) as the operator lock', (name) => {
    expect(distinct(root, name)).toEqual(distinct(operator, name));
  });

  it('resolves the top-level rxjs to the operator version (the operator also nests a dev-tool copy)', () => {
    expect(root.packages['node_modules/rxjs']?.version).toBe('7.8.1');
    expect(operator.packages['node_modules/rxjs']?.version).toBe('7.8.1');
    expect(distinct(root, 'rxjs')).toEqual(['7.8.1']);
  });

  it('has one @tanstack/ai (0.63.0) and one @copilotkit/runtime (1.75.0), the latter nested only once', () => {
    expect(distinct(root, '@tanstack/ai')).toEqual(['0.63.0']);
    expect(versions(root, '@tanstack/ai').size).toBe(1);
    expect(distinct(root, '@copilotkit/runtime')).toEqual(['1.75.0']);
    expect(versions(root, '@copilotkit/runtime').size).toBe(1);
  });

  it('installs the Anthropic adapter at the newest version that admits @tanstack/ai 0.63.0', () => {
    expect(distinct(root, '@tanstack/ai-anthropic')).toEqual(['0.19.3']);
  });

  it('pins every dependency of the new packages exactly (no range operators)', () => {
    for (const path of [
      '../package.json',
      '../../runtime/package.json',
      '../../../apps/worker/package.json',
    ]) {
      const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      for (const [name, range] of Object.entries(manifest.dependencies))
        expect(range, `${path} ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('declares the same version for shared SDK dependencies across the three new manifests', () => {
    const read = (path: string) =>
      (
        JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as {
          dependencies: Record<string, string>;
        }
      ).dependencies;
    const manifests = [
      read('../package.json'),
      read('../../runtime/package.json'),
      read('../../../apps/worker/package.json'),
    ];
    for (const name of ['@ag-ui/client', '@ag-ui/core', '@tanstack/ai', 'rxjs', 'zod']) {
      const declared = new Set(manifests.map((m) => m[name]).filter(Boolean));
      expect(declared.size, name).toBe(1);
    }
  });
});
