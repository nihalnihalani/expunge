import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceBuildId } from './build-id.mjs';

const operator = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildId = sourceBuildId(operator);
mkdirSync(join(operator, 'dist'), { recursive: true });
writeFileSync(
  join(operator, 'dist', 'build-id.json'),
  `${JSON.stringify({ buildId })}\n`,
);
console.log(`build id ${buildId.slice(0, 12)}`);
