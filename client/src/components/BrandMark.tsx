/**
 * Matjarak (متجرك) brand mark — the "M" icon only.
 * Placeholder approximation of the approved mark (monoline M, rounded joins,
 * center node) until final SVG/PNG assets are placed in client/src/assets/brand/.
 * Scales to whatever size className provides.
 */
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <div
      className={`${className} rounded-full shrink-0 bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center`}
      role="img"
      aria-label="متجرك"
    >
      <svg viewBox="0 0 24 24" className="w-3/5 h-3/5" fill="none">
        <path
          d="M6 17 L6 7 L12 13 L18 7 L18 17"
          stroke="#FFFFFF"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="13" r="1.6" fill="#EDE9FE" />
      </svg>
    </div>
  );
}
