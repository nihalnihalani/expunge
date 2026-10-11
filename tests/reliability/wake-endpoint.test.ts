/**
 * Adversarial probes of the worker's /internal/wake endpoint over real TCP sockets.
 *
 * The server under test is the product's `createWakeServer` (apps/worker/src/wake.ts) with the product's
 * `authenticateWake`, `wakeCommandSchema` and stores. Only its collaborators are stand-ins, and they are labeled:
 *   FakeWakeTarget   - the dispatcher queue (the real Dispatcher needs a database and a model)
 *   readyReadiness() - a READY readiness record (the real worker is BLOCKED until domain tools are integrated)
 * No credential is real. Canary values below are synthetic strings used only to prove they never leak.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryWakeCommandStore,
  authenticateWake,
  createWakeServer,
  wakeCommandSchema,
  type WakeCommand,
  type WakeCommandStore,
  type WakeDecision,
  type WakeTarget,
} from '../../apps/worker/src/wake.js';
import { checkReadiness, type Readiness } from '../../apps/worker/src/readiness.js';
import { closeServer, listen, postJson, rawExchange, sleep } from './support.js';

const TOKEN = randomBytes(24).toString('hex');
const BODY = { jobId: 'job-1', commandId: 'cmd-00000001' };
const auth = (token = TOKEN) => ({ Authorization: `Bearer ${token}` });

function readyReadiness(): Readiness {
  return {
    status: 'READY',
    blockers: [],
    lines: ['READY: FAKE readiness for the endpoint probe'],
    checks: {
      provider: 'configured',
      scope: 'configured',
      database: 'configured',
      wakeToken: 'configured',
      domainTools: 'configured',
    },
    reachability: 'not_checked',
  };
}

/** FAKE dispatcher queue with a capacity, recording every command it was handed. */
class FakeWakeTarget {
  readonly woken: WakeCommand[] = [];
  constructor(public capacity = Number.POSITIVE_INFINITY) {}
  canAccept(): boolean {
    return this.woken.length < this.capacity;
  }
  wake(command: WakeCommand): boolean {
    if (this.woken.length >= this.capacity) return false;
    this.woken.push(command);
    return true;
  }
}

type Started = { server: Server; port: number; target: FakeWakeTarget; store: WakeCommandStore };
const open: Server[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await closeServer(server);
});

async function start(
  options: {
    store?: WakeCommandStore;
    target?: FakeWakeTarget;
    readiness?: () => Readiness;
    token?: string;
  } = {},
): Promise<Started> {
  const target = options.target ?? new FakeWakeTarget();
  const store = options.store ?? new InMemoryWakeCommandStore();
  const server = createWakeServer({
    token: options.token ?? TOKEN,
    store,
    target: target as unknown as WakeTarget,
    readiness: options.readiness ?? readyReadiness,
  });
  open.push(server);
  return { server, port: await listen(server), target, store };
}

