import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string) => readFileSync(here(relative), 'utf8');

describe('attribution and license handling for the OpenMuse port', () => {
  it('ships the MIT license text from the pinned upstream commit unchanged', () => {
    const license = readFileSync(here('../LICENSE.openmuse'));
    // git blob a3366dc2633aa74760c26210963ec8a11df02894 at openmuse@1ac68f3
    const blob = createHash('sha1').update(`blob ${license.length}\0`).update(license).digest('hex');
    expect(blob).toBe('a3366dc2633aa74760c26210963ec8a11df02894');
    expect(license.toString('utf8')).toContain('Copyright (c) 2026 OpenMuse contributors');
  });

  it('records the pin, every source URL and every modification in THIRD_PARTY.md', () => {
    const doc = read('../THIRD_PARTY.md');
    expect(doc).toContain('1ac68f3909f2478ab6280883f1ab5ea65eb5719d');
    for (const file of ['tanstack-agent.ts', 'config.ts', 'conversation.ts', 'model.ts', 'worker.ts'])
      expect(doc).toContain(
        `https://github.com/CopilotKit/openmuse/blob/1ac68f3909f2478ab6280883f1ab5ea65eb5719d/apps/server/src/${file === 'config.ts' ? '' : 'engine/'}${file}`,
      );
    for (let i = 1; i <= 12; i++) expect(doc).toContain(`| M${i} |`);
    expect(doc).toContain('625452e06cde74cb25b0ce319e2c1be0488f5a5f');
  });

  it('marks every ported source file with the upstream attribution', () => {
    for (const file of ['tanstack-agent', 'provider', 'state-tools', 'model-retries']) {
      const source = read(`../src/${file}.ts`);
      expect(source.slice(0, 600)).toContain('OpenMuse');
      expect(source.slice(0, 600)).toContain('MIT');
    }
  });
});
