import type { KeyboardEvent, ReactNode } from "react";
import { ChevronDown, ChevronUp, MapPin, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

export type MobileOrderCardProps = {
  orderNumber: string;
  customerName: string;
  customerPhone?: string;
  governorate?: string;
  /** Rendered as-is — pass a StatusBadge. */
  statusBadge: ReactNode;
  /** Rendered as-is — pass a StatusBadge for the source/channel. */
  sourceBadge?: ReactNode;
  productSummary: string;
  total: ReactNode;
  dateLabel?: string;
  expanded?: boolean;
  onToggle?: () => void;
  /** Extra badges (needsReview, duplicate, …) shown next to the status. */
  warnings?: ReactNode;
  /** Shown only while expanded — full address, notes, action buttons. */
  details?: ReactNode;
  onClick?: () => void;
  className?: string;
};

/**
 * The order-list row for phones. This replaces dragging a 9-column table sideways: a
 * customer's name, phone, status and total are the only things visible until the card is
 * opened, and everything else lives behind "expand" rather than being squeezed into cells.
 *
 * الوصول (المرحلة 3): البطاقة القابلة للنقر `role="button"` في ترتيب التركيز وتستجيب لـEnter/Space،
 * واسم الوصول يحمل رقم الأوردر؛ زر التفاصيل ≥44px بـ`aria-expanded`؛ الرقم والهاتف بخط DM Sans واتجاه LTR.
 */
export function MobileOrderCard({
  orderNumber,
  customerName,
  customerPhone,
  governorate,
  statusBadge,
  sourceBadge,
  productSummary,
  total,
  dateLabel,
  expanded = false,
  onToggle,
  warnings,
  details,
  onClick,
  className,
}: MobileOrderCardProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onClick) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
  };
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]",
        className
      )}
      data-testid="mobile-order-card"
    >
      <div
        className={cn("space-y-2.5 p-3.5", onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
        onClick={onClick}
        onKeyDown={onKeyDown}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={onClick ? `فتح الأوردر ${orderNumber} — ${customerName}` : undefined}
        // فتح الأوردر قراءة (تنقّل للتفاصيل) — منطقة الفتح فيها معلومات وزر طيّ فقط؛ التفاصيل (وأي إجراء كتابة) خارجها.
        data-readonly-safe
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-base font-bold">{customerName}</span>
              {statusBadge}
              {sourceBadge}
            </div>
            {warnings && <div className="flex flex-wrap gap-1">{warnings}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-end">
            <span className="font-en text-xs text-muted-foreground tabular-nums" dir="ltr">{orderNumber}</span>
            {dateLabel && <span className="text-[11px] text-muted-foreground">{dateLabel}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {customerPhone && (
            <span className="flex items-center gap-1">
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="font-en tabular-nums" dir="ltr">{customerPhone}</span>
            </span>
          )}
          {governorate && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {governorate}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-foreground/90" title={productSummary}>{productSummary}</span>
          <span className="shrink-0 font-bold tabular-nums">{total}</span>
        </div>

        {onToggle && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="flex min-h-11 w-full items-center justify-center gap-1 border-t border-border pt-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> إخفاء التفاصيل
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> عرض التفاصيل
              </>
            )}
          </button>
        )}
      </div>

      {expanded && details && (
        <div className="border-t border-border bg-muted/30 p-3">{details}</div>
      )}
    </div>
  );
}
