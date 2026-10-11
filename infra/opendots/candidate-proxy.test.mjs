import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
const createHashHex = (value) => createHash('sha256').update(value).digest('hex');
import { createCandidateProxy } from './candidate-proxy.mjs';

const running = [];
const candidateKey = 'test-candidate-key-unique-1234';
const internalKey = 'test-internal-key-distinct-1234';
const env = {
  EXPUNGE_CANDIDATE_ID: 'candidate-stored',
  EXPUNGE_CANDIDATE_ACCESS_TOKEN: candidateKey,
  EXPUNGE_CANDIDATE_BROKER_TOKEN: internalKey,
  EXPUNGE_CANDIDATE_BROKER_ORIGIN: 'http://fixed-broker.invalid:4320',
};
async function start(
  overrides = {},
  transport = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
) {
  const server = createCandidateProxy({ ...env, ...overrides }, transport);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  running.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});
test('defaults to denying all outbound routes even with a valid scoped token', async () => {
  let calls = 0;
  const origin = await start({}, async () => {
    calls++;
    throw new Error('Unexpected call');
  });
  const response = await fetch(`${origin}/artifact`, {
    headers: { Authorization: `Bearer ${candidateKey}` },
  });
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});
test('binds admitted requests to fixed broker/candidate and server-held credentials', async () => {
  let observed;
  const origin = await start(
    { EXPUNGE_CANDIDATE_ALLOWED_ROUTES: '[{"method":"POST","path":"/artifact"}]' },
    async (url, options) => {
      observed = { url: String(url), options };
      return new Response('{"artifactHash":"abcd"}', { headers: { 'Content-Type': 'application/json' } });
    },
  );
  const response = await fetch(`${origin}/artifact`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${candidateKey}`,
      'Content-Type': 'application/json',
      'x-expunge-candidate-id': 'forged',
    },
    body: '{"source":"bounded"}',
  });
  assert.equal(response.status, 200);
  assert.equal(observed.url, 'http://fixed-broker.invalid:4320/artifact');
  assert.equal(observed.options.headers['x-expunge-candidate-id'], 'candidate-stored');
  assert.equal(observed.options.headers.Authorization, `Bearer ${internalKey}`);
  assert.equal(observed.options.redirect, 'error');
});
test('rejects missing auth, arbitrary origins, encoded traversal, query and non-admitted methods', async () => {
  const origin = await start({ EXPUNGE_CANDIDATE_ALLOWED_ROUTES: '[{"method":"GET","path":"/artifact"}]' });
  assert.equal((await fetch(`${origin}/artifact`)).status, 401);
  for (const path of ['/private', '/%2e%2e/private', '/artifact?url=http://169.254.169.254']) {
    assert.equal(
      (await fetch(origin + path, { headers: { Authorization: `Bearer ${candidateKey}` } })).status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(`${origin}/artifact`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${candidateKey}` },
      })
    ).status,
    403,
  );
  const raw = await new Promise((resolve, reject) => {
    const req = request(
      origin,
      { path: 'http://169.254.169.254/artifact', headers: { Authorization: `Bearer ${candidateKey}` } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(raw, 403);
});
test('blocks response disclosure of internal token and upstream redirects', async () => {
  const allow = { EXPUNGE_CANDIDATE_ALLOWED_ROUTES: '[{"method":"GET","path":"/artifact"}]' };
  const reflected = await start(
    allow,
    async () =>
      new Response(JSON.stringify({ leaked: internalKey }), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const response = await fetch(`${reflected}/artifact`, {
    headers: { Authorization: `Bearer ${candidateKey}` },
  });
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(internalKey));
  const redirect = await start(
    allow,
    async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
  );
  assert.equal(
    (await fetch(`${redirect}/artifact`, { headers: { Authorization: `Bearer ${candidateKey}` } })).status,
    302,
  );
});
test('rejects generic proxy configuration or shared credentials at startup', () => {
  assert.throws(() =>
    createCandidateProxy({ ...env, EXPUNGE_CANDIDATE_ALLOWED_ROUTES: '[{"method":"CONNECT","path":"/"}]' }),
  );
  assert.throws(() =>
    createCandidateProxy({
      ...env,
      EXPUNGE_CANDIDATE_ALLOWED_ROUTES: '[{"method":"GET","path":"/a/../private"}]',
    }),
  );
  assert.throws(() => createCandidateProxy({ ...env, EXPUNGE_CANDIDATE_BROKER_TOKEN: candidateKey }));
});
test('refuses the operator internal-token name and any reuse of the operator token (K10)', () => {
  assert.throws(
    () => createCandidateProxy({ ...env, EXPUNGE_INTERNAL_TOKEN: 'operator-token-value-1234567890' }),
    /operator/,
  );
  const operatorToken = 'operator-token-value-1234567890';
  const sha = createHashHex(operatorToken);
  assert.throws(
    () =>
      createCandidateProxy({
        ...env,
        EXPUNGE_CANDIDATE_BROKER_TOKEN: operatorToken,
        EXPUNGE_OPERATOR_TOKEN_SHA256: sha,
      }),
    /differ from the operator/,
  );
  assert.throws(
    () =>
      createCandidateProxy({
        ...env,
        EXPUNGE_CANDIDATE_ACCESS_TOKEN: operatorToken,
        EXPUNGE_OPERATOR_TOKEN_SHA256: sha,
      }),
    /differ from the operator/,
  );
  assert.throws(
    () => createCandidateProxy({ ...env, EXPUNGE_OPERATOR_TOKEN_SHA256: 'NOT-HEX' }),
    /hex SHA-256/,
  );
  // A distinct broker token with the operator hash configured starts normally.
  createCandidateProxy({ ...env, EXPUNGE_OPERATOR_TOKEN_SHA256: sha }).close();
});
