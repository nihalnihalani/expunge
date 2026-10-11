import { pathToFileURL } from 'node:url';
import { createEvidenceProcess, type EvidenceLog } from './process.js';

const log: EvidenceLog = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

/**
 * The evidence process entry. It prints the readiness lines (names only) and exits 3 when BLOCKED, like the worker's
 * `--readiness`; when READY it runs the dispatcher and observer loops until SIGINT/SIGTERM.
 *
 * The export-suppression source exists (`createMongoExportSuppression`, the `erasure_suppressions` read) but no leak-guard
 * source does (the subject map the privacy controller owns), and this entry point wires neither, so it is always BLOCKED:
 * event intents are not sent and the observer does not run. That is the intended fail-closed state, not a missing
 * feature to paper over. A missing suppression source is BLOCKED by readiness, never replaced by a stub.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const started = createEvidenceProcess(env, {}, { log });
  for (const line of started.readiness.lines) console.log(line);
  if (started.status === 'BLOCKED') return 3;
  started.process.start({ dispatch: 5_000, scan: 30_000 });
  const stop = () => {
    started.process.stop();
    void started.service.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => void (process.exitCode = code),
    (error) => {
      console.error(JSON.stringify({ fatal: error instanceof Error ? error.name : 'unknown' }));
      process.exit(1);
    },
  );
