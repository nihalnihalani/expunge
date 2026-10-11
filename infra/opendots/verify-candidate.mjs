/** Exercise the actual pinned computer API in the bounded candidate profile. */
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
loadEnvFile(resolve(process.argv[2] ?? 'infra/opendots/.env.candidates.local'));
const env = process.env;
if (!env.EXPUNGE_CANDIDATE_DOT_ID || !env.EXPUNGE_CANDIDATE_COMPUTER_TOKEN)
  throw new Error('Set a candidate ID and its derived computer token.');
const origin = `http://127.0.0.1:${Number(env.EXPUNGE_CANDIDATE_PORT ?? 4313)}`;
const headers = {
  Authorization: `Bearer ${env.EXPUNGE_CANDIDATE_COMPUTER_TOKEN}`,
  'x-openbot-bot-id': env.EXPUNGE_CANDIDATE_DOT_ID,
  'Content-Type': 'application/json',
};
async function action(path, body) {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Candidate control action failed with HTTP ${response.status}.`);
  return response.json();
}
const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(5000) });
if (!health.ok) throw new Error('Pinned candidate computer is not healthy.');
await action('/files/write', {
  path: 'candidate-a1.json',
  contents: '{"candidate":"harmless-local-check"}\n',
});
const read = await action('/files/read', { path: 'candidate-a1.json' });
if (read.text !== '{"candidate":"harmless-local-check"}\n') throw new Error('Candidate file check failed.');
// Network egress probes run INSIDE the guarded namespace through the candidate's own /exec.
// The DNS rows are a permanent regression probe for the embedded-resolver channel: Docker's
// resolver at 127.0.0.11 is reached over loopback, so a loopback ACCEPT alone lets dockerd
// forward queries upstream. Each DNS probe must fail; a missing DNS row fails the check too.
const program = `import dns from 'node:dns/promises';
const settle = (label, work, ms) => Promise.race([
  work().then((value) => ({label, resolved: value}), (e) => ({label, blocked: true, error: typeof e.code === 'string' ? e.code : e.name})),
  new Promise((resolve) => setTimeout(() => resolve({label, blocked: true, error: 'timeout'}), ms)),
]);
const fetched = (label, url) => settle(label, async () => (await fetch(url, {signal: AbortSignal.timeout(1000)})).status, 1500)
  .then((row) => (row.resolved === undefined ? row : {label, status: row.resolved}));
const resolverAt = (server) => () => { const r = new dns.Resolver({timeout: 1000, tries: 1}); r.setServers([server]); return r.resolve4('example.com'); };
const rows = [];
for (const [label, url] of [
  ['proxy', 'http://candidate-proxy:4314/artifact'],
  ['internet-ip', 'https://1.1.1.1'],
  ['metadata', 'http://169.254.169.254'],
  ['host-gateway', 'http://172.30.90.1:4320'],
  ['public-dns', 'https://example.com'],
]) rows.push(await fetched(label, url));
rows.push(...await Promise.all([
  settle('dns-system-resolver', () => dns.resolve4('example.com'), 2500),
  settle('dns-getaddrinfo', () => dns.lookup('example.com'), 2500),
  settle('dns-embedded-127.0.0.11', resolverAt('127.0.0.11'), 2500),
  settle('dns-direct-1.1.1.1', resolverAt('1.1.1.1'), 2500),
]));
for (const row of rows) console.log(JSON.stringify(row));
process.exit(0);`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const result = await action('/exec', {
  command: `node --input-type=module -e ${quote(program)}`,
  timeoutMs: 20_000,
});
if (result.exitCode !== 0 || result.timedOut || result.truncated)
  throw new Error('Candidate network check did not finish cleanly.');
const rows = result.stdout
  .trim()
  .split('\n')
  .map((row) => JSON.parse(row));
const dnsLabels = ['dns-system-resolver', 'dns-getaddrinfo', 'dns-embedded-127.0.0.11', 'dns-direct-1.1.1.1'];
if (dnsLabels.some((label) => !rows.some((row) => row.label === label)))
  throw new Error('Candidate DNS confinement probes did not all run.');
if (
  rows.find((row) => row.label === 'proxy')?.status !== 403 ||
  rows.filter((row) => row.label !== 'proxy').some((row) => row.blocked !== true)
)
  throw new Error('Candidate network confinement check failed.');
console.log(
  JSON.stringify({
    kind: 'live-pinned-candidate-computer-verification',
    healthStatus: health.status,
    candidateFileRoundtrip: true,
    rows,
  }),
);
