import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/** حارس نصّي لوصلات وضع «القراءة فقط» — مصدر واحد، رابط tRPC، مناطق القراءة المشتركة، والاستثناءات الصريحة. */
const SRC = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf-8");

describe("🔌 وضع القراءة فقط — الوصلات", () => {
  it("مصدر واحد: TenantAccessProvider حول التطبيق، والشريط يقرأ منه بلا استعلام ثانٍ", () => {
    const app = read("App.tsx");
    expect(app).toMatch(/<TenantAccessProvider>\s*<TenantAccessNotice \/>\s*<Router \/>\s*<\/TenantAccessProvider>/);
    const notice = read("components/TenantAccessNotice.tsx");
    expect(notice).toContain("useTenantAccess()");
    expect(notice).not.toContain("tenantAccess.status.useQuery");
    expect(read("contexts/TenantAccessContext.tsx")).toContain("trpc.tenantAccess.status.useQuery");
  });
  it("طبقة البيانات: readOnlyLink قبل httpBatchLink، بنفس trpcCallAllowed المستخدمة في السيرفر", () => {
    const main = read("main.tsx");
    expect(main.indexOf("readOnlyLink,")).toBeGreaterThan(-1);
    expect(main.indexOf("readOnlyLink,")).toBeLessThan(main.indexOf("httpBatchLink({"));
    expect(read("lib/tenantReadOnly.ts")).toContain('import { trpcCallAllowed');
  });
  it("الحارس: التقاط قبل React لكل أشكال التفعيل، وتعليم بصري بلا requestAnimationFrame", () => {
    const g = read("contexts/TenantAccessContext.tsx");
    for (const t of ['"pointerdown"', '"click"', '"keydown"', '"submit"']) expect(g, t).toContain(t);
    expect(g).toContain("addEventListener(t, onPointer, true)");
    expect(g).not.toMatch(/requestAnimationFrame\(/);
    expect(read("index.css")).toContain("[data-tenant-readonly] [data-readonly-blocked]");
  });
  it("مناطق القراءة المشتركة معلَّمة مرة واحدة", () => {
    const zones: Array<[string, string]> = [
      ["components/DashboardLayout.tsx", 'ref={sidebarRef} data-readonly-safe'],
      ["components/DashboardLayout.tsx", "<header data-readonly-safe"],
      ["components/shell/TopBar.tsx", 'data-readonly-safe data-testid="topbar-actions"'],
      ["components/shell/MobileBottomNav.tsx", "data-readonly-safe"],
      ["components/shell/WorkspaceTabs.tsx", "data-readonly-safe"],
      ["components/shell/EmployeeShell.tsx", "<header data-readonly-safe"],
      ["components/shell/BusinessSwitcher.tsx", "data-readonly-safe"],
      ["components/shared/FilterBar.tsx", "data-readonly-safe"],
      ["components/shared/ScopeBar.tsx", "data-readonly-safe"],
      ["components/shared/Pagination.tsx", "data-readonly-safe"],
      ["components/shared/ResponsiveDataTable.tsx", "data-readonly-safe"],
      ["components/DateRangePicker.tsx", "data-readonly-safe"],
      ["components/workspace/DataToolbar.tsx", "data-readonly-safe"],
      ["components/ui/dialog.tsx", "data-readonly-safe"],
      ["components/ui/sheet.tsx", "data-readonly-safe"],
    ];
    for (const [f, s] of zones) expect(read(f), f).toContain(s);
  });
  it("الاستثناءات الصريحة: مدخل الإنشاء مخفي، وتفعيل/تعطيل النشاط كتابة رغم aria-pressed", () => {
    expect(read("components/shell/CreateMenu.tsx")).toContain("if (items.length === 0 || readOnly) return null;");
    expect(read("pages/Businesses.tsx")).toContain("<Button data-readonly-write");
  });
  it("قوائم الاختيار التي تكتب فورًا معلَّمة كتابة (تغيير الحالة/الإسناد/وضع الإدخال)", () => {
    const writeSelects: Array<[string, string]> = [
      ["pages/EmployeeDashboard.tsx", "handleStatusSelect(order, v)"],
      ["pages/EmployeeDashboard.tsx", "updateStatusMutation.mutate({ taskId: task.id, status: v })"],
      ["pages/ManagerDashboard.tsx", "updateStatusMutation.mutate({ taskId: task.id, status: v })"],
      ["pages/ManagerDashboard.tsx", "<Select onValueChange={(val) => {"],
      ["pages/Orders.tsx", "updateStatusMutation.mutate({ id: drawerOrder.id"],
      ["pages/Businesses.tsx", "set.mutate({ businessId, mode: v as OrderEntryMode })"],
    ];
    for (const [f, anchor] of writeSelects) {
      const s = read(f); const i = s.indexOf(anchor);
      expect(i, `${f} ${anchor}`).toBeGreaterThan(-1);
      expect(s.slice(i, s.indexOf("</SelectTrigger>", i)), `${f} ${anchor}`).toContain("<SelectTrigger data-readonly-write");
    }
  });
  it("الخروج متاح من كل شاشة (لا يُعطَّل أبدًا)", () => {
    for (const f of ["pages/EmployeeDashboard.tsx", "pages/ManagerDashboard.tsx", "pages/WarehouseDashboard.tsx", "pages/FacebookEntry.tsx", "pages/TodayShipments.tsx", "pages/ledger/LedgerLayout.tsx"]) {
      const s = read(f);
      if (s.includes("<PortalHeaderActions") && s.includes("onLogout={handleLogout}")) {
        // الخروج عبر المكوّن المشترك: زره داخل الحاوية المعلّمة data-readonly-safe
        const c = read("components/shell/PortalHeaderActions.tsx");
        const box = c.indexOf('data-testid="portal-header-actions"');
        expect(c.lastIndexOf("<div", box), f).toBeGreaterThan(-1);
        expect(c.slice(c.lastIndexOf("<div", box), box), f).toContain("data-readonly-safe");
        expect(c.indexOf("onClick={onLogout}"), f).toBeGreaterThan(box);
        continue;
      }
      const i = s.search(/onClick=\{(handleLogout|logout)\}/);
      expect(i, f).toBeGreaterThan(-1);
      const tag = s.lastIndexOf("<Button", i) > s.lastIndexOf("<button", i) ? s.lastIndexOf("<Button", i) : s.lastIndexOf("<button", i);
      expect(s.slice(tag, i), f).toContain("data-readonly-safe");
    }
  });
});
