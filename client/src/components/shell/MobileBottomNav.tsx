import { useLocation } from "wouter";
import { useSidebar } from "@/components/ui/sidebar";
import { MORE_ICON, activeDestinationKey, type NavDestination } from "@/config/navigation";

/**
 * تنقّل الموبايل السفلي — أهم الوجهات في متناول الإبهام، مش سايدبار ديسكتوب مضغوطة.
 *
 * بياخد الوجهات **المفلترة بالصلاحيات** من الشل (نفس مصدر السايدبار = NavConfig)، بيعرض
 * أول ٤ + زر «المزيد» اللي بيفتح السايدبار الكامل (باقي الوجهات + الأدوات). الحارس الحقيقي
 * على الـroutes؛ ده تنقّل بس.
 *
 * Theme Spec §5: مناطق لمس ≥ 44px، `type="button"`، احترام `safe-area-inset-bottom`، النشط
 * بالنحاسي (Tokens فقط).
 */
export function MobileBottomNav({ destinations }: { destinations: NavDestination[] }) {
  const [location, setLocation] = useLocation();
  const { setOpenMobile } = useSidebar();
  const activeKey = activeDestinationKey(location);
  const primary = destinations.slice(0, 4);
  const MoreIcon = MORE_ICON;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      dir="rtl"
      aria-label="التنقّل الأساسي"
      data-testid="mobile-bottom-nav"
    >
      {primary.map(dest => {
        const active = dest.key === activeKey;
        return (
          <button
            key={dest.key}
            type="button"
            onClick={() => setLocation(dest.path)}
            className={`flex min-h-[56px] min-w-11 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition-colors ${
              active ? "text-primary-text" : "text-muted-foreground"
            }`}
            aria-current={active ? "page" : undefined}
            data-testid={`bottom-nav-${dest.key}`}
          >
            <dest.icon className={`h-5 w-5 ${active ? "text-primary" : ""}`} aria-hidden="true" />
            <span className="max-w-full truncate">{dest.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setOpenMobile(true)}
        className="flex min-h-[56px] min-w-11 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium text-muted-foreground"
        aria-label="المزيد"
        data-testid="bottom-nav-more"
      >
        <MoreIcon className="h-5 w-5" aria-hidden="true" />
        <span>المزيد</span>
      </button>
    </nav>
  );
}
