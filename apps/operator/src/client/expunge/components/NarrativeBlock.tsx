import { MessageSquareQuote } from 'lucide-react';

/**
 * The only place model text is drawn. Dashed, hatched and italic, with a fixed label, so it
 * cannot be mistaken for committed status. It is never placed inside a status region.
 */
export function NarrativeBlock({
  text,
  replayed = false,
}: {
  text: string;
  replayed?: boolean;
}) {
  return (
    <figure className="ex-narrative">
      <figcaption className="ex-narrative-label">
        <MessageSquareQuote size={14} aria-hidden />
        Model narrative, not verified
        {replayed ? ' · replayed from a recorded run' : ''}
      </figcaption>
      <blockquote className="ex-narrative-text">{text}</blockquote>
    </figure>
  );
}
