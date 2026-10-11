/** Real local ComputerService verification. Creates two synthetic Dot computers.
 * Requires the built operator and running pinned supervisor; never resets or
 * deletes volumes. Reads server-only credentials without printing them.
 */
import { loadEnvFile } from 'node:process';
import { createHmac } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnvFile(resolve(process.argv[2] ?? resolve(root, '.env')));
const env = process.env;
if (!env.COMPUTER_SUPERVISOR_TOKEN || !env.COMPUTER_TOKEN)
  throw new Error('Set server-only computer credentials before live verification.');
const { WorkspaceStore } = await import(
  pathToFileURL(resolve(root, 'apps/operator/dist/server/server/workspace.js')).href
);
const { ComputerService } = await import(
  pathToFileURL(resolve(root, 'apps/operator/dist/server/server/computer-service.js')).href
);
const dir = await mkdtemp(resolve(tmpdir(), 'expunge-live-computers-'));
const workspace = new WorkspaceStore(resolve(dir, 'workspace.sqlite'), 'a1-local-verification-owner');
const config = {
  baseUrl: 'https://api.openai.com/v1',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
  computerSupervisorUrl: env.COMPUTER_SUPERVISOR_URL || 'http://127.0.0.1:4312',
  computerSupervisorToken: env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: env.COMPUTER_TOKEN,
  computerNamespace: env.COMPUTER_NAMESPACE || 'opendots',
};
const service = new ComputerService(workspace, config, () => false);
const first = workspace.dots()[0];
const second = workspace.createDot(
  first.spaceId,
  'A1 isolation witness',
  'Synthetic local verification only.',
  false,
  false,
);
const results = [];
try {
  for (const dot of [first, second]) {
    await service.permissions(dot.id, { enabled: true, files: true, shell: true, browser: false });
    const status = await service.start(dot.id);
    if (status.state !== 'running') throw new Error('Pinned computer did not become ready.');
    results.push({ dotId: dot.id, started: true });
  }
  await service.action(
    first.id,
    'files_write',
    { path: 'candidate/a1.json', contents: '{"source":"harmless candidate fixture"}\n' },
    'agent',
  );
  const read = await service.action(first.id, 'files_read', { path: 'candidate/a1.json' }, 'agent');
  if (read.text !== '{"source":"harmless candidate fixture"}\n')
    throw new Error('Computer file read did not match its written candidate fixture.');
  const secondList = await service.action(second.id, 'files_list', {}, 'agent');
  if (!Array.isArray(secondList.entries) || secondList.entries.some((entry) => entry.path === 'candidate'))
    throw new Error('Second computer listing did not show an independent workspace.');
  let separate = false;
  try {
    await service.action(second.id, 'files_read', { path: 'candidate/a1.json' }, 'agent');
  } catch (error) {
    if (error instanceof Error && /HTTP 400/.test(error.message)) separate = true;
    else throw error;
  }
  if (!separate) throw new Error('Second computer can read first computer candidate file.');
  const supervisor = await fetch(`${config.computerSupervisorUrl}/computers`, {
    headers: { Authorization: `Bearer ${env.COMPUTER_SUPERVISOR_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!supervisor.ok) throw new Error('Supervisor verification request failed.');
  const computers = (await supervisor.json()).computers;
  const firstState = computers.find((computer) => computer.botId === first.id);
  const firstUrl = firstState?.port ? `http://127.0.0.1:${firstState.port}` : firstState?.url;
  if (!firstUrl) throw new Error('Computer control endpoint missing.');
  const secondToken = createHmac('sha256', env.COMPUTER_TOKEN)
    .update(`opendots-computer:${second.id}`)
    .digest('hex');
  const wrongCredential = await fetch(`${firstUrl}/files/list`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secondToken}`,
      'x-openbot-bot-id': first.id,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (wrongCredential.status !== 401) throw new Error('A different Dot credential was accepted.');
  const exec = await service.action(
    first.id,
    'exec',
    { command: 'node -e "console.log(\\"harmless-candidate-check\\")"', timeoutMs: 5000 },
    'agent',
  );
  const audit = workspace.computers.audit(first.id);
  if (
    !audit.some(
      (entry) => entry.action === 'files_write' && entry.actor === 'agent' && entry.outcome === 'succeeded',
    )
  )
    throw new Error('ComputerService did not record the agent action.');
  const proof = {
    kind: 'live-pinned-opendots-computer-verification',
    results,
    separateWorkspaces: true,
    secondList,
    crossDotCredentialStatus: wrongCredential.status,
    read,
    exec,
    agentAudit: audit.filter((entry) => entry.actor === 'agent'),
  };
  await writeFile(resolve(dir, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(
    JSON.stringify({
      kind: proof.kind,
      separateWorkspaces: true,
      crossDotCredentialStatus: wrongCredential.status,
      agentAction: 'succeeded',
      proofPath: resolve(dir, 'proof.json'),
    }),
  );
} finally {
  for (const dot of [first, second]) {
    try {
      await service.stop(dot.id);
    } catch {
      /* Retain original failure; no reset/delete. */
    }
  }
  workspace.close();
}
