import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Trusted candidate BROKER. It is the only thing behind the candidate proxy and exposes exactly two typed routes:
 *  - POST /artifact/fetch {artifactHash}      -> the bytes of an ADMITTED artifact, size-bounded;
 *  - POST /result/submit  {ticketId, value}   -> a typed result for one RUN TICKET, validated and spooled for the trusted
 *                                                side, which validates it again with its own schemas.
 * A run ticket is minted by the trusted side (128-bit random id, bound to candidate, slot, artifact hash, input hash, job,
 * run and call number, with an expiry) and delivered only to that run through a read-only directory. The candidate names a
 * ticket, never the binding itself, so it cannot submit under another run's identity. A ticket takes one result: the same
 * value again is idempotent, any different value is refused. The record of what was accepted is the spool, which the broker
 * re-reads at start, so a restart does not reopen a ticket or a call.
 * It holds no database, model, grader, promoter, telemetry or operator credential and refuses to start with ANY environment
 * name outside an allowlist. Its only secret is the inbound proxy-to-broker token it checks; the candidate reaches it only
 * through the proxy, which never forwards that token to the candidate.
 */
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_TICKET_BYTES = 4 * 1024;
const SLOTS = new Set(['discovery', 'context', 'critic']);
const HASH = /^[a-f0-9]{64}$/;
const TICKET_ID = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The only environment names the broker accepts. Anything else (a database URI, a provider key, ...) refuses start. */
export const ALLOWED_ENV = new Set([
  'PORT',
  'EXPUNGE_CANDIDATE_ID',
  'EXPUNGE_CANDIDATE_BROKER_TOKEN',
  'EXPUNGE_BROKER_ARTIFACT_DIR',
  'EXPUNGE_BROKER_SPOOL_DIR',
  'EXPUNGE_BROKER_TICKET_DIR',
  'EXPUNGE_BROKER_RATE_PER_MINUTE',
  'EXPUNGE_BROKER_MAX_CONCURRENCY',
  // Container defaults of the node image; none carries a secret.
  'PATH',
  'HOME',
  'HOSTNAME',
  'NODE_VERSION',
  'YARN_VERSION',
  'TERM',
  'PWD',
  'SHLVL',
  'OLDPWD',
  '_',
]);

const same = (first, second) => {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Bounded plain JSON: objects, arrays, strings, finite numbers, booleans, null; limited depth and breadth. */
function plainJson(value, depth = 0) {
  if (depth > 6) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 2000;
  if (Array.isArray(value)) return value.length <= 256 && value.every((v) => plainJson(v, depth + 1));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(value);
    return keys.length <= 64 && keys.every((k) => k.length <= 64 && plainJson(value[k], depth + 1));
  }
  return false;
}

