/** Matjarak (متجرك) brand mark — scales to whatever size className provides. */
export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <div
      className={`${className} rounded-full shrink-0 bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center`}
      role="img"
      aria-label="متجرك"
    >
      <svg viewBox="0 0 24 24" className="w-3/5 h-3/5" fill="none">
        <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" fill="#FFFFFF" opacity="0.3" />
        <path d="M12 6 L17 9 L17 15 L12 18 L7 15 L7 9 Z" fill="#FFFFFF" />
      </svg>
    </div>
  );
}
