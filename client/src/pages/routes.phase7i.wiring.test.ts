/**
 * المرحلة 7I — تغطية المسارات: كل Route في App.tsx يشير إلى صفحة موجودة؛ كل صفحة مسارية بلا ألوان Tailwind
 * خام ولا hex ولا إيموجي ولا هوية بنفسجية قديمة، وكل Button فيها بهدف لمس 44px على الهاتف؛ الصفحات المستقلة
 * (بلا DashboardLayout) فيها <main> واحد؛ والصفحات المُعاد بناؤها في 7I تحافظ على hooks كما كانت.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (p: string) => strip(readFileSync(path.join(root, p), "utf8"));
const hooks = (src: string) => [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);
const app = readFileSync(path.join(root, "App.tsx"), "utf8");

/** صفحات المسارات: من استيرادات App.tsx (default imports من ./pages/...) */
const PAGE_IMPORTS = [...app.matchAll(/^import (\w+) from "\.\/pages\/([^"]+)";/gm)].map(m => ({ name: m[1], file: `pages/${m[2]}.tsx` }));
const ROUTES = [...app.matchAll(/<Route path=\{?"([^"]+)"\}?/g)].map(m => m[1]);

describe("🗺️ مصفوفة المسارات", () => {
  it("كل المسارات المعروفة موجودة (لا مسار فُقد) والصفحات المستوردة موجودة على القرص", () => {
    for (const r of ["/", "/login", "/signup", "/platform-admin/login", "/platform-admin", "/dashboard", "/orders", "/workspace", "/employees", "/inventory", "/reports", "/employee-login", "/accountant", "/employee-dashboard", "/warehouse-dashboard", "/manager-dashboard", "/today-shipments", "/shipping-schedule", "/webhook-settings", "/merge-logs", "/returns", "/duplicates", "/preparation", "/print-logs", "/activity-log", "/order/:id", "/sales-channels", "/businesses", "/printed-orders", "/scan-logs", "/bosta-orders", "/ledger/transactions", "/ledger", "/permissions", "/goods-receipt", "/stocktake", "/stock-transfer", "/workshop-returns", "/facebook-entry", "/scan-orders", "/404"]) expect(ROUTES, r).toContain(r);
    expect(ROUTES.length).toBeGreaterThanOrEqual(55);
    for (const p of PAGE_IMPORTS) expect(existsSync(path.join(root, p.file)), p.file).toBe(true);
    expect(app).toContain("<Route component={NotFound} />"); // catch-all
  });
  it("الصفحات المحاسبية المجمّدة كلها على AccountingDisabled", () => {
    for (const p of ["/accounting", "/treasury", "/expenses", "/collections", "/supplier-statements", "/salary-profiles", "/salary-preparation", "/payroll", "/closings", "/daily-ledger", "/daily-collections", "/advertising", "/accounting-settings", "/shipping-finance", "/accounting-disabled"]) expect(app).toContain(`<Route path="${p}"><AccountingDisabled /></Route>`);
    expect(app).toContain('<Route path={"/accountant"}>');
  });
});

// الصفحات المسارية الفعلية (غير المجمّدة) — من الاستيرادات
const ACTIVE = PAGE_IMPORTS.filter(p => !["Accounting", "Treasury", "Expenses", "Collections", "SupplierStatements", "SalaryProfiles", "SalaryPreparation", "Payroll", "Closings", "DailyLedger", "DailyCollections", "Advertising", "AccountingSettings", "ShippingFinance", "AccountantWorkspace", "InventoryAccounting"].includes(p.name));

describe("🎨 أساسيات الهوية على كل صفحة مسارية", () => {
  for (const p of ACTIVE) {
    it(`${p.file}: لا ألوان خام/hex/إيموجي/بنفسجي قديم؛ كل Button 44px`, () => {
      const s = read(p.file);
      expect(s).not.toMatch(/\b(bg|text|border|from|to|ring)-(gray|stone|slate|blue|amber|emerald|green|red|purple|violet|indigo|yellow|orange|rose|sky|cyan|teal|pink)-\d{2,3}\b/);
      expect(s).not.toMatch(/rgba\(91,61,245|#5b3df5|#8b5cf6/i); // الهوية البنفسجية القديمة
      expect(s).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}\u{26A0}\u{1F6AB}]/u);
      const buttons = s.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
      for (const b of buttons) expect(b, p.file + " " + b.slice(0, 80).replace(/\s+/g, " ")).toMatch(/min-h-1[12]|\bh-1[0-9]\b|\{TOUCH\}|\$\{TOUCH\}|\{ICON_BTN\}|\$\{ICON_BTN\}|\$\{cls\}/);
    });
  }
  it("الصفحات المستقلة (بلا DashboardLayout) فيها <main> واحد", () => {
    for (const f of ["pages/Home.tsx", "pages/Login.tsx", "pages/Register.tsx", "pages/EmployeeLogin.tsx", "pages/NotFound.tsx", "pages/AccountingDisabled.tsx", "pages/platform/PlatformAdmin.tsx", "pages/platform/PlatformAdminLogin.tsx", "pages/ManagerDashboard.tsx", "pages/WarehouseDashboard.tsx"]) expect((read(f).match(/<main\b/g) ?? []).length, f).toBe(1);
  });
});

