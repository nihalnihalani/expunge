// The authoritative mutation class, computed from the parent and child bundles themselves. The model's claim is
// advisory and only recorded. Order: tightening < behavioral < authority_expansion.
import type { GuardrailAst, GuardrailPredicate, HarnessBundle, MutationClass } from '@expunge/contracts';
import { canonicalJson } from '@expunge/contracts';
import { changedUnits } from './patches.js';

export interface ClassComponent {
  unit: string;
  kind: MutationClass;
  reason: string;
}
const ORDER: Record<MutationClass, number> = { tightening: 0, behavioral: 1, authority_expansion: 2 };
const SEVERITY = { allow: 0, ask: 1, deny: 2 } as const;
const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** Tools a rule governs; `null` means every tool (absent or empty `appliesTo`). */
function scopeOf(rule: GuardrailAst): ReadonlySet<string> | null {
  return rule.appliesTo && rule.appliesTo.length ? new Set(rule.appliesTo) : null;
}
/** True when `after` governs every call that `before` governed. */
function scopeCovers(after: ReadonlySet<string> | null, before: ReadonlySet<string> | null): boolean {
  if (after === null) return true;
  if (before === null) return false;
  return [...before].every((tool) => after.has(tool));
}
function isSuperset(candidate: GuardrailPredicate, original: GuardrailPredicate): boolean {
  return candidate.op === 'any' && candidate.predicates.some((member) => same(member, original));
}

function classifyRule(
  before: GuardrailAst | undefined,
  after: GuardrailAst | undefined,
  unit: string,
): ClassComponent {
  if (!before && after) {
    return after.result === 'allow'
      ? { unit, kind: 'behavioral', reason: 'allow rule added' }
      : { unit, kind: 'tightening', reason: 'restrictive rule added' };
  }
  if (before && !after) {
    return before.result === 'allow'
      ? { unit, kind: 'behavioral', reason: 'allow rule removed' }
      : { unit, kind: 'authority_expansion', reason: 'restrictive rule removed' };
  }
  const old = before!;
  const next = after!;
  if (SEVERITY[next.result] < SEVERITY[old.result])
    return { unit, kind: 'authority_expansion', reason: 'rule made less restrictive' };
  const [oldScope, nextScope] = [scopeOf(old), scopeOf(next)];
  if (!scopeCovers(nextScope, oldScope)) {
    return { unit, kind: 'authority_expansion', reason: 'rule no longer governs every call it governed' };
  }
  const stricter = SEVERITY[next.result] > SEVERITY[old.result] || !scopeCovers(oldScope, nextScope);
  if (!same(old.predicate, next.predicate) && !isSuperset(next.predicate, old.predicate)) {
    return {
      unit,
      kind: 'authority_expansion',
      reason: 'rule predicate changed without a provable superset',
    };
  }
  return stricter
    ? { unit, kind: 'tightening', reason: 'rule made more restrictive' }
    : { unit, kind: 'behavioral', reason: 'rule metadata changed' };
}

export function classifyMutation(
  parent: HarnessBundle,
  child: HarnessBundle,
): { mutationClass: MutationClass | null; components: ClassComponent[] } {
  const components: ClassComponent[] = [];
  for (const unit of changedUnits(parent, child)) {
    if (unit.startsWith('guardrails.')) {
      const ruleId = unit.slice('guardrails.'.length);
      components.push(
        classifyRule(
          parent.guardrails.find((rule) => rule.ruleId === ruleId),
          child.guardrails.find((rule) => rule.ruleId === ruleId),
          unit,
        ),
      );
    } else if (unit === 'toolPolicy.grants') {
      const added = child.toolPolicy.grants.filter((tool) => !parent.toolPolicy.grants.includes(tool));
      const removed = parent.toolPolicy.grants.filter((tool) => !child.toolPolicy.grants.includes(tool));
      components.push(
        added.length
          ? { unit, kind: 'authority_expansion', reason: 'tool grant added' }
          : removed.length
            ? { unit, kind: 'tightening', reason: 'tool grant removed' }
            : { unit, kind: 'behavioral', reason: 'grant order changed' },
      );
    } else if (unit === 'toolPolicy.prerequisites') {
      const key = (item: { toolId: string; requiredArtifact: string }) =>
        `${item.toolId}:${item.requiredArtifact}`;
      const before = new Set(parent.toolPolicy.prerequisites.map(key));
      const after = new Set(child.toolPolicy.prerequisites.map(key));
      const removed = [...before].some((item) => !after.has(item));
      const added = [...after].some((item) => !before.has(item));
      components.push(
        removed
          ? { unit, kind: 'authority_expansion', reason: 'prerequisite removed' }
          : added
            ? { unit, kind: 'tightening', reason: 'prerequisite added' }
            : { unit, kind: 'behavioral', reason: 'prerequisite order changed' },
      );
    } else if (unit === 'completionPolicy') {
      components.push(
        child.completionPolicy === 'model_narrative'
          ? { unit, kind: 'authority_expansion', reason: 'completion no longer requires a committed receipt' }
          : { unit, kind: 'tightening', reason: 'completion now requires a committed receipt' },
      );
    } else if (unit.startsWith('limits.')) {
      const key = unit.slice('limits.'.length) as keyof HarnessBundle['limits'];
      const grew = child.limits[key] > parent.limits[key];
      components.push(
        !grew
          ? { unit, kind: 'tightening', reason: 'limit lowered' }
          : key === 'changedDocuments'
            ? { unit, kind: 'authority_expansion', reason: 'more records may be changed' }
            : { unit, kind: 'behavioral', reason: 'limit raised' },
      );
    } else {
      components.push({ unit, kind: 'behavioral', reason: 'execution behavior changed' });
    }
  }
  if (!components.length) return { mutationClass: null, components };
  const mutationClass = components.reduce<MutationClass>(
    (worst, part) => (ORDER[part.kind] > ORDER[worst] ? part.kind : worst),
    'tightening',
  );
  return { mutationClass, components };
}
