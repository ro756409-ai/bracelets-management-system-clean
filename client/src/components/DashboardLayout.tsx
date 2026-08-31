import { useAuth } from "@/_core/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermission";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
import {
  Factory,
  LayoutDashboard, LogOut, PanelRight, Users, ShoppingCart,
  Package, BarChart3, Briefcase, AlertTriangle, Zap, GitMerge, RotateCcw, PackageCheck, Clock, Activity, Globe, Building2, QrCode, Printer, Home, Boxes, UserCog, LineChart, Plug, Settings, Truck, Wallet, Receipt, Banknote, CalendarDays, PackagePlus, ArrowLeftRight, RotateCcw as ReturnIcon, Megaphone, ClipboardCheck,
  ChevronDown,
} from "lucide-react";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  MORE_ICON, activeDestinationKey, visibleChildren, visibleDestinations, visibleToolsLinks,
} from "@/config/navigation";
import { BusinessSwitcher } from "@/components/shell/BusinessSwitcher";
import { MobileBottomNav } from "@/components/shell/MobileBottomNav";
import { WorkspaceTabs } from "@/components/shell/WorkspaceTabs";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { BrandLogo } from './BrandLogo';
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Sidebar, grouped by workflow instead of one flat list of 19 items (Phase A of the UI
 * redesign — see UI_AUDIT.md). Every route and the `adminOnly` gate below is unchanged
 * from the previous `menuItems`/`adminMenuItems` split; only the grouping/visual
 * hierarchy is new.
 *
 * Deliberately NOT included: /employee-dashboard, /manager-dashboard, /today-shipments,
 * /facebook-entry. These are a separate portal gated by the `employee_token` cookie
 * (`employeePortal.me`), independent of this layout's `app_session_id` session — an
 * owner logged in via /login has no `employee_token` and would be bounced to
 * /employee-login if this sidebar linked there. Reached instead via /employee-login's
 * own role-based redirect. (The original audit listed these as simply "hidden from the
 * sidebar"; this is the corrected finding after tracing the two cookies.)
 */
// `financial` بند مالي — بيظهر للمالك والمحاسب بس (اللي عندهم `accounting.view`)، ومخفي
// عن المدير والمودريتور والتأكيدات وإدخال البيانات. الإخفاء ده مش أمان لوحده — البوابة
// على السيرفر (`permissionProcedure`) هي الحارس الحقيقي؛ ده عشان مايشوفش قسم مايوصلوش.
type MenuItem = { icon: typeof LayoutDashboard; label: string; path: string; adminOnly?: boolean; financial?: boolean };
type MenuGroup = {
  label: string;
  icon: typeof LayoutDashboard;
  items: MenuItem[];
  /** المجموعة بتتطوي تحت اسمها بدل ما بنودها تتعرض كلها. */
  collapsible?: boolean;
};


const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

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
            onClick={() => { window.location.href = getLoginUrl(); }}
            size="lg"
            className="w-full"
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
  // التنقّل V2 كله بيتبني من المصدر الواحد (config/navigation): ٧ وجهات أساسية (قابلة للطي
  // فالسايدبار تفضل مختصرة) + مجموعة «المزيد» للأدوات والسجلّات والحسابات القديمة. الفلترة
  // بالصلاحيات من نفس مصدر السيرفر (myPermissions) عبر canSeeNav — تعريف واحد، مش مبعتر.
  const navDestinations = useMemo(
    () => visibleDestinations(isAdmin, permissions),
    [isAdmin, permissions]
  );
  const visibleGroups: MenuGroup[] = useMemo(() => {
    const groups: MenuGroup[] = navDestinations.map(dest => ({
      label: dest.label,
      icon: dest.icon,
      items: visibleChildren(dest, isAdmin, permissions).map(c => ({
        icon: c.icon, label: c.label, path: c.path,
      })),
      // الوجهة متعددة الأبناء بتتطوي وتفضل مختصرة؛ اللي فيها بند واحد بيظهر مباشرة.
      collapsible: true,
    }));
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

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar side="right" collapsible="icon" disableTransition={isResizing}>
          <SidebarHeader className="h-16 justify-center border-b border-sidebar-border">
            <div className="flex items-center gap-3 px-2 w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-sidebar-accent rounded-lg transition-colors shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelRight className="h-4 w-4 text-sidebar-foreground/60" />
              </button>
              {!isCollapsed && (
                <div className="min-w-0">
                  <BrandLogo variant="horizontal" size="md" showEnglishName mode="dark" />
                </div>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 py-2">
            {/* مبدّل الأنشطة اتنقل للـTopbar (BusinessSwitcher) — مصدر واحد، من غير تكرار. */}
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
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent"
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
                      <group.icon className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1 text-right">{group.label}</span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                      />
                    </button>
                  ) : (
                    <SidebarGroupLabel className="gap-1.5">
                      <group.icon className="h-3.5 w-3.5" />
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
                            className="h-10 transition-all font-medium"
                          >
                            <item.icon className={`h-4 w-4 shrink-0 ${isActive ? "text-sidebar-primary" : ""}`} />
                            <span className="flex-1 truncate">{item.label}</span>
                            {showBadge && !isCollapsed && (
                              <Badge variant="destructive" className="h-5 text-xs px-1.5">
                                {lowStockCount}
                              </Badge>
                            )}
                            {showBadge && isCollapsed && (
                              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-destructive" />
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

          <SidebarFooter className="p-3 border-t border-sidebar-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-sidebar-accent/50 transition-colors w-full text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                  <Avatar className="h-8 w-8 border border-sidebar-border shrink-0">
                    <AvatarFallback className="text-xs font-bold bg-sidebar-primary text-sidebar-primary-foreground">
                      {user?.name?.charAt(0).toUpperCase() ?? 'U'}
                    </AvatarFallback>
                  </Avatar>
                  {!isCollapsed && (
                    <div className="flex-1 min-w-0 text-right">
                      <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.name || "-"}</p>
                      <p className="text-xs text-sidebar-foreground/50 truncate">
                        {user?.role === 'admin' ? 'مدير' : 'موظف'}
                      </p>
                    </div>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive">
                  <LogOut className="ml-2 h-4 w-4" />
                  <span>تسجيل الخروج</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>

        <div
          className={`absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => { if (!isCollapsed) setIsResizing(true); }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {/* Topbar موحّد: مبدّل الأنشطة (المصدر المعتمد) + عنوان الصفحة على الموبايل +
            مؤشّر المخزون المنخفض. البروفايل بيفضل في تذييل السايدبار — مفيش تكرار. */}
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/95 px-4 backdrop-blur">
          <div className="flex min-w-0 items-center gap-3">
            {isMobile && <SidebarTrigger className="h-9 w-9 rounded-lg" />}
            {isMobile && (
              <span className="truncate font-semibold text-foreground">{activeMenuItem?.label ?? "القائمة"}</span>
            )}
            <BusinessSwitcher />
          </div>
          {lowStockCount > 0 && (
            <button
              onClick={() => setLocation("/inventory")}
              className="flex items-center gap-1 text-xs text-destructive"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>{lowStockCount} منتج ينفد</span>
            </button>
          )}
        </header>
        {/* تبويبات القسم (secondary nav) — الوجهة بتبقى workspace بتفاصيلها فوق المحتوى. */}
        <WorkspaceTabs tabs={workspaceTabs} />
        {/* مساحة سفلية على الموبايل عشان المحتوى ما يتغطّاش وراء الـbottom nav. */}
        <main className="flex-1 p-4 pb-24 md:p-6 md:pb-6">{children}</main>
      </SidebarInset>
      <MobileBottomNav destinations={navDestinations} />
    </>
  );
}
