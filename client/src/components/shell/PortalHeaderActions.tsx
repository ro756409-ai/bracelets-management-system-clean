import { useEffect, useState, type ReactNode } from "react";
import { LogOut, MoreHorizontal, type LucideIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * أفعال رأس بوابات الموظفين — مكوّن مشترك. على الهاتف (< 640px): **صف واحد** بلا التفاف: الأفعال المثبّتة +
 * الرسائل + «المزيد» (باقي الأفعال) + الخروج. من 640px: كل الأفعال ظاهرة كما كانت. لا يحذف أي فعل ولا يغيّر
 * صلاحية أو منطقًا: كل فعل نفس onSelect، والمفاتيح (pressed) تبقى مفاتيح داخل القائمة (menuitemcheckbox).
 * أهداف اللمس 44px على الهاتف؛ المحتوى داخل منطقة قراءة آمنة (تنقل/عرض لا كتابة).
 */
export type PortalAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  /** مفتاح عرض (لوحة/فلتر): يُعلن حالته بـaria-pressed ويظهر كخانة اختيار في «المزيد». */
  pressed?: boolean;
  /** يبقى ظاهرًا على الهاتف (الأكثر استخدامًا). */
  pinned?: boolean;
  /** نص قصير بجانب الأيقونة من 640px (مثل «تحديث»). */
  textFromSm?: string;
  /** فاصل قبل هذا الفعل من 640px. */
  separatorBefore?: boolean;
  testId?: string;
};

/**
 * ≥ 640px؟ من matchMedia، ويُعاد التقييم مع حدث change **و** resize (بعض البيئات لا تُرسل change عند تغيير
 * العرض — تدوير جهاز/تغيير حجم نافذة). بلا matchMedia (jsdom/SSR) = عريض، كبقية المكوّنات.
 */
const WIDE = "(min-width: 640px)";
function useWide(): boolean {
  const read = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(WIDE).matches : true);
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(WIDE);
    const update = () => setWide(window.matchMedia(WIDE).matches); // قراءة جديدة في كل تحديث
    update();
    mql.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    return () => { mql.removeEventListener?.("change", update); window.removeEventListener("resize", update); };
  }, []);
  return wide;
}

const BTN = "flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-brand-md)] text-primary-foreground transition-colors md:h-8 md:min-h-8 md:min-w-8";
const tone = (pressed?: boolean) => (pressed ? "bg-primary-foreground/35 hover:bg-primary-foreground/45" : "bg-primary-foreground/10 hover:bg-primary-foreground/20");

export function PortalHeaderActions({ actions, messages, messagesBefore, onLogout }: {
  actions: PortalAction[];
  messages?: ReactNode;
  /** من 640px: مفتاح الفعل الذي تُرسم الرسائل قبله (موضعها الأصلي)؛ بدونه قبل أول فاصل أو في النهاية. */
  messagesBefore?: string;
  onLogout: () => void;
}) {
  const wide = useWide();
  const visible = wide ? actions : actions.filter(a => a.pinned);
  const overflow = wide ? [] : actions.filter(a => !a.pinned);
  const overflowActive = overflow.some(a => a.pressed);
  const anchorKey = wide ? (actions.find(a => a.key === messagesBefore) ?? actions.find(a => a.separatorBefore))?.key : undefined;
  return (
    <div className={cn("flex items-center justify-end gap-1.5", wide ? "flex-wrap" : "flex-nowrap")} data-readonly-safe data-testid="portal-header-actions">
      {visible.map(a => (
        <span key={a.key} className="contents">
          {/* من 640px: الرسائل في مكانها الأصلي */}
          {wide && a.key === anchorKey && messages}
          {a.separatorBefore && wide && <span className="mx-1 h-5 w-px bg-primary-foreground/25" aria-hidden="true" />}
          <button
            type="button"
            onClick={a.onSelect}
            aria-pressed={a.pressed === undefined ? undefined : a.pressed}
            aria-label={a.label}
            title={a.label}
            className={cn(BTN, tone(a.pressed), a.textFromSm && "md:min-w-0 sm:px-2")}
            data-testid={a.testId}
          >
            <a.icon className="h-4 w-4" aria-hidden="true" />
            {a.textFromSm && <span className="hidden text-xs font-medium sm:inline">{a.textFromSm}</span>}
          </button>
        </span>
      ))}
      {(!wide || !anchorKey) && messages}
      {overflow.length > 0 && (
        <DropdownMenu dir="rtl">
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn(BTN, tone(false), "relative")} aria-label="المزيد" title="المزيد" data-testid="portal-header-more">
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              {overflowActive && <span className="absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-primary-foreground" aria-hidden="true" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52" data-readonly-safe>
            {overflow.map(a =>
              a.pressed === undefined ? (
                <DropdownMenuItem key={a.key} className="min-h-11 gap-2" onSelect={a.onSelect} data-testid={a.testId}>
                  <a.icon className="h-4 w-4" aria-hidden="true" /> {a.label}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuCheckboxItem key={a.key} className="min-h-11 gap-2" checked={a.pressed} onCheckedChange={() => a.onSelect()} onSelect={e => e.preventDefault()} data-testid={a.testId}>
                  <a.icon className="h-4 w-4" aria-hidden="true" /> {a.label}
                </DropdownMenuCheckboxItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button type="button" onClick={onLogout} className={cn(BTN, "bg-primary-foreground/10 hover:bg-primary-foreground/25 md:min-w-0 sm:px-2")} aria-label="تسجيل الخروج" title="تسجيل الخروج" data-testid="portal-header-logout">
        <LogOut className="h-4 w-4" aria-hidden="true" />
        <span className="hidden text-xs font-medium sm:inline">خروج</span>
      </button>
    </div>
  );
}
