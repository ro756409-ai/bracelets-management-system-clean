import { Check, ChevronDown, Store } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * مبدّل الأنشطة (Business Switcher) — ثابت في الشل.
 *
 * **Business هو وحدة النطاق** (Sprint 2): «كل الأنشطة» أو نشاط واحد محدد. المصدر المعتمد
 * الوحيد `BusinessContext.businesses` (من `businesses.activeList`، tenant-scoped) — بيكبر
 * تلقائيًا لأي نشاط جديد بدون كود خاص. تغيير الاختيار بيغيّر نطاق كل الشاشات عبر
 * `currentBusinessId → currentBusinessIds`.
 *
 * المجموعات (Groups) طبقة **تنظيم بصري اختيارية** فقط — بتظهر كعناوين تجمّع الأنشطة، لكن
 * **اختيار مجموعة مايغيّرش النطاق** ولا فيه multi-select. عزل الموظف بيفضل على السيرفر
 * (`sessionBusinessIds`) — الاختيار هنا مايوسّعش وصول أبدًا، والسيرفر بيقصّ أي نطاق مُرسل.
 */
export function BusinessSwitcher() {
  const { businesses, groups, currentBusinessId, setCurrentBusinessId } = useBusinessContext();

  // نشاط واحد أو أقل → مفيش داعي لمبدّل (multi-business ready، لكن مانزحمش الواجهة).
  if (!businesses || businesses.length <= 1) return null;

  const current = currentBusinessId != null ? businesses.find(b => b.id === currentBusinessId) : undefined;
  const label = current?.name ?? "كل الأنشطة";

  // ترتيب الأنشطة حسب المجموعة (عناوين بصرية اختيارية)، والأنشطة بلا مجموعة في الآخر.
  const groupName = (gid: number | null) => (gid != null ? groups.find(g => g.id === gid)?.name : undefined);
  const sorted = [...businesses].sort((a, b) => {
    const ga = groupName(a.groupId) ?? "￿"; // بلا مجموعة → آخر القائمة
    const gb = groupName(b.groupId) ?? "￿";
    return ga === gb ? a.name.localeCompare(b.name, "ar") : ga.localeCompare(gb, "ar");
  });

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
      <DropdownMenuContent align="start" className="max-h-[70vh] w-60 overflow-y-auto">
        <DropdownMenuItem onClick={() => setCurrentBusinessId(undefined)} className="cursor-pointer justify-between font-medium">
          <span>كل الأنشطة</span>
          {currentBusinessId == null && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sorted.map((b, i) => {
          const gName = groupName(b.groupId);
          const prevGName = i > 0 ? groupName(sorted[i - 1].groupId) : undefined;
          // عنوان المجموعة بيظهر أول ما تتغيّر المجموعة (تنظيم بصري فقط).
          const showHeader = gName != null && gName !== prevGName;
          return (
            <div key={b.id}>
              {showHeader && <DropdownMenuLabel className="text-xs text-muted-foreground">{gName}</DropdownMenuLabel>}
              <DropdownMenuItem
                onClick={() => setCurrentBusinessId(b.id)}
                className="cursor-pointer justify-between"
              >
                <span className="truncate">{b.name}</span>
                {currentBusinessId === b.id && <Check className="h-4 w-4 text-primary" />}
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
