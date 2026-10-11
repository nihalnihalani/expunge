import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const operator = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What a build is made from. Tests, docs and scripts do not change the built output. */
const ROOTS = ['src', 'public'];
const FILES = [
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.server.json',
];

function walk(directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (entry.isFile()) found.push(path);
  }
}

/**
 * A hash of the source a build is made from: each file's relative path and content hash, in
 * sorted order. `npm run build` writes it to dist/build-id.json; the server reports it at
 * /api/expunge/status; the browser checks recompute it from the tree under test and refuse to
 * run against a server built from anything else.
 */
export function sourceBuildId(root = operator) {
  const found = [];
  for (const directory of ROOTS) {
    try {
      if (statSync(join(root, directory)).isDirectory())
        walk(join(root, directory), found);
    } catch {
      // A missing optional root contributes nothing.
    }
  }
  for (const file of FILES) {
    try {
      if (statSync(join(root, file)).isFile()) found.push(join(root, file));
    } catch {
      // Optional file.
    }
  }
  const lines = found
    .map((path) => relative(root, path).split('\\').join('/'))
    .sort()
    .map((rel) => {
      const content = readFileSync(join(root, rel));
      return `${rel}\0${createHash('sha256').update(content).digest('hex')}\n`;
    });
  return createHash('sha256').update(lines.join('')).digest('hex');
}
