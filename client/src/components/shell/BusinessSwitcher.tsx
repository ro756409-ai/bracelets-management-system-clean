import { Check, ChevronDown, Store } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * مبدّل الأنشطة (Business/Section Switcher) — ثابت في الشل.
 *
 * **بيستهلك المصدر المعتمد الوحيد** (`BusinessContext`): نطاق الجلسة multi-business بيتحدد
 * بالمجموعة الحالية (`currentGroupId` → `currentBusinessIds`)، ومفيش مصدر جديد ولا
 * hand-derive. تغيير الاختيار بيغيّر نطاق كل الصفحات — نفس السلوك الحالي، بس واضح ومبرز.
 *
 * ملاحظة: النطاق group-based زي ما هو في الـbackend — Phase 1 مابتغيّرش business scoping.
 */
export function BusinessSwitcher() {
  const { groups, currentGroupId, setCurrentGroupId } = useBusinessContext();

  // نشاط/قسم واحد أو أقل → مفيش داعي لمبدّل (multi-business ready لكن مانزحمش الواجهة).
  if (!groups || groups.length === 0) return null;

  const current = currentGroupId != null ? groups.find(g => g.id === currentGroupId) : undefined;
  const label = current?.name ?? "كل الأنشطة";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-9 items-center gap-2 rounded-[var(--radius-brand-md)] border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="تبديل النشاط"
        >
          <Store className="h-4 w-4 text-muted-foreground" />
          <span className="max-w-[10rem] truncate">{label}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>النشاط الحالي</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setCurrentGroupId(undefined)} className="cursor-pointer justify-between">
          <span>كل الأنشطة</span>
          {currentGroupId == null && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
        {groups.map(g => (
          <DropdownMenuItem
            key={g.id}
            onClick={() => setCurrentGroupId(g.id)}
            className="cursor-pointer justify-between"
          >
            <span className="truncate">{g.name}</span>
            {currentGroupId === g.id && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
