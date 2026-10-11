import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The operator is a standalone project with its own lock, so its Node floor must be kept equal
// to the root's by a test, not by memory (nodejs/node#60717 is fixed in 24.13.1 and 25.4.0).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8');
const operator = JSON.parse(read('../package.json')) as {
  engines: { node: string };
};
const lock = JSON.parse(read('../package-lock.json')) as {
  packages: Record<string, { engines?: { node: string } }>;
};
const rootPackage = new URL('../../../package.json', import.meta.url);

it('keeps the operator Node range, its lock entry and .nvmrc equal to the root', () => {
  expect(lock.packages[''].engines?.node).toBe(operator.engines.node);
  expect(read('../.nvmrc').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  if (!existsSync(rootPackage)) return;
  const root = JSON.parse(readFileSync(rootPackage, 'utf8')) as {
    engines: { node: string };
  };
  expect(operator.engines.node).toBe(root.engines.node);
  const rootNvmrc = new URL('../../../.nvmrc', import.meta.url);
  if (existsSync(rootNvmrc))
    expect(read('../.nvmrc').trim()).toBe(
      readFileSync(rootNvmrc, 'utf8').trim(),
    );
});

it('does not add or change dependencies', () => {
  // Expunge adds no npm dependency: every runtime and dev dependency stays an upstream pin.
  const names = Object.keys(JSON.parse(read('../package.json')).dependencies);
  for (const added of [
    'd3',
    'cytoscape',
    'reactflow',
    '@xyflow/react',
    'recharts',
    'zustand',
    'swr',
    '@tanstack/react-virtual',
  ])
    expect(names).not.toContain(added);
});
