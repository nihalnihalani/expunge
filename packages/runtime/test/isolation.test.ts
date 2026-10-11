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
  it('is imported by no production source under apps/worker/src or packages/{runtime,vendor-openmuse}/src except the runtime testing module and its re-export', () => {
    const production = [
      ...sources(join(root, 'apps/worker/src')),
      ...sources(join(root, 'packages/runtime/src')),
      ...sources(join(root, 'packages/vendor-openmuse/src')),
    ].filter((path) => !path.includes('/src/testing/'));
    const offenders = production.filter((path) => {
      if (path.endsWith('packages/runtime/src/index.ts')) return false; // the single, explicit re-export
      return /FakeChatModel|fake-chat-model|fakeText|fakeToolCalls|fakeHang/.test(readFileSync(path, 'utf8'));
    });
    expect(offenders).toEqual([]);
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
