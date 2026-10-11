import { JOB_TABS, type JobTab } from './routes';

/**
 * Which job tabs have a view, decided from file names only. This must not import the view
 * modules: the job frame is imported by those views, and an eager import here would form a
 * cycle that leaves their namespaces undefined during evaluation.
 */
const files = Object.keys(import.meta.glob('./views/*View.tsx'));
const fileFor = (tab: JobTab) =>
  `./views/${tab[0].toUpperCase()}${tab.slice(1)}View.tsx`;

export const registeredTabs: JobTab[] = JOB_TABS.filter((tab) =>
  files.includes(fileFor(tab)),
);
