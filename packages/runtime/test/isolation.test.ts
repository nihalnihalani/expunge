import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the labeled fake provider stays out of production code', () => {
  it('is imported or re-exported by no production source under apps/worker/src or packages/{runtime,vendor-openmuse}/src, including the package entry', () => {
    const production = [
      ...sources(join(root, 'apps/worker/src')),
      ...sources(join(root, 'packages/runtime/src')),
      ...sources(join(root, 'packages/vendor-openmuse/src')),
    ].filter((path) => !path.includes('/src/testing/'));
    const offenders = production.filter((path) =>
      /FakeChatModel|fake-chat-model|testing\/index|fakeText|fakeToolCalls|fakeHang|FAKE_PROVIDER_NAME/.test(
        readFileSync(path, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('is reachable only through the @expunge/runtime/testing subpath, never the production entry', async () => {
    const manifest = JSON.parse(readFileSync(join(root, 'packages/runtime/package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports['.']).toBe('./src/index.ts');
    expect(manifest.exports['./testing']).toBe('./src/testing/index.ts');
    const production = (await import('../src/index.js')) as Record<string, unknown>;
    for (const name of ['FakeChatModel', 'fakeText', 'fakeToolCalls', 'fakeHang', 'FAKE_PROVIDER_NAME'])
      expect(name in production, name).toBe(false);
    const testing = (await import('../src/testing/index.js')) as Record<string, unknown>;
    expect(typeof testing.FakeChatModel).toBe('function');
  });

  it('is clearly labeled as a fake in its own source', () => {
    const source = readFileSync(join(root, 'packages/runtime/src/testing/fake-chat-model.ts'), 'utf8');
    expect(source).toContain('FAKE, DETERMINISTIC TEST PROVIDER');
    expect(source).toContain('NEVER A SUBSTITUTE FOR LIVE EVIDENCE');
  });

  it('the worker never reads the operator internal token or a setup credential', () => {
    for (const path of sources(join(root, 'apps/worker/src'))) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(
        /EXPUNGE_INTERNAL_TOKEN|MONGODB_SETUP_URI|MONGODB_FIXTURE|MONGODB_GRADER/,
      );
    }
  });
});
