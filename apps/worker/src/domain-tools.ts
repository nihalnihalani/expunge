import { WORKER_TOOL_IDS, type ToolProvider } from '@expunge/runtime';

export type DomainTools = { provider: ToolProvider; available: boolean; missing: readonly string[] };

/**
 * PARTIAL (flagged): the typed job-bound tools named in OWNERSHIP.md frozen interface 6 (inspect_scope ...
 * report_diagnostic) belong to the domain gateway (packages/domain / packages/governance), which does not
 * exist yet. Until it does, this provider offers NO tools and the worker reports `BLOCKED: domain tools`
 * in its readiness output instead of claiming jobs it cannot complete.
 */
export function loadDomainTools(): DomainTools {
  return { provider: { create: () => [] }, available: false, missing: WORKER_TOOL_IDS };
}
