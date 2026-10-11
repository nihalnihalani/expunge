import { Send } from 'lucide-react';

/**
 * Shown after a user action until a committed event confirms or contradicts it. It is
 * deliberately neutral and dashed, never styled as success.
 */
export function PendingAcknowledgement({
  children = 'Submitted, waiting for the database to confirm.',
}: {
  children?: React.ReactNode;
}) {
  return (
    <span className="ex-pending" role="status">
      <Send size={14} aria-hidden />
      <span>{children}</span>
    </span>
  );
}