const wakeRequest = (
  path: string,
  extraHeaders: string[] = [],
  body = JSON.stringify(BODY),
  method = 'POST',
): string =>
  `${method} ${path} HTTP/1.1\r\nHost: wake\r\nConnection: close\r\n${extraHeaders.join('\r\n')}${extraHeaders.length ? '\r\n' : ''}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

describe('authentication', () => {
  it('accepts exactly the configured bearer token', async () => {
    const { port, target } = await start();
    const reply = await postJson(port, '/internal/wake', BODY, auth());
    expect(reply.status).toBe(202);
    expect(JSON.parse(reply.text)).toEqual({ status: 'accepted' });
    expect(target.woken).toEqual([BODY]);
  });

  const wrong: Array<[string, string | undefined]> = [
    ['no Authorization header', undefined],
    ['empty token', 'Bearer '],
    ['wrong scheme', `Basic ${TOKEN}`],
    ['lower-case scheme', `bearer ${TOKEN}`],
    ['no scheme', TOKEN],
    ['token plus one character', `Bearer ${TOKEN}0`],
    ['token minus one character', `Bearer ${TOKEN.slice(0, -1)}`],
    ['same length, last byte changed', `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith('0') ? '1' : '0'}`],
    ['same length, first byte changed', `Bearer ${TOKEN.startsWith('0') ? '1' : '0'}${TOKEN.slice(1)}`],
    ['leading space after scheme', `Bearer  ${TOKEN}`],
    ['token repeated', `Bearer ${TOKEN}${TOKEN}`],
  ];
  it.each(wrong)('rejects %s with 401 and wakes nothing', async (_name, header) => {
    const { port, target } = await start();
    const reply = await postJson(
      port,
      '/internal/wake',
      BODY,
      header === undefined ? {} : { Authorization: header },
    );
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.text)).toEqual({ error: 'Unauthorized' });
    expect(target.woken).toEqual([]);
  });

  it('gives every failure the same bytes, so the response is not an oracle', async () => {
    const { port } = await start();
    const bodies = new Set<string>();
    for (const [, header] of wrong) {
      const reply = await postJson(
        port,
        '/internal/wake',
        BODY,
        header === undefined ? {} : { Authorization: header },
      );
      bodies.add(
        `${reply.status}|${reply.text}|${reply.headers.get('content-type')}|${reply.headers.get('cache-control')}`,
      );
    }
    expect(bodies.size).toBe(1);
  });

  it('observation: trailing whitespace on the header value is removed by the HTTP parser before the compare', async () => {
    // RFC 9110 strips optional whitespace around a field value, so `Bearer <token> ` authenticates. This is not a
    // weakening: the secret is unchanged and no other byte is tolerated.
    const { port, target } = await start();
    const reply = await rawExchange(
      port,
      wakeRequest('/internal/wake', [`Authorization: Bearer ${TOKEN}   `]),
    );
    expect(reply.statuses).toEqual([202]);
    expect(target.woken).toHaveLength(1);
  });

  it('does not take the token from the query string, a cookie or a look-alike header', async () => {
    const { port, target } = await start();
    const viaQuery = await rawExchange(port, wakeRequest(`/internal/wake?token=${TOKEN}`));
    expect(viaQuery.statuses).toEqual([404]);
    const viaCookie = await rawExchange(port, wakeRequest('/internal/wake', [`Cookie: token=${TOKEN}`]));
    expect(viaCookie.statuses).toEqual([401]);
    const viaOther = await rawExchange(
      port,
      wakeRequest('/internal/wake', [
        `X-Forwarded-Authorization: Bearer ${TOKEN}`,
        `Proxy-Authorization: Bearer ${TOKEN}`,
      ]),
    );
    expect(viaOther.statuses).toEqual([401]);
    expect(target.woken).toEqual([]);
  });

  it('with two Authorization headers only the first counts (Node discards the duplicate)', async () => {
    const { port, target } = await start();
    const wrongFirst = await rawExchange(
      port,
      wakeRequest('/internal/wake', ['Authorization: Bearer nope', `Authorization: Bearer ${TOKEN}`]),
    );
    expect(wrongFirst.statuses).toEqual([401]);
    expect(target.woken).toEqual([]);
    const rightFirst = await rawExchange(
      port,
      wakeRequest('/internal/wake', [`Authorization: Bearer ${TOKEN}`, 'Authorization: Bearer nope']),
    );
    expect(rightFirst.statuses).toEqual([202]);
    expect(target.woken).toHaveLength(1);
  });

  it('refuses everything when no token is configured (empty configured token never matches)', async () => {
    expect(authenticateWake('Bearer ', '')).toBe(false);
    expect(authenticateWake('Bearer anything', '')).toBe(false);
    expect(authenticateWake(undefined, TOKEN)).toBe(false);
    const { port, target } = await start({ token: '' });
    const reply = await postJson(port, '/internal/wake', BODY, { Authorization: 'Bearer ' });
    expect(reply.status).toBe(401);
    expect(target.woken).toEqual([]);
  });

  it('authenticates before it reveals readiness, media type or body problems', async () => {
    const blocked: Readiness = {
      ...readyReadiness(),
      status: 'BLOCKED',
      blockers: [{ code: 'database credentials', detail: 'Set MONGODB_DOMAIN_EXECUTOR_URI' }],
    };
    const { port } = await start({ readiness: () => blocked });
    const noAuth = await rawExchange(port, wakeRequest('/internal/wake', [], 'not json'));
    expect(noAuth.statuses).toEqual([401]);
    const wrongType = await rawExchange(
      port,
      `POST /internal/wake HTTP/1.1\r\nHost: w\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 1\r\n\r\nx`,
    );
    expect(wrongType.statuses).toEqual([401]);
    const withAuth = await postJson(port, '/internal/wake', BODY, auth());
    expect(withAuth.status).toBe(503);
    expect(JSON.parse(withAuth.text)).toEqual({ error: 'Blocked', blockers: ['database credentials'] });
  });

  it('compares with timingSafeEqual and never with a short-circuiting operator (source assertion)', () => {
    const source = readFileSync(new URL('../../apps/worker/src/wake.ts', import.meta.url), 'utf8');
    const fn = source.slice(
      source.indexOf('export function authenticateWake'),
      source.indexOf('export interface WakeTarget'),
    );
    expect(fn).toContain('timingSafeEqual(presented, expected)');
    expect(fn).not.toMatch(
      /authorization\s*===|===\s*expectedToken|presented\s*===\s*expected|\.startsWith\(expectedToken/,
    );
  });

  it('shows no first-byte versus last-byte timing difference at the compare (advisory micro-benchmark)', () => {
    // Evidence, not proof: a short-circuit compare differs by nanoseconds, which loopback HTTP cannot resolve, so the
    // comparison itself is timed in-process. Min-of-batches is robust to scheduler noise; the bound is deliberately loose.
    const firstWrong = `Bearer ${TOKEN.startsWith('0') ? '1' : '0'}${TOKEN.slice(1)}`;
    const lastWrong = `Bearer ${TOKEN.slice(0, -1)}${TOKEN.endsWith('0') ? '1' : '0'}`;
    const time = (header: string) => {
      let best = Number.POSITIVE_INFINITY;
      for (let batch = 0; batch < 15; batch += 1) {
        const start = process.hrtime.bigint();
        for (let i = 0; i < 40_000; i += 1) authenticateWake(header, TOKEN);
        const elapsed = Number(process.hrtime.bigint() - start);
        if (elapsed < best) best = elapsed;
      }
      return best;
    };
    time(firstWrong);
    const a = time(firstWrong);
    const b = time(lastWrong);
    const relative = Math.abs(a - b) / Math.max(a, b);
    console.log(
      `wake auth micro-benchmark: first-byte-wrong ${a}ns, last-byte-wrong ${b}ns per 40000 calls, relative difference ${relative.toFixed(3)}`,
    );
    expect(relative).toBeLessThan(0.35);
  });
});

describe('routing and request framing', () => {
  const cases: Array<[string, string, string]> = [
    ['GET /internal/wake', 'GET', '/internal/wake'],
    ['PUT /internal/wake', 'PUT', '/internal/wake'],
    ['DELETE /internal/wake', 'DELETE', '/internal/wake'],
    ['PATCH /internal/wake', 'PATCH', '/internal/wake'],
    ['OPTIONS /internal/wake', 'OPTIONS', '/internal/wake'],
    ['POST trailing slash', 'POST', '/internal/wake/'],
    ['POST with query', 'POST', '/internal/wake?x=1'],
    ['POST double slash', 'POST', '//internal/wake'],
    ['POST upper case', 'POST', '/INTERNAL/WAKE'],
    ['POST percent-encoded', 'POST', '/internal/%77ake'],
    ['POST null byte', 'POST', '/internal/wake%00'],
    ['POST dot segment', 'POST', '/internal/./wake'],
    ['POST parent segment', 'POST', '/x/../internal/wake'],
    ['POST backslash', 'POST', '/internal\\wake'],
    ['POST absolute-form', 'POST', 'http://wake/internal/wake'],
  ];
  it.each(cases)('%s is not the wake route (404) and wakes nothing', async (_name, method, path) => {
    const { port, target } = await start();
    const reply = await rawExchange(
      port,
      wakeRequest(path, [`Authorization: Bearer ${TOKEN}`], JSON.stringify(BODY), method),
    );
    expect(reply.statuses.length === 1 || reply.statuses.length === 0).toBe(true);
    if (reply.statuses.length === 1) expect([400, 404]).toContain(reply.statuses[0]);
    expect(target.woken).toEqual([]);
  });

  it('serves liveness and readiness without credentials but nothing else', async () => {
    const { port } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/internal/wake`)).status).toBe(404);
  });

  it('rejects ambiguous framing: Content-Length with Transfer-Encoding, duplicate or negative lengths', async () => {
    const { port, target } = await start();
    const head = `POST /internal/wake HTTP/1.1\r\nHost: w\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\n`;
    const body = JSON.stringify(BODY);
    const smuggled = `0\r\n\r\nPOST /internal/wake HTTP/1.1\r\nHost: w\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const cases = [
      `${head}Content-Length: ${smuggled.length}\r\nTransfer-Encoding: chunked\r\n\r\n${smuggled}`,
      `${head}Content-Length: ${body.length}\r\nContent-Length: ${body.length + 1}\r\n\r\n${body}`,
      `${head}Content-Length: -1\r\n\r\n${body}`,
      `${head}Transfer-Encoding: xchunked\r\n\r\n${body}`,
      `${head}Transfer-Encoding: chunked\r\n\r\nZZ\r\n${body}\r\n0\r\n\r\n`,
    ];
    for (const payload of cases) {
      const reply = await rawExchange(port, payload);
      expect(
        reply.statuses.every((s) => s === 400 || s === 501),
        JSON.stringify(reply.statuses),
      ).toBe(true);
    }
    expect(target.woken).toEqual([]);
  });

  it('treats pipelined requests as separate requests, each authenticated on its own', async () => {
    const { port, target } = await start();
    const good = (id: string) => {
      const body = JSON.stringify({ jobId: 'j', commandId: id });
      return `POST /internal/wake HTTP/1.1\r\nHost: w\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    };
    const bad = `POST /internal/wake HTTP/1.1\r\nHost: w\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`;
    const reply = await rawExchange(port, `${good('cmd-pipe-0001')}${bad}${good('cmd-pipe-0002')}`, 800);
    expect(reply.statuses).toEqual([202, 401, 202]);
    expect(target.woken.map((c) => c.commandId)).toEqual(['cmd-pipe-0001', 'cmd-pipe-0002']);
  });
});

