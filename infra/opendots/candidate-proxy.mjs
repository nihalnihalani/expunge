import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1_000_000;
function sameSecret(first, second) {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
function exactPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') ||
    raw.includes('?') || raw.includes('#') || raw.includes('%') || raw.includes('\\') ||
    raw.split('/').some((part) => part === '.' || part === '..')) return false;
  return /^\/[A-Za-z0-9/_-]*$/.test(raw);
}

/** Restricted reverse proxy, not a general browser/HTTP forward proxy. */
export function createCandidateProxy(env, transport = fetch) {
  const origin = new URL(env.EXPUNGE_CANDIDATE_BROKER_ORIGIN ?? '');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Broker must be a fixed HTTP(S) origin.');
  const candidateId = env.EXPUNGE_CANDIDATE_ID ?? '';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(candidateId)) throw new Error('Set a stored candidate ID.');
  const accessToken = env.EXPUNGE_CANDIDATE_ACCESS_TOKEN ?? '';
  // The proxy-to-broker principal has its OWN name. EXPUNGE_INTERNAL_TOKEN is the operator's read-projection
  // principal and must never be configured here (K10): both services default to :4320.
  if (env.EXPUNGE_INTERNAL_TOKEN !== undefined)
    throw new Error('EXPUNGE_INTERNAL_TOKEN belongs to the operator; use EXPUNGE_CANDIDATE_BROKER_TOKEN for the proxy.');
  const serviceToken = env.EXPUNGE_CANDIDATE_BROKER_TOKEN ?? '';
  if (accessToken.length < 24 || serviceToken.length < 24 || accessToken === serviceToken)
    throw new Error('Use distinct candidate and broker transport tokens of at least 24 characters.');
  // Optional: the lowercase hex SHA-256 of the operator's EXPUNGE_INTERNAL_TOKEN. Only the hash is given to the
  // proxy, so it can refuse an accidental reuse without ever holding the operator secret.
  const operatorTokenSha256 = env.EXPUNGE_OPERATOR_TOKEN_SHA256 ?? '';
  if (operatorTokenSha256 && !/^[a-f0-9]{64}$/.test(operatorTokenSha256))
    throw new Error('EXPUNGE_OPERATOR_TOKEN_SHA256 must be a lowercase hex SHA-256.');
  if (operatorTokenSha256 && createHash('sha256').update(serviceToken).digest('hex') === operatorTokenSha256)
    throw new Error('The proxy-to-broker token must differ from the operator internal token.');
  if (operatorTokenSha256 && createHash('sha256').update(accessToken).digest('hex') === operatorTokenSha256)
    throw new Error('The candidate access token must differ from the operator internal token.');
  const allow = JSON.parse(env.EXPUNGE_CANDIDATE_ALLOWED_ROUTES ?? '[]');
  if (!Array.isArray(allow) || allow.length > 32 || allow.some((route) =>
    !route || !['GET', 'POST'].includes(route.method) || !exactPath(route.path)))
    throw new Error('Broker allowlist must contain bounded exact GET/POST paths.');

  const server = createServer(async (req, res) => {
    const deny = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    };
    if (!exactPath(req.url) || !allow.some((route) => route.method === req.method && route.path === req.url))
      return deny(403, 'Candidate route is not admitted.');
    const bearer = typeof req.headers.authorization === 'string'
      ? req.headers.authorization.replace(/^Bearer /, '') : '';
    if (!sameSecret(bearer, accessToken)) return deny(401, 'Candidate transport authentication required.');
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json'))
      return deny(415, 'Use application/json.');
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) return deny(413, 'Candidate payload exceeds its bound.');
        chunks.push(chunk);
      }
      const response = await transport(new URL(req.url, origin), {
        method: req.method,
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          'x-expunge-candidate-id': candidateId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return deny(response.status, 'Candidate broker denied or could not complete the request.');
      if (!response.headers.get('content-type')?.includes('application/json'))
        return deny(502, 'Candidate broker returned an invalid response.');
      const reader = response.body?.getReader();
      if (!reader) return deny(502, 'Candidate broker returned an empty response.');
      const out = [];
      let outputSize = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        outputSize += value.length;
        if (outputSize > MAX_BYTES) { await reader.cancel(); return deny(502, 'Candidate response exceeds its bound.'); }
        out.push(Buffer.from(value));
      }
      const text = Buffer.concat(out).toString('utf8');
      if (text.includes(serviceToken)) return deny(502, 'Candidate broker returned a restricted response.');
      JSON.parse(text);
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(text);
    } catch {
      return deny(502, 'Candidate broker is unavailable.');
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
  createCandidateProxy(process.env).listen(Number(process.env.PORT ?? 4314), '0.0.0.0');