describe("🔌 صفحات 7I — hooks كما كانت", () => {
  it("MergeLogs / ActivityLog / AgentWorkspace / WarehouseDashboard / StockTransfer / Duplicates", () => {
    expect(hooks(read("pages/MergeLogs.tsx"))).toEqual(["trpc.reports.mergeLogs.useQuery"]);
    expect(hooks(read("pages/ActivityLog.tsx"))).toEqual(["trpc.activityLog.list.useQuery"]);
    expect(hooks(read("pages/AgentWorkspace.tsx"))).toEqual([
      "trpc.orders.myOrders.useQuery", "trpc.orders.confirm.useMutation", "trpc.orders.cancel.useMutation", "trpc.orders.editOrder.useMutation", "trpc.orders.editOrderItems.useMutation",
      "trpc.products.list.useQuery", "trpc.variants.all.useQuery", "trpc.orders.orderItems.useQuery", "trpc.orders.postpone.useMutation",
    ]);
    expect(hooks(read("pages/WarehouseDashboard.tsx")).length).toBe(7);
    expect(hooks(read("pages/StockTransfer.tsx"))).toEqual(["trpc.businesses.warehouses.useQuery", "trpc.products.list.useQuery", "trpc.variants.all.useQuery", "trpc.accountingV2.stockTransfer.useMutation"]);
    expect(hooks(read("pages/Duplicates.tsx"))).toEqual(["trpc.duplicates.list.useQuery", "trpc.duplicates.delete.useMutation", "trpc.duplicates.restore.useMutation", "trpc.duplicates.deleteAll.useMutation"]);
    expect(hooks(read("pages/Orders.tsx")).length).toBeGreaterThan(10);
  });
  it("ActivityLog: «الكل» لا يُرسل للسيرفر كقيمة فلتر؛ AgentWorkspace: التأكيد بحارس ضغط مكرر ونفس payload الإلغاء/التأجيل", () => {
    const a = read("pages/ActivityLog.tsx");
    expect(a).toContain('action: actionFilter && actionFilter !== "all" ? actionFilter : undefined,');
    const w = read("pages/AgentWorkspace.tsx");
    expect(w).toContain("createInFlightGuard"); expect(w).toContain("confirmMutation.mutate({ orderId, operationId: operationIdFor(`confirm:${orderId}`) }, { onSettled: done })");
    expect(w).toContain("cancelReason: cancelReason as any,"); expect(w).toContain("postponedTo: new Date(postponeDate),");
    expect(w).toContain("<OrderEditDialog"); expect(w).toContain("allowItemsEdit={canEditItems}");
  });
  it("EmployeeLogin: نفس REST والتوجيه بحسب الدور؛ بلا نقش rgba البنفسجي", () => {
    const e = read("pages/EmployeeLogin.tsx");
    expect(e).toContain('"/api/employee/login"'); expect(e).toContain('setLocation("/warehouse-dashboard")'); expect(e).toContain('setLocation("/ledger")'); expect(e).toContain("resetEmployeeClientState(queryClient, readEmployeeScope())");
    expect(e).not.toContain("rgba(");
  });
});
