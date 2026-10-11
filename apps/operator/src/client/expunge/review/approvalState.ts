import type { ApprovalDescriptorView } from '../../../shared/expunge';

export type ApprovalAvailability =
  | { canDecide: true }
  | {
      canDecide: false;
      reason: 'expired' | 'stale' | 'approved' | 'declined' | 'consumed';
      text: string;
    };

const TEXT = {
  expired:
    'This approval has expired. Nothing was approved. Refresh to see the committed state.',
  stale:
    'This proposal is stale: the active parent or the scope changed after it was prepared. It cannot be approved. Refresh to see the committed state.',
  approved:
    'The database has recorded an approval for this proposal. Promotion is a separate committed step.',
  declined: 'The database has recorded a decline for this proposal.',
  consumed:
    'The grant for this proposal was already used. It cannot be used again.',
} as const;

/**
 * Whether the stored descriptor can still be decided. The clock only ever removes the
 * Approve action (expiry passed); it never grants one. The database still decides.
 */
export function approvalAvailability(
  descriptor: Pick<ApprovalDescriptorView, 'state' | 'expiresAt'>,
  now: number,
): ApprovalAvailability {
  if (descriptor.state === 'pending') {
    const expires = Date.parse(descriptor.expiresAt);
    if (!Number.isFinite(expires) || expires <= now)
      return { canDecide: false, reason: 'expired', text: TEXT.expired };
    return { canDecide: true };
  }
  const reason = descriptor.state;
  return { canDecide: false, reason, text: TEXT[reason] };
}

/** "in 4 min", "in 35 s" or "expired"; recomputed by the caller at low frequency. */
export function expiresIn(expiresAt: string, now: number) {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  if (ms < 90_000) return `in ${Math.ceil(ms / 1000)} s`;
  if (ms < 90 * 60_000) return `in ${Math.ceil(ms / 60_000)} min`;
  return `in ${Math.round(ms / 3_600_000)} h`;
}

export const CHANGE_WORD: Record<
  ApprovalDescriptorView['flipSet'][number]['change'],
  string
> = {
  added: 'Added',
  widened: 'Widened',
  removed: 'Removed',
  tightened: 'Tightened',
};
