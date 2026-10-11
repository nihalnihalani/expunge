// Active egress and containment probes. Runs INSIDE the guarded candidate network namespace, as the candidate
// would: ALL capabilities dropped, no-new-privileges, read-only root. The orchestrator feeds this file on stdin:
//
//   docker run -i --rm --pull=never --network container:<netguard> --cap-drop ALL \
//     --security-opt no-new-privileges:true --read-only --memory 128m --pids-limit 32 \
//     node:24.18.1-alpine node --input-type=module - < netguard-in-namespace.mjs
//
// It prints one JSON object per line: { id, verdict, detail }. Verdicts: "blocked" (no connection, no answer),
// "open" (a connection was established or a reply arrived), "answered" (an HTTP-level reply), "info".
// Nothing here sends credentials; the only third-party contact attempted is a single TCP SYN, ICMP echo or DNS query
// to a public address that the guard is supposed to drop.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const PROXY_IP = process.env.PROBE_PROXY_IPV4 ?? '172.30.90.2';
const PROXY_PORT = Number(process.env.PROBE_PROXY_PORT ?? 4314);
const emit = (id, verdict, detail = '') =>
  process.stdout.write(`${JSON.stringify({ id, verdict, detail })}\n`);

/** One TCP connect attempt. Resolves { connected, error } and never hangs. */
function tcpConnect(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ connected: false, error: 'timeout' }));
    socket.once('connect', () => finish({ connected: true }));
    socket.once('error', (error) => finish({ connected: false, error: error.code ?? String(error.message) }));
  });
}

/** Sends raw bytes over TCP and returns everything received within the window. */
function rawExchange(host, port, payload, windowMs = 2500) {
  return new Promise((resolve) => {
    const chunks = [];
    const socket = net.connect({ host, port });
    const done = (error) => {
      socket.destroy();
      resolve({ text: Buffer.concat(chunks).toString('latin1'), error });
    };
    socket.setTimeout(windowMs, () => done(chunks.length ? undefined : 'timeout'));
    socket.once('error', (error) => done(error.code ?? String(error.message)));
    socket.on('data', (data) => chunks.push(data));
    socket.once('close', () => done(undefined));
    socket.once('connect', () => socket.write(payload));
  });
}

function statusLines(text) {
  return [...text.matchAll(/^HTTP\/1\.[01] (\d{3})/gm)].map((m) => Number(m[1]));
}

function run(file, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        out: `${stdout}${stderr}`.trim().slice(0, 200),
      });
    });
  });
}

function listeners() {
  const parse = (file, v6) => {
    try {
      return readFileSync(file, 'utf8')
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols[3] === '0A')
        .map((cols) => {
          const [addr, port] = cols[1].split(':');
          return { family: v6 ? 6 : 4, addr, port: Number.parseInt(port, 16) };
        });
    } catch {
      return [];
    }
  };
  return [...parse('/proc/net/tcp', false), ...parse('/proc/net/tcp6', true)];
}

function dnsQuery(name) {
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  return Buffer.concat([
    Buffer.from([0x13, 0x37, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ...labels,
    Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]),
  ]);
}

// -- 0. what the namespace looks like ------------------------------------------------------------------------------
const found = listeners();
emit('inventory-tcp-listeners', 'info', JSON.stringify(found));
const resolver = found.find((l) => l.family === 4 && l.addr === '0B00007F');
const control = found.find((l) => l.port === 4100);
emit(
  'inventory-control-port-listening',
  control ? 'info' : 'blocked',
  control ? 'port 4100 listening' : 'port 4100 not listening',
);

// -- 1. IPv6 ---------------------------------------------------------------------------------------------------------
for (const target of ['fe80::1%eth0', 'fe80::1%lo', '2606:4700:4700::1111']) {
  const r = await tcpConnect(target, 443);
  emit(`ipv6-tcp ${target}`, r.connected ? 'open' : 'blocked', r.error ?? '');
}
await new Promise((resolve) => {
  const socket = dgram.createSocket('udp6');
  const timer = setTimeout(() => {
    socket.close();
    emit('ipv6-udp multicast ff02::1%eth0', 'blocked', 'no reply');
    resolve();
  }, 2000);
  socket.once('message', () => {
    clearTimeout(timer);
    socket.close();
    emit('ipv6-udp multicast ff02::1%eth0', 'open', 'reply received');
    resolve();
  });
  socket.once('error', (error) => {
    clearTimeout(timer);
    socket.close();
    emit('ipv6-udp multicast ff02::1%eth0', 'blocked', error.code ?? String(error.message));
    resolve();
  });
  socket.send(Buffer.from('x'), 9, 'ff02::1%eth0');
});

// -- 2. ICMP: a positive control first, so "blocked" cannot mean "ping does not work here" --------------------------
const control4 = await run('ping', ['-c', '1', '-W', '2', '127.0.0.1']);
emit(
  'icmp-control ping 127.0.0.1',
  control4.code === 0 ? 'info' : 'blocked',
  `exit ${control4.code} ${control4.out}`,
);
for (const target of ['1.1.1.1', PROXY_IP, '172.19.0.1']) {
  const r = await run('ping', ['-c', '1', '-W', '2', target]);
  emit(`icmp ping ${target}`, r.code === 0 ? 'open' : 'blocked', `exit ${r.code} ${r.out}`);
}

