import { Phone, Truck } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * خلية المحاولات — نوعان **لا يُخلطان أبدًا**:
 *   • محاولات الاتصال (من `noAnswerCallAttempts`، عدد الجولة الحالية) — تُعرض كـ«اتصال».
 *   • محاولات توصيل شركة الشحن — لا عمود يخزّنها اليوم؛ عند غيابها (`null`/`undefined`) تُعرض «غير متاح»
 *     بلا رقم ولا نقاط، ولا تُستنتج من محاولات الاتصال.
 */
export type AttemptsCellProps = {
  callAttempts?: number | null;
  deliveryAttempts?: number | null;
  /** الحد الأقصى لمحاولات التوصيل عند توفر مصدر حقيقي (افتراضي 3 كما في Theme Spec) */
  deliveryMax?: number;
  className?: string;
};

export const UNAVAILABLE_LABEL = "غير متاح";

export function AttemptsCell({ callAttempts, deliveryAttempts, deliveryMax = 3, className }: AttemptsCellProps) {
  const hasDelivery = deliveryAttempts != null && Number.isFinite(deliveryAttempts) && deliveryAttempts >= 0;
  const hasCalls = callAttempts != null && Number.isFinite(callAttempts) && callAttempts >= 0;
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 text-xs leading-tight", className)} data-testid="attempts-cell">
      <span className="flex items-center gap-1" data-testid="attempts-delivery" data-state={hasDelivery ? "known" : "unavailable"}>
        <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">توصيل:</span>
        {hasDelivery ? (
          <>
            <span className="font-en tabular-nums text-foreground">{deliveryAttempts}/{deliveryMax}</span>
            <span className="flex items-center gap-0.5" aria-hidden="true">
              {Array.from({ length: deliveryMax }).map((_, i) => (
                <span key={i} className={cn("h-1.5 w-1.5 rounded-full", i < (deliveryAttempts as number) ? "bg-foreground" : "bg-border")} />
              ))}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{UNAVAILABLE_LABEL}</span>
        )}
      </span>
      {hasCalls && (
        <span className="flex items-center gap-1" data-testid="attempts-calls">
          <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">اتصال:</span>
          <span className="font-en tabular-nums text-foreground">{callAttempts}</span>
        </span>
      )}
    </div>
  );
}
