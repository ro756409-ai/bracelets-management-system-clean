import { useLocation } from "wouter";
import { useSidebar } from "@/components/ui/sidebar";
import { MORE_ICON, activeDestinationKey, type NavDestination } from "@/config/navigation";

/**
 * تنقّل الموبايل السفلي — أهم الوجهات في متناول الإبهام، مش سايدبار ديسكتوب مضغوطة.
 *
 * بياخد الوجهات **المفلترة بالصلاحيات** من الشل (نفس مصدر السايدبار = NavConfig)، بيعرض
 * أول ٤ + زر «المزيد» اللي بيفتح السايدبار الكامل (باقي الوجهات + الأدوات). الحارس الحقيقي
 * على الـroutes؛ ده تنقّل بس.
 */
export function MobileBottomNav({ destinations }: { destinations: NavDestination[] }) {
  const [location, setLocation] = useLocation();
  const { setOpenMobile } = useSidebar();
  const activeKey = activeDestinationKey(location);
  const primary = destinations.slice(0, 4);
  const MoreIcon = MORE_ICON;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch border-t border-border bg-card/95 backdrop-blur md:hidden"
      dir="rtl"
      aria-label="التنقّل الأساسي"
    >
      {primary.map(dest => {
        const active = dest.key === activeKey;
        return (
          <button
            key={dest.key}
            onClick={() => setLocation(dest.path)}
            className={`flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
              active ? "text-primary" : "text-muted-foreground"
            }`}
            aria-current={active ? "page" : undefined}
          >
            <dest.icon className={`h-5 w-5 ${active ? "text-primary" : ""}`} />
            <span className="truncate">{dest.label}</span>
          </button>
        );
      })}
      <button
        onClick={() => setOpenMobile(true)}
        className="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground"
        aria-label="المزيد"
      >
        <MoreIcon className="h-5 w-5" />
        <span>المزيد</span>
      </button>
    </nav>
  );
}
