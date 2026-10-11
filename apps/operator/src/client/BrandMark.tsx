/**
 * Expunge mark: ruled lines of text with one span redacted. Drawn in currentColor so it
 * follows the shell's ink in light and dark themes.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="2"
        y="3.5"
        width="16"
        height="1.6"
        rx="0.8"
        fill="currentColor"
      />
      <rect
        x="2"
        y="9.2"
        width="3.5"
        height="1.6"
        rx="0.8"
        fill="currentColor"
      />
      <rect
        x="7"
        y="7.6"
        width="11"
        height="4.8"
        rx="0.8"
        fill="currentColor"
      />
      <rect
        x="2"
        y="14.9"
        width="10"
        height="1.6"
        rx="0.8"
        fill="currentColor"
      />
    </svg>
  );
}