describe('strict body', () => {
  const rejected: Array<[string, unknown]> = [
    ['extra field', { ...BODY, harnessHash: 'a'.repeat(64) }],
    ['actor smuggled in', { ...BODY, actor: { actorId: 'owner', tenantId: 't' } }],
    ['budget smuggled in', { ...BODY, budget: { modelCalls: 1_000_000 } }],
    ['__proto__ key', JSON.parse('{"jobId":"job-1","commandId":"cmd-00000001","__proto__":{"admin":true}}')],
    ['missing commandId', { jobId: 'job-1' }],
    ['missing jobId', { commandId: 'cmd-00000001' }],
    ['empty object', {}],
    ['commandId 7 characters', { jobId: 'job-1', commandId: 'abcdefg' }],
    ['commandId 129 characters', { jobId: 'job-1', commandId: 'a'.repeat(129) }],
    ['jobId 129 characters', { jobId: 'j'.repeat(129), commandId: 'cmd-00000001' }],
    ['empty jobId', { jobId: '', commandId: 'cmd-00000001' }],
    ['jobId with a space', { jobId: 'job 1', commandId: 'cmd-00000001' }],
    ['jobId with a slash', { jobId: '../job', commandId: 'cmd-00000001' }],
    ['jobId with CRLF', { jobId: 'job\r\nX-Injected: 1', commandId: 'cmd-00000001' }],
    ['jobId with NUL', { jobId: 'job\u0000', commandId: 'cmd-00000001' }],
    ['jobId with unicode', { jobId: 'jöb', commandId: 'cmd-00000001' }],
    ['commandId with semicolon', { jobId: 'job-1', commandId: 'cmd-0000;rm' }],
    ['numeric jobId', { jobId: 1, commandId: 'cmd-00000001' }],
    ['object commandId', { jobId: 'job-1', commandId: { $ne: null } }],
    ['array commandId', { jobId: 'job-1', commandId: ['cmd-00000001'] }],
    ['array body', [BODY]],
    ['null body', null],
    ['string body', 'cmd-00000001'],
    ['number body', 7],
  ];
  it.each(rejected)('rejects %s with 400 and wakes nothing', async (_name, body) => {
    const { port, target } = await start();
    const reply = await postJson(port, '/internal/wake', body as never, auth());
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.text)).toEqual({ error: 'InvalidCommand' });
    expect(target.woken).toEqual([]);
  });

  it('rejects malformed JSON, an empty body and a truncated body', async () => {
    const { port, target } = await start();
    for (const body of [
      '',
      '{',
      '{"jobId":"job-1"',
      'not json',
      '{"jobId":"job-1","commandId":"cmd-00000001"}x',
    ]) {
      const reply = await postJson(port, '/internal/wake', body, auth());
      expect(reply.status, JSON.stringify(body)).toBe(400);
    }
    expect(target.woken).toEqual([]);
  });

  it('on duplicate keys the last value wins and exactly that value is what gets woken', async () => {
    const { port, target } = await start();
    const reply = await postJson(
      port,
      '/internal/wake',
      '{"jobId":"first","jobId":"second","commandId":"cmd-dup-0001"}',
      auth(),
    );
    expect(reply.status).toBe(202);
    expect(target.woken).toEqual([{ jobId: 'second', commandId: 'cmd-dup-0001' }]);
  });

  it('enforces the 1024 byte body bound whether the length is declared or chunked', async () => {
    const { port, target } = await start();
    const padded = (size: number) => JSON.stringify(BODY) + ' '.repeat(size - JSON.stringify(BODY).length);
    const atLimit = await postJson(port, '/internal/wake', padded(1024), auth());
    expect(atLimit.status).toBe(202);
    const over = await postJson(port, '/internal/wake', padded(1025), auth());
    expect(over.status).toBe(413);
    // Declared length far beyond the bound, only a little actually sent: the server must answer without waiting for it all.
    const declared = await rawExchange(
      port,
      `POST /internal/wake HTTP/1.1\r\nHost: w\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1073741824\r\n\r\n${'x'.repeat(2048)}`,
    );
    expect(declared.statuses).toEqual([413]);
    // Chunked with no declared length.
    const chunk = 'x'.repeat(2048);
    const chunked = await rawExchange(
      port,
      `POST /internal/wake HTTP/1.1\r\nHost: w\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`,
    );
    expect(chunked.statuses).toEqual([413]);
    expect(target.woken).toHaveLength(1);
  });

  it('checks the media type after authentication', async () => {
    const { port, target } = await start();
    const mk = (type: string | null) =>
      `POST /internal/wake HTTP/1.1\r\nHost: w\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\n${type ? `Content-Type: ${type}\r\n` : ''}Content-Length: ${JSON.stringify(BODY).length}\r\n\r\n${JSON.stringify(BODY)}`;
    expect((await rawExchange(port, mk('text/plain'))).statuses).toEqual([415]);
    expect((await rawExchange(port, mk('application/x-www-form-urlencoded'))).statuses).toEqual([415]);
    expect((await rawExchange(port, mk(null))).statuses).toEqual([415]);
    expect((await rawExchange(port, mk('application/json; charset=utf-8'))).statuses).toEqual([202]);
    expect(target.woken).toHaveLength(1);
  });
});

