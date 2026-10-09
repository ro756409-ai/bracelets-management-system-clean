import { useAuth } from "@/_core/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermission";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { LayoutDashboard, PanelRight, ChevronDown } from "lucide-react";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  MORE_ICON, activeDestinationKey, visibleChildren, visibleDestinations, visibleToolsLinks,
} from "@/config/navigation";
import { BusinessSwitcher } from "@/components/shell/BusinessSwitcher";
import { MobileBottomNav } from "@/components/shell/MobileBottomNav";
import { WorkspaceTabs } from "@/components/shell/WorkspaceTabs";
import { CreateMenu } from "@/components/shell/CreateMenu";
import { TopBarActions } from "@/components/shell/TopBar";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { BrandLogo } from './BrandLogo';
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";

/**
 * App Shell — Copper Signature × Clean Spatial (Theme Spec §3), المرحلة 2.
 *
 * Sidebar يمين (RTL) قابل للطي إلى أيقونات مع Tooltips، عرض قابل للسحب (كما كان)، أبيض/بطاقة في
 * Light وداكن دافئ في Dark عبر **Tokens فقط**: ألوان السايدبار تُشتق من الـTokens الدلالية
 * (`--card/--foreground/--primary-soft/--primary-text/--border/--primary`) بتعيين CSS مُحكَم على
 * حاوية السايدبار (الديسكتوب) وورقة الموبايل — فلا لون مباشر في أي مكوّن. العنصر النشط: خلفية
 * primary-soft + نص primary-text + علامة 3px نحاسية على الحافة المنطقية (inset-inline-start).
 *
 * الشريط العلوي: «إنشاء» المقسوم (روابط موجودة مفلترة بالصلاحيات)، البحث (لوحة الأوامر ⌘K)، مدخلات
 * معطّلة صراحةً (تخصيص العرض/المساعدة/الإشعارات)، وقائمة المستخدم — **مرة واحدة في DOM** (أُزيلت من
 * تذييل السايدبار). هوية النشاط/المبدّل: رأس السايدبار على الديسكتوب، والشريط العلوي على الموبايل.
 *
 * Routes والصلاحيات كما هي: التنقّل كله من `config/navigation` (visibleDestinations بالصلاحيات من
 * myPermissions). الإخفاء ليس أمانًا — كل route محروس على مستواه.
 *
 * Deliberately NOT included: /employee-dashboard, /manager-dashboard, /today-shipments,
 * /facebook-entry (بوابة الموظف بكوكي `employee_token`؛ المالك بلا الكوكي يُطرد منها).
 */
type MenuItem = { icon: typeof LayoutDashboard; label: string; path: string };
type MenuGroup = {
  label: string;
  icon: typeof LayoutDashboard;
  items: MenuItem[];
  /** المجموعة بتتطوي تحت اسمها بدل ما بنودها تتعرض كلها. */
  collapsible?: boolean;
};

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 236;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

/**
 * ألوان السايدبار من الـTokens الدلالية (Light: بطاقة بيضاء، Dark: بطاقة داكنة دافئة) — مُعيّنة على
 * حاوية الديسكتوب وورقة الموبايل معًا لأن ورقة الموبايل تُرسم في Portal خارج شجرة الـProvider.
 * (الانتقال إلى :root/.dark في index.css خطوة لاحقة عندما يكون الملف ضمن نطاق مرحلة.)
 */
export const SIDEBAR_TOKEN_CSS = `
[data-slot="sidebar-container"], [data-slot="sidebar"][data-mobile="true"] {
  --sidebar: var(--card);
  --sidebar-foreground: var(--foreground);
  --sidebar-primary: var(--primary);
  --sidebar-primary-foreground: var(--primary-foreground);
  --sidebar-accent: var(--primary-soft);
  --sidebar-accent-foreground: var(--primary-text);
  --sidebar-border: var(--border);
  --sidebar-ring: var(--ring);
}
`;

