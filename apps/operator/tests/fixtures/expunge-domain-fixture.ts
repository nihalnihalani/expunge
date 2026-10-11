/**
 * FIXTURE BACKEND. A deterministic stand-in for the Expunge domain service's internal
 * projection routes, used only by protocol tests and by browser runs of the operator UI. It
 * answers `backend.kind: "fixture"` so the UI shows a persistent fixture banner. Nothing it
 * serves is a live job, a model run, a database result or a Raindrop event, and no screenshot
 * taken against it may be described as one.
 *
 * Slices add scenarios by dropping a module into tests/fixtures/ext/ whose default export is
 * `(state: FixtureState) => void`; the server loads every module in that directory.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ApprovalDescriptorView,
  ArtifactEnvelope,
  DeploymentView,
  ExpungeJobSnapshotV2,
  JobStatus,
  TargetKind,
  TypedProjectionEvent,
  WorldSummary,
} from '../../src/shared/expunge.js';
import {
  baseSnapshot,
  event,
  hex,
  later,
  preview,
  startedPayload,
  world,
} from './expunge-data.js';

export interface FixtureJob {
  snapshot: ExpungeJobSnapshotV2;
  events: TypedProjectionEvent[];
}
export type FixtureMode =
  | 'ok'
  | 'down'
  | 'unauthorized'
  | 'forbidden'
  | 'unbound'
  | 'evidence_never'
  | 'evidence_dead_letter'
  | 'slow';

export interface FixtureTokens {
  read: string;
  jobWrite: string;
  approval: string;
}
export const FIXTURE_TOKENS: FixtureTokens = {
  read: 'fixture-read-token-0123456789abcdef',
  jobWrite: 'fixture-job-write-token-0123456789ab',
  approval: 'fixture-approval-token-0123456789a',
};

export interface FixtureState {
  mode: FixtureMode;
  tokens: FixtureTokens;
  worlds: WorldSummary[];
  jobs: Map<string, FixtureJob>;
  artifacts: Map<string, ArtifactEnvelope>;
  proposals: Map<string, ApprovalDescriptorView>;
  deployments: Map<TargetKind, DeploymentView>;
  threads: Map<string, string>;
  /** Called by POST /__fixture/advance/:jobId; scenario modules register steps here. */
  advance: Map<string, (state: FixtureState) => void>;
  /** Handlers a scenario module may add for POST decisions and cancellations. */
  onCancel: Array<(state: FixtureState, jobId: string) => void>;
  onDecision: Array<
    (
      state: FixtureState,
      proposalId: string,
      decision: 'approve' | 'decline',
    ) => void
  >;
  submitted: Array<{ requestKey: string; jobId: string }>;
  log: Array<{ method: string; path: string; search: string; auth: string }>;
  restartCount: number;
  nextJob: number;
}

export function freshState(): FixtureState {
  return {
    mode: 'ok',
    tokens: FIXTURE_TOKENS,
    worlds: [world],
    jobs: new Map(),
    artifacts: new Map(),
    proposals: new Map(),
    deployments: new Map(),
    threads: new Map(),
    advance: new Map(),
    onCancel: [],
    onDecision: [],
    submitted: [],
    log: [],
    restartCount: 0,
    nextJob: 1,
  };
}

const json = (status: number, body: unknown) => ({ status, body });
type Reply = { status: number; body: unknown };

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export function submitJob(state: FixtureState, requestKey: string): FixtureJob {
  const existing = state.submitted.find(
    (item) => item.requestKey === requestKey,
  );
  if (existing) return state.jobs.get(existing.jobId)!;
  const jobId = `job-new-${state.nextJob++}`;
  const snapshot = baseSnapshot(jobId, {
    status: 'queued',
    sequence: 1,
    phase: null,
    phaseStates: {
      inspect: 'pending',
      resolve: 'pending',
      discover: 'pending',
      preview: 'pending',
      apply: 'pending',
      verify: 'pending',
      complete: 'pending',
    },
    coverage: {
      registeredCollectionIds: world.collectionIds,
      inspectedCollectionIds: [],
      discoveredFieldIds: [],
      completeness: 'declared',
      limitations: [],
    },
  });
  const job: FixtureJob = {
    snapshot,
    events: [event(jobId, 1, 'job_started', startedPayload)],
  };
  state.jobs.set(jobId, job);
  state.submitted.push({ requestKey, jobId });
  return job;
}

