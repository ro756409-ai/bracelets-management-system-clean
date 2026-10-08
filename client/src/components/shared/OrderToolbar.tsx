import { useId, type FormEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * شريط أدوات الجدول (Theme Spec §3): يمين = أيقونة + عنوان + عدد اختياري؛ وسط = بحث بحقل محدد
 * (رقم الأوردر/الهاتف/الاسم/AWB…) يُرسل عند Enter أو زر «بحث»؛ يسار = إجراءات (تصفية/تحميل…).
 * بلا منطق أعمال: الصفحة تمرّر الحقول وتستقبل `{field, query}`. كل عنصر تفاعلي ≥44px.
 */
export type SearchField = { id: string; label: string };
export type OrderSearch = { field: string; query: string };

export type OrderToolbarProps = {
  title: string;
  icon?: ReactNode;
  /** عدد حقيقي من الاستعلام؛ `null` = لا عدد (لا نخترع صفرًا) */
  count?: number | null;
  countLabel?: string;
  fields: SearchField[];
  search: OrderSearch;
  onSearchChange: (next: OrderSearch) => void;
  onSubmit: (search: OrderSearch) => void;
  actions?: ReactNode;
  className?: string;
};

export function OrderToolbar({ title, icon, count, countLabel = "أوردر", fields, search, onSearchChange, onSubmit, actions, className }: OrderToolbarProps) {
  const inputId = useId();
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(search); };
  const current = fields.find(f => f.id === search.field) ?? fields[0];
  return (
    <div className={cn("flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between", className)} data-testid="order-toolbar">
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground" aria-hidden="true">{icon}</span>}
        <h2 className="truncate text-base font-bold">{title}</h2>
        {count != null && <span className="rounded-[var(--radius-brand-pill)] bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums" data-testid="order-toolbar-count">{count} {countLabel}</span>}
      </div>

      <form onSubmit={submit} role="search" aria-label="بحث في الأوردرات" className="flex min-w-0 flex-1 flex-wrap items-center gap-2 lg:max-w-xl">
        <Select value={current?.id} onValueChange={field => onSearchChange({ ...search, field })}>
          <SelectTrigger className="min-h-11 w-[9.5rem] shrink-0" aria-label="حقل البحث" data-testid="order-toolbar-field">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {fields.map(f => <SelectItem key={f.id} value={f.id} className="min-h-11 md:min-h-9">{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <label htmlFor={inputId} className="sr-only">{`بحث حسب ${current?.label ?? ""}`}</label>
        <Input id={inputId} value={search.query} onChange={e => onSearchChange({ ...search, query: e.target.value })} placeholder={current ? `ابحث بـ${current.label}` : "بحث"} className="min-h-11 min-w-0 flex-1" inputMode="search" data-testid="order-toolbar-input" />
        <Button type="submit" variant="secondary" className="min-h-11 shrink-0 gap-1" data-testid="order-toolbar-submit">
          <Search className="h-4 w-4" aria-hidden="true" />
          بحث
        </Button>
      </form>

      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