export function createCandidateBroker(env, clock = () => Date.now()) {
  const unexpected = Object.keys(env).filter((name) => !ALLOWED_ENV.has(name));
  if (unexpected.length > 0)
    throw new Error(`The broker refuses to start with unlisted environment: ${unexpected.join(', ')}.`);
  const token = env.EXPUNGE_CANDIDATE_BROKER_TOKEN ?? '';
  if (token.length < 24) throw new Error('Set a broker token of at least 24 characters.');
  const candidateId = env.EXPUNGE_CANDIDATE_ID ?? '';
  if (!ID.test(candidateId)) throw new Error('Set a stored candidate ID.');
  const artifactDir = env.EXPUNGE_BROKER_ARTIFACT_DIR ?? '';
  const spoolDir = env.EXPUNGE_BROKER_SPOOL_DIR ?? '';
  const ticketDir = env.EXPUNGE_BROKER_TICKET_DIR ?? '';
  if (!artifactDir || !spoolDir || !ticketDir)
    throw new Error('Set the artifact, spool and ticket directories.');
  const ratePerMinute = Number(env.EXPUNGE_BROKER_RATE_PER_MINUTE ?? 120);
  const maxConcurrent = Number(env.EXPUNGE_BROKER_MAX_CONCURRENCY ?? 4);
  if (
    !Number.isSafeInteger(ratePerMinute) ||
    ratePerMinute < 1 ||
    !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent < 1
  )
    throw new Error('Rate and concurrency bounds must be positive integers.');

  const digestOf = (r) =>
    sha256(Buffer.from(JSON.stringify([r.slot, r.artifactHash, r.inputHash, JSON.stringify(r.value)])));
  const callKey = (r) => `${r.jobId}:${r.runId}:${r.callNumber}`;
  const byTicket = new Map(); // ticketId -> { resultId, digest }
  const byCall = new Map(); // jobId:runId:callNumber -> digest
  // The spool is the durable record: a restarted broker rebuilds what it already accepted.
  const spoolFile = join(spoolDir, 'results.jsonl');
  if (existsSync(spoolFile))
    for (const line of readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        byTicket.set(record.ticketId, { resultId: record.resultId, digest: digestOf(record) });
        byCall.set(callKey(record), digestOf(record));
      } catch {
        /* a torn last line is ignored; the next accepted result is appended after it */
      }
    }

  // Per-candidate rate bound (fixed one-minute window) and a cap on concurrent requests (the hash work).
  let windowStart = clock();
  let windowCount = 0;
  let inFlight = 0;

  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const bearer =
      typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer /, '') : '';
    if (!same(bearer, token)) return reply(401, { error: 'Broker authentication required.' });
    if (req.headers['x-expunge-candidate-id'] !== candidateId)
      return reply(403, { error: 'Candidate binding mismatch.' });
    if (req.method !== 'POST' || !['/artifact/fetch', '/result/submit'].includes(req.url ?? ''))
      return reply(404, { error: 'Unknown broker route.' });
    if (clock() - windowStart >= 60_000) {
      windowStart = clock();
      windowCount = 0;
    }
    if (++windowCount > ratePerMinute || inFlight >= maxConcurrent)
      return reply(429, { error: 'Candidate request rate is bounded.' });
    inFlight++;
    try {
      if (!req.headers['content-type']?.startsWith('application/json'))
        return reply(415, { error: 'Use application/json.' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) return reply(413, { error: 'Request exceeds its bound.' });
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'Malformed JSON.' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return reply(400, { error: 'Expected an object.' });

      // Admitted artifacts are files named by their own sha256, re-hashed on every serve.
      const admitted = (hash) => {
        if (!HASH.test(hash)) return null;
        const path = join(artifactDir, hash);
        if (!existsSync(path) || statSync(path).size > MAX_ARTIFACT_BYTES) return null;
        const bytes = readFileSync(path);
        return sha256(bytes) === hash ? bytes : null;
      };

      if (req.url === '/artifact/fetch') {
        if (Object.keys(body).length !== 1 || typeof body.artifactHash !== 'string')
          return reply(400, { error: 'Expected {artifactHash}.' });
        const bytes = admitted(body.artifactHash);
        if (!bytes) return reply(404, { error: 'Artifact is not admitted.' });
        return reply(200, {
          artifactHash: body.artifactHash,
          bytes: bytes.length,
          contentBase64: bytes.toString('base64'),
        });
      }

      // /result/submit: the candidate names a ticket and supplies the value; everything else comes from the ticket.
      if (Object.keys(body).sort().join(',') !== 'ticketId,value')
        return reply(400, { error: 'Expected {ticketId, value}.' });
      if (!TICKET_ID.test(String(body.ticketId))) return reply(400, { error: 'Invalid ticket.' });
      const ticket = (() => {
        const path = join(ticketDir, `${body.ticketId}.json`);
        if (!existsSync(path) || statSync(path).size > MAX_TICKET_BYTES) return null;
        try {
          const t = JSON.parse(readFileSync(path, 'utf8'));
          const ok =
            t &&
            typeof t === 'object' &&
            t.ticketId === body.ticketId &&
            t.candidateId === candidateId &&
            SLOTS.has(t.slot) &&
            HASH.test(String(t.artifactHash)) &&
            HASH.test(String(t.inputHash)) &&
            ID.test(String(t.jobId)) &&
            ID.test(String(t.runId)) &&
            Number.isSafeInteger(t.callNumber) &&
            t.callNumber >= 0 &&
            typeof t.expiresAt === 'string' &&
            Number.isFinite(Date.parse(t.expiresAt));
          return ok ? t : null;
        } catch {
          return null;
        }
      })();
      if (!ticket) return reply(403, { error: 'Unknown or malformed ticket.' });
      if (Date.parse(ticket.expiresAt) <= clock()) return reply(403, { error: 'Ticket has expired.' });
      if (!admitted(ticket.artifactHash))
        return reply(403, { error: 'Ticket names an artifact that is not admitted.' });
      if (
        !plainJson(body.value) ||
        typeof body.value !== 'object' ||
        body.value === null ||
        Array.isArray(body.value)
      )
        return reply(400, { error: 'Result value must be a bounded plain JSON object.' });
      const valueText = JSON.stringify(body.value);
      if (Buffer.byteLength(valueText) > MAX_VALUE_BYTES)
        return reply(413, { error: 'Result value exceeds its bound.' });
      const record = {
        candidateId,
        ticketId: ticket.ticketId,
        jobId: ticket.jobId,
        runId: ticket.runId,
        callNumber: ticket.callNumber,
        inputHash: ticket.inputHash,
        slot: ticket.slot,
        artifactHash: ticket.artifactHash,
        value: body.value,
      };
      const digest = digestOf(record);
      const earlier = byTicket.get(ticket.ticketId);
      if (earlier)
        return earlier.digest === digest
          ? reply(200, { accepted: true, resultId: earlier.resultId, duplicate: true })
          : reply(409, { error: 'A different result was already submitted for this ticket.' });
      const sameCall = byCall.get(callKey(record));
      if (sameCall !== undefined && sameCall !== digest)
        return reply(409, { error: 'A different result was already accepted for this call.' });
      const resultId = randomUUID();
      appendFileSync(
        spoolFile,
        JSON.stringify({ resultId, ...record, receivedAt: new Date(clock()).toISOString() }) + '\n',
        { flag: 'a' },
      );
      byTicket.set(ticket.ticketId, { resultId, digest });
      byCall.set(callKey(record), digest);
      return reply(200, { accepted: true, resultId });
    } catch {
      return reply(500, { error: 'Broker could not complete the request.' });
    } finally {
      inFlight--;
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createCandidateBroker(process.env).listen(Number(process.env.PORT ?? 4320), '0.0.0.0');
