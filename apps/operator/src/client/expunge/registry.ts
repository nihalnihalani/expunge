import type { ComponentType } from 'react';
import type { ExpungeRoute } from './routes';

export interface ViewProps {
  route: ExpungeRoute;
  navigate: (route: ExpungeRoute) => void;
}

export interface ViewMeta {
  id: string;
  /** Nav label for global views; tab label for job views. */
  label: string;
  /** Route names this view renders. */
  routes: ExpungeRoute['name'][];
  /** For job views: which tab. */
  tab?: string;
  scope: 'global' | 'job';
  order: number;
  /** Global nav target. */
  navRoute?: ExpungeRoute;
  /** Highest priority serves the bare #/expunge route. */
  home?: number;
}

export interface ViewModule {
  default: ComponentType<ViewProps>;
  meta: ViewMeta;
}

export function pickView(modules: ViewModule[], route: ExpungeRoute) {
  if (route.name === 'home' || route.name === 'unknown')
    return [...modules]
      .filter((module) => module.meta.home !== undefined)
      .sort((a, b) => (b.meta.home ?? 0) - (a.meta.home ?? 0))[0];
  return modules.find(
    (module) =>
      module.meta.routes.includes(route.name) &&
      (route.name !== 'job' || (module.meta.tab ?? 'workbench') === route.tab),
  );
}

export function globalNav(modules: ViewModule[]) {
  return modules
    .filter((module) => module.meta.scope === 'global' && module.meta.navRoute)
    .sort((a, b) => a.meta.order - b.meta.order);
}

export function jobTabs(modules: ViewModule[]) {
  return modules
    .filter((module) => module.meta.scope === 'job')
    .sort((a, b) => a.meta.order - b.meta.order);
}
