// Edit units. A candidate is its parent plus at most three typed patches; each patch replaces one unit of one of the
// four surfaces (or the plugin slot) and carries its own hypothesis and evidence. The compiler re-derives the child
// from the parent and the patches and refuses any difference, so a helpful edit cannot carry unrelated changes.
import {
  canonicalJson,
  type GuardrailAst,
  type HarnessBundle,
  type JsonValue,
  type TypedPatch,
} from '@expunge/contracts';
import { PATCH_PATH_TABLE } from './vocabulary.js';
import { issue, type Issue } from './issues.js';

const CONTEXT_FIELDS = [
  'schemaMode',
  'includeNestedArrays',
  'referenceDepth',
  'lessonRecall',
  'maxContextTokens',
  'evidenceFormat',
] as const;
const LIMIT_KEYS = [
  'modelCalls',
  'toolCalls',
  'scannedDocuments',
  'changedDocuments',
  'traversalDepth',
  'graphNodes',
  'graphEdges',
  'wallTimeMs',
  'totalTokens',
  'maxCostMicrousd',
] as const;

export type PatchTarget =
  | { surface: 'context'; field: (typeof CONTEXT_FIELDS)[number] }
  | { surface: 'workflow'; field: 'workflow' | 'completionPolicy' }
  | { surface: 'guardrails'; ruleId: string }
  | {
      surface: 'tool_policy';
      field: 'grants' | 'prerequisites' | 'limit';
      limitKey?: (typeof LIMIT_KEYS)[number];
    }
  | { surface: 'plugin' };

/** Maps a patch path to the unit it edits; null when the path is not one the vocabulary admits. */
export function parsePatchPath(path: string): PatchTarget | null {
  const [head, key, ...rest] = path.split('.');
  if (rest.length) return null;
  if (head === 'contextPolicy' && key && (CONTEXT_FIELDS as readonly string[]).includes(key)) {
    return { surface: 'context', field: key as (typeof CONTEXT_FIELDS)[number] };
  }
  if (path === 'workflow' || path === 'completionPolicy') return { surface: 'workflow', field: path };
  if (head === 'guardrails' && key) return { surface: 'guardrails', ruleId: key };
  if (path === 'toolPolicy.grants') return { surface: 'tool_policy', field: 'grants' };
  if (path === 'toolPolicy.prerequisites') return { surface: 'tool_policy', field: 'prerequisites' };
  if (head === 'limits' && key && (LIMIT_KEYS as readonly string[]).includes(key)) {
    return { surface: 'tool_policy', field: 'limit', limitKey: key as (typeof LIMIT_KEYS)[number] };
  }
  if (path === 'pluginArtifacts') return { surface: 'plugin' };
  return null;
}

/** The disclosed path table, for tests and prompts. */
export const DISCLOSED_PATCH_PATHS = PATCH_PATH_TABLE;

export function readUnit(bundle: HarnessBundle, target: PatchTarget): JsonValue {
  switch (target.surface) {
    case 'context':
      return bundle.contextPolicy[target.field] as JsonValue;
    case 'workflow':
      return (target.field === 'workflow' ? bundle.workflow : bundle.completionPolicy) as JsonValue;
    case 'guardrails':
      return (bundle.guardrails.find((rule) => rule.ruleId === target.ruleId) ?? null) as JsonValue;
    case 'tool_policy':
      if (target.field === 'grants') return bundle.toolPolicy.grants;
      if (target.field === 'prerequisites') return bundle.toolPolicy.prerequisites as JsonValue;
      return bundle.limits[target.limitKey!];
    case 'plugin':
      return bundle.pluginArtifacts as JsonValue;
  }
}

