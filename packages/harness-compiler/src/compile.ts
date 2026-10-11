// The trusted compiler: a candidate HarnessBundle (plus its parent and patches) in, a compiled artifact or a typed
// rejection out. It runs no model, reads no database and trusts no field of the candidate that it can re-derive.
import {
  GUARDRAIL_MAX_DEPTH,
  contentHash,
  validateHarnessBundle,
  type EvidenceBundle,
  type EvidenceReference,
  type GuardrailAst,
  type HarnessBundle,
  type MutationClass,
  type SourceOrigin,
  type TypedPatch,
} from '@expunge/contracts';
import { classifyMutation, type ClassComponent } from './classify.js';
import type { DecisionLedgerRow } from './decisions.js';
import { compileGuardrails, validateGuardrails, type CompiledRule } from './guardrails.js';
import { COMPILER_HASH, VOCABULARY_HASH } from './hashes.js';
import { REJECTION_CODES, issue, type Issue, type RejectionCode } from './issues.js';
import { scanForShortcuts, type ForbiddenLiterals, type PublicRegistry } from './literals.js';
import { compileDecisionExpression, type MongoExpression } from './mongo.js';
import { findNoOpRules } from './noop.js';
import { changedUnits, verifyPatches } from './patches.js';
import { validatePlugins, type PluginPolicy } from './plugins.js';
import { validateContext, validateLimits, validateToolPolicy, type OwnerFloor } from './policy.js';
import { walkPredicate } from './semantics.js';
import { analyzeWorkflow, type WorkflowPlan } from './workflow.js';
import { MAX_EDITS } from './vocabulary.js';

export interface EvidenceCatalogEntry {
  permittedUse: EvidenceReference['permittedUse'];
  origin: SourceOrigin;
  split: EvidenceBundle['split'];
}
export type EvidenceCatalog = ReadonlyMap<string, EvidenceCatalogEntry>;

/** Every identifier a patch may legitimately cite, mapped to what the evidence may be used for. */
export function buildEvidenceCatalog(bundles: readonly EvidenceBundle[]): EvidenceCatalog {
  const catalog = new Map<string, EvidenceCatalogEntry>();
  for (const bundle of bundles) {
    catalog.set(bundle.evidenceId, {
      permittedUse: 'training',
      origin: 'verifier_feedback',
      split: bundle.split,
    });
    for (const source of bundle.sources) {
      const ids = [
        source.externalEventId,
        source.externalTraceId,
        ...source.externalSignalIds,
        ...source.localSourceIds,
      ];
      for (const id of ids)
        if (id)
          catalog.set(id, { permittedUse: source.permittedUse, origin: source.origin, split: bundle.split });
    }
  }
  return catalog;
}

export interface CompileContext {
  expected: {
    runtimeAdapterHash: string;
    eligibilityPolicyHash: string;
    sourceEligibilityPolicyHash: string;
  };
  floor: OwnerFloor;
  registry: PublicRegistry;
  forbidden: ForbiddenLiterals;
  evidence?: EvidenceCatalog;
  replayCorpus?: readonly DecisionLedgerRow[];
  plugins?: PluginPolicy;
  /** The caller acknowledges that an authority expansion is intended and will be routed to a bound human grant. */
  allowAuthorityExpansion?: boolean;
  maxEdits?: number;
}
export interface CompileInput {
  candidate: HarnessBundle;
  /** Null when compiling a root bundle (W0, expert-static). */
  parent: HarnessBundle | null;
  patches?: readonly TypedPatch[];
  /** What the proposer said the class is. Recorded, never trusted. */
  claimedClass?: MutationClass;
}

export interface Diagnostic {
  code: string;
  message: string;
}
export interface CompiledArtifact {
  bundleHash: string;
  parentHash: string | null;
  compiledPredicates: CompiledRule[];
  decisionExpression: { result: MongoExpression; ruleIds: MongoExpression };
  workflowPlan: WorkflowPlan;
  toolGrants: string[];
  /** Computed by the compiler; null for a root bundle with no parent. */
  mutationClass: MutationClass | null;
  claimedClass: MutationClass | null;
  classComponents: ClassComponent[];
  /** The child widens authority: promotion needs a bound human grant. */
  requiresGrant: boolean;
  editedUnits: string[];
  diagnostics: Diagnostic[];
  compilerHash: string;
  vocabularyHash: string;
}
export interface Rejection {
  /** Phase that stopped compilation. */
  phase: 'schema' | 'infrastructure' | 'edits' | 'shortcuts' | 'structure' | 'classification' | 'standing';
  primary: RejectionCode;
  codes: RejectionCode[];
  issues: Issue[];
}
export type CompileResult = { ok: true; artifact: CompiledArtifact } | { ok: false; rejection: Rejection };

function reject(phase: Rejection['phase'], issues: Issue[]): CompileResult {
  const codes = [...new Set(issues.map((entry) => entry.code))];
  return { ok: false, rejection: { phase, primary: issues[0]!.code, codes, issues } };
}

