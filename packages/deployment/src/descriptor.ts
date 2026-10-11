import {
  contentHash,
  type ActorContext,
  type DeploymentKey,
  type JsonValue,
  type MutationClass,
  type ScopeKey,
} from '@expunge/contracts';
import { deriveFlipSetDigest } from '@expunge/mongo';
import { classifyMutation, parsePatchPath, readUnit, type ClassComponent } from '@expunge/harness-compiler';
import {
  AuthorityRepository,
  DeploymentRepository,
  fail,
  scopeFilter,
  type MongoService,
} from '@expunge/mongo';
import { loadAdmittedReport, type AdmittedReport } from './report.js';

export type FlipChange = 'added' | 'widened' | 'removed' | 'tightened';
export type ApprovalDescriptor = {
  proposalId: string;
  target: DeploymentKey['target'];
  parentHash: string;
  childHash: string;
  expectedParentRevision: number;
  computedClass: MutationClass;
  flipSet: Array<{ capability: string; change: FlipChange }>;
  flipSetDigest: string;
  scope: { scopeId: string; scopeRevision: number; authorizationRevision: number };
  gateReportId: string;
  gateReportDigest: string;
  consequences: string[];
  /** Every changed unit, not only the authority flips: what it was, what it becomes, and how the classifier read it. */
  changes: Array<{ unit: string; kind: MutationClass; reason: string; before: JsonValue; after: JsonValue }>;
  /** The figures the gate decided on, copied from the stored report. */
  gateSummary: JsonValue;
  /** The digest a client must echo. Everything above is hashed; nothing in a request can change it. */
  descriptorDigest: string;
};

/**
 * How a classified component changed what the worker may do. An authority expansion is only ever `added` (a new grant)
 * or `widened`: "restrictive rule removed" and "prerequisite removed" are widenings of authority, not reductions, and
 * must not read as one. `removed` and `tightened` describe non-expanding components only.
 */
export const changeOf = (component: ClassComponent): FlipChange => {
  if (component.kind === 'authority_expansion')
    return /grant added/.test(component.reason) ? 'added' : 'widened';
  if (/removed/.test(component.reason)) return 'removed';
  if (/more restrictive|lowered|now requires|restrictive rule added/.test(component.reason))
    return 'tightened';
  return 'added';
};

/** Plain-language lines for the human, derived from the classified components, not from anything a proposer wrote. */
function consequencesOf(components: readonly ClassComponent[], computedClass: MutationClass): string[] {
  const lines = components
    .filter((component) => component.kind === 'authority_expansion')
    .map((component) => `Expands authority: ${component.unit} (${component.reason}).`);
  if (!lines.length)
    lines.push(
      computedClass === 'tightening'
        ? 'Only restricts what the worker may do.'
        : 'Changes how the worker runs; grants it no new authority.',
    );
  lines.push('Replaces the active worker harness for this scope. A rollback is a separate audited move.');
  return lines;
}

/**
 * The descriptor a human approves, rendered entirely from stored rows: the admitted report (re-derived by
 * `loadAdmittedReport`), the two stored bundles and the deployment pointer. The client gets this and answers with
 * `{descriptorDigest, decision}` only; the digest is recomputed from storage when the answer arrives, so a descriptor
 * that has gone stale (pointer moved, authority revision bumped, report changed) no longer matches.
 */
export async function renderDescriptor(
  service: MongoService,
  request: {
    reportId: string;
    parentHash: string;
    childHash: string;
    target: DeploymentKey['target'];
    actor: ActorContext;
  },
): Promise<{ descriptor: ApprovalDescriptor; admitted: AdmittedReport; pointerRevision: number }> {
  const scope: ScopeKey = scopeFilter(request.actor);
  const admitted = await loadAdmittedReport(service, {
    reportId: request.reportId,
    parentHash: request.parentHash,
    childHash: request.childHash,
    scope,
  });
  const pointer = await new DeploymentRepository(service).read({ ...scope, target: request.target });
  if (!pointer) fail('DeploymentMissing');
  // The transition is parent -> child, so the pointer must still be at the tested parent.
  if (pointer.activeHash !== request.parentHash) fail('StaleParent');
  const authority = await new AuthorityRepository(service).read(scope);
  const components = classifyMutation(admitted.parent, admitted.child).components;
  const flipSet = components
    .filter((component) => component.kind === 'authority_expansion')
    .map((component) => ({ capability: component.unit, change: changeOf(component) }));
  const body = {
    proposalId: admitted.report.candidateId,
    target: request.target,
    parentHash: request.parentHash,
    childHash: request.childHash,
    expectedParentRevision: pointer.revision,
    computedClass: admitted.computedClass,
    flipSet,
    flipSetDigest: deriveFlipSetDigest(admitted.flips),
    scope: {
      scopeId: scope.scopeId,
      scopeRevision: pointer.scopeRevision,
      authorizationRevision: authority.authorizationRevision,
    },
    gateReportId: admitted.report.reportId,
    gateReportDigest: admitted.digest,
    consequences: consequencesOf(components, admitted.computedClass),
    changes: components.map((component) => {
      const target = parsePatchPath(component.unit);
      // A unit the patch grammar cannot name cannot be shown to a human: refuse rather than approve what is not displayed.
      if (!target) fail('UnreadableChange');
      return {
        unit: component.unit,
        kind: component.kind,
        reason: component.reason,
        before: readUnit(admitted.parent, target),
        after: readUnit(admitted.child, target),
      };
    }),
    gateSummary: ((admitted.report.causalControls as { decisionSummary?: JsonValue } | null)
      ?.decisionSummary ?? null) as JsonValue,
  };
  const descriptor: ApprovalDescriptor = {
    ...body,
    descriptorDigest: contentHash(body, 'approval-descriptor'),
  };
  return { descriptor, admitted, pointerRevision: pointer.revision };
}
