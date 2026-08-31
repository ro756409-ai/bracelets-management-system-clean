import { useLocation } from "wouter";
import type { NavLink } from "@/config/navigation";

/**
 * تبويبات الـWorkspace — التنقّل الثانوي داخل الوجهة الواحدة.
 *
 * فلسفة V2: بدل «كل feature = بند في السايدبار»، الوجهة الأساسية (الطلبات/المخزون…) بتفتح
 * workspace، والتفاصيل تبويبات فوق المحتوى. بيتبني من نفس NavConfig (أبناء الوجهة المرئية)
 * فمفيش تعريف تنقّل تاني. بيظهر على الديسكتوب بس — الموبايل عنده bottom nav + سايدبار.
 *
 * بيظهر بس لما الوجهة فيها أكتر من تبويب مرئي (وجهة ببند واحد مالهاش داعي لشريط تبويبات).
 */
export function WorkspaceTabs({ tabs }: { tabs: NavLink[] }) {
  const [location, setLocation] = useLocation();
  if (tabs.length < 2) return null;

  return (
    <div className="hidden border-b border-border bg-background md:block" dir="rtl">
      <nav className="flex items-stretch gap-1 overflow-x-auto px-4" aria-label="تبويبات القسم">
        {tabs.map(tab => {
          const active = location === tab.path || location.startsWith(tab.path + "/");
          return (
            <button
              key={tab.path}
              onClick={() => setLocation(tab.path)}
              className={`relative flex items-center gap-2 whitespace-nowrap px-3 py-3 text-sm font-medium transition-colors ${
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
              {active && (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
