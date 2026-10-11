import { Check, Circle, CircleDot, Minus, X } from 'lucide-react';
import {
  JOB_PHASES,
  type JobPhase,
  type PhaseState,
} from '../../../shared/expunge';

const LABEL: Record<JobPhase, string> = {
  inspect: 'Inspect',
  resolve: 'Resolve',
  discover: 'Discover',
  preview: 'Preview',
  apply: 'Apply',
  verify: 'Verify',
  complete: 'Complete',
};
const STATE_WORD: Record<PhaseState, string> = {
  pending: 'Pending',
  active: 'Active',
  committed: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
};
const ICON = {
  pending: Circle,
  active: CircleDot,
  committed: Check,
  skipped: Minus,
  failed: X,
} as const;

/**
 * The seven workflow nodes. States come from the server's committed checkpoints, never from
 * elapsed time or client actions. The node named "Complete" is a workflow step; the job is
 * complete only when a committed receipt says so.
 */
export function PhaseStepper({
  states,
  phase,
}: {
  states: Record<JobPhase, PhaseState>;
  phase: JobPhase | null;
}) {
  return (
    <ol className="ex-steps" aria-label="Workflow phases">
      {JOB_PHASES.map((name) => {
        const state = states[name];
        const Icon = ICON[state];
        return (
          <li
            key={name}
            className={`ex-step ex-step--${state}`}
            aria-current={phase === name ? 'step' : undefined}
          >
            <span className="ex-step-mark" aria-hidden>
              <Icon size={14} />
            </span>
            <span className="ex-step-name">{LABEL[name]}</span>
            <span className="ex-step-state">{STATE_WORD[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}
