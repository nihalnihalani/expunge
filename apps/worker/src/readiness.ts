import { PRINCIPAL_URI_VARIABLES } from '@expunge/mongo';
import { providerReadiness } from '@expunge/runtime';

export type Blocker = {
  code:
    | 'provider credentials'
    | 'model configuration'
    | 'database credentials'
    | 'wake token'
    | 'scope binding'
    | 'domain tools';
  detail: string;
};

export type Readiness = {
  status: 'READY' | 'BLOCKED';
  blockers: Blocker[];
  /** Human-readable lines, e.g. "BLOCKED: provider credentials (Set OPENAI_API_KEY.)". No secret values. */
  lines: string[];
  /**
   * What was actually checked. `configured` means the variable is present and well formed. Nothing here
   * asserts that Atlas or the provider is reachable or authorized; that needs a live probe.
   */
  checks: Record<'provider' | 'database' | 'wakeToken' | 'scope' | 'domainTools', 'configured' | 'blocked'>;
  reachability: 'not_checked';
};

export const MIN_WAKE_TOKEN_LENGTH = 32;

export function checkReadiness(
  env: Readonly<Record<string, string | undefined>>,
  options: { domainToolsAvailable: boolean },
): Readiness {
  const blockers: Blocker[] = [];
  const provider = providerReadiness(env);
  if (!provider.ready)
    for (const item of provider.blockers) blockers.push({ code: item.blocker, detail: item.detail });
  const databaseVariable = PRINCIPAL_URI_VARIABLES.domain_executor;
  if (!env[databaseVariable]?.trim())
    blockers.push({
      code: 'database credentials',
      detail: `Set ${databaseVariable} (the worker uses the domain_executor principal only; no fallback to setup credentials).`,
    });
  const wake = env.EXPUNGE_WAKE_TOKEN ?? '';
  if (wake.length < MIN_WAKE_TOKEN_LENGTH)
    blockers.push({
      code: 'wake token',
      detail: `Set EXPUNGE_WAKE_TOKEN to at least ${MIN_WAKE_TOKEN_LENGTH} characters (operator to worker wake commands only).`,
    });
  if (!env.EXPUNGE_TENANT_ID?.trim() || !env.EXPUNGE_ENV?.trim() || !env.EXPUNGE_SCOPE_ID?.trim())
    blockers.push({
      code: 'scope binding',
      detail:
        'Set EXPUNGE_TENANT_ID, EXPUNGE_ENV and EXPUNGE_SCOPE_ID: the worker serves one scope, polls only that scope for crashed-worker recovery and refuses jobs outside it.',
    });
  if (!options.domainToolsAvailable)
    blockers.push({
      code: 'domain tools',
      detail:
        'The typed job-bound tools (inspect_scope ... report_diagnostic) are not integrated yet; the worker will not claim jobs it cannot complete.',
    });
  const blocked = (code: Blocker['code'][]) =>
    blockers.some((b) => code.includes(b.code)) ? 'blocked' : 'configured';
  const lines = blockers.length
    ? blockers.map((blocker) => `BLOCKED: ${blocker.code} (${blocker.detail})`)
    : ['READY: configuration present. Reachability of Atlas and the provider is not checked here.'];
  return {
    status: blockers.length ? 'BLOCKED' : 'READY',
    blockers,
    lines,
    checks: {
      provider: blocked(['provider credentials', 'model configuration']),
      database: blocked(['database credentials']),
      wakeToken: blocked(['wake token']),
      scope: blocked(['scope binding']),
      domainTools: blocked(['domain tools']),
    },
    reachability: 'not_checked',
  };
}
