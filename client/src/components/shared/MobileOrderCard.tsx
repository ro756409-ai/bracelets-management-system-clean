import type { ReactNode } from "react";
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
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]",
        className
      )}
    >
      <div
        className={cn("space-y-2 p-3", onClick && "cursor-pointer")}
        onClick={onClick}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold">{customerName}</span>
              {statusBadge}
              {sourceBadge}
            </div>
            {warnings && <div className="flex flex-wrap gap-1">{warnings}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-left">
            <span className="font-mono text-xs text-muted-foreground">{orderNumber}</span>
            {dateLabel && <span className="text-[11px] text-muted-foreground">{dateLabel}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {customerPhone && (
            <span className="flex items-center gap-1">
              <Phone className="h-3.5 w-3.5" />
              <span dir="ltr">{customerPhone}</span>
            </span>
          )}
          {governorate && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" />
              {governorate}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={productSummary}>{productSummary}</span>
          <span className="shrink-0 font-semibold tabular-nums">{total}</span>
        </div>

        {onToggle && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex w-full items-center justify-center gap-1 border-t border-border pt-2 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" /> إخفاء التفاصيل
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" /> عرض التفاصيل
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
