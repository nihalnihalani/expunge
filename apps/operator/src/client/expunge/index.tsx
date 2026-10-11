import { lazy, Suspense } from 'react';

const Workbench = lazy(() => import('./ExpungeApp'));

/** Lazy boundary: the shell loads none of the Expunge workflow until the view opens. */
export function ExpungeWorkbench() {
  return (
    <Suspense
      fallback={
        <main
          id="main-content"
          tabIndex={-1}
          className="main-content"
          aria-busy="true"
        >
          <p>Loading Expunge</p>
        </main>
      }
    >
      <Workbench />
    </Suspense>
  );
}
