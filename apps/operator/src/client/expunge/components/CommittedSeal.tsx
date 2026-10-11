import { BadgeCheck } from 'lucide-react';
import { shortHash } from '../format';

export type SealKind =
  'receipt' | 'event' | 'promotion' | 'grant' | 'candidate';
export interface SealSource {
  kind: SealKind;
  id: string;
  sequence: number;
}

/**
 * The only authority badge. It cannot be built from client state: `source` must name a
 * committed record and its event sequence. Without a valid source it renders nothing, so
 * no code path can show "Committed" because a button was clicked.
 */
export function CommittedSeal({
  source,
}: {
  source: SealSource | null | undefined;
}) {
  if (
    !source ||
    !source.id ||
    !Number.isInteger(source.sequence) ||
    source.sequence < 0
  )
    return null;
  return (
    <span className="ex-seal" data-source-kind={source.kind}>
      <BadgeCheck size={14} aria-hidden />
      <span className="ex-seal-word">Committed</span>
      <span>{source.kind}</span>
      <span className="ex-seal-id">
        <span aria-hidden>{shortHash(source.id, 10, 4)}</span>
        <span className="ex-sr">{source.id}</span>
      </span>
      <span className="ex-num">event {source.sequence}</span>
    </span>
  );
}
