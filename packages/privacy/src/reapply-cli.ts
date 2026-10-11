import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPrincipalService, mongoConfigFromEnv } from '@expunge/mongo';
import { ENC_KEY_VARIABLE, MAC_KEY_VARIABLE, openLedger, sealLedger } from './ledger-security.js';
import {
  REQUIRED_ATTESTATIONS,
  ledgerSha256,
  newCursor,
  reapplyErasures,
  type ReapplyCursor,
} from './reapply.js';
import { exportErasureLedger, mongoReapplyPorts, writePrivateFile } from './reapply-mongo.js';

/**
 * Post-restore erasure re-application. All commands use the privacy_controller principal (MONGODB_PRIVACY_CONTROLLER_URI),
 * never setup.
 *
 *   export --ledger FILE [--retention-days N]   (BEFORE wiping the damaged database) write the erasure ledger: mode 0600,
 *                                        signed with HMAC (env EXPUNGE_LEDGER_MAC_KEY, required), AES-256-GCM encrypted when
 *                                        EXPUNGE_LEDGER_ENC_KEY (64 hex) is set; the header carries counts, latest times, retention
 *   apply  --ledger FILE --cursor FILE [--allow-expired]   (after the restore, BEFORE any service starts) verify MAC, header and
 *                                        retention, then replay; resumable; exit 0 only when DONE
 *   attest --cursor FILE NAME=REFERENCE  record that a step this tool cannot do was done (names: world-effects-reconciled,
 *                                        derived-artifacts-retracted); needs a non-empty reference such as a ticket or run id
 *
 * Exit codes: 0 done, 2 usage/configuration, 5 pending (the restored system must stay out of service), 1 failure.
 * Exit 0 means the replayed jobs, suppressions and tombstones are present. It does NOT mean erasure is complete: the two
 * attestations are free text in an unauthenticated file and are ATTESTED, NOT VERIFIED (the report's `notice` says so).
 */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const ledgerPath = flag('--ledger');
  const cursorPath = flag('--cursor');
  const loadCursor = (hash: string): ReapplyCursor => {
    if (cursorPath && existsSync(cursorPath))
      return JSON.parse(readFileSync(cursorPath, 'utf8')) as ReapplyCursor;
    return newCursor(hash);
  };
  try {
    if (command === 'attest') {
      const pair = rest.find((a) => /^[a-z-]+=.+/.test(a));
      if (!cursorPath || !pair || !existsSync(cursorPath)) return usage();
      const [name, ...ref] = pair.split('=');
      if (!(REQUIRED_ATTESTATIONS as readonly string[]).includes(name!)) return usage();
      const cursor = JSON.parse(readFileSync(cursorPath, 'utf8')) as ReapplyCursor;
      cursor.attestations[name!] = ref.join('=');
      writePrivateFile(cursorPath, JSON.stringify(cursor));
      console.log(JSON.stringify({ attested: name, status: 'ATTESTED, NOT VERIFIED' }));
      return 0;
    }
    if ((command !== 'export' && command !== 'apply') || !ledgerPath) return usage();
    const service = createPrincipalService(mongoConfigFromEnv(env), 'privacy_controller');
    try {
      await service.client.connect();
      if (command === 'export') {
        const ledger = await exportErasureLedger(service);
        const days = Number(flag('--retention-days') ?? 30);
        writePrivateFile(
          ledgerPath,
          sealLedger(ledger, {
            macKey: env[MAC_KEY_VARIABLE],
            encKey: env[ENC_KEY_VARIABLE],
            retentionDays: days,
          }),
        );
        console.log(
          JSON.stringify({ exported: { jobs: ledger.jobs.length, tombstones: ledger.tombstones.length } }),
        );
        return 0;
      }
      if (!cursorPath) return usage();
      const text = readFileSync(ledgerPath, 'utf8');
      const hash = ledgerSha256(text);
      const cursor = loadCursor(hash);
      const parsed = openLedger(text, {
        macKey: env[MAC_KEY_VARIABLE],
        encKey: env[ENC_KEY_VARIABLE],
        allowExpired: rest.includes('--allow-expired'),
      });
      const report = await reapplyErasures(parsed, hash, mongoReapplyPorts(service), cursor, (c) =>
        writePrivateFile(cursorPath, JSON.stringify(c)),
      );
      writePrivateFile(cursorPath, JSON.stringify(cursor));
      console.log(JSON.stringify(report));
      return report.done ? 0 : 5;
    } finally {
      await service.close();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.name : 'unknown',
        code: (error as { code?: string }).code,
        message: error instanceof Error ? error.message.slice(0, 120) : undefined,
      }),
    );
    return 1;
  }
}

function usage(): number {
  console.error(
    'usage: reapply-cli.ts export --ledger F | apply --ledger F --cursor F | attest --cursor F NAME=REF',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((code) => void (process.exitCode = code));
