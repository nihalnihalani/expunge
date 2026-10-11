import { useEffect } from 'react';

/** The Expunge view owns document.title while mounted; the shell restores its own on leaving. */
export function useDocumentTitle(label: string) {
  useEffect(() => {
    document.title = `${label} · Expunge`;
  }, [label]);
}
