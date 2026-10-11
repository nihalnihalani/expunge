/**
 * Crafted request targets, credentials and bodies against the candidate proxy's real HTTP server.
 *
 * The server is the product's `createCandidateProxy` (infra/opendots/candidate-proxy.mjs) listening on a loopback
 * socket. Only its outbound transport is a stand-in (FAKE broker transport recording what would have been fetched),
 * so the allowlist and authentication decisions are the product's. The running compose proxy is probed separately
 * from inside the guarded namespace (netguard.live.test.ts); there its route list is empty, so those probes can only
 * show "403 for everything". Here an admitted route exists, so the differential between the admitted path and its
 * look-alikes is observable.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateProxy } from '../../infra/opendots/candidate-proxy.mjs';
import { closeServer, listen, rawExchange } from './support.js';

const ACCESS = randomBytes(24).toString('hex');
const BROKER = randomBytes(24).toString('hex');
const ROUTES = [
  { method: 'POST', path: '/api/candidate/run' },
  { method: 'GET', path: '/api/candidate/status' },
];

type Call = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  redirect?: string;
  body?: unknown;
};
const open: Server[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await closeServer(server);
});

async function start(
  reply: (call: Call) => Response | Promise<Response> = () =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
) {
  const calls: Call[] = [];
  const server = createCandidateProxy(
    {
      EXPUNGE_CANDIDATE_BROKER_ORIGIN: 'http://127.0.0.1:9',
      EXPUNGE_CANDIDATE_ID: 'cand-fake-0001',
      EXPUNGE_CANDIDATE_ACCESS_TOKEN: ACCESS,
      EXPUNGE_CANDIDATE_BROKER_TOKEN: BROKER,
      EXPUNGE_CANDIDATE_ALLOWED_ROUTES: JSON.stringify(ROUTES),
    },
    async (url, init) => {
      const call: Call = {
        url: url.toString(),
        method: init.method,
        headers: init.headers,
        redirect: init.redirect,
        body: init.body,
      };
      calls.push(call);
      return reply(call);
    },
  );
  open.push(server);
  return { port: await listen(server), calls };
}

const req = (method: string, target: string, headers: string[] = [], body = '') =>
  `${method} ${target} HTTP/1.1\r\nHost: candidate-proxy:4314\r\nConnection: close\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}${body ? `Content-Length: ${Buffer.byteLength(body)}\r\n` : ''}\r\n${body}`;
const bearer = `Authorization: Bearer ${ACCESS}`;
const json = 'Content-Type: application/json';

describe('the admitted route and its credential', () => {
  it('forwards exactly the admitted path with the broker credential, never the candidate credential', async () => {
    const { port, calls } = await start();
    const reply = await rawExchange(
      port,
      req(
        'POST',
        '/api/candidate/run',
        [bearer, json, 'X-Forwarded-For: 10.0.0.9', 'Cookie: a=b', 'X-Evil: 1'],
        '{"a":1}',
      ),
    );
    expect(reply.statuses).toEqual([200]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:9/api/candidate/run');
    expect(call.redirect).toBe('error');
    expect(Object.keys(call.headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
      'x-expunge-candidate-id',
    ]);
    expect(call.headers.Authorization).toBe(`Bearer ${BROKER}`);
    expect(JSON.stringify(call)).not.toContain(ACCESS);
    expect(call.headers['x-expunge-candidate-id']).toBe('cand-fake-0001');
  });

  const wrongAuth: Array<[string, string[]]> = [
    ['no Authorization', []],
    ['wrong token', ['Authorization: Bearer nope']],
    ['broker token presented by the candidate', [`Authorization: Bearer ${BROKER}`]],
    ['token one character short', [`Authorization: Bearer ${ACCESS.slice(0, -1)}`]],
    ['lower-case scheme', [`Authorization: bearer ${ACCESS}`]],
    ['doubled scheme', [`Authorization: Bearer Bearer ${ACCESS}`]],
  ];
  it.each(wrongAuth)('%s on an admitted route is 401 and nothing is forwarded', async (_name, headers) => {
    const { port, calls } = await start();
    const reply = await rawExchange(port, req('GET', '/api/candidate/status', headers));
    expect(reply.statuses).toEqual([401]);
    expect(calls).toEqual([]);
  });

  it('observation: the Bearer scheme is optional, a bare token in Authorization is accepted', async () => {
    // `authorization.replace(/^Bearer /, '')` leaves a bare token untouched and it then compares equal. Not exploitable
    // (the secret is still required) but looser than the documented scheme.
    const { port, calls } = await start();
    const reply = await rawExchange(port, req('GET', '/api/candidate/status', [`Authorization: ${ACCESS}`]));
    expect(reply.statuses).toEqual([200]);
    expect(calls).toHaveLength(1);
  });
});

describe('look-alikes of the admitted path never reach the broker, even with the right credential', () => {
  const targets: Array<[string, string]> = [
    ['trailing slash', '/api/candidate/status/'],
    ['upper case', '/API/CANDIDATE/STATUS'],
    ['double slash prefix', '//api/candidate/status'],
    ['double slash inside', '/api//candidate/status'],
    ['dot segment', '/api/./candidate/status'],
    ['parent segment', '/api/x/../candidate/status'],
    ['percent-encoded dot', '/api/%2e/candidate/status'],
    ['percent-encoded slash', '/api%2fcandidate/status'],
    ['percent-encoded letter', '/api/candidate/%73tatus'],
    ['query string', '/api/candidate/status?x=1'],
    ['fragment', '/api/candidate/status#frag'],
    ['backslash', '/api\\candidate\\status'],
    ['null byte', '/api/candidate/status%00'],
    ['space', '/api/candidate/status%20'],
    ['semicolon parameter', '/api/candidate/status;jsessionid=1'],
    ['absolute form', 'http://candidate-proxy:4314/api/candidate/status'],
    ['absolute form to the metadata address', 'http://169.254.169.254/api/candidate/status'],
    ['authority form', 'candidate-proxy:4314'],
    ['asterisk form', '*'],
    ['long path', `/api/candidate/status/${'a'.repeat(5000)}`],
  ];
  it.each(targets)(
    '%s is refused with 403 or a parse error and wakes no transport call',
    async (_name, target) => {
      const { port, calls } = await start();
      const reply = await rawExchange(port, req('GET', target, [bearer]));
      expect(
        reply.statuses.length === 0 || reply.statuses.every((s) => [400, 403, 414, 431].includes(s)),
        JSON.stringify(reply.statuses),
      ).toBe(true);
      expect(calls).toEqual([]);
    },
  );

  it('other methods on an admitted path, and the admitted method on the other path, are refused', async () => {
    const { port, calls } = await start();
    for (const [method, target] of [
      ['GET', '/api/candidate/run'],
      ['POST', '/api/candidate/status'],
      ['PUT', '/api/candidate/run'],
      ['DELETE', '/api/candidate/status'],
      ['PATCH', '/api/candidate/run'],
      ['HEAD', '/api/candidate/status'],
      ['OPTIONS', '/api/candidate/status'],
    ] as const) {
      const reply = await rawExchange(
        port,
        req(method, target, [bearer, json], method === 'PUT' || method === 'PATCH' ? '{}' : ''),
      );
      expect(reply.statuses, `${method} ${target}`).toEqual([403]);
    }
    expect(calls).toEqual([]);
  });

  it('CONNECT and Upgrade are refused before any routing', async () => {
    const { port, calls } = await start();
    const connect = await rawExchange(
      port,
      'CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n',
    );
    expect(connect.text).toContain('403 Forbidden');
    const upgrade = await rawExchange(
      port,
      req('GET', '/api/candidate/status', [bearer, 'Connection: Upgrade', 'Upgrade: websocket']),
    );
    expect(upgrade.text).toContain('403 Forbidden');
    expect(calls).toEqual([]);
  });
});

describe('bodies, broker answers and error hygiene', () => {
  it('POST needs application/json and a body within 1,000,000 bytes', async () => {
    const { port, calls } = await start();
    const wrongType = await rawExchange(
      port,
      req('POST', '/api/candidate/run', [bearer, 'Content-Type: text/plain'], 'x'),
    );
    expect(wrongType.statuses).toEqual([415]);
    const big = await rawExchange(
      port,
      req('POST', '/api/candidate/run', [bearer, json], 'x'.repeat(1_000_001)),
      5000,
    );
    expect(big.statuses).toEqual([413]);
    expect(calls).toEqual([]);
  });

  it('refuses a broker answer that is not JSON, that carries the broker token, or that is too large; the candidate sees opaque errors', async () => {
    const cases: Array<[string, () => Response, number]> = [
      [
        'non-JSON content type',
        () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
        502,
      ],
      [
        'broker token in the body',
        () =>
          new Response(`{"leak":"${BROKER}"}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        502,
      ],
      [
        'oversized body',
        () =>
          new Response(`{"x":"${'a'.repeat(1_000_100)}"}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        502,
      ],
      [
        'broker 500 with details',
        () =>
          new Response('{"stack":"at /srv/secret/path.js:1"}', {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        500,
      ],
      [
        'broker 403',
        () =>
          new Response('{"why":"internal reason"}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        403,
      ],
    ];
    for (const [name, make, status] of cases) {
      const { port } = await start(() => make());
      const reply = await rawExchange(port, req('GET', '/api/candidate/status', [bearer]), 5000);
      expect(reply.statuses, name).toEqual([status]);
      expect(reply.text, name).not.toContain(BROKER);
      expect(reply.text, name).not.toContain('/srv/secret');
      expect(reply.text, name).not.toContain('internal reason');
    }
  });

  it('a transport that throws becomes an opaque 502', async () => {
    const { port } = await start(() => {
      throw new Error(`connect ECONNREFUSED http://broker.internal:4320 using ${BROKER}`);
    });
    const reply = await rawExchange(port, req('GET', '/api/candidate/status', [bearer]));
    expect(reply.statuses).toEqual([502]);
    expect(reply.text).not.toContain('broker.internal');
    expect(reply.text).not.toContain(BROKER);
  });

  it('refuses to start with weak or shared tokens, or with the operator token reused', () => {
    const base = {
      EXPUNGE_CANDIDATE_BROKER_ORIGIN: 'http://127.0.0.1:9',
      EXPUNGE_CANDIDATE_ID: 'cand-fake-0001',
      EXPUNGE_CANDIDATE_ALLOWED_ROUTES: '[]',
    };
    expect(() =>
      createCandidateProxy({
        ...base,
        EXPUNGE_CANDIDATE_ACCESS_TOKEN: 'short',
        EXPUNGE_CANDIDATE_BROKER_TOKEN: BROKER,
      }),
    ).toThrow(/at least 24/);
    expect(() =>
      createCandidateProxy({
        ...base,
        EXPUNGE_CANDIDATE_ACCESS_TOKEN: ACCESS,
        EXPUNGE_CANDIDATE_BROKER_TOKEN: ACCESS,
      }),
    ).toThrow(/distinct/);
    expect(() =>
      createCandidateProxy({
        ...base,
        EXPUNGE_CANDIDATE_ACCESS_TOKEN: ACCESS,
        EXPUNGE_CANDIDATE_BROKER_TOKEN: BROKER,
        EXPUNGE_INTERNAL_TOKEN: 'x',
      }),
    ).toThrow(/EXPUNGE_INTERNAL_TOKEN/);
    expect(() =>
      createCandidateProxy({
        ...base,
        EXPUNGE_CANDIDATE_ACCESS_TOKEN: ACCESS,
        EXPUNGE_CANDIDATE_BROKER_TOKEN: BROKER,
        EXPUNGE_CANDIDATE_ALLOWED_ROUTES: JSON.stringify([{ method: 'GET', path: '/a/../b' }]),
      }),
    ).toThrow(/bounded exact/);
  });
});
