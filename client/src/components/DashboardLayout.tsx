import { useAuth } from "@/_core/hooks/useAuth";
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
  LayoutDashboard, LogOut, PanelRight, Users, ShoppingCart,
  Package, BarChart3, Briefcase, AlertTriangle, Zap, GitMerge, RotateCcw, PackageCheck, Clock, Activity, Globe, Building2, QrCode, Printer, Home, Boxes, UserCog, LineChart, Plug, Settings, Truck, Wallet, Receipt, Banknote, CalendarDays, PackagePlus, ArrowLeftRight, RotateCcw as ReturnIcon, Megaphone,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
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
type MenuItem = { icon: typeof LayoutDashboard; label: string; path: string; adminOnly?: boolean };
type MenuGroup = { label: string; icon: typeof LayoutDashboard; items: MenuItem[] };

const MENU_GROUPS: MenuGroup[] = [
  {
    label: "الرئيسية",
    icon: Home,
    items: [
      { icon: LayoutDashboard, label: "لوحة التحكم", path: "/dashboard" },
      { icon: Briefcase, label: "مساحة العمل", path: "/workspace" },
    ],
  },
  {
    label: "الطلبات",
    icon: ShoppingCart,
    items: [
      { icon: ShoppingCart, label: "الأوردرات", path: "/orders" },
      { icon: Truck, label: "طلبات بوسطة", path: "/bosta-orders" },
      { icon: RotateCcw, label: "المرتجعات", path: "/returns", adminOnly: true },
      { icon: AlertTriangle, label: "المكررات", path: "/duplicates", adminOnly: true },
    ],
  },
  {
    label: "التشغيل",
    icon: PackageCheck,
    items: [
      { icon: PackageCheck, label: "التجهيز", path: "/preparation" },
      { icon: Printer, label: "المطبوعات", path: "/printed-orders" },
      { icon: Clock, label: "سجل الطباعات", path: "/print-logs" },
      { icon: QrCode, label: "مسح QR الأوردرات", path: "/scan-orders" },
      { icon: QrCode, label: "سجل المسحات", path: "/scan-logs" },
      { icon: Activity, label: "سجل الأنشطة", path: "/activity-log" },
    ],
  },
  {
    label: "المخزون",
    icon: Boxes,
    items: [{ icon: Package, label: "المخزون", path: "/inventory" }],
  },
  {
    label: "الموظفون",
    icon: UserCog,
    items: [{ icon: Users, label: "الموظفين", path: "/employees", adminOnly: true }],
  },
  {
    // بند واحد مش أربعة: الخزنة والمصروفات والتحصيلات بقت تابات جوه /accounting.
    // أربعة بنود تحت بعض كانت بتخلي القائمة تبان أطول من غير ما تضيف وجهة حقيقية.
    label: "الحسابات",
    icon: Wallet,
    items: [
      // «تحصيل اليوم» بقت أول حاجة في المجموعة لأنها اللي بتتفتح كل يوم: دخل من شركة
      // الشحن، خرج من الخزنة، تحصيل أوردر بعينه، وإيداع/سحب — الأربعة في شاشة واحدة.
      //
      // «مركز التسجيل اليومي» (/daily-ledger) اتشال من هنا مش من النظام: الرابط لسه
      // بيفتح، والشاشة لسه شغّالة. الأربع حاجات اللي كانت فيه بقت كلها في «تحصيل
      // اليوم»، فمابقاش فيه سبب يخلي التاجر يختار بين شاشتين بيعملوا نفس الشغل.
      { icon: Banknote, label: "تحصيل اليوم", path: "/daily-collections", adminOnly: true },
      { icon: Users, label: "تجهيز المرتبات", path: "/salary-preparation", adminOnly: true },
      { icon: PackagePlus, label: "إذن استلام بضاعة", path: "/goods-receipt", adminOnly: true },
      { icon: ArrowLeftRight, label: "تحويل مخزون", path: "/stock-transfer", adminOnly: true },
      { icon: ReturnIcon, label: "مرتجعات الورشة", path: "/workshop-returns", adminOnly: true },
      { icon: Megaphone, label: "الإعلانات", path: "/advertising", adminOnly: true },
      { icon: Wallet, label: "الحسابات", path: "/accounting", adminOnly: true },
    ],
  },
  {
    label: "التقارير",
    icon: LineChart,
    items: [
      { icon: BarChart3, label: "التقارير", path: "/reports" },
      { icon: GitMerge, label: "تقرير الدمج", path: "/merge-logs", adminOnly: true },
    ],
  },
  {
    label: "التكاملات",
    icon: Plug,
    items: [
      { icon: Globe, label: "قنوات البيع", path: "/sales-channels", adminOnly: true },
      { icon: Zap, label: "Easy Order ربط", path: "/webhook-settings", adminOnly: true },
    ],
  },
  {
    label: "الإعدادات",
    icon: Settings,
    items: [{ icon: Building2, label: "إدارة الأنشطة", path: "/businesses", adminOnly: true }],
  },
];

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
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const { groups, currentGroupId, setCurrentGroupId, currentBusinessIds } = useBusinessContext();
  const { data: lowStockProducts } = trpc.products.lowStock.useQuery(
    currentBusinessIds && currentBusinessIds.length > 0 ? { businessIds: currentBusinessIds } : undefined
  );
  const lowStockCount = lowStockProducts?.length ?? 0;

  const isAdmin = user?.role === 'admin';
  // Same visibility rule as before (isAdmin gate) — only which GROUP an item is displayed
  // under is new, not who can see it.
  const visibleGroups = MENU_GROUPS
    .map(group => ({ ...group, items: group.items.filter(item => !item.adminOnly || isAdmin) }))
    .filter(group => group.items.length > 0);
  const allMenuItems = visibleGroups.flatMap(g => g.items);
  const activeMenuItem = allMenuItems.find(item => item.path === location);

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
            {/* Business Group Switcher */}
            {!isCollapsed && groups.length > 0 && (
              <div className="px-3 pb-3 pt-1">
                <Select
                  value={currentGroupId !== undefined ? String(currentGroupId) : 'all'}
                  onValueChange={(val) => setCurrentGroupId(val === 'all' ? undefined : Number(val))}
                >
                  <SelectTrigger className="w-full h-9 text-xs bg-sidebar-accent/30 border-sidebar-border">
                    <SelectValue placeholder="اختر القسم" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل الأقسام</SelectItem>
                    {groups.map(g => (
                      <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {visibleGroups.map(group => (
              <SidebarGroup key={group.label} className="px-2 py-0.5">
                {/* عنوان المجموعة بيتخفي لما تكون بند واحد: "المخزون" فوق "المخزون"،
                    و"الموظفون" فوق "الموظفين" — كانت بتقرا كإنها صفحتين مختلفتين. */}
                {group.items.length > 1 && (
                  <SidebarGroupLabel className="gap-1.5">
                    <group.icon className="h-3.5 w-3.5" />
                    {group.label}
                  </SidebarGroupLabel>
                )}
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
              </SidebarGroup>
            ))}
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
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-4 backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="h-9 w-9 rounded-lg" />
              <span className="font-semibold text-foreground">{activeMenuItem?.label ?? "القائمة"}</span>
            </div>
            {lowStockCount > 0 && (
              <div className="flex items-center gap-1 text-destructive text-xs">
                <AlertTriangle className="h-3 w-3" />
                <span>{lowStockCount} منتج ينفد</span>
              </div>
            )}
          </div>
        )}
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
