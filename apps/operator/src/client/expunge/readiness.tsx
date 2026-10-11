import { createContext, useCallback, useContext, useState } from 'react';
import type { ExpungeReadiness } from '../../shared/expunge';
import { useResource, type ResourceState } from './hooks/useResource';

interface ReadinessValue {
  resource: ResourceState<ExpungeReadiness>;
  /** Bypasses the server's five-second cache. */
  recheck: () => void;
}

const Context = createContext<ReadinessValue | null>(null);

export function ReadinessProvider({ children }: { children: React.ReactNode }) {
  const [forced, setForced] = useState(0);
  const resource = useResource<ExpungeReadiness>(
    forced ? `/readiness?fresh=1&n=${forced}` : '/readiness',
    { pollMs: 60_000 },
  );
  const recheck = useCallback(() => setForced((value) => value + 1), []);
  return (
    <Context.Provider value={{ resource, recheck }}>
      {children}
    </Context.Provider>
  );
}

export function useReadiness() {
  const value = useContext(Context);
  if (!value) throw new Error('ReadinessProvider is missing.');
  return value;
}
