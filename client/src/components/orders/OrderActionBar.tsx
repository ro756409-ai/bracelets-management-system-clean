import type { ReactNode } from "react";
import { CheckCircle, Clock, MoreVertical, PhoneOff, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WhatsAppButton } from "@/components/shared";
import { cn } from "@/lib/utils";

/**
 * شريط إجراءات الأوردر (المرحلة 7B): ثابت أسفل الشاشة على الموبايل (فوق MobileBottomNav)، وعادي على الديسكتوب.
 * عرض فقط: الصفحة تقرّر ما المسموح (`can*`) وما القابل للتنفيذ (`actionable`) وتمرّر `pending` لتعطيل كل الأزرار
 * أثناء أي mutation. ما ليس مسموحًا لا يُرسم أصلًا. كل زر ≥44px على الموبايل.
 */
export type OrderActionBarProps = {
  phone?: string | null;
  /** الأوردر بحالة تقبل التأكيد/الإلغاء/التأجيل/«لم يرد» (new/postponed) */
  actionable: boolean;
  can: { confirm: boolean; cancel: boolean; postpone: boolean; noAnswer: boolean };
  pending: { confirm?: boolean; cancel?: boolean; postpone?: boolean; noAnswer?: boolean; any: boolean };
  onConfirm: () => void;
  onCancel: () => void;
  onPostpone: () => void;
  onNoAnswer: () => void;
  /** بنود «المزيد» — مفلترة بالصلاحية من الصفحة */
  more?: Array<{ key: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; destructive?: boolean }>;
  className?: string;
};

export function OrderActionBar({ phone, actionable, can, pending, onConfirm, onCancel, onPostpone, onNoAnswer, more = [], className }: OrderActionBarProps) {
  const showConfirm = actionable && can.confirm;
  const showCancel = actionable && can.cancel;
  const showPostpone = actionable && can.postpone;
  const showNoAnswer = actionable && can.noAnswer;
  const nothing = !showConfirm && !showCancel && !showPostpone && !showNoAnswer && !phone && more.length === 0;
  if (nothing) return null;
  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30 border-t border-border bg-background/95 px-3 py-2 backdrop-blur",
        "md:static md:z-auto md:rounded-[var(--radius-brand-md)] md:border md:bg-card md:px-4 md:py-3 md:shadow-[var(--shadow-card)]",
        className
      )}
      role="toolbar"
      aria-label="إجراءات الأوردر"
      aria-busy={pending.any || undefined}
      data-testid="order-action-bar"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
        {showConfirm && (
          <Button type="button" className="min-h-11 flex-1 gap-1 bg-[var(--success)] text-[var(--success-foreground)] hover:opacity-90 md:flex-none md:min-h-9" disabled={pending.any} aria-busy={pending.confirm || undefined} onClick={onConfirm} data-testid="action-confirm">
            <CheckCircle className="h-4 w-4" aria-hidden="true" /> {pending.confirm ? "جارٍ التأكيد…" : "تأكيد"}
          </Button>
        )}
        {showCancel && (
          <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1 border-destructive/30 text-destructive md:flex-none md:min-h-9" disabled={pending.any} onClick={onCancel} data-testid="action-cancel">
            <XCircle className="h-4 w-4" aria-hidden="true" /> إلغاء
          </Button>
        )}
        {showPostpone && (
          <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1 md:flex-none md:min-h-9" disabled={pending.any} onClick={onPostpone} data-testid="action-postpone">
            <Clock className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" /> تأجيل
          </Button>
        )}
        {showNoAnswer && (
          <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1 md:flex-none md:min-h-9" disabled={pending.any} onClick={onNoAnswer} data-testid="action-no-answer">
            <PhoneOff className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" /> لم يرد
          </Button>
        )}
        {phone !== undefined && <WhatsAppButton phone={phone} size="sm" className="min-h-11 flex-1 md:flex-none md:min-h-9" />}
        {more.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" className="min-h-11 gap-1 md:min-h-9" disabled={pending.any} aria-label="المزيد من الإجراءات" data-testid="action-more">
                <MoreVertical className="h-4 w-4" aria-hidden="true" /> المزيد
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {more.map(m => (
                <DropdownMenuItem key={m.key} className={cn("min-h-11 md:min-h-9", m.destructive && "text-destructive focus:text-destructive")} disabled={m.disabled} onClick={m.onSelect} data-testid={`action-more-${m.key}`}>
                  {m.icon}{m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
