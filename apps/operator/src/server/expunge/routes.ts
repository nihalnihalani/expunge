import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  JOB_KINDS,
  JOB_STATUSES,
  TARGET_KINDS,
  type TargetKind,
} from '../../shared/expunge.js';
import { describeExpungeConfig, type ExpungeConfigView } from './config.js';
import {
  ExpungeDomainError,
  type ExpungeDomainService,
} from './domain-service.js';
import { logRejection } from './log.js';
import { ReadinessCache } from './readiness.js';
import {
  ProjectionRejected,
  cancelRequestSchema,
  decisionRequestSchema,
  previewRequestSchema,
  submitRequestSchema,
} from './schemas.js';

const jobId = /^[A-Za-z0-9_-]{1,128}$/;
const looseId = /^[A-Za-z0-9_.:-]{1,128}$/;
const cursor = /^[A-Za-z0-9_=.:-]{1,256}$/;
const param = (c: Context, name: string) => c.req.param(name) ?? '';

export interface ExpungeAccess {
  /**
   * The operator has an owner access token configured, and the boundary in app.ts has already
   * verified it on this request. Without one, nothing but readiness and status is served: a
   * local process that sends no Origin must not be able to read jobs, submit, cancel or approve.
   */
  ownerAuthenticated: boolean;
  /** Build identity written at build time (dist/build-id.json), or null when running unbuilt. */
  build?: string | null;
}

