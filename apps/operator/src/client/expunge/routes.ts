/** Hash routes for the Expunge workflow. Pure, so they are unit tested. */
export const JOB_TABS = [
  'workbench',
  'evidence',
  'candidate',
  'evaluation',
  'receipt',
] as const;
export type JobTab = (typeof JOB_TABS)[number];
export const TARGETS = ['worker', 'improver', 'hider'] as const;
export type RouteTarget = (typeof TARGETS)[number];

export type ExpungeRoute =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'new' }
  | { name: 'job'; jobId: string; tab: JobTab }
  | { name: 'lineage'; target: RouteTarget }
  | { name: 'campaign'; jobId: string }
  | { name: 'privacy'; jobId: string }
  | { name: 'unknown'; hash: string };

const id = /^[A-Za-z0-9_-]{1,128}$/;

export function isExpungeHash(hash: string) {
  return /^#\/expunge(\/|$)/.test(hash);
}

export function parseRoute(hash: string): ExpungeRoute {
  if (!isExpungeHash(hash)) return { name: 'unknown', hash };
  const parts = hash
    .replace(/^#\/expunge\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    });
  if (parts.length === 0) return { name: 'home' };
  const [first, second, third] = parts;
  if (first === 'setup' && parts.length === 1) return { name: 'setup' };
  if (first === 'new' && parts.length === 1) return { name: 'new' };
  if (first === 'jobs' && second && id.test(second)) {
    if (parts.length === 2)
      return { name: 'job', jobId: second, tab: 'workbench' };
    if (parts.length === 3 && (JOB_TABS as readonly string[]).includes(third))
      return { name: 'job', jobId: second, tab: third as JobTab };
  }
  if (
    first === 'lineage' &&
    parts.length === 2 &&
    (TARGETS as readonly string[]).includes(second)
  )
    return { name: 'lineage', target: second as RouteTarget };
  if (first === 'campaigns' && parts.length === 2 && id.test(second))
    return { name: 'campaign', jobId: second };
  if (first === 'privacy' && parts.length === 2 && id.test(second))
    return { name: 'privacy', jobId: second };
  return { name: 'unknown', hash };
}

export function formatRoute(route: ExpungeRoute): string {
  switch (route.name) {
    case 'home':
      return '#/expunge';
    case 'setup':
      return '#/expunge/setup';
    case 'new':
      return '#/expunge/new';
    case 'job':
      return route.tab === 'workbench'
        ? `#/expunge/jobs/${encodeURIComponent(route.jobId)}`
        : `#/expunge/jobs/${encodeURIComponent(route.jobId)}/${route.tab}`;
    case 'lineage':
      return `#/expunge/lineage/${route.target}`;
    case 'campaign':
      return `#/expunge/campaigns/${encodeURIComponent(route.jobId)}`;
    case 'privacy':
      return `#/expunge/privacy/${encodeURIComponent(route.jobId)}`;
    default:
      return '#/expunge';
  }
}
