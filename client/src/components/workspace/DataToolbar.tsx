import { useState, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { SearchInput, Drawer, type FilterChip } from "@/components/shared";
import { Button } from "@/components/ui/button";

/**
 * شريط أدوات موحّد فوق جداول الـWorkspace — **superset لكل ما يقدمه `FilterBar` المشترك** +
 * فلاتر متقدمة في Drawer. الهدف: تقليل الزحام مع **صفر فقد وظيفة**.
 *
 * بيدعم: بحث (SearchInput بديباونس) · فلاتر أساسية ظاهرة دائمًا · **شرائح الفلاتر النشطة
 * (chips)** · **مسح فلتر واحد / مسح الكل (reset)** · **Advanced Filters Drawer** · **badge**
 * بعدد الفلاتر المتقدمة النشطة. لا يعرف شيئًا عن الـAPI/النطاق — الصفحة تمرّر القيم والفلاتر،
 * فيبقى منطق الفلترة وعزل البيانات في يد الصفحة/السيرفر (إعادة تنظيم UI فقط).
 */
export function DataToolbar({
  search,
  onSearch,
  searchPlaceholder,
  /** فلاتر أساسية ظاهرة دائمًا (Select/date…). */
  filters,
  /** فلاتر متقدمة تظهر في Drawer عند الطلب. */
  advancedFilters,
  /** عدد الفلاتر المتقدمة المفعّلة — يبان كـbadge على زر «فلاتر متقدمة». */
  advancedActiveCount = 0,
  /** شرائح الفلاتر النشطة (نفس عقد FilterBar). */
  chips = [],
  onClearChip,
  onReset,
  /** إجراءات جهة البداية (تصدير/إضافة…) — هادية. */
  actions,
}: {
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  filters?: ReactNode;
  advancedFilters?: ReactNode;
  advancedActiveCount?: number;
  chips?: FilterChip[];
  onClearChip?: (key: string) => void;
  onReset?: () => void;
  actions?: ReactNode;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-3" dir="rtl">
      <div className="flex flex-wrap items-center gap-2">
        {onSearch && (
          <SearchInput
            value={search ?? ""}
            onChange={onSearch}
            placeholder={searchPlaceholder ?? "بحث…"}
            className="min-w-0 flex-1 lg:max-w-xs"
          />
        )}

        {filters}

        {advancedFilters && (
          <Button variant="outline" size="sm" className="h-9 shrink-0 gap-1.5" onClick={() => setAdvancedOpen(true)}>
            <SlidersHorizontal className="h-4 w-4" />
            فلاتر متقدمة
            {advancedActiveCount > 0 && (
              <span className="ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-primary-foreground tabular-nums">
                {advancedActiveCount}
              </span>
            )}
          </Button>
        )}

        {onReset && chips.length > 0 && (
          <Button variant="ghost" className="h-9 shrink-0 gap-1 text-muted-foreground" onClick={onReset}>
            <X className="h-4 w-4" />
            <span className="hidden sm:inline">مسح الفلاتر</span>
          </Button>
        )}

        {actions && <div className="ms-auto flex items-center gap-2">{actions}</div>}
      </div>

      {/* شرائح الفلاتر النشطة — نفس شكل FilterBar بالظبط (backward compatible). */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">مُفلتر بـ:</span>
          {chips.map(chip => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-[var(--radius-brand-pill)] border border-border bg-muted px-2 py-1 text-xs"
            >
              <span className="text-muted-foreground">{chip.label}:</span>
              <span className="font-medium">{chip.value}</span>
              {onClearChip && (
                <button
                  type="button"
                  onClick={() => onClearChip(chip.key)}
                  aria-label={`إزالة فلتر ${chip.label}`}
                  className="rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {advancedFilters && (
        <Drawer open={advancedOpen} onOpenChange={setAdvancedOpen} title="فلاتر متقدمة" width="sm">
          <div className="grid gap-4">{advancedFilters}</div>
        </Drawer>
      )}
    </div>
  );
}