/** Schema validation as issues: only vocabulary names and indexes reach a path, never the offending value. */
function schemaIssues(bundle: unknown, label: string): Issue[] {
  try {
    validateHarnessBundle(bundle);
    return [];
  } catch (error) {
    const named = error as {
      name?: string;
      message?: string;
      issues?: Array<{ path: Array<string | number> }>;
    };
    if (named.name === 'ZodError' && Array.isArray(named.issues)) {
      return named.issues
        .slice(0, 20)
        .map((entry) =>
          issue(
            'schema_invalid',
            `${label}.${entry.path.map(String).join('.')}`,
            'value does not match the bundle schema',
          ),
        );
    }
    if (named.message === 'GuardrailBounds') {
      // The contract reports one error for both bounds; measure to say which.
      let nodes = 0;
      let deepest = 0;
      for (const rule of (bundle as HarnessBundle).guardrails) {
        walkPredicate(rule.predicate, (_node, depth) => {
          nodes++;
          deepest = Math.max(deepest, depth);
        });
      }
      return [
        deepest > GUARDRAIL_MAX_DEPTH
          ? issue('guardrail_depth', `${label}.guardrails`, 'a predicate is nested too deeply')
          : issue(
              'guardrail_nodes',
              `${label}.guardrails`,
              `guardrails have too many predicate nodes (${nodes})`,
            ),
      ];
    }
    if (named.message === 'InvalidWorkflowReferences')
      return [
        issue(
          'workflow_reference_invalid',
          `${label}.workflow`,
          'entry, terminal or edge names a missing node',
        ),
      ];
    return [issue('schema_invalid', label, 'bundle could not be validated')];
  }
}

function infrastructureIssues(
  candidate: HarnessBundle,
  parent: HarnessBundle | null,
  context: CompileContext,
): Issue[] {
  const issues: Issue[] = [];
  const expect = (field: keyof HarnessBundle, expected: string) => {
    if (candidate[field] !== expected)
      issues.push(
        issue('infrastructure_hash_mismatch', field, 'bundle is bound to different infrastructure'),
      );
  };
  expect('compilerHash', COMPILER_HASH);
  expect('vocabularyHash', VOCABULARY_HASH);
  expect('authorityFloorHash', context.floor.hash);
  expect('runtimeAdapterHash', context.expected.runtimeAdapterHash);
  expect('eligibilityPolicyHash', context.expected.eligibilityPolicyHash);
  if (candidate.contextPolicy.sourceEligibilityPolicyHash !== context.expected.sourceEligibilityPolicyHash) {
    issues.push(
      issue(
        'infrastructure_hash_mismatch',
        'contextPolicy.sourceEligibilityPolicyHash',
        'bundle is bound to a different source eligibility policy',
      ),
    );
  }
  const expectedParent = parent ? contentHash(parent) : null;
  if (candidate.parentHash !== expectedParent)
    issues.push(
      issue('parent_hash_mismatch', 'parentHash', 'parentHash is not the hash of the parent bundle'),
    );
  return issues;
}

function mentions(reference: EvidenceReference, id: string): boolean {
  return (
    reference.externalEventId === id ||
    reference.externalTraceId === id ||
    reference.externalSignalIds.includes(id) ||
    reference.localSourceIds.includes(id)
  );
}
function evidenceIssues(
  candidate: HarnessBundle,
  patches: readonly TypedPatch[],
  context: CompileContext,
): Issue[] {
  const issues: Issue[] = [];
  const check = (ids: readonly string[], where: string, requireInBundle: boolean) => {
    if (!ids.length) {
      issues.push(issue('evidence_missing', where, 'an edit needs at least one evidence reference'));
      return;
    }
    for (const id of ids) {
      const entry = context.evidence?.get(id);
      if (!entry)
        issues.push(
          issue('evidence_not_found', where, 'cited evidence does not exist among the permitted bundles'),
        );
      else if (entry.permittedUse !== 'training' || entry.split !== 'train')
        issues.push(
          issue('evidence_not_permitted', where, 'cited evidence is not permitted training evidence'),
        );
      else if (requireInBundle && !candidate.evidence.some((reference) => mentions(reference, id))) {
        issues.push(
          issue(
            'evidence_not_in_bundle',
            where,
            'cited evidence is not recorded in the bundle evidence list',
          ),
        );
      }
    }
  };
  patches.forEach((patch, index) => {
    const where = `patches[${index}]`;
    if (patch.hypothesis.trim().length < 10)
      issues.push(issue('hypothesis_missing', `${where}.hypothesis`, 'an edit needs a stated hypothesis'));
    check(patch.sourceEvidenceIds, `${where}.sourceEvidenceIds`, true);
  });
  return issues;
}