function writeUnit(bundle: HarnessBundle, target: PatchTarget, value: JsonValue): void {
  switch (target.surface) {
    case 'context':
      (bundle.contextPolicy as Record<string, unknown>)[target.field] = value;
      return;
    case 'workflow':
      (bundle as unknown as Record<string, unknown>)[target.field] = value;
      return;
    case 'guardrails': {
      const rest = bundle.guardrails.filter((rule) => rule.ruleId !== target.ruleId);
      bundle.guardrails = value === null ? rest : [...rest, value as unknown as GuardrailAst];
      return;
    }
    case 'tool_policy':
      if (target.field === 'grants') bundle.toolPolicy.grants = value as string[];
      else if (target.field === 'prerequisites')
        bundle.toolPolicy.prerequisites = value as HarnessBundle['toolPolicy']['prerequisites'];
      else (bundle.limits as Record<string, unknown>)[target.limitKey!] = value;
      return;
    case 'plugin':
      bundle.pluginArtifacts = value as HarnessBundle['pluginArtifacts'];
  }
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** The child a set of patches describes. Only the patched units change; `parentHash` and `evidence` are the caller's. */
export function applyPatches(parent: HarnessBundle, patches: readonly TypedPatch[]): HarnessBundle {
  const child = structuredClone(parent);
  for (const patch of patches) {
    const target = parsePatchPath(patch.path);
    if (!target) throw new Error('PatchPathInvalid');
    writeUnit(child, target, patch.after);
  }
  return child;
}

/** Every editable unit whose value differs between two bundles, as patch paths. */
export function changedUnits(parent: HarnessBundle, child: HarnessBundle): string[] {
  const changed: string[] = [];
  for (const field of CONTEXT_FIELDS) {
    if (!same(parent.contextPolicy[field], child.contextPolicy[field]))
      changed.push(`contextPolicy.${field}`);
  }
  if (!same(parent.workflow, child.workflow)) changed.push('workflow');
  if (parent.completionPolicy !== child.completionPolicy) changed.push('completionPolicy');
  const ruleIds = new Set([...parent.guardrails, ...child.guardrails].map((rule) => rule.ruleId));
  for (const ruleId of [...ruleIds].sort()) {
    const before = parent.guardrails.find((rule) => rule.ruleId === ruleId);
    const after = child.guardrails.find((rule) => rule.ruleId === ruleId);
    if (!same(before, after)) changed.push(`guardrails.${ruleId}`);
  }
  if (!same(parent.toolPolicy.grants, child.toolPolicy.grants)) changed.push('toolPolicy.grants');
  if (!same(parent.toolPolicy.prerequisites, child.toolPolicy.prerequisites))
    changed.push('toolPolicy.prerequisites');
  for (const key of LIMIT_KEYS) if (parent.limits[key] !== child.limits[key]) changed.push(`limits.${key}`);
  if (!same(parent.pluginArtifacts, child.pluginArtifacts)) changed.push('pluginArtifacts');
  return changed;
}

/** Fields no patch may touch: identity, infrastructure bindings and the append-only evidence list. */
export function immutableChanges(parent: HarnessBundle, child: HarnessBundle): string[] {
  const changed: string[] = [];
  if (parent.target !== child.target) changed.push('target');
  if (parent.contractVersion !== child.contractVersion) changed.push('contractVersion');
  if (parent.contextPolicy.sourceEligibilityPolicyHash !== child.contextPolicy.sourceEligibilityPolicyHash) {
    changed.push('contextPolicy.sourceEligibilityPolicyHash');
  }
  for (const field of [
    'runtimeAdapterHash',
    'compilerHash',
    'vocabularyHash',
    'authorityFloorHash',
    'eligibilityPolicyHash',
  ] as const) {
    if (parent[field] !== child[field]) changed.push(field);
  }
  // Evidence is append-only: the parent's references stay, in order, as a prefix.
  if (
    child.evidence.length < parent.evidence.length ||
    !same(parent.evidence, child.evidence.slice(0, parent.evidence.length))
  ) {
    changed.push('evidence');
  }
  return changed;
}

/**
 * Checks that the patches are exactly the difference between parent and child: valid paths, unique, matching
 * before/after, real changes, nothing else different, and within the edit budget.
 */
export function verifyPatches(
  parent: HarnessBundle,
  child: HarnessBundle,
  patches: readonly TypedPatch[],
  maxEdits: number,
): Issue[] {
  const issues: Issue[] = [];
  if (patches.length > maxEdits)
    issues.push(
      issue('edit_budget_exceeded', 'patches', 'more independently justified edits than the budget allows'),
    );
  const seen = new Set<string>();
  patches.forEach((patch, index) => {
    const where = `patches[${index}]`;
    const target = parsePatchPath(patch.path);
    if (!target) {
      issues.push(issue('patch_path_invalid', `${where}.path`, 'path is not an editable unit'));
      return;
    }
    if (seen.has(patch.path))
      issues.push(issue('patch_path_duplicate', `${where}.path`, 'unit patched twice'));
    seen.add(patch.path);
    if (target.surface !== patch.surface)
      issues.push(issue('patch_surface_mismatch', `${where}.surface`, 'surface does not match the path'));
    if (!same(patch.before, readUnit(parent, target)))
      issues.push(issue('patch_before_mismatch', `${where}.before`, 'before does not match the parent'));
    if (!same(patch.after, readUnit(child, target)))
      issues.push(issue('patch_after_mismatch', `${where}.after`, 'after does not match the child'));
    if (same(patch.before, patch.after)) issues.push(issue('no_op_patch', where, 'patch changes nothing'));
  });
  if (issues.some((entry) => entry.code === 'patch_path_invalid')) return issues;
  const actual = changedUnits(parent, child);
  if (!actual.length) issues.push(issue('no_change', 'bundle', 'child equals parent'));
  const explained = new Set(patches.map((patch) => patch.path));
  for (const path of actual) {
    if (!explained.has(path))
      issues.push(issue('unexplained_change', path, 'child differs from the parent without a patch'));
  }
  for (const field of immutableChanges(parent, child))
    issues.push(issue('immutable_field_changed', field, 'field may not change'));
  return issues;
}
