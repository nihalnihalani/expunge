import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The one modal primitive (APG modal dialog pattern, DESIGN.md 9.3). Built on the native
 * <dialog> opened with showModal(), which makes the rest of the page inert and traps Escape, and
 * adds what the platform leaves out:
 * - focus starts on the title (tabindex -1), never on a consequential control;
 * - Tab and Shift+Tab wrap inside the dialog;
 * - Escape closes without a decision (the caller's onClose);
 * - on close, focus returns to the invoker, or to `fallbackSelector` when the invoker is gone.
 * The dialog is named by its visible title.
 */
export function Dialog({
  open,
  onClose,
  title,
  titleId,
  fallbackSelector = 'h2, h1',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  fallbackSelector?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    invoker.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    titleRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      const target = invoker.current;
      if (target && target.isConnected) target.focus();
      else
        document
          .querySelector<HTMLElement>(`.ex-root ${fallbackSelector}`)
          ?.focus?.();
    };
  }, [open, fallbackSelector]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className="ex-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        // Escape: close without a decision. The effect cleanup returns focus.
        event.preventDefault();
        onCloseRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const nodes = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE),
        ].filter((node) => !node.hasAttribute('hidden'));
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (!first || !last) return;
        if (
          event.shiftKey &&
          (active === first || active === titleRef.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <h2 id={titleId} className="ex-h2" tabIndex={-1} ref={titleRef}>
        {title}
      </h2>
      {children}
    </dialog>
  );
}
