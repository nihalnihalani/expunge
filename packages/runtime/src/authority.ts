import type { BaseEvent } from '@ag-ui/core';
import { EventType } from '@ag-ui/core';

/**
 * Keys that name authority. Application state is a UI projection supplied by the client or proposed
 * by the model; none of it may ever name or change which harness, actor, scope, lease, receipt or
 * grant applies. Authority comes only from the stored job and the pinned bundle it names.
 */
export const PROTECTED_STATE_KEYS: ReadonlySet<string> = new Set(
  [
    'harnessHash',
    'harness',
    'bundle',
    'bundleHash',
    'binding',
    'runBinding',
    'authority',
    'actor',
    'actorId',
    'tenantId',
    'env',
    'scopeId',
    'authorizationRevision',
    'scopeRevision',
    'worldId',
    'worldRevision',
    'jobId',
    'runId',
    'workerProfileHash',
    'profileHash',
    'lease',
    'fence',
    'ownerId',
    'status',
    'completion',
    'completionPolicy',
    'receipt',
    'receiptId',
    'receipts',
    'domainStatus',
    'grant',
    'grantId',
    'approval',
    'approvals',
    'deployment',
    'promotion',
    'eligibility',
    'contextInputs',
    'permissions',
    'toolPolicy',
    'limits',
  ].map((key) => key.toLowerCase()),
);

const isProtected = (key: string) => PROTECTED_STATE_KEYS.has(key.toLowerCase());
const decodePointer = (segment: string) => segment.replaceAll('~1', '/').replaceAll('~0', '~');

/** Returns a deep copy without protected keys at any depth, and the dotted paths removed. */
export function stripProtectedKeys(value: unknown, path = ''): { value: unknown; removed: string[] } {
  if (Array.isArray(value)) {
    const removed: string[] = [];
    const out = value.map((item, index) => {
      const result = stripProtectedKeys(item, `${path}/${index}`);
      removed.push(...result.removed);
      return result.value;
    });
    return { value: out, removed };
  }
  if (value && typeof value === 'object') {
    const removed: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isProtected(key)) {
        removed.push(`${path}/${key}`);
        continue;
      }
      const result = stripProtectedKeys(child, `${path}/${key}`);
      removed.push(...result.removed);
      out[key] = result.value;
    }
    return { value: out, removed };
  }
  return { value, removed: [] };
}

type PatchOp = { op?: unknown; path?: unknown; value?: unknown; from?: unknown };

/** Filters one model-emitted STATE_SNAPSHOT / STATE_DELTA. Returns null when nothing safe remains. */
export function filterModelStateEvent(event: BaseEvent): { event: BaseEvent | null; removed: string[] } {
  if (event.type === EventType.STATE_SNAPSHOT) {
    const { snapshot } = event as unknown as { snapshot: unknown };
    const result = stripProtectedKeys(snapshot);
    return { event: { ...event, snapshot: result.value } as BaseEvent, removed: result.removed };
  }
  if (event.type === EventType.STATE_DELTA) {
    const { delta } = event as unknown as { delta: unknown };
    if (!Array.isArray(delta)) return { event: null, removed: ['/'] };
    const removed: string[] = [];
    const kept: PatchOp[] = [];
    for (const raw of delta as PatchOp[]) {
      const path = typeof raw.path === 'string' ? raw.path : '';
      const segments = path.split('/').slice(1).map(decodePointer);
      if (
        path === '' ||
        segments.some(isProtected) ||
        (typeof raw.from === 'string' && raw.from.split('/').slice(1).map(decodePointer).some(isProtected))
      ) {
        removed.push(path || '/');
        continue;
      }
      if ('value' in raw) {
        const stripped = stripProtectedKeys(raw.value, path);
        removed.push(...stripped.removed);
        kept.push({ ...raw, value: stripped.value });
      } else kept.push(raw);
    }
    if (kept.length === 0) return { event: null, removed };
    return { event: { ...event, delta: kept } as BaseEvent, removed };
  }
  return { event, removed: [] };
}
