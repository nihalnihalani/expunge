// Subject/task literal and hidden-test-shortcut scanning. A harness bundle is a procedure, not a memory of one
// incident: it must not contain the training subject's identifiers, a task's concrete values, or anything that could
// only be known by someone who saw held-out data (record IDs, unregistered field IDs, held-out markers).
import type { EvidenceBundle, HarnessBundle, TypedPatch } from '@expunge/contracts';
import { issue, type Issue } from './issues.js';

export interface ForbiddenLiterals {
  /** Subject identifiers of the incident the proposer saw (tokens, e-mails, record IDs, display names). */
  subject: readonly string[];
  /** Task-specific concrete values (counts, names) that would make the rule specific to one incident. */
  task: readonly string[];
  /** Trusted-service-only markers of held-out worlds (path segments, seeds, IDs). Empty for the proposer's own check. */
  hidden?: readonly string[];
}
/** What a proposer may know about the scope: the public registry of the world it trained on. */
export interface PublicRegistry {
  collectionIds: readonly string[];
  fieldIds: readonly string[];
}

const SUBJECT_PATTERNS = [
  /syn_(?:subject|alias)_/i,
  /@example\.invalid/i,
  /synthetic\s[A-Z][a-z]+\s[A-Z][a-z]+/,
];
/** A record ID, a long opaque token or a hash-sized hex run has no place in a free identifier. */
const RECORD_ID_PATTERNS = [/\bsyn_[0-9a-f]{16,}\b/i, /[0-9a-f]{20,}/i];
const FIELD_ID_SHAPE = /\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g;
/** Keys that legitimately hold a hash; their values are not scanned for hex runs. */
const HASH_KEYS = new Set([
  'parentHash',
  'sourceEligibilityPolicyHash',
  'sourceHash',
  'compiledHash',
  'abiHash',
  'sandboxProfileHash',
  'inputSchemaHash',
  'outputSchemaHash',
  'runtimeAdapterHash',
  'compilerHash',
  'vocabularyHash',
  'authorityFloorHash',
  'eligibilityPolicyHash',
  'contentHash',
]);

export interface ScannedString {
  path: string;
  value: string;
  /** Provider event/trace identifiers inside evidence references are opaque by nature. */
  opaqueIdentifier: boolean;
}
export function collectStrings(
  value: unknown,
  path: string,
  out: ScannedString[] = [],
  opaque = false,
): ScannedString[] {
  if (typeof value === 'string') out.push({ path, value, opaqueIdentifier: opaque });
  else if (Array.isArray(value))
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out, opaque));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (HASH_KEYS.has(key)) continue;
      collectStrings(
        child,
        path ? `${path}.${key}` : key,
        out,
        opaque || key === 'evidence' || key === 'sourceEvidenceIds',
      );
    }
  }
  return out;
}

function scanString(
  entry: ScannedString,
  forbidden: ForbiddenLiterals,
  registry: PublicRegistry,
  issues: Issue[],
): void {
  const { value, path } = entry;
  const lowered = value.toLowerCase();
  if (
    forbidden.subject.some((literal) => literal.length >= 4 && lowered.includes(literal.toLowerCase())) ||
    SUBJECT_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    issues.push(issue('subject_literal', path, 'string contains a subject identifier'));
  }
  if (forbidden.task.some((literal) => literal.length >= 3 && lowered.includes(literal.toLowerCase()))) {
    issues.push(issue('task_literal', path, 'string contains a task-specific value'));
  }
  if ((forbidden.hidden ?? []).some((marker) => marker.length >= 4 && value.includes(marker))) {
    issues.push(issue('hidden_test_shortcut', path, 'string contains a held-out marker'));
  }
  if (!entry.opaqueIdentifier && RECORD_ID_PATTERNS.some((pattern) => pattern.test(value))) {
    issues.push(issue('hidden_test_shortcut', path, 'string contains a record identifier'));
  }
  // `<node>.output` is a workflow binding, not a field ID.
  if (!/\.output$/.test(value) || value.includes(' ')) {
    for (const match of value.matchAll(FIELD_ID_SHAPE)) {
      const [fieldId, collection] = [match[0], match[1]!];
      if (registry.collectionIds.includes(collection) && !registry.fieldIds.includes(fieldId)) {
        issues.push(
          issue('hidden_test_shortcut', path, 'string names a field that is not in the public registry'),
        );
      }
    }
  }
}

/** Scans every string of the bundle and of the patches (their hypotheses are persisted and displayed too). */
export function scanForShortcuts(
  bundle: HarnessBundle,
  patches: readonly TypedPatch[],
  forbidden: ForbiddenLiterals,
  registry: PublicRegistry,
): Issue[] {
  const issues: Issue[] = [];
  const entries = [
    ...collectStrings(bundle, 'bundle'),
    ...collectStrings(
      patches.map(({ path, hypothesis, before, after, sourceEvidenceIds }) => ({
        path,
        hypothesis,
        before,
        after,
        sourceEvidenceIds,
      })),
      'patches',
    ),
  ];
  for (const entry of entries) scanString(entry, forbidden, registry, issues);
  // One report per (code, path): repeated matches in one string add nothing.
  const seen = new Set<string>();
  return issues.filter(
    (item) => !seen.has(`${item.code}@${item.path}`) && seen.add(`${item.code}@${item.path}`),
  );
}

/** Derives the forbidden subject literals from the evidence a proposer was shown. */
export function subjectLiteralsFrom(evidence: readonly EvidenceBundle[]): string[] {
  const literals = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(
        /syn_[A-Za-z0-9_]{6,}|[\w.+-]+@example\.invalid|Synthetic [A-Z][a-z]+ [A-Z][a-z]+/g,
      )) {
        literals.add(match[0]);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const bundle of evidence) {
    visit(bundle.tools);
    visit(bundle.failureWitnesses);
    visit(bundle.diagnostics);
    visit(bundle.modelOutput);
  }
  return [...literals];
}