/** Mount after OpenDots' owner/origin/content-type boundary under /api. */
export function expungeRoutes(
  domain?: ExpungeDomainService,
  config: ExpungeConfigView = describeExpungeConfig({}),
  access: ExpungeAccess = { ownerAuthenticated: false },
) {
  const routes = new Hono();
  const readiness = new ReadinessCache(config, domain);
  const problem = (
    c: Context,
    status: 400 | 401 | 404 | 409 | 501 | 502 | 503,
    code: string,
    error: string,
    missing?: string[],
  ) => c.json({ error, code, ...(missing?.length ? { missing } : {}) }, status);
  const unconfigured = (c: Context) =>
    problem(
      c,
      503,
      'unconfigured',
      'Expunge domain service is not configured.',
      config.configured.missing,
    );
  const fail = (c: Context, error: unknown, route: string, id?: string) => {
    if (error instanceof ProjectionRejected) {
      logRejection({ route, jobId: id, issues: error.issues });
      return problem(
        c,
        502,
        'bad_response',
        'The domain service returned data the operator refused to forward.',
      );
    }
    if (error instanceof ExpungeDomainError) {
      switch (error.code) {
        case 'not_found':
          return problem(c, 404, 'not_found', 'Not found.');
        case 'conflict':
          return problem(
            c,
            409,
            'conflict',
            'The request conflicts with the committed state.',
          );
        case 'unsupported':
          return problem(
            c,
            501,
            'unsupported',
            'The domain service does not support this request.',
          );
        case 'invalid_request':
          return problem(
            c,
            400,
            'invalid_request',
            'The domain service rejected the request.',
          );
        case 'write_principal_missing':
          return problem(
            c,
            503,
            'write_principal_missing',
            'This action needs a server-side credential that is not configured.',
            error.missing,
          );
        case 'unreachable':
        case 'timeout':
        case 'tls_error':
          return problem(
            c,
            503,
            error.code,
            'Expunge domain service is unavailable.',
          );
        case 'unauthorized':
        case 'forbidden':
          return problem(
            c,
            502,
            error.code,
            'The domain service rejected this operator credential.',
          );
        default:
          return problem(
            c,
            502,
            error.code,
            'The domain service returned an error.',
          );
      }
    }
    if (error instanceof z.ZodError)
      return problem(c, 400, 'invalid_request', 'Invalid request.');
    logRejection({
      route,
      jobId: id,
      issues: [error instanceof Error ? error.name : 'unknown'],
    });
    return problem(c, 502, 'internal', 'Expunge request failed.');
  };
  const body = async (c: Context) =>
    c.req.json().catch(() => null) as Promise<unknown>;
  const guard =
    <T>(
      route: string,
      handler: (c: Context, domain: ExpungeDomainService) => Promise<T>,
      paramName?: string,
    ) =>
    async (c: Context) => {
      if (!domain) return unconfigured(c);
      try {
        return (await handler(c, domain)) as Response;
      } catch (error) {
        return fail(
          c,
          error,
          route,
          paramName ? param(c, paramName) : undefined,
        );
      }
    };
  const badId = (c: Context, value: string, pattern: RegExp, what: string) =>
    pattern.test(value)
      ? undefined
      : problem(c, 400, 'invalid_request', `Invalid ${what}.`);

  // Every route except readiness and status needs an owner token on the operator, reads included.
  routes.use('/expunge/*', async (c, next) => {
    const open =
      c.req.method === 'GET' &&
      /\/expunge\/(readiness|status)$/.test(c.req.path);
    if (!open && !access.ownerAuthenticated)
      return problem(
        c,
        401,
        'owner_auth_required',
        'Expunge needs the owner access token. Set OWNER_TOKEN on the operator, restart, and unlock with it.',
        ['OWNER_TOKEN'],
      );
    await next();
  });
  routes.get('/expunge/status', (c) =>
    c.json({
      // Derived from the actual configuration, not asserted: setup-only until the domain is configured.
      operator: config.configured.status === 'pass' ? 'ready' : 'setup_only',
      domain: domain ? 'configured' : 'unconfigured',
      authority:
        domain && config.configured.status === 'pass'
          ? 'mongodb'
          : 'unconfigured',
      telemetry: config.telemetry,
      ownerAuth: access.ownerAuthenticated ? 'configured' : 'missing',
      build: access.build ?? null,
    }),
  );
  routes.get('/expunge/readiness', async (c) => {
    try {
      return c.json(
        await readiness.get(c.req.query('fresh') === '1', c.req.raw.signal),
      );
    } catch (error) {
      return fail(c, error, 'readiness');
    }
  });
  routes.get(
    '/expunge/worlds',
    guard('worlds', async (c, d) =>
      c.json({ worlds: await d.listWorlds(c.req.raw.signal) }),
    ),
  );
  routes.post(
    '/expunge/previews',
    guard('previews', async (c, d) => {
      const parsed = previewRequestSchema.safeParse(await body(c));
      if (!parsed.success)
        return problem(c, 400, 'invalid_request', 'Invalid preview request.');
      return c.json(await d.previewCleanup(parsed.data, c.req.raw.signal));
    }),
  );
  routes.get(
    '/expunge/jobs',
    guard('jobs_list', async (c, d) => {
      const kind = c.req.query('kind');
      const status = c.req.query('status');
      const after = c.req.query('cursor');
      const limitText = c.req.query('limit');
      if (kind && !(JOB_KINDS as readonly string[]).includes(kind))
        return problem(c, 400, 'invalid_request', 'Invalid kind.');
      if (status && !(JOB_STATUSES as readonly string[]).includes(status))
        return problem(c, 400, 'invalid_request', 'Invalid status.');
      if (after && !cursor.test(after))
        return problem(c, 400, 'invalid_request', 'Invalid cursor.');
      if (limitText && !/^\d{1,3}$/.test(limitText))
        return problem(c, 400, 'invalid_request', 'Invalid limit.');
      return c.json(
        await d.listJobs(
          {
            kind,
            status,
            cursor: after,
            limit: limitText ? Number(limitText) : undefined,
          },
          c.req.raw.signal,
        ),
      );
    }),
  );
  routes.post(
    '/expunge/jobs',
    guard('jobs_submit', async (c, d) => {
      const parsed = submitRequestSchema.safeParse(await body(c));
      if (!parsed.success)
        return problem(c, 400, 'invalid_request', 'Invalid cleanup request.');
      return c.json(await d.submitCleanup(parsed.data, c.req.raw.signal), 202);
    }),
  );
  routes.get(
    '/expunge/jobs/:jobId',
    guard(
      'job',
      async (c, d) => {
        const bad = badId(c, param(c, 'jobId'), jobId, 'job ID');
        if (bad) return bad;
        const job = await d.readJob(param(c, 'jobId'), c.req.raw.signal);
        return job
          ? c.json(job)
          : problem(c, 404, 'not_found', 'Job not found.');
      },
      'jobId',
    ),
  );
  routes.get(
    '/expunge/jobs/:jobId/events',
    guard(
      'events',
      async (c, d) => {
        const id = param(c, 'jobId');
        const bad = badId(c, id, jobId, 'job ID');
        if (bad) return bad;
        const raw = c.req.query('afterSequence') ?? '0';
        if (!/^\d+$/.test(raw))
          return problem(c, 400, 'invalid_request', 'Invalid event cursor.');
        const parsed = z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .safeParse(Number(raw));
        if (!parsed.success)
          return problem(c, 400, 'invalid_request', 'Invalid event cursor.');
        const limitText = c.req.query('limit');
        if (limitText && !/^\d{1,3}$/.test(limitText))
          return problem(c, 400, 'invalid_request', 'Invalid limit.');
        return c.json(
          await d.readCommittedEvents(
            id,
            parsed.data,
            c.req.raw.signal,
            limitText ? Number(limitText) : undefined,
          ),
        );
      },
      'jobId',
    ),
  );
  routes.post(
    '/expunge/jobs/:jobId/cancel',
    guard(
      'cancel',
      async (c, d) => {
        const id = param(c, 'jobId');
        const bad = badId(c, id, jobId, 'job ID');
        if (bad) return bad;
        const parsed = cancelRequestSchema.safeParse((await body(c)) ?? {});
        if (!parsed.success)
          return problem(c, 400, 'invalid_request', 'Invalid cancel request.');
        return c.json(
          await d.cancelJob(id, parsed.data, c.req.raw.signal),
          202,
        );
      },
      'jobId',
    ),
  );
  routes.get(
    '/expunge/artifacts/:artifactId',
    guard('artifact', async (c, d) => {
      const id = param(c, 'artifactId');
      const bad = badId(c, id, looseId, 'artifact ID');
      if (bad) return bad;
      const after = c.req.query('cursor');
      if (after && !cursor.test(after))
        return problem(c, 400, 'invalid_request', 'Invalid cursor.');
      const artifact = await d.readArtifact(
        id,
        { cursor: after },
        c.req.raw.signal,
      );
      return artifact
        ? c.json(artifact)
        : problem(c, 404, 'not_found', 'Artifact not found.');
    }),
  );
  routes.get(
    '/expunge/proposals/:proposalId',
    guard('proposal', async (c, d) => {
      const id = param(c, 'proposalId');
      const bad = badId(c, id, looseId, 'proposal ID');
      if (bad) return bad;
      const view = await d.readApproval(id, c.req.raw.signal);
      return view
        ? c.json(view)
        : problem(c, 404, 'not_found', 'Proposal not found.');
    }),
  );
  routes.post(
    '/expunge/proposals/:proposalId/decision',
    guard('decision', async (c, d) => {
      const id = param(c, 'proposalId');
      const bad = badId(c, id, looseId, 'proposal ID');
      if (bad) return bad;
      const parsed = decisionRequestSchema.safeParse(await body(c));
      if (!parsed.success)
        return problem(c, 400, 'invalid_request', 'Invalid decision request.');
      return c.json(await d.decideApproval(id, parsed.data, c.req.raw.signal));
    }),
  );
  routes.get(
    '/expunge/deployments/:target',
    guard('deployment', async (c, d) => {
      const target = param(c, 'target');
      if (!(TARGET_KINDS as readonly string[]).includes(target))
        return problem(c, 400, 'invalid_request', 'Invalid target.');
      const view = await d.readDeployment(
        target as TargetKind,
        c.req.raw.signal,
      );
      return view
        ? c.json(view)
        : problem(c, 404, 'not_found', 'No deployment for this target.');
    }),
  );
  return routes;
}
