import {
  LayoutDashboard, ShoppingCart, PackageCheck, Boxes, Users, LineChart, Settings,
  Briefcase, Truck, RotateCcw, AlertTriangle, Printer, QrCode, Clock, Activity,
  Package, PackagePlus, ClipboardCheck, Building2, Globe, Zap,
  BarChart3, GitMerge, Wallet, Wrench,
} from "lucide-react";

/**
 * مصدر التنقّل الوحيد لـMatjarak V2 (data-driven).
 *
 * الشل (Desktop sidebar + Mobile bottom nav + More menu) كله بيتبني من هنا — مفيش تعريف
 * تنقّل تاني متبعتر. الفلسفة: **٧ وجهات أساسية بس** ظاهرة، وكل وجهة جوّاها روابط فرعية
 * (بتفتح الصفحات الموجودة زي ما هي — backward compatible). الأدوات التقنية والسجلّات
 * بتروح لـ«المزيد» فمايشغلوش المستخدم العادي.
 *
 * **الصلاحيات مصدرها `auth.myPermissions`** (نفس مصدر السيرفر). الإخفاء مش أمان — كل
 * route لسه متحرس على مستواه؛ ده بس عشان المستخدم مايشوفش وجهة مايوصلهاش.
 *   • `permission`: البند يظهر لو الصلاحية دي موجودة في myPermissions.
 *   • `adminOnly`: يظهر للمالك/الأدمن الصناعي فقط (user.role === "admin").
 *   • من غير الاتنين: يظهر لأي جلسة مصرّح لها.
 */

export type NavGate = {
  /** لو موجودة: البند يظهر بس لما الصلاحية دي في myPermissions. */
  permission?: string;
  /** لو true: للمالك/الأدمن الصناعي فقط. */
  adminOnly?: boolean;
};

export type NavLink = NavGate & {
  label: string;
  path: string;
  icon: typeof LayoutDashboard;
};

export type NavDestination = NavGate & {
  /** مفتاح ثابت — للـactive-state وbottom nav. */
  key: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** الصفحة اللي بتتفتح لما تدوس الوجهة نفسها (الرابط الأساسي). */
  path: string;
  /** الروابط الفرعية داخل الوجهة (secondary nav / tabs) — بتفتح صفحات موجودة. */
  children?: NavLink[];
};

/** الوجهات الأساسية السبع — القلب الظاهر للمستخدم. */
export const PRIMARY_DESTINATIONS: NavDestination[] = [
  {
    key: "home",
    label: "الرئيسية",
    icon: LayoutDashboard,
    path: "/dashboard",
    children: [
      { label: "لوحة التحكم", path: "/dashboard", icon: LayoutDashboard },
      { label: "مساحة العمل", path: "/workspace", icon: Briefcase },
    ],
  },
  {
    key: "orders",
    label: "الطلبات",
    icon: ShoppingCart,
    path: "/orders",
    children: [
      { label: "الأوردرات", path: "/orders", icon: ShoppingCart },
      { label: "طلبات بوسطة", path: "/bosta-orders", icon: Truck },
      { label: "المرتجعات", path: "/returns", icon: RotateCcw, adminOnly: true },
      { label: "المكررات", path: "/duplicates", icon: AlertTriangle, adminOnly: true },
      { label: "المطبوعات", path: "/printed-orders", icon: Printer },
      { label: "مسح QR الأوردرات", path: "/scan-orders", icon: QrCode },
    ],
  },
  {
    key: "operations",
    label: "التشغيل",
    icon: PackageCheck,
    path: "/preparation",
    children: [
      { label: "التجهيز", path: "/preparation", icon: PackageCheck },
      { label: "شحنات اليوم", path: "/today-shipments", icon: Truck },
      { label: "جدول الشحن", path: "/shipping-schedule", icon: Clock },
    ],
  },
  {
    key: "inventory",
    label: "المخزون",
    icon: Boxes,
    path: "/inventory",
    children: [
      { label: "المخزون", path: "/inventory", icon: Package },
      { label: "إذن استلام بضاعة", path: "/goods-receipt", icon: PackagePlus, permission: "inventory_costing.view" },
      { label: "الجرد", path: "/stocktake", icon: ClipboardCheck, permission: "inventory_costing.view" },
      // «تحويل مخزون» (/stock-transfer) مش بند تنقّل عمدًا — «مرتجعات الورشة» بتغلّف نفس
      // حركة التحويل وبتوري القطع المعلّقة كمان. الـroute لسه شغّال لأي رابط قديم.
      { label: "مرتجعات الورشة", path: "/workshop-returns", icon: RotateCcw, adminOnly: true },
    ],
  },
  {
    key: "team",
    label: "الفريق",
    icon: Users,
    path: "/employees",
    adminOnly: true,
    children: [
      { label: "الموظفين", path: "/employees", icon: Users, adminOnly: true },
    ],
  },
  {
    key: "reports",
    label: "التقارير",
    icon: LineChart,
    path: "/reports",
    children: [
      { label: "التقارير", path: "/reports", icon: BarChart3 },
    ],
  },
  {
    key: "settings",
    label: "الإعدادات",
    icon: Settings,
    path: "/businesses",
    adminOnly: true,
    children: [
      { label: "إدارة الأنشطة", path: "/businesses", icon: Building2, adminOnly: true },
      { label: "قنوات البيع", path: "/sales-channels", icon: Globe, adminOnly: true },
      { label: "Easy Order ربط", path: "/webhook-settings", icon: Zap, adminOnly: true },
    ],
  },
];

