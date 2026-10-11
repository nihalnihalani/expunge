import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Announce = (message: string) => void;
const Context = createContext<Announce>(() => undefined);
export const useAnnounce = () => useContext(Context);

const MIN_GAP_MS = 2000;

/**
 * One polite region per view. Announces only what callers pass (phase changes, terminal
 * states, approval needed, connection changes), coalesced to at most one message every two
 * seconds; a newer message replaces an older queued one. Never announce counters or events.
 */
export function LiveRegionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [message, setMessage] = useState('');
  const last = useRef(0);
  const queued = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    if (queued.current === undefined) return;
    last.current = Date.now();
    setMessage(queued.current);
    queued.current = undefined;
  }, []);
  const announce = useCallback<Announce>(
    (next) => {
      queued.current = next;
      const wait = Math.max(0, last.current + MIN_GAP_MS - Date.now());
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, wait);
    },
    [flush],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => announce, [announce]);
  return (
    <Context.Provider value={value}>
      {children}
      <div
        className="ex-sr"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {message}
      </div>
    </Context.Provider>
  );
}
