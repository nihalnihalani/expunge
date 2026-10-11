import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ConnectionBanner } from './components/ConnectionBanner';
import { LiveRegionProvider } from './components/LiveRegion';
import { ReadinessProvider, useReadiness } from './readiness';
import {
  formatRoute,
  isExpungeHash,
  parseRoute,
  type ExpungeRoute,
} from './routes';
import { globalNav, pickView, type ViewModule } from './registry';
import { connectionFor } from './views/ReadinessView';
import { useNow } from './hooks/useNow';
import './css/00-tokens.css';
import './css/10-base.css';

// Views and their stylesheets register themselves by file name: adding a slice means
// adding files, not editing this shell.
const modules = Object.values(
  import.meta.glob<ViewModule>('./views/*View.tsx', { eager: true }),
);
import.meta.glob('./css/*.css', { eager: true });

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}
const snapshot = () => window.location.hash;

export function navigate(route: ExpungeRoute) {
  const next = formatRoute(route);
  if (window.location.hash !== next) window.location.hash = next;
}

function Shell({ route }: { route: ExpungeRoute }) {
  const { resource, recheck } = useReadiness();
  const now = useNow();
  const view = pickView(modules, route);
  const nav = globalNav(modules);
  const homeView = pickView(modules, { name: 'home' });
  const first = useRef(true);
  const key = formatRoute(route);
  useEffect(() => {
    // Move focus to the new view's heading after a route change (not on first load).
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>(
      '.ex-root [data-ex-heading]',
    );
    heading?.focus({ preventScroll: false });
  }, [key]);
  const fixture = resource.data?.backend.kind === 'fixture';
  const View = view?.default;
  return (
    <div className="ex-shell">
      <div className="ex-head">
        <p className="ex-brand">Expunge</p>
        <nav aria-label="Expunge sections">
          <ul className="ex-nav">
            {nav.map((item) => {
              const target = item.meta.navRoute!;
              const current =
                formatRoute(target) === key ||
                (route.name === 'home' && item === homeView);
              return (
                <li key={item.meta.id}>
                  <a
                    href={formatRoute(target)}
                    aria-current={current ? 'page' : undefined}
                  >
                    {item.meta.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      {fixture && (
        <div className="ex-banner ex-banner--info" role="note">
          <strong>Fixture backend.</strong>
          <span>
            This is deterministic test data, not a live job or a database
            result.
          </span>
        </div>
      )}
      {resource.status === 'disconnected' || resource.status === 'retrying' ? (
        <ConnectionBanner
          connection={connectionFor(resource.status)}
          attempt={resource.attempt}
          nextRetryMs={resource.nextRetryMs}
          updatedAt={resource.updatedAt}
          now={now}
          onRetry={recheck}
        />
      ) : null}
      {View ? (
        <View route={route} navigate={navigate} />
      ) : (
        <div className="ex-page">
          <h1 className="ex-title" tabIndex={-1} data-ex-heading>
            Not found
          </h1>
          <p className="ex-lede">This Expunge address does not match a view.</p>
          <a className="ex-link" href="#/expunge">
            Go to Expunge
          </a>
        </div>
      )}
    </div>
  );
}

export default function ExpungeApp() {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '#/expunge');
  const route = useMemo(
    () =>
      isExpungeHash(hash)
        ? parseRoute(hash)
        : ({ name: 'home' } as ExpungeRoute),
    [hash],
  );
  return (
    <main id="main-content" tabIndex={-1} className="ex-root">
      <ReadinessProvider>
        <LiveRegionProvider>
          <Shell route={route} />
        </LiveRegionProvider>
      </ReadinessProvider>
    </main>
  );
}