// -- 3. TCP egress to everything except the pinned proxy port ----------------------------------------------------------
for (const [host, port] of [
  ['1.1.1.1', 443],
  ['169.254.169.254', 80],
  ['172.19.0.1', 80],
  [PROXY_IP, 80],
  [PROXY_IP, 4313],
  [PROXY_IP, 4320],
]) {
  const r = await tcpConnect(host, port);
  emit(`tcp ${host}:${port}`, r.connected ? 'open' : 'blocked', r.error ?? '');
}
const proxyReach = await tcpConnect(PROXY_IP, PROXY_PORT);
emit(
  `tcp-control ${PROXY_IP}:${PROXY_PORT}`,
  proxyReach.connected ? 'info' : 'blocked',
  proxyReach.error ?? 'connected (the one permitted route)',
);

// -- 4. Embedded resolver: DNS over TCP and UDP to its high ports (the port-53 DNAT target) --------------------------
if (resolver) {
  const tcp = await tcpConnect('127.0.0.11', resolver.port);
  emit(`dns-tcp 127.0.0.11:${resolver.port}`, tcp.connected ? 'open' : 'blocked', tcp.error ?? '');
  const query = dnsQuery('example.com');
  const framed = Buffer.concat([Buffer.from([query.length >> 8, query.length & 0xff]), query]);
  const answer = await rawExchange('127.0.0.11', resolver.port, framed, 2500);
  emit(
    'dns-tcp-query example.com via high port',
    answer.text.length > 0 ? 'open' : 'blocked',
    answer.error ?? `${answer.text.length} bytes`,
  );
}
for (const port of [53, 5353]) {
  const answer = await rawExchange('127.0.0.11', port, Buffer.from([0, 1, 0]), 1500);
  emit(`dns-tcp 127.0.0.11:${port}`, answer.text.length > 0 ? 'open' : 'blocked', answer.error ?? '');
}
await new Promise((resolve) => {
  const socket = dgram.createSocket('udp4');
  const timer = setTimeout(() => {
    socket.close();
    emit('dns-udp 8.8.8.8:53', 'blocked', 'no reply');
    resolve();
  }, 2000);
  socket.once('message', () => {
    clearTimeout(timer);
    socket.close();
    emit('dns-udp 8.8.8.8:53', 'open', 'reply received');
    resolve();
  });
  socket.once('error', (error) => {
    clearTimeout(timer);
    socket.close();
    emit('dns-udp 8.8.8.8:53', 'blocked', error.code ?? String(error.message));
    resolve();
  });
  socket.send(dnsQuery('example.com'), 53, '8.8.8.8');
});

// -- 5. Control port 4100 on loopback, no credentials ----------------------------------------------------------------
for (const [method, path, body] of [
  ['GET', '/health', null],
  ['POST', '/files/read', '{"path":"x"}'],
  ['POST', '/files/write', '{"path":"x","contents":"y"}'],
  ['GET', '/', null],
]) {
  const payload = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:4100\r\nConnection: close\r\n${body ? `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n` : ''}\r\n${body ?? ''}`;
  const r = await rawExchange('127.0.0.1', 4100, payload, 3000);
  emit(
    `control-4100 ${method} ${path} no auth`,
    'answered',
    JSON.stringify({ status: statusLines(r.text), error: r.error ?? null }),
  );
}
{
  const payload =
    'POST /files/read HTTP/1.1\r\nHost: 127.0.0.1:4100\r\nConnection: close\r\nAuthorization: Bearer not-the-token\r\nx-openbot-bot-id: not-a-bot\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{"path":"x"}';
  const r = await rawExchange('127.0.0.1', 4100, payload, 3000);
  emit(
    'control-4100 POST /files/read wrong bearer',
    'answered',
    JSON.stringify({ status: statusLines(r.text), error: r.error ?? null }),
  );
}

// -- 6. Crafted request targets against the trusted proxy ------------------------------------------------------------
const crafted = {
  'origin-form root': 'GET / HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  'absolute-form metadata':
    'GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n',
  'double slash': 'GET //evil.example/x HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  'encoded dot-dot': 'GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  'dot-dot segment': 'GET /a/../b HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  backslash: 'GET /a\\b HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  query: 'GET /x?y=1 HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  fragment: 'GET /x#f HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  'encoded slash': 'GET /x%2fy HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  'null byte': 'GET /x%00 HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  connect: `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`,
  upgrade:
    'GET / HTTP/1.1\r\nHost: candidate-proxy:4314\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
  'host spoof': 'GET / HTTP/1.1\r\nHost: 169.254.169.254\r\nX-Forwarded-For: 127.0.0.1\r\n\r\n',
  'post chunked smuggle':
    'POST /x HTTP/1.1\r\nHost: candidate-proxy:4314\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n0\r\n\r\nGET /smuggled HTTP/1.1\r\nHost: candidate-proxy:4314\r\n\r\n',
  'post cl+te':
    'POST /x HTTP/1.1\r\nHost: candidate-proxy:4314\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n0\r\n\r\n',
  'oversized header': `GET / HTTP/1.1\r\nHost: candidate-proxy:4314\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`,
  'http/1.0': 'GET / HTTP/1.0\r\n\r\n',
};
for (const [name, payload] of Object.entries(crafted)) {
  const r = await rawExchange(PROXY_IP, PROXY_PORT, payload, 2500);
  const statuses = statusLines(r.text);
  const leaked = /ami-id|instance-id|root:x:0|passwd/.test(r.text);
  emit(
    `proxy-crafted ${name}`,
    'answered',
    JSON.stringify({ status: statuses, error: r.error ?? null, leaked }),
  );
}
const alive = await rawExchange(
  PROXY_IP,
  PROXY_PORT,
  'GET / HTTP/1.1\r\nHost: candidate-proxy:4314\r\nConnection: close\r\n\r\n',
  2500,
);
emit(
  'proxy-alive-after-crafted',
  'answered',
  JSON.stringify({ status: statusLines(alive.text), error: alive.error ?? null }),
);
