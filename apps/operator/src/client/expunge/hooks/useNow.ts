import { useEffect, useState } from 'react';

/** A coarse clock for "checked 3 min ago" text. Updates at a low frequency on purpose. */
export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
