import { readFileSync } from 'node:fs';
import { contentHash } from '@expunge/contracts';

/** Hash logical module IDs and actual source bytes; absolute checkout paths never enter the digest. */
export function sourceCommitment(files: readonly string[], domain: string): string {
  const sources = [...files]
    .sort()
    .map((moduleId) => ({ moduleId, source: readFileSync(new URL(moduleId, import.meta.url), 'utf8') }));
  return contentHash({ sources }, domain);
}
