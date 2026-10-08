import { UserX } from "lucide-react";
import { ORDER_STATUS, ReviewAttentionBanner, ScopeBar, UnderlineTabs, type UnderlineTab } from "@/components/shared";
import { cn } from "@/lib/utils";

/**
 * رأس صفحة الأوردرات (المرحلة 4) — **عرض فقط**: نطاق النشاط + تبويبات الحالة + شريط «بانتظار قرار».
 * كل القيم تأتي من الصفحة (`Orders.tsx`) التي تملك الاستعلامات والحالة؛ هنا لا tRPC ولا منطق أعمال.
 *
 *   • ScopeBar يقرأ/يكتب نفس `BusinessContext` الذي يستخدمه مبدّل النشاط في الـShell (مصدر واحد).
 *   • UnderlineTabs: «الكل» + الحالات العشر بنفس أسمائها وقيمها + «مؤكدات اليوم» (وضع منفصل، مفتاح `__today__`).
 *   • العدّادات حقيقية من `statusCounts`/`todayConfirmed`؛ غياب الرقم = لا عدّاد (لا صفر مخترع).
 */
export const TODAY_TAB_KEY = "__today__";
export const ALL_TAB_KEY = "all";

/** ترتيب تبويبات الحالة — نفس ترتيب شرائح الحالة السابقة في الصفحة. */
export const ORDER_STATUS_TAB_ORDER = ["new", "confirmed", "no_answer", "postponed", "printed", "preparing", "shipped", "delivered", "cancelled", "returned"] as const;

export type OrdersTabsProps = {
  businesses: Array<{ id: number; name: string }>;
  /** `null` = كل الأنشطة */
  scopeValue: number | null;
  onScopeChange: (id: number | null) => void;
  statusCounts?: { total?: number; byStatus?: Record<string, number | undefined>; needsReview?: number } | null;
  todayCount?: number | null;
  /** مفتاح الحالة النشطة، أو `all`، أو `__today__` */
  value: string;
  onChange: (key: string) => void;
  statusLabel: (key: string) => string;
  unassigned: { active: boolean; disabled: boolean; count?: number | null; onToggle: () => void };
  className?: string;
};

export function OrdersTabs({ businesses, scopeValue, onScopeChange, statusCounts, todayCount, value, onChange, statusLabel, unassigned, className }: OrdersTabsProps) {
  const tabs: UnderlineTab[] = [
    { key: ALL_TAB_KEY, label: "الكل", count: statusCounts?.total ?? null },
    ...ORDER_STATUS_TAB_ORDER.map((key): UnderlineTab => ({ key, label: statusLabel(key), count: statusCounts?.byStatus?.[key] ?? null, icon: ORDER_STATUS[key]?.icon })),
    { key: TODAY_TAB_KEY, label: "مؤكدات اليوم", count: todayCount ?? null },
  ];

  const unassignedChip = (
    <button
      type="button"
      aria-pressed={unassigned.active}
      disabled={unassigned.disabled}
      onClick={unassigned.onToggle}
      title={unassigned.disabled ? "غير متاح أثناء الفلترة بموظف محدد" : "عرض الأوردرات اللي مالهاش موظف مسؤول"}
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-brand-pill)] border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        unassigned.active ? "border-[var(--warning)]/60 bg-[var(--warning)]/15 text-[var(--warning)]" : "border-border bg-card text-muted-foreground hover:text-foreground"
      )}
      data-testid="orders-unassigned-toggle"
    >
      <UserX className="h-4 w-4" aria-hidden="true" />
      الأوردرات غير الموزعة
      {unassigned.active && unassigned.count != null && (
        <span className="rounded-[var(--radius-brand-pill)] bg-[var(--warning)]/20 px-1.5 text-xs font-bold tabular-nums">{Number(unassigned.count).toLocaleString("ar-EG")}</span>
      )}
    </button>
  );

  return (
    <div className={cn("space-y-3", className)} data-testid="orders-tabs">
      <ReviewAttentionBanner count={statusCounts?.needsReview} />
      {businesses.length > 1 ? (
        <ScopeBar options={businesses.map(b => ({ id: b.id, label: b.name }))} value={scopeValue} onChange={id => onScopeChange(id == null ? null : Number(id))}>
          {unassignedChip}
        </ScopeBar>
      ) : (
        <div className="flex items-center gap-2">{unassignedChip}</div>
      )}
      <UnderlineTabs tabs={tabs} value={value} onChange={onChange} ariaLabel="حالات الأوردرات" />
    </div>
  );
}