/** العنصر النشط: علامة 3px نحاسية على الحافة المنطقية (RTL = اليمين) — فوق خلفية primary-soft ونص primary-text من Tokens السايدبار. */
const ACTIVE_MARK_CLASS = "before:absolute before:inset-y-1.5 before:inset-inline-start-0 before:w-[3px] before:rounded-full before:bg-sidebar-primary";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-4">
            <BrandLogo variant="vertical" size="xl" />
            <p className="text-sm text-muted-foreground text-center">
              يرجى تسجيل الدخول للوصول إلى المنصة
            </p>
          </div>
          <Button
            type="button"
            onClick={() => { window.location.href = getLoginUrl(); }}
            size="lg"
            className="min-h-11 w-full"
          >
            تسجيل الدخول
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <style precedence="default" href="matjarak-shell-sidebar-tokens">{SIDEBAR_TOKEN_CSS}</style>
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({ children, setSidebarWidth }: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const { permissions } = usePermissions();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // النطاق multi-business (currentBusinessIds) لسه بيتقرا هنا لتنبيه المخزون؛ مبدّل الأنشطة
  // نفسه بقى في BusinessSwitcher (نفس المصدر BusinessContext).
  const { currentBusinessIds } = useBusinessContext();
  const { data: lowStockProducts } = trpc.products.lowStock.useQuery(
    currentBusinessIds && currentBusinessIds.length > 0 ? { businessIds: currentBusinessIds } : undefined
  );
  const lowStockCount = lowStockProducts?.length ?? 0;

  const isAdmin = user?.role === 'admin';
  // التنقّل V2 كله بيتبني من المصدر الواحد (config/navigation): الوجهات الأساسية (قابلة للطي
  // فالسايدبار تفضل مختصرة) + مجموعة «المزيد» للأدوات والسجلّات. الفلترة بالصلاحيات من نفس
  // مصدر السيرفر (myPermissions) عبر canSeeNav — تعريف واحد، مش مبعتر.
  const navDestinations = useMemo(
    () => visibleDestinations(isAdmin, permissions),
    [isAdmin, permissions]
  );
  const visibleGroups: MenuGroup[] = useMemo(() => {
    const groups: MenuGroup[] = navDestinations.map(dest => {
      const items = visibleChildren(dest, isAdmin, permissions).map(c => ({
        icon: c.icon, label: c.label, path: c.path,
      }));
      return {
        label: dest.label,
        icon: dest.icon,
        items,
        // الوجهة متعددة الأبناء بتتطوي وتفضل مختصرة. الوجهة ذات البند الواحد **لا** تتطوي:
        // العنوان القابل للنقر بيظهر فقط لو items>1، فلو خلّيناها collapsible وهي بند واحد
        // بتختفي تمامًا (لا عنوان يفتحها ولا محتوى) — ده اللي كان بيخفي «الموظفين» و«التقارير».
        collapsible: items.length > 1,
      };
    });
    const tools = visibleToolsLinks(isAdmin, permissions);
    if (tools.length > 0) {
      groups.push({
        label: "المزيد",
        icon: MORE_ICON,
        items: tools.map(l => ({ icon: l.icon, label: l.label, path: l.path })),
        collapsible: true,
      });
    }
    return groups;
  }, [navDestinations, isAdmin, permissions]);
  const allMenuItems = visibleGroups.flatMap(g => g.items);
  const activeMenuItem = allMenuItems.find(item => item.path === location);

  // تبويبات الـWorkspace للوجهة الحالية (التنقّل الثانوي) — من نفس NavConfig.
  const activeKey = activeDestinationKey(location);
  const activeDest = navDestinations.find(d => d.key === activeKey);
  const workspaceTabs = activeDest
    ? visibleChildren(activeDest, isAdmin, permissions)
    : [];

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      // Sidebar is docked on the right (RTL) — its right edge is fixed to the viewport
      // edge, so width grows as the mouse moves left, away from that fixed edge.
      const sidebarRight = sidebarRef.current?.getBoundingClientRect().right ?? 0;
      const newWidth = sidebarRight - e.clientX;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  const userName = user?.name ?? "";
  const roleLabel = user?.role === 'admin' ? 'إدارة' : 'موظف';

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar side="right" collapsible="icon" disableTransition={isResizing}>
          <SidebarHeader className="h-16 justify-center border-b border-sidebar-border">
            <div className="flex items-center gap-2 px-2 w-full">
              <button
                type="button"
                onClick={toggleSidebar}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:h-10 md:w-10"
                aria-label={isCollapsed ? "توسيع القائمة" : "طي القائمة"}
                aria-expanded={!isCollapsed}
                data-testid="sidebar-toggle"
              >
                <PanelRight className="h-4 w-4" aria-hidden="true" />
              </button>
              {/* هوية النشاط الفعّال (اسم البراند + اللوجو من القاعدة) — وهي نفسها مبدّل
                  الأنشطة لو المالك عنده أكتر من نشاط. مطوية → اللوجو/الحرف بس. */}
              <div className="min-w-0 flex-1">
                <BusinessSwitcher variant="sidebar" collapsed={isCollapsed} />
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 py-2">
            {visibleGroups.map(group => {
              const holdsCurrent = group.items.some(
                item =>
                  location === item.path || location.startsWith(item.path + "/")
              );
              const collapsed =
                group.collapsible &&
                !holdsCurrent &&
                !openGroups.has(group.label);
              return (
              <SidebarGroup key={group.label} className="px-2 py-0.5">
                {/* عنوان المجموعة بيتخفي لما تكون بند واحد: "المخزون" فوق "المخزون"،
                    و"الموظفون" فوق "الموظفين" — كانت بتقرا كإنها صفحتين مختلفتين. */}
                {group.items.length > 1 &&
                  (group.collapsible ? (
                    <button
                      type="button"
                      className="flex w-full min-h-11 items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:min-h-9"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setOpenGroups(current => {
                          const next = new Set(current);
                          next.has(group.label)
                            ? next.delete(group.label)
                            : next.add(group.label);
                          return next;
                        })
                      }
                    >
                      <group.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="flex-1 text-start">{group.label}</span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                  ) : (
                    <SidebarGroupLabel className="gap-1.5 text-sidebar-foreground/70">
                      <group.icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {group.label}
                    </SidebarGroupLabel>
                  ))}
                {collapsed ? null : (
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map(item => {
                      const isActive = location === item.path || location.startsWith(item.path + '/');
                      const showBadge = item.path === '/inventory' && lowStockCount > 0;
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => setLocation(item.path)}
                            tooltip={item.label}
                            aria-current={isActive ? "page" : undefined}
                            // أهداف لمس 44px داخل ورقة الموبايل؛ 40px مقصود على الديسكتوب
                            className={`relative h-11 font-medium transition-colors md:h-10 ${isActive ? ACTIVE_MARK_CLASS : ""}`}
                          >
                            <item.icon className={`h-4 w-4 shrink-0 ${isActive ? "text-sidebar-primary" : ""}`} aria-hidden="true" />
                            <span className="flex-1 truncate">{item.label}</span>
                            {showBadge && !isCollapsed && (
                              <Badge variant="destructive" className="h-5 text-xs px-1.5">
                                {lowStockCount}
                              </Badge>
                            )}
                            {showBadge && isCollapsed && (
                              <span className="absolute top-1 end-1 w-2 h-2 rounded-full bg-destructive" aria-hidden="true" />
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
                )}
              </SidebarGroup>
              );
            })}
          </SidebarContent>
        </Sidebar>

        {/* مقبض تغيير العرض: ديسكتوب فقط — على الموبايل السايدبار ورقة والمقبض كان يبرز 4px خارج الشاشة */}
        <div
          className={`absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : "hidden md:block"}`}
          onMouseDown={() => { if (!isCollapsed) setIsResizing(true); }}
          style={{ zIndex: 50 }}
          aria-hidden="true"
        />
      </div>

      <SidebarInset>
        {/* الشريط العلوي (Theme Spec §3): يمين = «إنشاء» (ديسكتوب) / زر القائمة + هوية النشاط + اسم الصفحة
            (موبايل)؛ يسار = البحث، مدخلات معطّلة صراحةً، تنبيه المخزون، قائمة المستخدم (مرة واحدة في DOM). */}
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-3 backdrop-blur md:h-16 md:px-4">
          {/* المجموعة اليمنى تتقلص (min-w-0 flex-1) والإجراءات ثابتة (shrink-0) — فلا يُدفع شيء خارج 360px */}
          <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
            {isMobile && <SidebarTrigger className="h-11 w-11 shrink-0 rounded-lg" aria-label="فتح القائمة" />}
            {/* الموبايل: هوية النشاط (لوجو/حرف + اسم) في الشريط العلوي؛ الديسكتوب: في رأس السايدبار. */}
            {isMobile && <BusinessSwitcher variant="topbar" />}
            {/* اسم الصفحة نص ثانوي (موجود في العنوان وفي WorkspaceTabs): يختفي تحت 640px بدل أن يظهر مقطوعًا؛
                يبقى من 640 إلى 767 (هواتف عريضة/تابلت صغير) حيث له مكان. الديسكتوب لا يرسمه أصلًا (isMobile). */}
            {isMobile && (
              <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:inline">{activeMenuItem?.label ?? "القائمة"}</span>
            )}
            {!isMobile && <CreateMenu isAdmin={isAdmin} permissions={permissions} />}
          </div>
          <TopBarActions
            isMobile={isMobile}
            isAdmin={isAdmin}
            permissions={permissions}
            userName={userName}
            roleLabel={roleLabel}
            lowStockCount={lowStockCount}
            onGoInventory={() => setLocation("/inventory")}
            onLogout={logout}
          />
        </header>
        {/* تبويبات القسم (secondary nav) — الوجهة بتبقى workspace بتفاصيلها فوق المحتوى. */}
        <WorkspaceTabs tabs={workspaceTabs} />
        {/* مساحة سفلية على الموبايل عشان المحتوى ما يتغطّاش وراء الـbottom nav (+ safe-area). */}
        {/* الـlandmark الوحيد (عنصر main) هو SidebarInset أعلاه؛ هذه حاوية التخطيط فقط (كانت عنصر main ثانيًا — مشكلة landmark قديمة أُصلحت في 7A) */}
        <div className="flex-1 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6" data-testid="page-content">{children}</div>
      </SidebarInset>
      <MobileBottomNav destinations={navDestinations} />
    </>
  );
}
