import type { JsonValue, ScopeKey } from '@expunge/contracts';
import { detectLeak, requireGuard, type LeakCode, type LeakGuard } from '@expunge/observability';
import type { ArtifactKind, ContentPurger, EligibilityStore } from './ports.js';
import type { RetractionReason, RetractionRunner, RetractionState } from './retract.js';
import { classifyRetention } from './structure.js';

/**
 * Subject-literal scan of RETAINED artifact and lesson content. It reuses the observer's leak guard, so a literal is
 * found in a key or a value, in folded or split form, and after URL-, base64- and hex-decoding; held-out keys and the
 * grader's salted private-id set are checked too. Immutability and content addressing are never an exemption: a hit on
 * an active artifact revokes it (and, through the closure, what was derived from it).
 */

export type ScanItem = { artifactId: string; kind: ArtifactKind; value: JsonValue };

export type Violation =
  | { artifactId: string; kind: ArtifactKind; type: 'leak'; code: LeakCode; path?: string }
  | { artifactId: string; kind: ArtifactKind; type: 'raw_retention' };

export type ScanReport = {
  scanned: number;
  structural: number;
  /** Raw material in a place that may keep only generalized structure (a lesson, a bundle, a candidate). */
  raw: number;
  violations: Violation[];
};

/** Kinds that may keep raw source bytes: only the raw store itself, which the privacy controller can delete from. */
const MAY_HOLD_RAW: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(['raw_source']);

/** The finding for one item, or null. Never returns the matched text. */
export function scanItem(item: ScanItem, guard: LeakGuard): Violation[] {
  const found: Violation[] = [];
  const leak = detectLeak(item.value, guard);
  if (leak)
    found.push({
      artifactId: item.artifactId,
      kind: item.kind,
      type: 'leak',
      code: leak.code,
      ...(leak.path ? { path: leak.path } : {}),
    });
  if (!MAY_HOLD_RAW.has(item.kind) && classifyRetention(item.value) === 'raw')
    found.push({ artifactId: item.artifactId, kind: item.kind, type: 'raw_retention' });
  return found;
}

export function scanRetained(items: Iterable<ScanItem>, guard: LeakGuard): ScanReport {
  requireGuard(guard);
  const report: ScanReport = { scanned: 0, structural: 0, raw: 0, violations: [] };
  for (const item of items) {
    report.scanned++;
    if (classifyRetention(item.value) === 'structural') report.structural++;
    else if (!MAY_HOLD_RAW.has(item.kind)) report.raw++;
    report.violations.push(...scanItem(item, guard));
  }
  return report;
}

export type EnforcementAction =
  | { artifactId: string; action: 'retracted'; state: RetractionState }
  /** Already revoked or deleted, but its bytes held prohibited content: the bytes were removed now. */
  | {
      artifactId: string;
      action: 'bytes_purged';
      eligibility: string;
      outcome: 'purged' | 'tombstoned' | 'not_found';
    }
  | { artifactId: string; action: 'already_inactive'; eligibility: string };

/**
 * Acts on a scan report: every violating artifact that is still ACTIVE (`permitted`) is retracted through the
 * retraction protocol; one that is already revoked or deleted is only reported. The reason code names the control that
 * found it, never the matched text.
 */
export async function enforceScan(
  deps: {
    eligibility: EligibilityStore;
    retraction: RetractionRunner;
    purger: ContentPurger;
    /** The policy hash a tombstone records for bytes removed from an already inactive artifact (the row's own wins). */
    policyHash: string;
  },
  scope: ScopeKey,
  report: ScanReport,
): Promise<EnforcementAction[]> {
  const actions: EnforcementAction[] = [];
  const seen = new Set<string>();
  for (const violation of report.violations) {
    if (seen.has(violation.artifactId)) continue;
    seen.add(violation.artifactId);
    const row = await deps.eligibility.get(scope, violation.artifactId);
    if (!row || row.state !== 'permitted') {
      // Revoked is not removed: a leak hit on an already inactive artifact still removes its bytes.
      if (violation.type === 'leak') {
        actions.push({
          artifactId: violation.artifactId,
          action: 'bytes_purged',
          eligibility: row?.state ?? 'unregistered',
          outcome: await deps.purger.purge(
            scope,
            violation.artifactId,
            violation.kind,
            `scan_${violation.code}`,
            { policyHash: row?.policyHash ?? deps.policyHash, closureId: null },
          ),
        });
        continue;
      }
      actions.push({
        artifactId: violation.artifactId,
        action: 'already_inactive',
        eligibility: row?.state ?? 'unregistered',
      });
      continue;
    }
    const reason: RetractionReason =
      violation.type === 'leak'
        ? violation.code === 'HeldOutLeak'
          ? 'scan_HeldOutLeak'
          : violation.code === 'PrivateIdLeak'
            ? 'scan_PrivateIdLeak'
            : 'scan_SubjectLiteral'
        : 'scan_raw_retention';
    actions.push({
      artifactId: violation.artifactId,
      action: 'retracted',
      state: await deps.retraction.run(scope, violation.artifactId, reason),
    });
  }
  return actions;
}
