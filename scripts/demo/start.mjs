import { spawn, execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Starts the demo stack (domain service, worker, operator UI) for ONE scope, or stops what it started.
 *
 *   node scripts/demo/start.mjs <scopeId>             start all three, detached; pids and logs in .expunge/run/
 *   node scripts/demo/start.mjs <scopeId> --dry-run   print the commands and the variable NAMES each process gets
 *   node scripts/demo/start.mjs stop                  stop only the processes this script started (pid files)
 *
 * The scope id is passed explicitly to all three processes together with one tenant, environment and domain URL, so they
 * can never disagree (an inherited EXPUNGE_SCOPE_ID is overridden). The domain service and the worker load the root .env
 * themselves (--env-file-if-exists; values passed here win). The operator gets a clean environment built from an
 * allowlist of the variables apps/operator/src/server reads: owner, origins, domain URL and role tokens, Intelligence and
 * model keys. No MONGODB_* or ATLAS_* variable ever reaches it (asserted here; the operator's root launcher also refuses
 * MONGODB_*). Refuses to start when a port is already taken, so it cannot collide with a stack that is already running.
 * Prints names, ports and paths only, never values.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runDir = join(root, '.expunge/run');
const pidDir = join(runDir, 'pids');
const logDir = join(runDir, 'logs');
const envFile = join(root, '.env');

/** What apps/operator/src/server reads (plus the scope trio, for one shared value). Nothing that opens a database. */
const OPERATOR_VARS = [
  'OWNER_ID',
  'OWNER_TOKEN',
  'APP_ORIGIN',
  'HOST',
  'PORT',
  'DATABASE_PATH',
  'EXPUNGE_DOMAIN_URL',
  'EXPUNGE_DOMAIN_TIMEOUT_MS',
  'EXPUNGE_ALLOWED_ORIGINS',
  'EXPUNGE_INTERNAL_TOKEN',
  'EXPUNGE_JOB_WRITE_TOKEN',
  'EXPUNGE_APPROVAL_TOKEN',
  'EXPUNGE_ALLOW_TELEMETRY',
  'EXPUNGE_TENANT_ID',
  'EXPUNGE_ENV',
  'EXPUNGE_SCOPE_ID',
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_URL',
  'INTELLIGENCE_GATEWAY_WS_URL',
  'INTELLIGENCE_WS_URL',
  'CPK_TELEMETRY_ID',
  'COPILOTKIT_TELEMETRY_SAMPLE_RATE',
  'COPILOTKIT_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'WEB_SEARCH_PROVIDER',
  'PARALLEL_API_KEY',
  'BROWSER_URL',
  'BROWSER_SECRET',
  'VOICE_API_KEY',
  'VOICE_MODEL',
  'VOICE_NAME',
  'SLACK_CHANNEL_NAME',
  'SLACK_TEAM_ID',
  'SLACK_USER_IDS',
  'SLACK_DOT_ID',
  'COMPUTER_SUPERVISOR_URL',
  'COMPUTER_SUPERVISOR_TOKEN',
  'COMPUTER_TOKEN',
  'COMPUTER_NAMESPACE',
];
/** Process basics npm, vite and node need; nothing else from the launching shell reaches the operator. */
const BASE_VARS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
const FORBIDDEN = /^(MONGODB_|ATLAS_)/;
const VITE_PORT = 5173;

const fail = (code, detail = {}) => {
  console.log(JSON.stringify({ status: 'BLOCKED', code, ...detail }));
  process.exit(2);
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positional = args.filter((arg) => !arg.startsWith('--'));
if (positional.length !== 1) {
  console.log('usage: node scripts/demo/start.mjs <scopeId> [--dry-run] | node scripts/demo/start.mjs stop');
  process.exit(2);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const commandOf = (pid) => {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const records = () =>
  existsSync(pidDir)
    ? readdirSync(pidDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({
          file: join(pidDir, file),
          ...JSON.parse(readFileSync(join(pidDir, file), 'utf8')),
        }))
    : [];

if (positional[0] === 'stop') {
  const stopped = [];
  for (const record of records()) {
    // A pid is signalled only while it still runs the command this script started (guards against pid reuse).
    if (alive(record.pid) && commandOf(record.pid).includes(record.marker)) {
      try {
        process.kill(-record.pid, 'SIGTERM'); // detached: the pid is its process group (npm, vite, tsx children)
      } catch {
        process.kill(record.pid, 'SIGTERM');
      }
      const deadline = Date.now() + 8000;
      while (alive(record.pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
      if (alive(record.pid))
        try {
          process.kill(-record.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      stopped.push(record.name);
    }
    rmSync(record.file, { force: true });
  }
  console.log(JSON.stringify({ status: 'STOPPED', stopped }));
  process.exit(0);
}

const scopeId = positional[0];
if (!/^[A-Za-z0-9._-]{1,128}$/.test(scopeId)) fail('InvalidScopeId', { expected: '[A-Za-z0-9._-]{1,128}' });

let fileEnv = {};
try {
  fileEnv = parseEnv(readFileSync(envFile, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
// Same precedence as node --env-file: the launching environment wins over the file.
const setting = (name) => process.env[name]?.trim() || fileEnv[name]?.trim() || '';
const tenantId = setting('EXPUNGE_TENANT_ID');
const environment = setting('EXPUNGE_ENV');
const missing = [!tenantId && 'EXPUNGE_TENANT_ID', !environment && 'EXPUNGE_ENV'].filter(Boolean);
if (missing.length) fail('MissingConfiguration', { missing });
const domainUrl = setting('EXPUNGE_DOMAIN_URL') || 'http://127.0.0.1:4320';
const shared = {
  EXPUNGE_TENANT_ID: tenantId,
  EXPUNGE_ENV: environment,
  EXPUNGE_SCOPE_ID: scopeId,
  EXPUNGE_DOMAIN_URL: domainUrl,
};

const operatorEnv = {};
for (const name of [...BASE_VARS, ...OPERATOR_VARS]) {
  const value = BASE_VARS.includes(name) ? process.env[name] : setting(name);
  if (value) operatorEnv[name] = value;
}
Object.assign(operatorEnv, shared);
const leaked = Object.keys(operatorEnv).filter((name) => FORBIDDEN.test(name));
if (leaked.length) fail('OperatorEnvironmentLeak', { names: leaked });

const ports = {
  domain: Number(new URL(domainUrl).port || 4320),
  worker: Number(setting('EXPUNGE_WORKER_PORT') || 4330),
  operator: Number(setting('PORT') || 4310),
  vite: VITE_PORT,
};
const nodeEnvFile = `--env-file-if-exists=${envFile}`;
const processes = [
  {
    name: 'domain',
    cwd: root,
    argv: ['node', '--import', 'tsx', nodeEnvFile, 'scripts/domain-service.ts'],
    marker: 'scripts/domain-service.ts',
    env: { ...process.env, ...shared },
    ports: [ports.domain],
  },
  {
    name: 'worker',
    cwd: join(root, 'apps/worker'),
    argv: ['node', '--import', 'tsx', nodeEnvFile, 'src/index.ts'],
    marker: 'src/index.ts',
    env: { ...process.env, ...shared },
    ports: [ports.worker],
  },
  {
    name: 'operator',
    cwd: root,
    argv: ['node', 'apps/operator/scripts/run-from-root.mjs', 'dev'],
    marker: 'run-from-root.mjs',
    env: operatorEnv,
    ports: [ports.operator, ports.vite],
  },
];

if (dryRun) {
  for (const entry of processes)
    console.log(
      JSON.stringify({
        name: entry.name,
        cwd: entry.cwd,
        command: entry.argv.join(' '),
        explicit: shared,
        environment: entry.name === 'operator' ? Object.keys(entry.env).sort() : 'inherited + root .env',
        ports: entry.ports,
      }),
    );
  process.exit(0);
}

const running = records().filter(
  (record) => alive(record.pid) && commandOf(record.pid).includes(record.marker),
);
if (running.length)
  fail('AlreadyRunning', { names: running.map((record) => record.name), hint: 'stop first' });
const listening = (port) =>
  new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });
const taken = [];
for (const port of Object.values(ports)) if (await listening(port)) taken.push(port);
if (taken.length)
  fail('PortInUse', { ports: taken, hint: 'another stack is running; stop it or change the ports' });

mkdirSync(pidDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
for (const entry of processes) {
  const log = join(logDir, `${entry.name}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(entry.argv[0], entry.argv.slice(1), {
    cwd: entry.cwd,
    env: entry.env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  entry.child = child;
  entry.log = log;
  entry.exited = null;
  child.on('exit', (code) => (entry.exited = code ?? 1));
  writeFileSync(
    join(pidDir, `${entry.name}.json`),
    JSON.stringify({ name: entry.name, pid: child.pid, marker: entry.marker, scopeId }),
  );
}

// Wait for each port to answer (the operator's first dev start compiles for a while), or for an early exit.
const deadline = Date.now() + 90_000;
const status = {};
for (const entry of processes) {
  let ready = false;
  while (!ready && entry.exited === null && Date.now() < deadline) {
    ready = (await Promise.all(entry.ports.map(listening))).every(Boolean);
    if (!ready) await new Promise((done) => setTimeout(done, 500));
  }
  status[entry.name] = ready ? 'ready' : entry.exited !== null ? `exited (${entry.exited})` : 'not ready yet';
}
const ok = Object.values(status).every((value) => value === 'ready');
console.log(
  JSON.stringify(
    {
      status: ok ? 'READY' : 'CHECK_LOGS',
      scope: { tenantId, env: environment, scopeId },
      processes: status,
      open: `http://localhost:${VITE_PORT}`,
      logs: Object.fromEntries(processes.map((entry) => [entry.name, entry.log])),
      stop: 'node scripts/demo/start.mjs stop',
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
