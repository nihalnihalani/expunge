/**
 * The shell's client api module reads sessionStorage when it is imported. Node 25 defines it;
 * Node 24 does not. Import this first in any test that renders client modules so the suite
 * does not depend on the Node version.
 */
const store = new Map<string, string>();
if (typeof globalThis.sessionStorage === 'undefined')
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
export {};
