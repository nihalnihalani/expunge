/**
 * A horizontally scrollable table region. Scrollable regions must be reachable by keyboard
 * (WCAG 2.1.1) and named, so it is a focusable labeled region. Tables keep their real
 * <table> semantics inside it; this is the 1.4.10 reflow exception for data tables.
 */
export function TableWrap({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ex-tablewrap" role="region" tabIndex={0} aria-label={label}>
      {children}
    </div>
  );
}
