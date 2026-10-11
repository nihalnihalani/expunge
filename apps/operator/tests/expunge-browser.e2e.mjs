/* eslint-disable no-undef -- Node script driving a browser; not part of the vitest run. */
/**
 * Browser verification runner for the Expunge workflow (DA-7 E1).
 *
 *   EXPUNGE_E2E_OUT=<dir> node --import tsx tests/expunge-browser.e2e.mjs s1 [s2 s3 ...]
 *
 * Requires `npm run build` first. The runner:
 *   1. recomputes the build id of the source tree under test and compares it with
 *      dist/build-id.json; a stale build exits 2 with `build_mismatch` before anything starts;
 *   2. starts the labeled FIXTURE backend and two operator processes (configured, and setup-only)
 *      from that dist on free loopback ports it picks itself, so no shared or default port is used;
 *   3. refuses to run unless the configured operator reports the same build id at
 *      /api/expunge/status (exit 2);
 *   4. records the build id, Node version and listener-free summary in each results file.
 * Everything it starts is stopped on exit. Not collected by vitest (no .test in the name).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceBuildId } from '../scripts/build-id.mjs';

const operator = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const slices = process.argv.slice(2);
if (slices.length === 0)
  throw new Error(
    'Usage: node --import tsx tests/expunge-browser.e2e.mjs <slice> [<slice> ...]',
  );
for (const slice of slices)
  if (!/^s\d+$/.test(slice)) throw new Error(`Unknown slice: ${slice}`);

const expected = sourceBuildId(operator);
let built = null;
try {
  built = JSON.parse(
    fs.readFileSync(path.join(operator, 'dist', 'build-id.json'), 'utf8'),
  ).buildId;
} catch {
  // No build at all is the same failure.
}
const mismatch = (reason, got) => {
  console.error(
    `build_mismatch: ${reason}. source ${expected.slice(0, 12)}, running ${String(got).slice(0, 12)}. Run npm run build.`,
  );
  process.exit(2);
};
if (built !== expected) mismatch('dist is not built from this tree', built);

const children = [];
const cleanup = [];
async function stopAll() {
  for (const child of children) child.kill('SIGTERM');
  for (const fn of cleanup) await fn().catch(() => undefined);
  fs.rmSync(scratch, { recursive: true, force: true });
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'expunge-e2e-'));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, headers, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response.json();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('An operator process did not answer in time.');
}

function startOperator(port, extra) {
  const child = spawn(
    process.execPath,
    [path.join(operator, 'dist', 'server', 'server', 'index.js')],
    {
      cwd: operator,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        HOST: '127.0.0.1',
        PORT: String(port),
        NODE_ENV: 'production',
        DATABASE_PATH: path.join(scratch, `operator-${port}.sqlite`),
        ...extra,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  children.push(child);
  return child;
}

let exitCode;
try {
  const { FIXTURE_TOKENS, startFixture } =
    await import('./fixtures/expunge-domain-fixture.ts');
  const fixture = await startFixture(0);
  cleanup.push(() => fixture.close());
  const ownerToken = crypto.randomBytes(24).toString('hex');
  const configuredPort = await freePort();
  const setupOnlyPort = await freePort();
  startOperator(configuredPort, {
    OWNER_TOKEN: ownerToken,
    EXPUNGE_DOMAIN_URL: fixture.url,
    EXPUNGE_INTERNAL_TOKEN: FIXTURE_TOKENS.read,
    EXPUNGE_JOB_WRITE_TOKEN: FIXTURE_TOKENS.jobWrite,
    EXPUNGE_APPROVAL_TOKEN: FIXTURE_TOKENS.approval,
  });
  startOperator(setupOnlyPort, { OWNER_TOKEN: ownerToken });
  const base = `http://127.0.0.1:${configuredPort}`;
  const auth = { Authorization: `Bearer ${ownerToken}` };
  const status = await waitFor(`${base}/api/expunge/status`, auth);
  await waitFor(`http://127.0.0.1:${setupOnlyPort}/api/expunge/status`, auth);
  if (status.build !== expected)
    mismatch('the server answering is another build', status.build);

  const tokenFile = path.join(scratch, 'owner-token');
  fs.writeFileSync(tokenFile, ownerToken, { mode: 0o600 });
  process.env.EXPUNGE_E2E_BASE = base;
  process.env.EXPUNGE_E2E_BASE_SETUPONLY = `http://127.0.0.1:${setupOnlyPort}`;
  process.env.EXPUNGE_E2E_FIXTURE = fixture.url;
  process.env.EXPUNGE_E2E_TOKEN_FILE = tokenFile;
  process.env.EXPUNGE_E2E_OUT ??= path.join(
    operator,
    '..',
    '..',
    'docs',
    'ui',
    'screens',
  );

  const { config, failures, finish, launch } =
    await import('./browser/common.mjs');
  const baseOut = process.env.EXPUNGE_E2E_OUT;
  const browser = await launch();
  try {
    for (const slice of slices) {
      process.env.EXPUNGE_E2E_OUT = path.join(baseOut, slice);
      const cfg = config();
      const module = await import(`./browser/${slice}.mjs`);
      const results = await module.run(browser, cfg);
      const summary = finish(slice, results, {
        buildId: expected,
        node: process.version,
        generatedBy: 'tests/expunge-browser.e2e.mjs',
        backend: 'FIXTURE (test data, not a live job)',
      });
      fs.writeFileSync(
        path.join(cfg.out, `results-${slice}.json`),
        JSON.stringify(summary, null, 1),
      );
    }
  } finally {
    await browser.close();
  }
  exitCode = failures.length ? 1 : 0;
} finally {
  await stopAll();
}
process.exit(exitCode ?? 1);
