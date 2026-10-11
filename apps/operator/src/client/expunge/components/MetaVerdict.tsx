import type { MetaVerdictView } from '../../../shared/expunge';
import { StatusChip } from './StatusChip';

/** One sentence per verdict, worded per PREREGISTRATION.md. The verdict is the stored one. */
export const VERDICT_COPY: Record<MetaVerdictView['verdict'], string> = {
  gain: "GAIN: I1's workers beat I0's by more than chance, by more than two I0 workers differ from each other, and by more than the no-data rewrite does.",
  loss: "LOSS: I1's workers did significantly worse than I0's.",
  tie: 'TIE: the difference cannot be distinguished from noise or from doing nothing.',
};

/** The stored rule, stated as text so the numbers below can be read against it. */
export const RULE_COPY =
  'Preregistered rule: GAIN if and only if p < 0.05 and net > 0 and net > |noiseNet| and net > noDataNet; LOSS if and only if p < 0.05 and net < 0; otherwise TIE. The unit is the incident; ties are dropped from the sign test.';

/** Shown when the artifact carries no stored verdict. */
export const NO_VERDICT_TEXT =
  'No preregistered verdict recorded. No gain, loss or tie is stated.';

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/**
 * Renders the stored preregistered meta verdict. It never computes a verdict from the numbers:
 * it shows what the backend recorded, the rule it was recorded under, and the figures.
 */
export function MetaVerdict({
  verdict,
}: {
  verdict: MetaVerdictView | undefined;
}) {
  if (!verdict) return <p className="ex-note">{NO_VERDICT_TEXT}</p>;
  return (
    <div className="ex-metaverdict">
      <p>
        <StatusChip
          state={
            verdict.verdict === 'gain'
              ? 'ok'
              : verdict.verdict === 'loss'
                ? 'fail'
                : 'unknown'
          }
          label={`stored verdict: ${verdict.verdict.toUpperCase()}`}
        />{' '}
        {VERDICT_COPY[verdict.verdict]}
      </p>
      <dl className="ex-dl">
        <dt>Incidents</dt>
        <dd className="ex-num">{verdict.incidents}</dd>
        <dt>Wins</dt>
        <dd className="ex-num">{verdict.wins}</dd>
        <dt>Losses</dt>
        <dd className="ex-num">{verdict.losses}</dd>
        <dt>Ties dropped</dt>
        <dd className="ex-num">{verdict.ties}</dd>
        <dt>Sign test p</dt>
        <dd className="ex-num">{verdict.p.toFixed(4)}</dd>
        <dt>Net (wins minus losses)</dt>
        <dd className="ex-num">{signed(verdict.net)}</dd>
        <dt>Noise net (I0 against I0, same incidents)</dt>
        <dd className="ex-num">{signed(verdict.noiseNet)}</dd>
        <dt>No-data net</dt>
        <dd className="ex-num">{signed(verdict.noDataNet)}</dd>
      </dl>
      <p className="ex-note">{RULE_COPY}</p>
      <p className="ex-note">
        A tie or a null result is an acceptable outcome. The sample is small,
        and no result here measures model weights or indefinite acceleration.
        This verdict is the one the backend stored; this screen did not
        recompute it.
      </p>
    </div>
  );
}
