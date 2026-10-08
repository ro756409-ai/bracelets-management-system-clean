import { AlertCircle, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * شريط «بانتظار قرار منك» (Theme Spec §3): يظهر فقط عندما يوجد عدد حقيقي > 0 من مصدر حقيقي
 * (مثل عدّاد `needsReview`). خلفية حمراء ناعمة بنص عادي + أيقونة — لا اعتماد على اللون وحده.
 * `role="status"` فيُعلن بهدوء عند تغيّر العدد. زر الإجراء ≥44px ولا يظهر بلا `action`.
 */
export type ReviewAttentionBannerProps = {
  count: number | null | undefined;
  /** يُبنى افتراضيًا من العدد؛ مرّر نصًا كاملًا لتجاوزه. */
  message?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
};

export function ReviewAttentionBanner({ count, message, action, className }: ReviewAttentionBannerProps) {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  const text = message ?? `لديك ${count} ${count === 1 ? "أوردر" : "أوردرات"} بانتظار قرار منك`;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-brand-md)] border border-destructive/30 bg-destructive/10 px-3 py-2", className)}
      data-testid="review-attention-banner"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0">{text}</span>
      </span>
      {action && (
        <button type="button" onClick={action.onClick} className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-semibold text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="review-attention-action">
          {action.label}
          <ChevronLeft className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
