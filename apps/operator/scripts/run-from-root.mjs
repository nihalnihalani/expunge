import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process, { loadEnvFile } from 'node:process';
import console from 'node:console';

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
  const forbidden = Object.keys(env)
    .filter(
      (name) =>
        name.startsWith('MONGODB_') &&
        typeof env[name] === 'string' &&
        env[name].trim(),
    )
    .sort();
  if (forbidden.length)
    throw new Error(
      `Operator environment contains forbidden database credentials: ${forbidden.join(', ')}. Use the operator role environment.`,
    );
  const next = { ...env };
  if (next.EXPUNGE_ALLOW_TELEMETRY !== '1') next.DO_NOT_TRACK = '1';
  return next;
}

function main() {
  const script = process.argv[2] ?? 'dev';
  if (!['dev', 'build', 'start', 'typecheck', 'test'].includes(script))
    throw new Error('Choose dev, build, start, typecheck or test.');
  try {
    loadEnvFile(resolve(root, '.env.operator'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Existing process environment wins, then the operator's role-scoped file.
  // Upstream startup also checks its environment after loading its standalone .env.
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