describe('response hygiene and header injection', () => {
  const ALLOWED_HEADERS = new Set([
    'content-type',
    'cache-control',
    'date',
    'connection',
    'content-length',
    'keep-alive',
    'transfer-encoding',
  ]);

  it('never reflects request input into a response header or body, and sets only the fixed headers', async () => {
    const { port } = await start();
    const marker = 'REFLECTCANARY7f3a';
    const attempts = [
      wakeRequest('/internal/wake', [
        `Authorization: Bearer ${TOKEN}`,
        `X-Marker: ${marker}`,
        `User-Agent: ${marker}`,
        `Origin: https://${marker}.example`,
      ]),
      wakeRequest(`/${marker}`, [`Authorization: Bearer ${TOKEN}`]),
      wakeRequest('/internal/wake', [`Authorization: Bearer ${marker}`]),
      wakeRequest(
        '/internal/wake',
        [`Authorization: Bearer ${TOKEN}`],
        JSON.stringify({ jobId: marker, commandId: marker, extra: marker }),
      ),
      wakeRequest(
        '/internal/wake',
        [`Authorization: Bearer ${TOKEN}`],
        `{"jobId":"${marker}\\r\\nSet-Cookie: a=b","commandId":"cmd-00000001"}`,
      ),
    ];
    for (const payload of attempts) {
      const reply = await rawExchange(port, payload);
      expect(reply.text).not.toContain(marker);
      expect(reply.text).not.toContain('Set-Cookie');
      const head = reply.text.split('\r\n\r\n')[0] ?? '';
      const names = head
        .split('\r\n')
        .slice(1)
        .map((line) => line.split(':')[0]!.toLowerCase());
      for (const name of names)
        expect(ALLOWED_HEADERS.has(name), `unexpected response header ${name}`).toBe(true);
      expect(head.toLowerCase()).toContain('cache-control: no-store');
    }
  });

  it('survives an obsolete line folded Authorization header without being tricked into accepting it', async () => {
    const { port, target } = await start();
    const folded = `POST /internal/wake HTTP/1.1\r\nHost: w\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\n X-Evil: yes\r\nContent-Type: application/json\r\nContent-Length: ${JSON.stringify(BODY).length}\r\n\r\n${JSON.stringify(BODY)}`;
    const reply = await rawExchange(port, folded);
    expect(reply.statuses.every((s) => s === 400 || s === 401)).toBe(true);
    expect(target.woken).toEqual([]);
  });

  it('bounds header size and count, and stays alive afterwards', async () => {
    const { port } = await start();
    const big = await rawExchange(
      port,
      wakeRequest('/internal/wake', [`Authorization: Bearer ${TOKEN}`, `X-Big: ${'a'.repeat(40_000)}`]),
    );
    expect(big.statuses).toEqual([431]);
    const many = Array.from({ length: 400 }, (_, i) => `X-H${i}: v`);
    const flood = await rawExchange(
      port,
      wakeRequest('/internal/wake', [`Authorization: Bearer ${TOKEN}`, ...many]),
    );
    expect(
      flood.statuses.length === 0 || flood.statuses.every((s) => s === 202 || s === 431 || s === 400),
    ).toBe(true);
    const longUrl = await rawExchange(
      port,
      wakeRequest(`/${'a'.repeat(30_000)}`, [`Authorization: Bearer ${TOKEN}`]),
    );
    expect(longUrl.statuses.every((s) => s === 431 || s === 414 || s === 404)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });

  it('has Node request and header timeouts, so a stalled client cannot hold a worker socket forever', async () => {
    const { server } = await start();
    expect(server.requestTimeout).toBeGreaterThan(0);
    expect(server.requestTimeout).toBeLessThanOrEqual(300_000);
    expect(server.headersTimeout).toBeGreaterThan(0);
    expect(server.headersTimeout).toBeLessThanOrEqual(61_000);
  });

  it('keeps answering other clients while one connection stalls with a promised body that never arrives', async () => {
    const { port, target } = await start();
    const stalled = rawExchange(
      port,
      `POST /internal/wake HTTP/1.1\r\nHost: w\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jobId":`,
      1200,
    );
    await sleep(100);
    const reply = await postJson(
      port,
      '/internal/wake',
      { jobId: 'job-2', commandId: 'cmd-00000002' },
      auth(),
    );
    expect(reply.status).toBe(202);
    await stalled;
    expect(target.woken.map((c) => c.commandId)).toEqual(['cmd-00000002']);
  });
});

describe('idempotency and back-pressure', () => {
  it('records a command once: the replay is a 200 duplicate and wakes nothing more', async () => {
    const { port, target } = await start();
    expect((await postJson(port, '/internal/wake', BODY, auth())).status).toBe(202);
    const again = await postJson(port, '/internal/wake', BODY, auth());
    expect(again.status).toBe(200);
    expect(JSON.parse(again.text)).toEqual({ status: 'duplicate' });
    expect(target.woken).toHaveLength(1);
  });

  it('100 concurrent copies of one command wake exactly once', async () => {
    const { port, target } = await start();
    const replies = await Promise.all(
      Array.from({ length: 100 }, () => postJson(port, '/internal/wake', BODY, auth())),
    );
    const counts = replies.reduce<Record<number, number>>(
      (m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ 202: 1, 200: 99 });
    expect(target.woken).toHaveLength(1);
  });

  it('answers 429 when the queue is full, without burning the command id', async () => {
    const target = new FakeWakeTarget(0);
    const { port } = await start({ target });
    const busy = await postJson(port, '/internal/wake', BODY, auth());
    expect(busy.status).toBe(429);
    expect(JSON.parse(busy.text)).toEqual({ error: 'Busy' });
    expect(busy.headers.get('retry-after')).toBeNull(); // observation: no Retry-After hint is sent
    target.capacity = 1;
    const retry = await postJson(port, '/internal/wake', BODY, auth());
    expect(retry.status).toBe(202); // the same command id is accepted once there is room, not treated as a duplicate
    expect(target.woken).toEqual([BODY]);
  });

  it('under a burst of 80 concurrent requests with capacity 20, accepts at most 20 and answers the rest 429', async () => {
    const target = new FakeWakeTarget(20);
    const { port } = await start({ target });
    const replies = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        postJson(
          port,
          '/internal/wake',
          { jobId: `job-${i}`, commandId: `cmd-burst-${String(i).padStart(4, '0')}` },
          auth(),
        ),
      ),
    );
    const accepted = replies.filter((r) => r.status === 202).length;
    expect(replies.every((r) => r.status === 202 || r.status === 429)).toBe(true);
    expect(accepted).toBeLessThanOrEqual(20);
    expect(target.woken).toHaveLength(accepted);
  });

  it('the race between the capacity check and the queueing returns 429 and the in-memory store lets the retry through', async () => {
    const flaky = new FakeWakeTarget();
    let allow = false;
    flaky.canAccept = () => true;
    flaky.wake = (command) => {
      if (!allow) return false;
      flaky.woken.push(command);
      return true;
    };
    const { port } = await start({ target: flaky });
    expect((await postJson(port, '/internal/wake', BODY, auth())).status).toBe(429);
    allow = true;
    expect((await postJson(port, '/internal/wake', BODY, auth())).status).toBe(202);
    expect(flaky.woken).toEqual([BODY]);
  });

  it('a store failure becomes an opaque 500, not a stack trace, and wakes nothing', async () => {
    const broken: WakeCommandStore = {
      accept: async () => {
        throw new Error('mongodb://canary-user:canary-pass@db.invalid/x exploded at /secret/path');
      },
      release: async () => {},
    };
    const { port, target } = await start({ store: broken });
    const reply = await postJson(port, '/internal/wake', BODY, auth());
    expect(reply.status).toBe(500);
    expect(reply.text).toBe('{"error":"Internal"}');
    expect(target.woken).toEqual([]);
  });
});