function authorize(
  state: FixtureState,
  header: string | undefined,
  expected: string,
): Reply | undefined {
  if (state.mode === 'unauthorized') return json(401, { error: 'no' });
  if (state.mode === 'forbidden') return json(403, { error: 'no' });
  if (header !== `Bearer ${expected}`) return json(401, { error: 'no' });
  return undefined;
}

export async function route(
  state: FixtureState,
  method: string,
  url: URL,
  headers: IncomingMessage['headers'],
  readJson: () => Promise<Record<string, unknown>>,
): Promise<Reply> {
  const path = url.pathname;
  const bearer = headers.authorization;
  state.log.push({
    method,
    path,
    search: url.search,
    auth: bearer ? bearer.replace(/Bearer (.{6}).*/, 'Bearer $1…') : '',
  });
  if (path.startsWith('/__fixture/')) {
    if (path === '/__fixture/mode' && method === 'POST') {
      state.mode = (await readJson()).mode as FixtureMode;
      return json(200, { mode: state.mode });
    }
    if (path === '/__fixture/log') return json(200, state.log);
    if (path === '/__fixture/restart' && method === 'POST') {
      // Simulates a backend restored to an earlier committed state: sequences regress.
      state.restartCount++;
      for (const job of state.jobs.values()) {
        job.events = job.events.slice(0, Math.max(1, job.events.length - 2));
        job.snapshot = {
          ...job.snapshot,
          sequence: job.events.at(-1)?.sequence ?? 1,
        };
      }
      return json(200, { restarted: state.restartCount });
    }
    const advance = path.match(/^\/__fixture\/advance\/([^/]+)$/);
    if (advance && method === 'POST') {
      const step = state.advance.get(advance[1]);
      if (!step) return json(404, { error: 'no scenario step' });
      step(state);
      return json(200, { ok: true });
    }
    return json(404, { error: 'unknown fixture control' });
  }
  if (!path.startsWith('/internal/projection/'))
    return json(404, { error: 'not found' });
  if (state.mode === 'down') return json(503, { error: 'down' });
  if (state.mode === 'slow')
    await new Promise((resolve) => setTimeout(resolve, 6000));
  const isWrite = method === 'POST';
  const rest = path.replace('/internal/projection/', '');
  const expected = !isWrite
    ? state.tokens.read
    : rest.startsWith('proposals/')
      ? state.tokens.approval
      : state.tokens.jobWrite;
  const denied = authorize(state, bearer, expected);
  if (denied) return denied;

  if (rest === 'readiness' && !isWrite) {
    const evidence =
      state.mode === 'evidence_never'
        ? {
            configured: true,
            writeProvenAt: null,
            readBackProvenAt: null,
            deadLetters: 0,
          }
        : state.mode === 'evidence_dead_letter'
          ? {
              configured: true,
              writeProvenAt: new Date(Date.now() - 600_000).toISOString(),
              readBackProvenAt: new Date(Date.now() - 300_000).toISOString(),
              deadLetters: 2,
            }
          : {
              configured: true,
              writeProvenAt: new Date(Date.now() - 600_000).toISOString(),
              readBackProvenAt: new Date(Date.now() - 300_000).toISOString(),
              deadLetters: 0,
            };
    return json(200, {
      backend: { kind: 'fixture', version: 'fixture-1' },
      scope: { bound: state.mode !== 'unbound' },
      evidence,
    });
  }
  if (rest === 'worlds' && !isWrite) return json(200, { worlds: state.worlds });
  if (rest === 'previews' && isWrite) {
    const body = await readJson();
    const subject = body.subject as {
      idType: 'objectId' | 'string' | 'int' | 'long';
      value: string;
    };
    return json(200, {
      ...preview,
      worldId: String(body.worldId),
      subject: {
        display: `${subject.idType} ${String(subject.value).slice(0, 4)}…${String(subject.value).slice(-2)}`,
        identityHash: hex(`subject:${subject.value}`),
        idType: subject.idType,
      },
    });
  }
  if (rest === 'jobs' && !isWrite) {
    const items = [...state.jobs.values()].map(({ snapshot, events }) => {
      const committed = events.find(
        (item) => item.kind === 'receipt_committed',
      );
      const receiptFields =
        committed && snapshot.receipt
          ? {
              receiptId: snapshot.receipt.receiptId,
              receiptSequence: committed.sequence,
              verifiedWorldRevision: (
                committed.payload as { verifiedWorldRevision: number }
              ).verifiedWorldRevision,
            }
          : {};
      return {
        ...receiptFields,
        jobId: snapshot.jobId,
        kind: snapshot.kind,
        status: snapshot.status,
        sequence: snapshot.sequence,
        subjectDisplay: snapshot.subject?.display,
        worldId: snapshot.world?.worldId,
        harnessHash: snapshot.harness?.hash,
        receiptDomainStatus:
          (snapshot as { receiptVerdict?: string }).receiptVerdict ===
          'complete'
            ? 'complete_in_registered_scope'
            : (snapshot as { receiptVerdict?: string }).receiptVerdict ===
                'incomplete'
              ? 'incomplete'
              : undefined,
        updatedAt: snapshot.updatedAt,
      };
    });
    return json(200, { items, nextCursor: null });
  }
  if (rest === 'jobs' && isWrite) {
    const body = await readJson();
    const job = submitJob(state, String(body.requestKey));
    return json(202, {
      jobId: job.snapshot.jobId,
      status: job.snapshot.status as JobStatus,
    });
  }
  const jobMatch = rest.match(/^jobs\/([^/]+)(?:\/(events|cancel))?$/);
  if (jobMatch) {
    const job = state.jobs.get(jobMatch[1]);
    if (!job) return json(404, { error: 'not found' });
    if (!jobMatch[2] && !isWrite)
      return json(200, {
        ...job.snapshot,
        streamEpoch: `epoch-${state.restartCount}`,
      });
    if (jobMatch[2] === 'events' && !isWrite) {
      const after = Number(url.searchParams.get('afterSequence') ?? '0');
      const limit = Math.min(
        500,
        Number(url.searchParams.get('limit') ?? '500'),
      );
      const events = job.events
        .filter((item) => item.sequence > after)
        .slice(0, limit);
      return json(200, {
        events,
        nextSequence: events.at(-1)?.sequence ?? after,
        streamEpoch: `epoch-${state.restartCount}`,
      });
    }
    if (jobMatch[2] === 'cancel' && isWrite) {
      for (const handler of state.onCancel) handler(state, jobMatch[1]);
      return json(202, { accepted: true, sequence: job.snapshot.sequence });
    }
  }
  const artifact = rest.match(/^artifacts\/([^/]+)$/);
  if (artifact && !isWrite) {
    const found = state.artifacts.get(artifact[1]);
    return found ? json(200, found) : json(404, { error: 'not found' });
  }
  const proposal = rest.match(/^proposals\/([^/]+)(?:\/(decision))?$/);
  if (proposal) {
    const found = state.proposals.get(proposal[1]);
    if (!found) return json(404, { error: 'not found' });
    if (!proposal[2] && !isWrite) return json(200, found);
    if (proposal[2] && isWrite) {
      const body = await readJson();
      if (body.descriptorDigest !== found.descriptorDigest)
        return json(409, { error: 'digest mismatch' });
      for (const handler of state.onDecision)
        handler(state, proposal[1], body.decision as 'approve' | 'decline');
      const after = state.proposals.get(proposal[1])!;
      return json(200, {
        accepted: true,
        state: after.state,
        committedEventSequence: 0,
      });
    }
  }
  const deployment = rest.match(/^deployments\/([^/]+)$/);
  if (deployment && !isWrite) {
    const found = state.deployments.get(deployment[1] as TargetKind);
    return found ? json(200, found) : json(404, { error: 'not found' });
  }
  const thread = rest.match(/^threads\/([^/]+)$/);
  if (thread && !isWrite) {
    const jobId = state.threads.get(thread[1]);
    return jobId ? json(200, { jobId }) : json(404, { error: 'not found' });
  }
  return json(404, { error: 'not found' });
}

export async function loadScenarios(state: FixtureState) {
  const dir = fileURLToPath(new URL('./ext/', import.meta.url));
  for (const name of readdirSync(dir)
    .filter((file) => /\.ts$/.test(file))
    .sort()) {
    const module = (await import(pathToFileURL(dir + name).href)) as {
      default?: (state: FixtureState) => void;
    };
    module.default?.(state);
  }
}

export interface RunningFixture {
  server: Server;
  url: string;
  state: FixtureState;
  close: () => Promise<void>;
}

export async function startFixture(
  port = 0,
  state: FixtureState = freshState(),
  options: { scenarios?: boolean } = {},
): Promise<RunningFixture> {
  if (options.scenarios !== false) await loadScenarios(state);
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const reply = await route(
          state,
          request.method ?? 'GET',
          url,
          request.headers,
          () => readBody(request),
        );
        response.writeHead(reply.status, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(reply.body));
      } catch {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end('{"error":"fixture failure"}');
      }
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    state,
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export { later };
