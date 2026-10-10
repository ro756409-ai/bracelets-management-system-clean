import { AlertTriangle, MessageSquareOff, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** حالات مركز الرسائل بأهداف لمس 44px (الحالات المشتركة تبقى كما هي لباقي الصفحات). */
export function MessagingError({ message, onRetry, compact }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={compact ? "space-y-2 p-3 text-center" : "flex flex-col items-center gap-3 px-4 py-10 text-center"} role="alert" data-testid="messaging-error">
      {!compact && <AlertTriangle className="h-7 w-7 text-destructive" aria-hidden="true" />}
      <p className="text-sm">{message}</p>
      {onRetry && (
        <Button type="button" variant="outline" className="min-h-11 gap-1.5" onClick={onRetry} data-readonly-safe>
          <RotateCcw className="h-4 w-4" aria-hidden="true" /> إعادة المحاولة
        </Button>
      )}
    </div>
  );
}

/** العلم معطّل أو المركز غير متاح: لا روابط ولا طلبات إضافية. */
export function MessagingUnavailable() {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center" role="status" data-testid="messaging-unavailable">
      <MessageSquareOff className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-semibold">مركز الرسائل غير متاح</p>
      <p className="max-w-sm text-sm text-muted-foreground">هذه الميزة غير مفعّلة بعد لحسابك.</p>
    </div>
  );
}
