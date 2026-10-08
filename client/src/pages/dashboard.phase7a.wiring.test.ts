/**
 * المرحلة 7A — حراسة نصّية للوحة التحكم: نفس الاستعلامات ونفس مصادر الأرقام وحساباتها، بوابات الصلاحيات،
 * لا أرقام ثابتة/وهمية، الرسم بألوان Tokens بلا أحمر افتراضي، و<main> واحد فقط في الصفحة.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const page = strip(readFileSync(path.join(root, "pages/Dashboard.tsx"), "utf8"));
const layout = readFileSync(path.join(root, "components/DashboardLayout.tsx"), "utf8");
const sidebar = readFileSync(path.join(root, "components/ui/sidebar.tsx"), "utf8");

/** الاستعلامات والـmutations كما كانت قبل 7A — لا إضافة ولا حذف */
const HOOKS_BEFORE = [
  "trpc.reports.dashboard.useQuery", "trpc.products.lowStock.useQuery", "trpc.reports.dailyChart.useQuery", "trpc.reports.mergeAlert.useQuery",
  "trpc.orders.todayConfirmed.useQuery", "trpc.broadcast.getActive.useQuery", "trpc.broadcast.send.useMutation", "trpc.broadcast.clear.useMutation", "trpc.seed.init.useMutation",
];

describe("🔌 Queries قبل = بعد", () => {
  it("نفس 9 hooks بالترتيب نفسه، ولا hook آخر على trpc", () => {
    const used = [...page.matchAll(/trpc\.[a-zA-Z.]+\.use(Query|Mutation)/g)].map(m => m[0]);
    expect(used).toEqual(HOOKS_BEFORE);
  });
  it("حارس الأمن القديم: enabled: isAdmin على dashboard/lowStock/dailyChart (ترتيب الملف محفوظ)", () => {
    const i1 = page.indexOf("trpc.reports.dashboard"), i2 = page.indexOf("trpc.products.lowStock"), i3 = page.indexOf("trpc.reports.dailyChart");
    expect(i1).toBeGreaterThan(0); expect(i2).toBeGreaterThan(i1); expect(i3).toBeGreaterThan(i2);
    expect(page.slice(i1, i2)).toContain("enabled: isAdmin && canViewStats");
    expect(page.slice(i2, i3)).toContain("enabled: isAdmin");
    expect(page.slice(i3)).toContain("enabled: isAdmin");
  });
  it("بوابات السيرفر نفسها على العميل: accounting.view للمؤشرات، orders.view لمؤكدات اليوم؛ لا جلب بلا صلاحية", () => {
    expect(page).toContain('const canViewStats = has("accounting.view");');
    expect(page).toContain('const canViewOrders = has("orders.view");');
    expect(page).toContain("enabled: isAdmin && canViewOrders");
    expect(page).toContain("canSeeNav(gateForPath(a.path), isAdmin, permissions)");
  });
});

