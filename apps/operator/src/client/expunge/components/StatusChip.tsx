import type { ComponentType } from 'react';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleSlash,
  Clock,
  Globe,
  Hand,
  History,
  Hourglass,
  LoaderCircle,
  OctagonX,
  PlugZap,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';

/**
 * Non-authority status vocabulary (DESIGN.md 4.2). Every state has an icon, a word and a
 * border treatment, so color is never the only carrier. The committed state is not here:
 * only CommittedSeal can express "the database committed this".
 */
export type ChipState =
  | 'queued'
  | 'running'
  | 'waiting_evidence'
  | 'waiting_approval'
  | 'waiting_external'
  | 'succeeded'
  | 'complete_in_scope'
  | 'incomplete'
  | 'failed'
  | 'finished_incomplete'
  | 'rejected'
  | 'cancelled'
  | 'stale'
  | 'disconnected'
  | 'retrying'
  | 'unavailable'
  | 'pending_ack'
  | 'ok'
  | 'fail'
  | 'unknown';

interface Def {
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  className: string;
  spin?: boolean;
}

const DEFS: Record<ChipState, Def> = {
  queued: { label: 'Queued', icon: Clock, className: '' },
  running: {
    label: 'Running',
    icon: LoaderCircle,
    className: 'ex-chip--running',
    spin: true,
  },
  waiting_evidence: {
    label: 'Waiting for evidence',
    icon: Hourglass,
    className: 'ex-chip--dashed',
  },
  waiting_approval: {
    label: 'Needs your decision',
    icon: Hand,
    className: 'ex-chip--warn',
  },
  waiting_external: {
    label: 'Waiting on provider',
    icon: Globe,
    className: 'ex-chip--dashed',
  },
  succeeded: { label: 'Job finished', icon: CircleCheck, className: '' },
  complete_in_scope: {
    label: 'Complete in registered scope',
    icon: ShieldCheck,
    className: 'ex-chip--complete',
  },
  incomplete: {
    label: 'Incomplete in registered scope',
    icon: TriangleAlert,
    className: 'ex-chip--warn',
  },
  failed: { label: 'Failed', icon: OctagonX, className: 'ex-chip--fail' },
  // A failed job that ran to the end and committed an honest incomplete receipt. Not a crash: warning, not fail.
  finished_incomplete: {
    label: 'Finished: cleanup incomplete',
    icon: CircleAlert,
    className: 'ex-chip--warn',
  },
  rejected: { label: 'Rejected', icon: Ban, className: 'ex-chip--rejected' },
  cancelled: {
    label: 'Cancelled',
    icon: CircleSlash,
    className: 'ex-chip--strike',
  },
  stale: {
    label: 'Out of date',
    icon: History,
    className: 'ex-chip--warn ex-chip--dashed',
  },
  disconnected: {
    label: 'Disconnected',
    icon: WifiOff,
    className: 'ex-chip--warn',
  },
  retrying: {
    label: 'Retrying',
    icon: RefreshCw,
    className: 'ex-chip--dashed',
    spin: true,
  },
  unavailable: {
    label: 'Unavailable',
    icon: PlugZap,
    className: 'ex-chip--dotted',
  },
  pending_ack: {
    label: 'Submitted, waiting for confirmation',
    icon: Send,
    className: 'ex-chip--dashed',
  },
  ok: { label: 'Pass', icon: CircleCheck, className: 'ex-chip--ok' },
  fail: { label: 'Fail', icon: OctagonX, className: 'ex-chip--fail' },
  unknown: {
    label: 'Not evaluated',
    icon: CircleHelp,
    className: 'ex-chip--dotted',
  },
};

export const CHIP_LABELS: Record<ChipState, string> = Object.fromEntries(
  Object.entries(DEFS).map(([key, def]) => [key, def.label]),
) as Record<ChipState, string>;

export function StatusChip({
  state,
  label,
  reducedMotion = false,
}: {
  state: ChipState;
  /** Override the visible words (for example "Complete in registered scope, revision 214"). */
  label?: string;
  reducedMotion?: boolean;
}) {
  const def = DEFS[state];
  // Under reduced motion the spinning glyphs become a static dot; the word stays.
  const Icon = reducedMotion && def.spin ? CircleDot : def.icon;
  return (
    <span className={`ex-chip ${def.className}`.trim()} data-state={state}>
      <Icon size={14} aria-hidden />
      <span className="ex-chip-label">{label ?? def.label}</span>
    </span>
  );
}
