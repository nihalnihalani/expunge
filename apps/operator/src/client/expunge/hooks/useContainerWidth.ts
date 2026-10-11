import { useEffect, useState, type RefObject } from 'react';

/** Reads an element's inline size, for layout decisions CSS container queries cannot make. */
export function useContainerWidth(
  ref: RefObject<HTMLElement | null>,
  fallback = 0,
) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