describe("🔢 مصادر الأرقام وحساباتها كما كانت", () => {
  it("الإجمالي/المؤكد+المطبوع/الجديد/نسبة التأكيد/قيمة مؤكدات اليوم — نفس الأسطر حرفيًا", () => {
    for (const line of [
      "const totalOrders = stats?.statusStats.reduce((sum, s) => sum + Number(s.count), 0) ?? 0;",
      "const confirmedOnlyCount = Number(stats?.statusStats.find(s => s.status === 'confirmed')?.count ?? 0);",
      "const printedCount = Number(stats?.statusStats.find(s => s.status === 'printed')?.count ?? 0);",
      "const confirmedCount = confirmedOnlyCount + printedCount;",
      "const newCount = stats?.statusStats.find(s => s.status === 'new')?.count ?? 0;",
      "const confirmRate = totalOrders > 0 ? Math.round((Number(confirmedCount) / totalOrders) * 100) : 0;",
      "const todayTotalRevenue = todayConfirmedOrders.reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);",
      "const todayConfirmedCount = todayConfirmedData?.total ?? 0;",
    ]) expect(page, line).toContain(line);
  });
  it("المشحون والموصَّل وقيمته من الاستعلام نفسه (shippedToday / statusStats delivered / totalRevenue) — بلا حساب جديد", () => {
    expect(page).toContain("const shippedCount = Number(stats?.shippedToday ?? 0);");
    expect(page).toContain("const deliveredCount = Number(stats?.statusStats.find(s => s.status === 'delivered')?.count ?? 0);");
    expect(page).toContain("const deliveredValue = Number(stats?.totalRevenue ?? 0);");
  });
  it("لا رقم ثابت/وهمي في أي بطاقة: كل value من fmt(...) أو عنصر محسوب؛ التحصيل النقدي «غير متاح» لا رقم", () => {
    const values = [...page.matchAll(/<StatCard[^>]*value=(\{[^}]*\}|"[^"]*")/g)].map(m => m[1]);
    expect(values.length).toBeGreaterThanOrEqual(7);
    for (const v of values) { expect(v, v).not.toMatch(/^"?\{?\s*\d/); expect(v, v).toMatch(/fmt\(/); }
    expect(page).toContain("التحصيل النقدي الفعلي"); expect(page).toContain("غير متاح");
    expect(page).not.toMatch(/collectedAmount|collectionStatus|trpc\.[a-zA-Z.]*collect/i); // لا استعلام تحصيل مخترع
    expect(page).toContain("ليست نقدًا محصّلًا");
  });
  it("الرسم: recharts بألوان Tokens فقط ولا أحمر كسلسلة؛ جدول بديل sr-only وملخص رقمي", () => {
    const fills = [...page.matchAll(/<Bar [^>]*fill="([^"]+)"/g)].map(m => m[1]);
    expect(fills).toEqual(["var(--chart-2)", "var(--chart-3)", "var(--chart-4)"]);
    expect(page).not.toMatch(/fill="#|fill="var\(--destructive\)|fill="var\(--chart-1\)"/);
    expect(page).not.toMatch(/#(ef4444|dc2626|3b82f6|22c55e|f59e0b|a855f7|6366f1|10b981)/i);
    expect(page).toContain('<table className="sr-only" data-testid="dashboard-chart-table">');
    expect(page).toContain('data-testid="dashboard-chart-totals"');
    expect(page).toContain('role="img" aria-label={`رسم أعمدة');
  });
});

describe("🏗️ الحالات والبنية والوصول", () => {
  it("المكوّنات المشتركة للحالات مستخدمة: LoadingSkeleton/EmptyState/ErrorState/OfflineState/PermissionDeniedState", () => {
    for (const c of ["<LoadingSkeleton", "<EmptyState", "<ErrorState", "<OfflineState", "<PermissionDeniedState"]) expect(page, c).toContain(c);
    expect(page).toContain("useOnlineStatus()");
  });
  it("الترويسة ونطاق النشاط الحقيقي: PageHeader + ScopeBar على BusinessContext؛ SectionIcon/PartnerLogo في مواضعها فقط", () => {
    expect(page).toContain("<PageHeader"); expect(page).toContain("<ScopeBar"); expect(page).toContain("setCurrentBusinessId(id == null ? undefined : Number(id))");
    expect((page.match(/<SectionIcon /g) ?? []).length).toBe(3);
    expect(page).toContain('<PartnerLogo partner="easyorders" size="xs" decorative />');
    expect(page).not.toContain('partner="bosta"');
  });
  it("<main> واحد فقط في الصفحة: SidebarInset يرسمه، وDashboardLayout لم يعد يرسم main ثانيًا", () => {
    expect((layout.match(/<main\b/g) ?? []).length).toBe(0);
    expect((sidebar.match(/<main\b/g) ?? []).length).toBe(1);
    expect(layout).toContain('<div className="flex-1 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6" data-testid="page-content">');
  });
  it("أهداف اللمس على الموبايل ≥44px لكل زر في الصفحة (min-h-11 أو h-16)", () => {
    const buttons = page.match(/<Button\b(?:=>|[^>])*>/gs) ?? []; // `=>` داخل onClick ليس نهاية الوسم
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) expect(b, b.slice(0, 80)).toMatch(/min-h-11|h-16/);
    expect(readFileSync(path.join(root, "components/dashboard/NeedsAttention.tsx"), "utf8")).toContain("min-h-11");
  });
});