/**
 * «المزيد / أدوات» — سجلّات وأدوات تقنية. مش وجهة أساسية؛ المستخدم العادي مايشوفهاش إلا
 * لما يفتح القائمة. مفيش أي functionality اتشالت — الروابط دي كانت في السايدبار القديمة.
 */
export const TOOLS_LINKS: NavLink[] = [
  { label: "سجل الطباعات", path: "/print-logs", icon: Clock },
  { label: "سجل المسحات", path: "/scan-logs", icon: QrCode },
  { label: "سجل الأنشطة", path: "/activity-log", icon: Activity },
  { label: "تقرير الدمج", path: "/merge-logs", icon: GitMerge, adminOnly: true },
];

/**
 * الحسابات — LEGACY/FROZEN في V2. بتفضل متاحة لأصحاب `accounting.view` فقط، لكن **مش**
 * محور تنقّل المالك: بتظهر هادية في «المزيد» مش كوجهة أساسية. مفيش تعديل على شاشاتها.
 */
export const ACCOUNTING_LINK: NavLink = {
  label: "الحسابات (قديم)",
  path: "/accounting",
  icon: Wallet,
  permission: "accounting.view",
};

/** أيقونة «المزيد» للموبايل/الأدوات. */
export const MORE_ICON = Wrench;

/**
 * فلترة بند حسب صلاحيات الجلسة — نفس منطق DashboardLayout القديم بالظبط، متمركز هنا.
 * `isAdmin` = user.role === "admin" (بيشمل المدير الصناعي). `permissions` = myPermissions.
 */
export function canSeeNav(gate: NavGate, isAdmin: boolean, permissions: string[]): boolean {
  if (gate.permission) return permissions.includes(gate.permission);
  if (gate.adminOnly) return isAdmin;
  return true;
}

/** الأبناء المرئيون لوجهة (بعد فلترة الصلاحيات). */
export function visibleChildren(dest: NavDestination, isAdmin: boolean, permissions: string[]): NavLink[] {
  return (dest.children ?? []).filter(c => canSeeNav(c, isAdmin, permissions));
}

/**
 * الوجهات المرئية: الوجهة تظهر لو بوابتها سمحت **و** عندها ابن مرئي واحد على الأقل
 * (أو مالهاش أبناء). كده وجهة كل أبناءها متحجوبين ماتظهرش فاضية.
 */
export function visibleDestinations(isAdmin: boolean, permissions: string[]): NavDestination[] {
  return PRIMARY_DESTINATIONS.filter(dest => {
    if (!canSeeNav(dest, isAdmin, permissions)) return false;
    if (!dest.children || dest.children.length === 0) return true;
    return visibleChildren(dest, isAdmin, permissions).length > 0;
  });
}

/** روابط «المزيد» المرئية (أدوات + الحسابات القديمة). */
export function visibleToolsLinks(isAdmin: boolean, permissions: string[]): NavLink[] {
  const tools = TOOLS_LINKS.filter(l => canSeeNav(l, isAdmin, permissions));
  const acc = canSeeNav(ACCOUNTING_LINK, isAdmin, permissions) ? [ACCOUNTING_LINK] : [];
  return [...tools, ...acc];
}

/** الوجهة اللي المسار الحالي تابع لها (للـactive state في الشل). */
export function activeDestinationKey(location: string): string | null {
  // أطول تطابق يكسب — عشان /stocktake ما يطابقش /s مثلاً.
  let best: { key: string; len: number } | null = null;
  for (const dest of PRIMARY_DESTINATIONS) {
    for (const link of dest.children ?? [{ path: dest.path } as NavLink]) {
      if (location === link.path || location.startsWith(link.path + "/")) {
        if (!best || link.path.length > best.len) best = { key: dest.key, len: link.path.length };
      }
    }
  }
  return best?.key ?? null;
}
