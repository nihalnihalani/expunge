import { createDomainEnv, createDomainToolProvider, type DomainReport } from '@expunge/domain';
import { DEFAULT_AUTHORITY_FLOOR, type AuthorityFloor } from '@expunge/governance';
import type { MongoService } from '@expunge/mongo';
import { errorCode, type ToolProvider } from '@expunge/runtime';
import type { LogEntry } from './dispatch.js';

export type DomainToolWiring = { provider: ToolProvider; available: true; missing: readonly [] };

/**
 * The worker's real tool provider: the nine typed, job-bound tools of the domain gateway (`@expunge/domain`), built on
 * the worker's own `domain_executor` client. The gateway refuses any other principal at construction.
 *
 * `floors` are the owner floors this process knows by hash; a run whose bundle names another floor cannot start (the
 * runtime reports the tools as unavailable, it does not fall back). There is no default beyond the shipped floor.
 * Operational reports from the gateway are logged by class name and code only, never as Error objects.
 */
export function createDomainToolWiring(
  service: MongoService,
  options: { floors?: readonly AuthorityFloor[]; log?: (entry: LogEntry) => void } = {},
): DomainToolWiring {
  const report = (event: DomainReport) => {
    if (!options.log) return;
    if (event.kind === 'projection_failed')
      options.log({
        level: 'warn',
        message: `gateway projection failed: ${event.eventKind}`,
        code: errorCode(event.error),
      });
    else if (event.kind === 'tool_failed')
      options.log({
        level: 'warn',
        message: `gateway tool failed: ${event.toolId}`,
        code: errorCode(event.error),
      });
    else
      options.log({
        level: 'warn',
        message: 'job cancelled for authority change',
        jobId: event.jobId,
        code: event.code,
      });
  };
  const env = createDomainEnv(service, { floors: options.floors ?? [DEFAULT_AUTHORITY_FLOOR], report });
  return { provider: createDomainToolProvider(env), available: true, missing: [] };
}
