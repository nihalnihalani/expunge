import { readdirSync, readFileSync } from 'node:fs';
import { contentHash } from '@expunge/contracts';

/**
 * The worker runtime's identity, computed from the bytes this process actually loaded: every `.ts`/`.js` module of the
 * runtime and of the vendored OpenMuse helpers (the test-only `testing/` directory is not part of a production build),
 * the contracts module that defines hashing, and the Node major version. Logical module ids and bytes only; absolute
 * checkout paths never enter the digest. A worker records it in each run's committed checkpoint at claim time, and a
 * campaign compares that OBSERVED value with its stored freeze; nothing a caller supplies stands in for it.
 */
const SOURCE_DIRS = ['.', '../../vendor-openmuse/src'] as const;
const EXTRA = ['../../contracts/src/index.ts'] as const;

function modulesOf(dir: string): string[] {
  const base = new URL(`${dir}/`, import.meta.url);
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name))
    .map((entry) => `${dir}/${entry.name}`);
}

/** Reads one module's bytes. Production reads the file; a test injects a source to prove the digest follows the bytes. */
export type ModuleReader = (moduleId: string, url: URL) => string;
const readFromDisk: ModuleReader = (_moduleId, url) => readFileSync(url, 'utf8');

export function computeRuntimeHash(read: ModuleReader = readFromDisk): string {
  const ids = [...SOURCE_DIRS.flatMap(modulesOf), ...EXTRA].sort();
  const sources = ids.map((moduleId) => ({
    moduleId,
    source: read(moduleId, new URL(moduleId, import.meta.url)),
  }));
  return contentHash({ sources, nodeMajor: process.versions.node.split('.')[0] }, 'worker-runtime');
}

/** Computed once per process at first use. */
let cached: string | undefined;
export const runtimeHash = (): string => (cached ??= computeRuntimeHash());
