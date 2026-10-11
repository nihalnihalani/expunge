/** The view's single h1. Focus moves here after a route change (SPA focus management). */
export function PageHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header>
      {eyebrow && <p className="ex-eyebrow">{eyebrow}</p>}
      <h1 className="ex-title" tabIndex={-1} data-ex-heading>
        {title}
      </h1>
      {children && <p className="ex-lede">{children}</p>}
    </header>
  );
}
