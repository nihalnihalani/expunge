import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandidateBroker, ALLOWED_ENV } from './candidate-broker.mjs';
import { createCandidateProxy } from './candidate-proxy.mjs';

/** Broker behind the real restricted proxy, in one process over loopback HTTP. No Docker, no database, no model. */
const sha = (value) => createHash('sha256').update(value).digest('hex');
const brokerToken = 'fixture-broker-token-distinct-0123456789';
const candidateToken = 'fixture-candidate-token-distinct-0123456789';
const ROUTES = '[{"method":"POST","path":"/artifact/fetch"},{"method":"POST","path":"/result/submit"}]';
const running = [];
let dirs, proxyOrigin, brokerOrigin, artifact, hash, now;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  running.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const brokerEnv = () => ({
  EXPUNGE_CANDIDATE_BROKER_TOKEN: brokerToken,
  EXPUNGE_CANDIDATE_ID: 'candidate-1',
  EXPUNGE_BROKER_ARTIFACT_DIR: dirs.artifacts,
  EXPUNGE_BROKER_SPOOL_DIR: dirs.spool,
  EXPUNGE_BROKER_TICKET_DIR: dirs.tickets,
});
beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'broker-'));
  dirs = { artifacts: join(root, 'artifacts'), spool: join(root, 'spool'), tickets: join(root, 'tickets') };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  artifact = 'export function discover() { return { candidates: [] }; }\n';
  hash = sha(artifact);
  writeFileSync(join(dirs.artifacts, hash), artifact);
  now = Date.UTC(2026, 9, 11, 12, 0, 0);
  brokerOrigin = await listen(createCandidateBroker(brokerEnv(), () => now));
  proxyOrigin = await listen(
    createCandidateProxy({
      EXPUNGE_CANDIDATE_ID: 'candidate-1',
      EXPUNGE_CANDIDATE_ACCESS_TOKEN: candidateToken,
      EXPUNGE_CANDIDATE_BROKER_TOKEN: brokerToken,
      EXPUNGE_CANDIDATE_BROKER_ORIGIN: brokerOrigin,
      EXPUNGE_CANDIDATE_ALLOWED_ROUTES: ROUTES,
    }),
  );
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** What the trusted side does: mint a 128-bit random id, bind it to artifact, input, job, run and call, set an expiry. */
function mint(over = {}) {
  const ticket = {
    ticketId: randomBytes(16).toString('hex'),
    candidateId: 'candidate-1',
    slot: 'discovery',
    artifactHash: hash,
    inputHash: 'c'.repeat(64),
    jobId: 'job-1',
    runId: 'run-1',
    callNumber: 0,
    expiresAt: new Date(now + 600_000).toISOString(),
    ...over,
  };
  writeFileSync(join(dirs.tickets, `${ticket.ticketId}.json`), JSON.stringify(ticket));
  return ticket;
}
const VALUE = { candidates: [{ fieldId: 'a.b', reason: 'x' }] };
const viaProxy = (path, body, init = {}) =>
  fetch(proxyOrigin + path, {
    method: init.method ?? 'POST',
    headers: { Authorization: `Bearer ${candidateToken}`, 'Content-Type': 'application/json' },
    ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
const direct = (origin, path, body, headers = {}) =>
  fetch(origin + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${brokerToken}`,
      'x-expunge-candidate-id': 'candidate-1',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
const spooled = () =>
  existsSync(join(dirs.spool, 'results.jsonl'))
    ? readFileSync(join(dirs.spool, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    : [];

test('the admitted artifact route works through the proxy: bytes come back intact and the broker token never does', async () => {
  const response = await viaProxy('/artifact/fetch', { artifactHash: hash });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(brokerToken));
  const body = JSON.parse(text);
  assert.equal(Buffer.from(body.contentBase64, 'base64').toString(), artifact);
});

test('an artifact that is not admitted, is malformed, or was tampered with on disk is never served', async () => {
  assert.equal((await viaProxy('/artifact/fetch', { artifactHash: 'a'.repeat(64) })).status, 404);
  assert.equal((await viaProxy('/artifact/fetch', { artifactHash: '../../etc/passwd' })).status, 404);
  assert.equal((await viaProxy('/artifact/fetch', { artifactHash: hash, extra: 1 })).status, 400);
  writeFileSync(join(dirs.artifacts, hash), artifact + '// tampered');
  assert.equal((await viaProxy('/artifact/fetch', { artifactHash: hash })).status, 404);
});

test('a ticket takes one result: the spooled record is built from the TICKET, and the same value again is idempotent', async () => {
  const ticket = mint();
  const first = await viaProxy('/result/submit', { ticketId: ticket.ticketId, value: VALUE });
  assert.equal(first.status, 200);
  const { resultId } = await first.json();
  const record = JSON.parse(spooled()[0]);
  assert.deepEqual(
    { ...record, resultId: undefined, receivedAt: undefined },
    {
      candidateId: 'candidate-1',
      ticketId: ticket.ticketId,
      jobId: 'job-1',
      runId: 'run-1',
      callNumber: 0,
      inputHash: 'c'.repeat(64),
      slot: 'discovery',
      artifactHash: hash,
      value: VALUE,
      resultId: undefined,
      receivedAt: undefined,
    },
  );
  assert.deepEqual(
    await (await viaProxy('/result/submit', { ticketId: ticket.ticketId, value: VALUE })).json(),
    { accepted: true, resultId, duplicate: true },
  );
  assert.equal(
    (await viaProxy('/result/submit', { ticketId: ticket.ticketId, value: { candidates: [] } })).status,
    409,
  );
  assert.equal(spooled().length, 1);
});

test('BR-2: the candidate cannot name a binding itself; only a minted, unguessable, unexpired ticket is accepted', async () => {
  const ticket = mint();
  // A body that tries to supply the old binding fields is refused outright.
  for (const body of [
    { ticketId: ticket.ticketId, value: VALUE, runId: 'run-other' },
    {
      jobId: 'job-1',
      runId: 'run-1',
      callNumber: 0,
      inputHash: 'c'.repeat(64),
      slot: 'discovery',
      artifactHash: hash,
      value: VALUE,
    },
    { value: VALUE },
    { ticketId: 'short', value: VALUE },
    { ticketId: '../' + 'a'.repeat(29), value: VALUE },
  ])
    assert.equal((await viaProxy('/result/submit', body)).status, 400, JSON.stringify(body).slice(0, 60));
  // A well-formed id that was never minted (guessing) is refused.
  assert.equal(
    (await viaProxy('/result/submit', { ticketId: randomBytes(16).toString('hex'), value: VALUE })).status,
    403,
  );
  // An expired ticket is refused; one for another candidate or a mismatched id inside the file is refused.
  const old = mint({ expiresAt: new Date(now - 1).toISOString() });
  assert.equal((await viaProxy('/result/submit', { ticketId: old.ticketId, value: VALUE })).status, 403);
  const other = mint({ candidateId: 'candidate-2' });
  assert.equal((await viaProxy('/result/submit', { ticketId: other.ticketId, value: VALUE })).status, 403);
  const forged = mint();
  writeFileSync(
    join(dirs.tickets, `${forged.ticketId}.json`),
    JSON.stringify({ ...forged, ticketId: 'f'.repeat(32) }),
  );
  assert.equal((await viaProxy('/result/submit', { ticketId: forged.ticketId, value: VALUE })).status, 403);
  // A ticket that names an artifact that is not admitted is refused.
  const unadmitted = mint({ artifactHash: 'b'.repeat(64) });
  assert.equal(
    (await viaProxy('/result/submit', { ticketId: unadmitted.ticketId, value: VALUE })).status,
    403,
  );
  assert.equal(spooled().length, 0);
});

test('BR-2: a ticket for one run cannot be used to write another run, and two tickets for one call cannot hold two results', async () => {
  const a = mint({ runId: 'run-a' });
  const b = mint({ runId: 'run-b' });
  assert.equal((await viaProxy('/result/submit', { ticketId: a.ticketId, value: VALUE })).status, 200);
  assert.equal(
    (await viaProxy('/result/submit', { ticketId: b.ticketId, value: { candidates: [] } })).status,
    200,
  ); // other run
  assert.deepEqual(
    spooled().map((l) => JSON.parse(l).runId),
    ['run-a', 'run-b'],
  );
  const again = mint({ runId: 'run-a' }); // a second ticket for the SAME job, run and call
  assert.equal(
    (await viaProxy('/result/submit', { ticketId: again.ticketId, value: { candidates: [] } })).status,
    409,
  );
});

test('BR-1: after a broker restart a different second result for the same ticket or call is still refused (rebuilt from the spool)', async () => {
  const ticket = mint();
  assert.equal((await viaProxy('/result/submit', { ticketId: ticket.ticketId, value: VALUE })).status, 200);
  const reborn = await listen(createCandidateBroker(brokerEnv(), () => now));
  const submit = (id, value) => direct(reborn, '/result/submit', { ticketId: id, value });
  assert.equal(
    (await submit(ticket.ticketId, { candidates: [{ fieldId: 'z', reason: 'other' }] })).status,
    409,
  );
  const sibling = mint(); // another ticket for the same call
  assert.equal(
    (await submit(sibling.ticketId, { candidates: [{ fieldId: 'z', reason: 'other' }] })).status,
    409,
  );
  assert.equal((await submit(ticket.ticketId, VALUE)).status, 200); // identical value: still idempotent
  assert.equal(spooled().length, 1);
});

test('every malformed value is refused and nothing is spooled', async () => {
  const ticket = mint();
  const bad = [
    'text',
    [1],
    { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
    { text: 'x'.repeat(2001) },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])),
  ];
  for (const value of bad)
    assert.equal((await viaProxy('/result/submit', { ticketId: ticket.ticketId, value })).status, 400);
  const big = {
    candidates: Array.from({ length: 200 }, (_, i) => ({ fieldId: `f${i}`, reason: 'y'.repeat(150) })),
  };
  assert.equal((await viaProxy('/result/submit', { ticketId: ticket.ticketId, value: big })).status, 413);
  assert.equal(spooled().length, 0);
});

test('every other route and method is denied at the proxy, and the broker itself only knows two routes', async () => {
  for (const [method, path] of [
    ['POST', '/promote'],
    ['POST', '/oracle/manifest'],
    ['POST', '/db/query'],
    ['GET', '/artifact/fetch'],
    ['POST', '/artifact'],
    ['DELETE', '/result/submit'],
    ['POST', '/result/submit/'],
    ['POST', '/artifact/fetch?x=1'],
  ]) {
    const response = await fetch(proxyOrigin + path, {
      method,
      headers: { Authorization: `Bearer ${candidateToken}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal((await direct(brokerOrigin, '/promote', {})).status, 404);
  assert.equal((await direct(brokerOrigin, '/oracle/manifest', {})).status, 404);
});

test('authentication and binding: no token, a wrong token, the broker token at the proxy, and a wrong candidate binding are refused', async () => {
  assert.equal(
    (
      await fetch(proxyOrigin + '/artifact/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(proxyOrigin + '/artifact/fetch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${brokerToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await direct(
        brokerOrigin,
        '/artifact/fetch',
        { artifactHash: hash },
        { Authorization: 'Bearer wrong-fixture-token-1234567890' },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await direct(
        brokerOrigin,
        '/artifact/fetch',
        { artifactHash: hash },
        { 'x-expunge-candidate-id': 'candidate-2' },
      )
    ).status,
    403,
  );
  assert.equal((await direct(brokerOrigin, '/artifact/fetch', { artifactHash: hash })).status, 200);
});

test('BR-3: the environment is an ALLOWLIST: any other name (database URIs under any principal name, provider keys) refuses start', () => {
  for (const name of [
    'MONGODB_URI',
    'MONGODB_DOMAIN_EXECUTOR_URI',
    'MONGODB_SETUP_URI',
    'OPENAI_API_KEY',
    'RAINDROP_API_KEY',
    'EXPUNGE_INTERNAL_TOKEN',
    'CPK_INTELLIGENCE_API_KEY',
    'COMPUTER_TOKEN',
    'ANYTHING_ELSE',
  ])
    assert.throws(
      () => createCandidateBroker({ ...brokerEnv(), [name]: 'x'.repeat(30) }),
      /unlisted environment/,
      name,
    );
  assert.ok(ALLOWED_ENV.has('EXPUNGE_BROKER_TICKET_DIR'));
  assert.ok(![...ALLOWED_ENV].some((name) => /MONGO|KEY|SECRET|PASSWORD|OPENAI|INTERNAL/.test(name)));
  // Container defaults of the node image are fine.
  assert.doesNotThrow(() =>
    createCandidateBroker({
      ...brokerEnv(),
      PATH: '/usr/bin',
      HOME: '/home/node',
      HOSTNAME: 'abc',
      NODE_VERSION: '24.18.1',
      YARN_VERSION: '1.22.22',
    }),
  );
  assert.throws(() => createCandidateBroker({ ...brokerEnv(), EXPUNGE_CANDIDATE_BROKER_TOKEN: 'short' }));
  assert.throws(() => createCandidateBroker({ ...brokerEnv(), EXPUNGE_CANDIDATE_ID: '../x' }));
  assert.throws(() => createCandidateBroker({ ...brokerEnv(), EXPUNGE_BROKER_RATE_PER_MINUTE: '0' }));
});

test(
  'BR-4: a per-candidate rate bound (fixed one-minute window) and a cap on concurrent requests',
  { timeout: 10_000 },
  async () => {
    const limited = await listen(
      createCandidateBroker(
        { ...brokerEnv(), EXPUNGE_BROKER_RATE_PER_MINUTE: '3', EXPUNGE_BROKER_MAX_CONCURRENCY: '4' },
        () => now,
      ),
    );
    const fetchArtifact = () => direct(limited, '/artifact/fetch', { artifactHash: hash });
    assert.deepEqual(
      [(await fetchArtifact()).status, (await fetchArtifact()).status, (await fetchArtifact()).status],
      [200, 200, 200],
    );
    assert.equal((await fetchArtifact()).status, 429);
    now += 61_000; // the next window
    assert.equal((await fetchArtifact()).status, 200);
    // Concurrency: with a cap of 1, a request held open by an unfinished body blocks the next one.
    const single = await listen(
      createCandidateBroker({ ...brokerEnv(), EXPUNGE_BROKER_MAX_CONCURRENCY: '1' }, () => now),
    );
    const url = new URL(single);
    const { request } = await import('node:http');
    const holder = request({
      host: url.hostname,
      port: url.port,
      path: '/artifact/fetch',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${brokerToken}`,
        'x-expunge-candidate-id': 'candidate-1',
        'Content-Type': 'application/json',
        'Content-Length': '100',
      },
    });
    holder.on('error', () => undefined);
    holder.write('{"artifactHash":');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await direct(single, '/artifact/fetch', { artifactHash: hash })).status, 429);
    holder.destroy();
  },
);
