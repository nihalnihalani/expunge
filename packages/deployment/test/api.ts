/**
 * Test entry to the package. The production functions take no test option; these wrappers lift the fixture refusal for
 * one call chain, through a module the package does not export, when a test passes `{ allowTestFixtures: true }`.
 */
import { fixtureFlag } from '../src/fixture-flag.js';
import * as real from '../src/index.js';
import { promoteWithHooks as promoteHooks, rollbackWithHooks, type RaceHooks } from '../src/promote.js';

export type Opts = { allowTestFixtures?: boolean };
const run = <R>(opts: Opts | undefined, fn: () => Promise<R>): Promise<R> =>
  opts?.allowTestFixtures ? fixtureFlag.run(true, fn) : fn();

export const loadAdmittedReport = (
  ...[service, request, opts]: [...Parameters<typeof real.loadAdmittedReport>, Opts?]
) => run(opts, () => real.loadAdmittedReport(service, request));
export const renderDescriptor = (
  ...[service, request, opts]: [...Parameters<typeof real.renderDescriptor>, Opts?]
) => run(opts, () => real.renderDescriptor(service, request));
export const answerApproval = (
  ...[service, request, opts]: [...Parameters<typeof real.answerApproval>, Opts?]
) => run(opts, () => real.answerApproval(service, request));
export const promoteAdmitted = (
  ...[service, request, opts]: [...Parameters<typeof real.promoteAdmitted>, Opts?]
) => run(opts, () => real.promoteAdmitted(service, request));
export const { issueRollbackGrant, rollbackDeployment, createPinnedCleanupJob, changeOf } = real;
export const promoteWithHooks = (
  service: Parameters<typeof real.promoteAdmitted>[0],
  request: Parameters<typeof real.promoteAdmitted>[1],
  hooks: RaceHooks,
  opts?: Opts,
) => run(opts, () => promoteHooks(service, request, hooks));
export { rollbackWithHooks };
