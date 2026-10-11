import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The identity of the build this process is running: a hash of the source tree it was built from,
 * written to dist/build-id.json by scripts/write-build-id.mjs at the end of `npm run build`. The
 * browser checks compare it to a hash of the tree under test, so a stale or foreign server cannot
 * pass a check. Null when running unbuilt (for example under tsx in development).
 */
export function readBuildId(
  file = fileURLToPath(new URL('../../../build-id.json', import.meta.url)),
): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      buildId?: unknown;
    };
    return typeof parsed.buildId === 'string' &&
      /^[a-f0-9]{64}$/.test(parsed.buildId)
      ? parsed.buildId
      : null;
  } catch {
    return null;
  }
}