describe('what the unauthenticated endpoints disclose', () => {
  it('names blockers (variable names only) and never echoes a configured secret value', async () => {
    const canaries = {
      OPENAI_API_KEY: 'CANARY-provider-key-0001',
      MONGODB_DOMAIN_EXECUTOR_URI: 'mongodb://canary-user:CANARY-db-pass-0002@127.0.0.1:1/x',
      EXPUNGE_WAKE_TOKEN: `CANARY-wake-token-0003-${'z'.repeat(20)}`,
      EXPUNGE_MODEL_PROVIDER: 'openai',
    };
    const readiness = checkReadiness(canaries, { domainToolsAvailable: false });
    const { port } = await start({ readiness: () => readiness, token: canaries.EXPUNGE_WAKE_TOKEN });
    const readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
    const text = await readyz.text();
    expect(readyz.status).toBe(503);
    expect(text).toContain('domain tools');
    for (const value of Object.values(canaries).filter(
      (v) => v.startsWith('CANARY') || v.includes('CANARY'),
    )) {
      expect(text).not.toContain(value);
    }
    const blocked = await postJson(port, '/internal/wake', BODY, {
      Authorization: `Bearer ${canaries.EXPUNGE_WAKE_TOKEN}`,
    });
    expect(blocked.status).toBe(503);
    for (const value of Object.values(canaries))
      if (value.includes('CANARY')) expect(blocked.text).not.toContain(value);
  });
});

describe('the command schema itself', () => {
  it('is strict: only jobId and commandId, nothing that could carry authority', () => {
    expect(Object.keys(wakeCommandSchema.shape).sort()).toEqual(['commandId', 'jobId']);
    expect(wakeCommandSchema.safeParse({ ...BODY, actor: {} }).success).toBe(false);
  });
});

export type { WakeDecision };
