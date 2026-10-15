/**
 * Matjarak (متجرك) brand mark — the "M" icon only.
 * Placeholder approximation of the approved mark (monoline M, rounded joins,
 * center node) until final SVG/PNG assets are placed in client/src/assets/brand/.
 * Scales to whatever size className provides.
 *
 * `variant="inverse"` (Matjarak 2.0، المرحلة 1B-4): نفس الشكل الهندسي حرفيًا بألوان معكوسة للأسطح الملوّنة بلون
 * مساحة العمل (هيدر المخزن) — من --brand-mark-inverse*. الهوية الحالية: نفس ألوان الشعار العادي حرفيًا.
 */
export function BrandMark({ className = "h-8 w-8", variant = "default" }: { className?: string; variant?: "default" | "inverse" }) {
  const inverse = variant === "inverse";
  return (
    <div
      className={`${className} rounded-full shrink-0 bg-gradient-to-br ${inverse ? "from-brand-mark-inverse to-brand-mark-inverse-strong" : "from-brand-mark to-brand-mark-strong"} flex items-center justify-center`}
      role="img"
      aria-label="متجرك"
      data-variant={inverse ? "inverse" : undefined}
    >
      <svg viewBox="0 0 24 24" className="w-3/5 h-3/5" fill="none">
        <path
          d="M6 17 L6 7 L12 13 L18 7 L18 17"
          stroke="#FFFFFF"
          style={inverse ? { stroke: "var(--brand-mark-inverse-foreground)" } : undefined}
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="13" r="1.6" fill="#EDE9FE" style={inverse ? { fill: "var(--brand-mark-inverse-node)" } : undefined} />
      </svg>
    </div>
  );
}
