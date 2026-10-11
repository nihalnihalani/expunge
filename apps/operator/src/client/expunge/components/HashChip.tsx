import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { shortHash } from '../format';

/**
 * Identifiers are never truncated without a path to the whole value: the visible form is
 * aria-hidden, the full value is present as hidden text, and a copy button copies it.
 */
export function HashChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ex-hash">
      <code>
        <span aria-hidden>{shortHash(value)}</span>
        <span className="ex-sr">{value}</span>
      </code>
      <button
        type="button"
        className="ex-btn ex-btn--quiet ex-iconbtn"
        aria-label={`Copy full ${label ?? 'identifier'}`}
        onClick={() => {
          try {
            void navigator.clipboard
              .writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? (
          <Check size={14} aria-hidden />
        ) : (
          <Copy size={14} aria-hidden />
        )}
      </button>
      <span className="ex-sr" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}
