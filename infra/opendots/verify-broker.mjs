/**
 * Live check of the candidate BROKER path: from INSIDE the guarded candidate computer, the two admitted routes work through
 * the proxy and everything else is denied. Usage: node infra/opendots/verify-broker.mjs <env-file> <artifact-sha256>
 * The env file must be the broker-profile stack's (EXPUNGE_BROKER_SPOOL_DIR is read to confirm what reached the broker).
 */
import { loadEnvFile } from 'node:process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
loadEnvFile(resolve(process.argv[2]));
const hash = process.argv[3];
const env = process.env;
if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('Pass the admitted artifact sha256.');
const origin = `http://127.0.0.1:${Number(env.EXPUNGE_CANDIDATE_PORT ?? 4313)}`;
const headers = {
  Authorization: `Bearer ${env.EXPUNGE_CANDIDATE_COMPUTER_TOKEN}`,
  'x-openbot-bot-id': env.EXPUNGE_CANDIDATE_DOT_ID,
  'Content-Type': 'application/json',
};
const exec = async (command) => {
  const response = await fetch(origin + '/exec', {
    method: 'POST',
    headers,
    body: JSON.stringify({ command, timeoutMs: 30_000 }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!response.ok) throw new Error(`exec failed with HTTP ${response.status}`);
  return response.json();
};
// The trusted side mints the run ticket (128-bit random id) and puts it in the broker's read-only ticket directory.
const ticketId = randomBytes(16).toString('hex');
writeFileSync(
  join(env.EXPUNGE_BROKER_TICKETS_DIR, `${ticketId}.json`),
  JSON.stringify({
    ticketId,
    candidateId: env.EXPUNGE_CANDIDATE_ID,
    slot: 'discovery',
    artifactHash: hash,
    inputHash: 'c'.repeat(64),
    jobId: 'job-live-1',
    runId: 'run-live-1',
    callNumber: 0,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }),
);
const program = `
const proxy = 'http://candidate-proxy:4314';
const token = process.argv[1];
const hash = process.argv[2];
const ticketId = process.argv[3];
const call = async (label, path, { method = 'POST', body, auth = token } = {}) => {
  try {
    const response = await fetch(proxy + path, {
      method,
      headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2500),
    });
    const text = await response.text();
    return { label, status: response.status, bytes: text.length, ...(label === 'fetch' ? { sha: (await import('node:crypto')).createHash('sha256').update(Buffer.from(JSON.parse(text).contentBase64, 'base64')).digest('hex') } : {}) };
  } catch (e) {
    return { label, blocked: true, error: typeof e.code === 'string' ? e.code : e.name };
  }
};
const blocked = async (label, url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return { label, blocked: false };
  } catch (e) {
    return { label, blocked: true, error: typeof e.code === 'string' ? e.code : e.name };
  }
};
const rows = [
  await call('fetch', '/artifact/fetch', { body: { artifactHash: hash } }),
  await call('submit', '/result/submit', { body: { ticketId, value: { candidates: [{ fieldId: 'a.b', reason: 'live' }] } } }),
  await call('submit-again', '/result/submit', { body: { ticketId, value: { candidates: [{ fieldId: 'a.b', reason: 'live' }] } } }),
  await call('submit-different', '/result/submit', { body: { ticketId, value: { candidates: [] } } }),
  await call('guessed-ticket', '/result/submit', { body: { ticketId: 'ab'.repeat(16), value: { candidates: [] } } }),
  await call('old-envelope', '/result/submit', { body: { jobId: 'job-live-1', runId: 'run-live-1', callNumber: 0, inputHash: 'c'.repeat(64), slot: 'discovery', artifactHash: hash, value: { candidates: [] } } }),
  await call('unadmitted-artifact', '/artifact/fetch', { body: { artifactHash: 'a'.repeat(64) } }),
  await call('promote', '/promote', { body: {} }),
  await call('oracle', '/oracle/manifest', { body: {} }),
  await call('get-fetch', '/artifact/fetch', { method: 'GET' }),
  await call('no-token', '/artifact/fetch', { body: { artifactHash: hash }, auth: '' }),
  await call('wrong-token', '/artifact/fetch', { body: { artifactHash: hash }, auth: 'x'.repeat(30) }),
  await blocked('direct-broker-ip', 'http://172.30.91.9:4320/artifact/fetch'),
  await blocked('broker-name', 'http://candidate-broker:4320/artifact/fetch'),
  await blocked('internet', 'https://1.1.1.1'),
  await blocked('metadata', 'http://169.254.169.254'),
];
for (const row of rows) console.log(JSON.stringify(row));
`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const run = await exec(
  `node --input-type=module -e ${quote(program)} ${quote(env.EXPUNGE_CANDIDATE_ACCESS_TOKEN)} ${quote(hash)} ${quote(ticketId)}`,
);
if (run.exitCode !== 0 || run.timedOut || run.truncated)
  throw new Error('Broker check did not finish cleanly.');
const rows = Object.fromEntries(
  run.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((row) => [row.label, row]),
);
const expect = (ok, what) => {
  if (!ok) throw new Error(`Broker check failed: ${what}`);
};
expect(rows.fetch.status === 200 && rows.fetch.sha === hash, 'admitted artifact fetched intact');
expect(rows.submit.status === 200, 'typed result accepted');
expect(rows['submit-again'].status === 200, 'duplicate result is idempotent');
expect(rows['submit-different'].status === 409, 'a different second result for the ticket is refused');
expect(rows['guessed-ticket'].status === 403, 'a guessed ticket is refused');
expect(rows['old-envelope'].status === 400, 'a self-declared binding is refused');
expect(rows['unadmitted-artifact'].status === 404, 'unadmitted artifact refused');
for (const label of ['promote', 'oracle', 'get-fetch'])
  expect(rows[label].status === 403, `${label} denied at the proxy`);
for (const label of ['no-token', 'wrong-token']) expect(rows[label].status === 401, `${label} refused`);
for (const label of ['direct-broker-ip', 'broker-name', 'internet', 'metadata'])
  expect(rows[label].blocked === true, `${label} blocked by the firewall`);
const spool = join(env.EXPUNGE_BROKER_SPOOL_DIR, 'results.jsonl');
const spooled = existsSync(spool) ? readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean) : [];
expect(
  spooled.length === 1 && JSON.parse(spooled[0]).runId === 'run-live-1',
  'exactly one result reached the broker spool',
);
console.log(
  JSON.stringify({
    kind: 'live-candidate-broker-verification',
    rows: Object.values(rows),
    spooledResults: spooled.length,
  }),
);
