import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Whether the current call chain may act on a report that carries a test label. This module is not exported by the
 * package (`exports` names only the entry point), so no service can reach the setter; the tests import it by path.
 */
export const fixtureFlag = new AsyncLocalStorage<boolean>();
export const fixturesAllowed = (): boolean => fixtureFlag.getStore() === true;
