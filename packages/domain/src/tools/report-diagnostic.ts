import { z } from 'zod';
import { contentHash } from '@expunge/contracts';
import type { ToolRuntime } from '../runtime.js';
import { keyText } from '../values.js';

export const DIAGNOSTIC_CATEGORIES = [
  'scope_gap',
  'schema_surprise',
  'tool_error',
  'budget',
  'other',
] as const;
export const reportDiagnosticInput = z
  .object({
    category: z.enum(DIAGNOSTIC_CATEGORIES),
    message: z.string().min(1).max(500),
  })
  .strict();
export type ReportDiagnosticInput = z.infer<typeof reportDiagnosticInput>;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Removes the subject's identity from free text before it is stored: control characters, then every identity value
 * (and the local part of an e-mail address), matched without regard to case and after Unicode compatibility folding,
 * so "A.B@X.TEST" does not survive because the stored value is "a.b@x.test".
 */
export function sanitizeDiagnostic(message: string, secrets: Iterable<string>): string {
  let out = [...message.normalize('NFKC')]
    .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? ' ' : char))
    .join('');
  const needles = new Set<string>();
  for (const secret of secrets) {
    const folded = secret.normalize('NFKC');
    if (folded.length >= 3) needles.add(folded);
    const at = folded.indexOf('@');
    if (at >= 3) needles.add(folded.slice(0, at));
  }
  for (const needle of [...needles].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(escapeRegex(needle), 'gi'), '[binding]');
  return out.slice(0, 500);
}

/**
 * Records the run's own account of a problem. It is labeled `agent_self_report`: a claim, never evidence, and it
 * changes nothing in the world. The row reserves the operation id under which the observability adapter will enqueue
 * its remote report; this tool does not enqueue it (see the domain README for why).
 */
export async function reportDiagnostic(rt: ToolRuntime, input: ReportDiagnosticInput) {
  const subject = await rt.store.getSubject(rt.actor, rt.job._id).catch(() => null);
  const resolution = await rt.store.latestStep(rt.actor, rt.job._id, 'subject_resolution');
  const secrets = new Set<string>(resolution ? resolution.payload.identityBindings.map(keyText) : []);
  if (subject) secrets.add(subject.value);
  const message = sanitizeDiagnostic(input.message, secrets);
  const outboxOperationId = contentHash(
    { kind: 'agent_diagnostic', jobId: rt.job._id, runId: rt.run.runId, category: input.category, message },
    'diagnostic-operation',
  );
  const row = await rt.store.putDiagnostic({
    tenantId: rt.actor.tenantId,
    env: rt.actor.env,
    scopeId: rt.actor.scopeId,
    jobId: rt.job._id,
    runId: rt.run.runId,
    origin: 'agent_self_report',
    category: input.category,
    message,
    outboxOperationId,
  });
  return { recorded: true as const, diagnosticId: row._id, origin: row.origin };
}
