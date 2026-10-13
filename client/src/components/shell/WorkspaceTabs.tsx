import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import type { NavLink } from "@/config/navigation";

/**
 * تبويبات الـWorkspace — التنقّل الثانوي داخل الوجهة الواحدة.
 *
 * فلسفة V2: بدل «كل feature = بند في السايدبار»، الوجهة الأساسية (الطلبات/المخزون…) بتفتح
 * workspace، والتفاصيل تبويبات فوق المحتوى. بيتبني من نفس NavConfig (أبناء الوجهة المرئية)
 * فمفيش تعريف تنقّل تاني.
 *
 * بيظهر بس لما الوجهة فيها أكتر من تبويب مرئي. على الشاشات الضيقة التبويبات **لا تنكمش ولا
 * تتراكب** (`shrink-0` يلغي أثر القاعدة العامة `.flex{min-width:0}`) والتمرير أفقي **داخل
 * المكوّن نفسه** (`overflow-x-auto`) لا على الصفحة؛ والتبويب النشط يُمرَّر إلى مجال الرؤية عند
 * تغيّره. Theme Spec §3: تبويبات بخط سفلي نحاسي 2px، نص نحاسي للنشط، ارتفاع ≥ 44px.
 */
export function WorkspaceTabs({ tabs }: { tabs: NavLink[] }) {
  const [location, setLocation] = useLocation();
  const activeRef = useRef<HTMLButtonElement | null>(null);
  // الأكثر تحديدًا يفوز: «/ledger/payroll» لا يُنسب لتبويب «/ledger» لمجرد أنه بادئته
  const activePath = tabs.filter(tab => location === tab.path || location.startsWith(tab.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;

  useEffect(() => {
    const el = activeRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [activePath]);

  if (tabs.length < 2) return null;

  return (
    <div className="border-b border-border bg-background" dir="rtl" data-readonly-safe data-testid="workspace-tabs">
      <nav
        className="flex items-stretch gap-1 overflow-x-auto overflow-y-hidden px-1 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden"
        aria-label="تبويبات القسم"
      >
        {tabs.map(tab => {
          const active = tab.path === activePath;
          return (
            <button data-readonly-safe
              key={tab.path}
              type="button"
              ref={active ? activeRef : undefined}
              onClick={() => setLocation(tab.path)}
              className={`relative flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "text-primary-text"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              aria-current={active ? "page" : undefined}
              data-testid={`workspace-tab-${tab.path}`}
            >
              <tab.icon className="h-4 w-4 shrink-0" />
              {tab.label}
              {active && (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