function changedRules(parent: HarnessBundle, candidate: HarnessBundle): GuardrailAst[] {
  return changedUnits(parent, candidate)
    .filter((unit) => unit.startsWith('guardrails.'))
    .map((unit) => candidate.guardrails.find((rule) => rule.ruleId === unit.slice('guardrails.'.length)))
    .filter((rule): rule is GuardrailAst => rule !== undefined);
}

export function compileHarness(input: CompileInput, context: CompileContext): CompileResult {
  const { candidate, parent } = input;
  const patches = input.patches ?? [];

  const schema = [...schemaIssues(candidate, 'bundle'), ...(parent ? schemaIssues(parent, 'parent') : [])];
  if (schema.length) return reject('schema', schema);

  const infrastructure = infrastructureIssues(candidate, parent, context);
  if (infrastructure.length) return reject('infrastructure', infrastructure);

  if (parent) {
    const edits = [
      ...verifyPatches(parent, candidate, patches, context.maxEdits ?? MAX_EDITS),
      ...evidenceIssues(candidate, patches, context),
    ];
    if (edits.length) return reject('edits', edits);
  } else if (patches.length) {
    return reject('edits', [issue('patch_path_invalid', 'patches', 'a root bundle has no parent to patch')]);
  }

  const shortcuts = scanForShortcuts(candidate, patches, context.forbidden, context.registry);
  if (shortcuts.length) return reject('shortcuts', shortcuts);

  const guardrailIssues = validateGuardrails(candidate.guardrails);
  const { issues: workflowIssues, plan } = analyzeWorkflow(
    candidate.workflow,
    candidate.toolPolicy,
    candidate.limits,
  );
  const structure = [
    ...guardrailIssues,
    ...workflowIssues,
    ...validateToolPolicy(candidate.toolPolicy, candidate.workflow, context.floor),
    ...validateLimits(candidate.limits, context.floor),
    ...validateContext(candidate.contextPolicy, candidate.limits),
    ...validatePlugins(candidate.pluginArtifacts, context.plugins),
  ];
  if (structure.length || !plan)
    return reject(
      'structure',
      structure.length ? structure : [issue('schema_invalid', 'workflow', 'workflow plan unavailable')],
    );

  let mutationClass: MutationClass | null = null;
  let classComponents: ClassComponent[] = [];
  const diagnostics: Diagnostic[] = [];
  if (parent) {
    ({ mutationClass, components: classComponents } = classifyMutation(parent, candidate));
    if (input.claimedClass && input.claimedClass !== mutationClass) {
      diagnostics.push({
        code: 'claimed_class_mismatch',
        message: `claimed ${input.claimedClass}, computed ${mutationClass}`,
      });
    }
    if (mutationClass === 'authority_expansion' && !context.allowAuthorityExpansion) {
      return reject('classification', [
        issue(
          'authority_expansion_unflagged',
          'bundle',
          'the candidate widens authority but was not flagged for a grant',
        ),
      ]);
    }
    const rules = changedRules(parent, candidate);
    if (rules.length) {
      const standing: Issue[] = [];
      for (const rule of rules) {
        const ids = rule.sourceEvidenceIds;
        if (!ids.length)
          standing.push(
            issue('evidence_missing', `guardrails.${rule.ruleId}.sourceEvidenceIds`, 'a rule needs evidence'),
          );
        for (const id of ids) {
          if (!context.evidence?.has(id))
            standing.push(
              issue(
                'evidence_not_found',
                `guardrails.${rule.ruleId}.sourceEvidenceIds`,
                'cited evidence does not exist among the permitted bundles',
              ),
            );
        }
      }
      if (!context.replayCorpus?.length)
        standing.push(
          issue(
            'replay_corpus_missing',
            'replayCorpus',
            'changed rules cannot be shown to matter without a replay corpus',
          ),
        );
      else {
        for (const ruleId of findNoOpRules(
          candidate.guardrails,
          rules.map((rule) => rule.ruleId),
          context.replayCorpus,
        )) {
          standing.push(
            issue('no_op_rule', `guardrails.${ruleId}`, 'removing the rule changes no replayed decision'),
          );
        }
      }
      if (standing.length) return reject('standing', standing);
    }
  }

  return {
    ok: true,
    artifact: {
      bundleHash: contentHash(candidate),
      parentHash: candidate.parentHash,
      compiledPredicates: compileGuardrails(candidate.guardrails),
      decisionExpression: compileDecisionExpression(candidate.guardrails),
      workflowPlan: plan,
      toolGrants: [...candidate.toolPolicy.grants],
      mutationClass,
      claimedClass: input.claimedClass ?? null,
      classComponents,
      requiresGrant: mutationClass === 'authority_expansion',
      editedUnits: parent ? changedUnits(parent, candidate) : [],
      diagnostics,
      compilerHash: COMPILER_HASH,
      vocabularyHash: VOCABULARY_HASH,
    },
  };
}

export { REJECTION_CODES };
