import {
  Check,
  Circle,
  CircleDot,
  EyeOff,
  Eraser,
  Eye,
  Lock,
  Minus,
  Search,
  Slash,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { EffectKind, GraphNodeState } from '../../../shared/expunge';
import { EFFECT_WORDS, STATE_WORDS } from '../projection/graphModel';

const STATE_ICON = {
  residual: TriangleAlert,
  applied: Check,
  previewed: Eye,
  inspected: Search,
  discovered: CircleDot,
  retained: Circle,
  excluded: Minus,
  not_inspected: EyeOff,
} as const;

/**
 * State of a record in the reference graph. An icon, a word and a border treatment, never
 * color alone. These are marks on records, not authority badges: "Effect applied" reads the
 * committed effect receipts but is not the seal.
 */
export function NodeStateChip({ state }: { state: GraphNodeState }) {
  const Icon = STATE_ICON[state];
  return (
    <span className={`ex-chip ex-node ex-node--${state}`}>
      <Icon size={14} aria-hidden />
      <span className="ex-chip-label">{STATE_WORDS[state]}</span>
    </span>
  );
}

const EFFECT_ICON = {
  delete: Trash2,
  redact: Eraser,
  restrict: Lock,
  tombstone: Slash,
} as const;

export function EffectChip({ effect }: { effect: EffectKind | null }) {
  if (!effect) return <span className="ex-muted">None</span>;
  const Icon = EFFECT_ICON[effect];
  return (
    <span className="ex-chip">
      <Icon size={14} aria-hidden />
      <span className="ex-chip-label">{EFFECT_WORDS[effect]}</span>
    </span>
  );
}
