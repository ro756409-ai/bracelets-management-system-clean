import { PowerOff } from "lucide-react";

/** نظام الفرق غير مفعّل (TEAMS_ENABLED=false) أو غير متاح — حالة صريحة بلا أي استعلام إضافي. */
export function TeamsUnavailable({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-brand-md)] border border-dashed border-border bg-card px-6 py-12 text-center" role="status" data-testid="teams-unavailable" dir="rtl">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
        <PowerOff className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <p className="font-medium">غير متاح</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{message ?? "نظام الفرق غير مفعّل حاليًا."}</p>
      </div>
    </div>
  );
}
