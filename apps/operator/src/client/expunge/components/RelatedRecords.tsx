import type { ArtifactRef } from '../../../shared/expunge';
import { formatRoute } from '../routes';

/**
 * Links to the records a job has, decided from the committed artifact index only: a job with no
 * retraction gets no Privacy link and a job with no campaign gets no Campaign link, so nothing
 * leads to an empty screen.
 */
export function relatedLinks(
  jobId: string,
  artifacts: Pick<ArtifactRef, 'kind'>[],
) {
  const has = (kind: ArtifactRef['kind']) =>
    artifacts.some((item) => item.kind === kind);
  return [
    has('retraction') && {
      label: 'Privacy and retraction',
      href: formatRoute({ name: 'privacy', jobId }),
    },
    has('campaign') && {
      label: 'Campaign',
      href: formatRoute({ name: 'campaign', jobId }),
    },
  ].filter((item): item is { label: string; href: string } => !!item);
}

export function RelatedRecords({
  jobId,
  artifacts,
}: {
  jobId: string;
  artifacts: Pick<ArtifactRef, 'kind'>[];
}) {
  const links = relatedLinks(jobId, artifacts);
  if (links.length === 0) return null;
  return (
    <nav aria-label="Related records" className="ex-related">
      <span className="ex-note">Related records:</span>
      <ul className="ex-tabs">
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href}>{link.label}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
