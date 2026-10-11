import { ProtocolError, DeploymentRepository } from '@expunge/mongo';
import type { DomainEnv } from '../env.js';
import { ROUTE_PRINCIPAL, authenticate } from './auth.js';
import { ServiceConfigError, type ServiceConfig } from './config.js';
import { ServiceRefusal } from './errors.js';
import {
  cancelJob,
  cancelRequestSchema,
  httpWakeSender,
  submitCleanup,
  submitRequestSchema,
  type WakeSender,
} from './jobs.js';
import { operatorPreview, previewRequestSchema } from './preview.js';
import { serveArtifactRoute } from './artifacts.js';
import { evidenceStatus } from './evidence.js';
import { serveProjection } from './projection.js';
import { listWorlds } from './worlds.js';

const BASE = '/internal/projection';
const MAX_BODY_BYTES = 16 * 1024;
export const SERVICE_VERSION = 'domain-gateway-1';

export interface DomainService {
  handle(request: Request): Promise<Response>;
}

export type DomainServiceDeps = {
  env: DomainEnv;
  config: ServiceConfig;
  /** Overrides the HTTP wake sender (tests). Absent means the configured worker origin, or no wake at all. */
  wake?: WakeSender | null;
  transport?: typeof fetch;
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ServiceRefusal(413, 'payload_too_large');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceRefusal(400, 'invalid_request');
  }
}

/** Route family of a request, or null when the path is not one this service knows. */
function route(method: string, pathname: string): { key: string; id?: string } | null {
  if (!pathname.startsWith(`${BASE}/`)) return null;
  const parts = pathname
    .slice(BASE.length + 1)
    .split('/')
    .filter(Boolean);
  const [head, id, tail] = parts;
  if (method === 'GET') {
    if (parts.length === 1 && (head === 'readiness' || head === 'worlds' || head === 'jobs'))
      return { key: `GET ${head}` };
    if (head === 'jobs' && id && parts.length === 2) return { key: 'GET jobs', id };
    if (head === 'jobs' && id && tail === 'events' && parts.length === 3) return { key: 'GET events', id };
    if (
      head &&
      ['artifacts', 'proposals', 'deployments', 'threads'].includes(head) &&
      id &&
      parts.length === 2
    )
      return { key: `GET ${head}`, id };
    return null;
  }
  if (method === 'POST') {
    if (head === 'previews' && parts.length === 1) return { key: 'POST previews' };
    if (head === 'jobs' && parts.length === 1) return { key: 'POST jobs' };
    if (head === 'jobs' && id && tail === 'cancel' && parts.length === 3) return { key: 'POST cancel', id };
    if (head === 'proposals' && id && tail === 'decision' && parts.length === 3)
      return { key: 'POST decision', id };
  }
  return null;
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAPPED: Record<string, [ServiceRefusal['status'], string]> = {
  UnknownWorld: [404, 'not_found'],
  // A page could not be read from one stable epoch (a reset kept happening during the read): try again.
  StreamEpochUnstable: [503, 'unavailable'],
  WorldInMaintenance: [409, 'world_in_maintenance'],
  StaleWorldBinding: [409, 'conflict'],
  ScanBudgetExceeded: [422, 'scan_budget_exceeded'],
  AuthorityMissing: [503, 'scope_not_authorized'],
  // The pointer moved between the service's read and the job insert.
  HarnessNotDeployed: [409, 'no_active_harness'],
};

/**
 * The domain's operator-facing HTTP surface. Three inbound principals, each bound by configuration to one owner and
 * one scope: the read projection token, the job-write token (previews, submit, cancel) and the approval token
 * (decisions). A token works only on its own routes. Routes whose backing state this package does not serve yet
 * answer 501 rather than a fixture. Responses carry closed error codes only.
 */
export function createDomainService(deps: DomainServiceDeps): DomainService {
  const { env, config } = deps;
  // A hand-built config gets the same guard as serviceConfigFromEnv: one token must never act as two principals.
  const configured = Object.values(config.tokens).filter(
    (token): token is string => typeof token === 'string',
  );
  if (new Set(configured).size !== configured.length) throw new ServiceConfigError(['tokens_must_differ']);
  let deployments: DeploymentRepository | null = null;
  const deploymentRepository = () => (deployments ??= new DeploymentRepository(env.service));
  const wake: WakeSender | null =
    deps.wake !== undefined ? deps.wake : config.wake ? httpWakeSender(config.wake, deps.transport) : null;

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const auth = authenticate(request, config);
    if (!auth.ok) return json(auth.status, { error: auth.error });
    const matched = route(request.method, url.pathname);
    if (!matched) return json(404, { error: 'not_found' });
    if (matched.id !== undefined && !SAFE_ID.test(matched.id)) return json(400, { error: 'invalid_request' });
    // A token never works outside its own route family.
    if (ROUTE_PRINCIPAL[matched.key] !== auth.principal) return json(403, { error: 'forbidden' });
    switch (matched.key) {
      case 'GET readiness': {
        const bound = await env.authority.read(config.owner.scope).then(
          () => true,
          () => false,
        );
        return json(200, {
          backend: { kind: 'live', version: SERVICE_VERSION },
          scope: { bound },
          // Derived from the committed telemetry outbox, never a constant; an unreadable outbox is unconfigured, not ready.
          evidence: await evidenceStatus(env, config.owner.scope).catch(() => ({
            configured: false,
            writeProvenAt: null,
            readBackProvenAt: null,
            deadLetters: 0,
          })),
        });
      }
      case 'GET worlds':
        return json(200, await listWorlds(env, config));
      case 'POST previews': {
        const body = previewRequestSchema.safeParse(await readBody(request));
        if (!body.success) return json(400, { error: 'invalid_request' });
        return json(200, await operatorPreview(env, config, body.data));
      }
      case 'POST jobs': {
        const body = submitRequestSchema.safeParse(await readBody(request));
        if (!body.success) return json(400, { error: 'invalid_request' });
        return json(200, await submitCleanup(env, config, deploymentRepository(), wake, body.data));
      }
      case 'POST cancel': {
        const body = cancelRequestSchema.safeParse(await readBody(request));
        if (!body.success) return json(400, { error: 'invalid_request' });
        return json(200, await cancelJob(env, config, matched.id!));
      }
      case 'GET jobs':
      case 'GET events': {
        // Job snapshots, event pages and the job list: committed state under the read principal (projection.ts).
        const served = await serveProjection(
          env,
          config,
          { key: matched.key as 'GET jobs' | 'GET events', ...(matched.id ? { id: matched.id } : {}) },
          url,
        );
        return json(served.status, served.body);
      }
      case 'GET artifacts':
      case 'GET deployments': {
        // Completion receipts and the deployment view (artifacts.ts); the other artifact kinds answer 404.
        const served = await serveArtifactRoute(
          env,
          config,
          { key: matched.key as 'GET artifacts' | 'GET deployments', id: matched.id! },
          url,
        );
        return json(served.status, served.body);
      }
      default:
        // Proposals (approval descriptors), the decision and threads are served by the projection layer, which is not
        // part of this package yet.
        return json(501, { error: 'unsupported' });
    }
  }

  return {
    async handle(request) {
      try {
        return await dispatch(request);
      } catch (error) {
        if (error instanceof ServiceRefusal) return json(error.status, { error: error.code });
        if (error instanceof ProtocolError) {
          const mapped = MAPPED[error.code];
          if (mapped) return json(mapped[0], { error: mapped[1] });
        }
        return json(500, { error: 'internal' });
      }
    },
  };
}
