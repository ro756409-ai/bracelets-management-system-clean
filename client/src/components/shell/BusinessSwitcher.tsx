import { Check, ChevronDown, LayoutGrid } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { BusinessAvatar } from "@/components/BusinessAvatar";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * هوية النشاط + مبدّل الأنشطة (Business Switcher) — رأس القائمة الجانبية وشريط الموبايل.
 *
 * بيعرض **اسم البراند ولوجو النشاط الفعّال** من قاعدة البيانات (أو أول حرف لو مفيش
 * لوجو). المصدر المعتمد الوحيد `BusinessContext.businesses` (من `businesses.activeList`،
 * بنطاق الجلسة على السيرفر): المالك بيشوف أنشطته، والموظف نشاطه بس.
 *
 *   • نشاط واحد متاح → متحدد تلقائيًا، والرأس **مش زرارًا** (مفيش قائمة).
 *   • أكتر من نشاط → الضغط يفتح قائمة الأنشطة المصرّح بها بس (+ «كل الأنشطة»).
 *
 * الاختيار هنا بيغيّر نطاق كل الشاشات عبر `currentBusinessId → currentBusinessIds`،
 * ومايوسّعش وصول أبدًا — السيرفر بيقصّ أي نطاق مُرسل (`scopeBusinessIds`).
 */
export function BusinessSwitcher({
  variant = "topbar",
  collapsed = false,
}: {
  /** sidebar = رأس القائمة الجانبية (على سطح داكن)، topbar = شريط الموبايل. */
  variant?: "sidebar" | "topbar";
  /** السايدبار مطوية على أيقونات → اللوجو/الحرف بس. */
  collapsed?: boolean;
}) {
  const { businesses, groups, currentBusinessId, setCurrentBusinessId, activeBusiness } = useBusinessContext();
  const dark = variant === "sidebar";
  const textColor = dark ? "text-white" : "text-foreground";
  const subColor = dark ? "text-white/60" : "text-muted-foreground";

  const name = activeBusiness?.name ?? (businesses.length > 1 ? "كل الأنشطة" : "");
  const identity = activeBusiness ? (
    <BusinessAvatar name={activeBusiness.name} logoUrl={activeBusiness.logoUrl} className="h-9 w-9" />
  ) : (
    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${dark ? "bg-white/15 text-white" : "bg-muted text-muted-foreground"}`} data-testid="business-all">
      <LayoutGrid className="h-4 w-4" />
    </div>
  );

  const face = (
    <div className="flex min-w-0 items-center gap-2.5" data-testid="business-identity">
      {identity}
      {!collapsed && (
        <div className="min-w-0 text-right">
          <p className={`truncate text-sm font-bold leading-tight ${textColor}`} data-testid="business-name">{name || "—"}</p>
          {businesses.length > 1 && <p className={`text-[11px] ${subColor}`}>تبديل النشاط</p>}
        </div>
      )}
    </div>
  );

  // نشاط واحد (أو لسه ماوصلش) → هوية ثابتة بلا قائمة.
  if (businesses.length <= 1) return face;

  const groupName = (gid: number | null) => (gid != null ? groups.find(g => g.id === gid)?.name : undefined);
  const sorted = [...businesses].sort((a, b) => {
    const ga = groupName(a.groupId) ?? "￿";
    const gb = groupName(b.groupId) ?? "￿";
    return ga === gb ? a.name.localeCompare(b.name, "ar") : ga.localeCompare(gb, "ar");
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`flex min-w-0 items-center gap-2 rounded-[var(--radius-brand-md)] px-1.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dark ? "hover:bg-sidebar-accent" : "hover:bg-muted"}`}
          aria-label="تبديل النشاط"
          data-testid="business-switcher"
        >
          {face}
          {!collapsed && <ChevronDown className={`h-4 w-4 shrink-0 ${subColor}`} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-64 overflow-y-auto">
        <DropdownMenuItem onClick={() => setCurrentBusinessId(undefined)} className="cursor-pointer justify-between font-medium">
          <span>كل الأنشطة</span>
          {currentBusinessId == null && <Check className="h-4 w-4 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {sorted.map((b, i) => {
          const gName = groupName(b.groupId);
          const prevGName = i > 0 ? groupName(sorted[i - 1].groupId) : undefined;
          const showHeader = gName != null && gName !== prevGName;
          return (
            <div key={b.id}>
              {showHeader && <DropdownMenuLabel className="text-xs text-muted-foreground">{gName}</DropdownMenuLabel>}
              <DropdownMenuItem
                onClick={() => setCurrentBusinessId(b.id)}
                className="cursor-pointer justify-between gap-2"
                data-testid={`business-option-${b.id}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <BusinessAvatar name={b.name} logoUrl={b.logoUrl} className="h-6 w-6" textClassName="text-xs" />
                  <span className="truncate">{b.name}</span>
                </span>
                {currentBusinessId === b.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
