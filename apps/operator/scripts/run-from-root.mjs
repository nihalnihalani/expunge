import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';

const operator = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(operator, '../..');

/**
 * Environment for the operator child process. Expunge builds run with operator
 * telemetry OFF by default: DO_NOT_TRACK=1 is set unless the owner explicitly
 * opts in with EXPUNGE_ALLOW_TELEMETRY=1. An explicit DO_NOT_TRACK or
 * COPILOTKIT_TELEMETRY_DISABLED already present always stays in force. Upstream
 * telemetry code is not changed; this only sets the flag it already honors.
 */
export function childEnvironment(env) {
  const next = { ...env };
  if (next.EXPUNGE_ALLOW_TELEMETRY !== '1') next.DO_NOT_TRACK = '1';
  return next;
}

function main() {
  const script = process.argv[2] ?? 'dev';
  if (!['dev', 'build', 'start', 'typecheck', 'test'].includes(script))
    throw new Error('Choose dev, build, start, typecheck or test.');
  try {
    loadEnvFile(resolve(root, '.env'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Existing process environment wins, then root .env. No credential values are
  // logged or copied. Upstream startup can still load a standalone operator .env.
  const child = spawn('npm', ['run', script, ...process.argv.slice(3)], {
    cwd: operator,
    env: childEnvironment(process.env),
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`Operator command failed: ${error.code ?? error.name}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
