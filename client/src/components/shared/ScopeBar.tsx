import type { ReactNode } from "react";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * شريط النطاق (Theme Spec §3): «كل الأنشطة» أو نشاط واحد بعلامة لونية — رقائق اختيار أحادية
 * (`aria-pressed`) ≥44px، تمرير أفقي داخل الشريط، ومكان لرقائق فلاتر إضافية (`children`).
 * اللون يأتي من بيانات النشاط إن وُجد (`color`)؛ وإلا أول حرف على سطح `accent` — لا ألوان مخترعة.
 *
 * Matjarak 2.0 (1C-5C): تحت v2 فقط — شريط مقسّم محايد: الحاوية سطح ناعم بزوايا pill، والرقائق غير المختارة بلا حد
 * ولا خلفية، والمختارة سطح `card` مرفوع بظل وحد محايد ونص أساسي. علامة النشاط (لونه أو حرفه على `accent`) زي ما هي.
 */
export type ScopeOption = { id: string | number; label: string; color?: string | null };

export type ScopeBarProps = {
  options: ScopeOption[];
  /** `null` = كل الأنشطة */
  value: string | number | null;
  onChange: (id: string | number | null) => void;
  allLabel?: string;
  children?: ReactNode;
  className?: string;
};

export function ScopeBar({ options, value, onChange, allLabel = "كل الأنشطة", children, className }: ScopeBarProps) {
  const chip = "flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--radius-brand-pill)] border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const on = "border-primary/40 bg-primary-soft text-primary-text brand-v2:border-border brand-v2:bg-card brand-v2:text-foreground brand-v2:shadow-sm";
  const off = "border-border bg-card text-muted-foreground hover:text-foreground brand-v2:border-transparent brand-v2:bg-transparent brand-v2:hover:bg-card/60";
  return (
    <div className={cn("rounded-[var(--radius-brand-md)] bg-surface-2 px-2 py-1.5 brand-v2:rounded-[var(--radius-brand-pill)] brand-v2:border brand-v2:border-border/60 brand-v2:p-1", className)} data-readonly-safe data-testid="scope-bar">
      <div role="group" aria-label="نطاق العرض" className="flex items-center gap-2 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden brand-v2:gap-1">
        <button type="button" aria-pressed={value == null} onClick={() => onChange(null)} className={cn(chip, value == null ? on : off)} data-testid="scope-all">
          <LayoutGrid className="h-4 w-4 shrink-0" aria-hidden="true" />
          {allLabel}
        </button>
        {options.map(o => {
          const active = value != null && String(value) === String(o.id);
          return (
            <button key={String(o.id)} type="button" aria-pressed={active} onClick={() => onChange(o.id)} className={cn(chip, active ? on : off)} data-testid={`scope-${o.id}`}>
              {o.color ? (
                <span className="h-3 w-3 shrink-0 rounded-sm border border-border" style={{ backgroundColor: o.color }} aria-hidden="true" />
              ) : (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground" aria-hidden="true">{o.label.trim().charAt(0)}</span>
              )}
              <span className="whitespace-nowrap">{o.label}</span>
            </button>
          );
        })}
        {children && <span className="mx-1 hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}
