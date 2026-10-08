// @vitest-environment jsdom
/**
 * المرحلة 7C — تشخيص وإصلاح حارس /goods-receipt و/stocktake.
 *
 * قبل: `FinancialRoute` غير الـbare كان يغلّف الصفحة دائمًا بـ`DashboardLayout`، و`DashboardLayout` يرسم
 * «يرجى تسجيل الدخول للوصول إلى المنصة» لأي جلسة `user` = null — فموظف مخزن ممنوح `inventory_costing.view`
 * (جلسة موظف، `auth.me` = null) كان يعدّي فحص الصلاحية ثم يقف عند شاشة الدخول رغم أن الـendpoints
 * (`authenticatedProcedure`/`permissionProcedure`) تصرّح له.
 * بعد: جلسة مالك → DashboardLayout كما هي؛ جلسة موظف مصرَّح له → EmployeeShell؛ بلا صلاحية → تحويل؛
 * بلا جلسة → Home. لا صلاحية جديدة ولا تغيير backend.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

const st = vi.hoisted(() => ({ user: null as any, authLoading: false, permissions: [] as string[], permLoading: false, redirects: [] as string[] }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: st.user, loading: st.authLoading }) }));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.permissions, isLoading: st.permLoading, has: (p: string) => st.permissions.includes(p) }), usePermission: (p: string) => st.permissions.includes(p) }));
vi.mock("wouter", () => ({ Redirect: ({ to }: { to: string }) => { st.redirects.push(to); return <div data-testid="redirect">{to}</div>; }, useLocation: () => ["/goods-receipt", vi.fn()] }));
vi.mock("@/pages/Home", () => ({ default: () => <div data-testid="home">Home</div> }));
// DashboardLayout الحقيقي يُبقي بوابته: user = null → «يرجى تسجيل الدخول» (نفس نص المكوّن الحقيقي، مُثبَّت نصيًا أدناه)
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: any) => (st.user ? <div data-testid="dashboard-layout">{children}</div> : <div>يرجى تسجيل الدخول للوصول إلى المنصة</div>) }));
vi.mock("@/lib/trpc", () => ({ trpc: { employeePortal: { me: { useQuery: () => ({ data: { name: "موظف المخزن" } }) } } } }));

import { FinancialRoute, homeForPermissions } from "./FinancialRoute";

const app = readFileSync(path.resolve(__dirname, "../../App.tsx"), "utf8");
const layout = readFileSync(path.resolve(__dirname, "../DashboardLayout.tsx"), "utf8");

beforeEach(() => { st.user = null; st.authLoading = false; st.permissions = []; st.permLoading = false; st.redirects = []; });
afterEach(() => cleanup());

const Page = () => <div data-testid="page">صفحة المخزون</div>;

describe("🩺 التشخيص (قبل): بوابة DashboardLayout + تغليف غير مشروط", () => {
  it("DashboardLayout الحقيقي يرسم «يرجى تسجيل الدخول» عندما user = null — وهذا ما كان يراه موظف المخزن المصرَّح له", () => {
    expect(layout).toContain("if (!user) {");
    expect(layout).toContain("يرجى تسجيل الدخول للوصول إلى المنصة");
  });
  it("السيرفر يصرّح للموظف: products.list/variants.all/businesses.warehouses authenticated، وstocktake*/purchaseReceipt* permissionProcedure — فالعطل كان في الواجهة فقط", () => {
    const routers = readFileSync(path.resolve(__dirname, "../../../../server/routers.ts"), "utf8");
    expect(routers).toContain("    warehouses: authenticatedProcedure");
    expect(routers).toContain('stocktakeList: permissionProcedure("inventory_costing.view")');
    expect(routers).toContain('purchaseReceiptCreate: permissionProcedure("inventory_costing.manage")');
    const trpcCore = readFileSync(path.resolve(__dirname, "../../../../server/_core/trpc.ts"), "utf8");
    expect(trpcCore).toContain("export const authenticatedProcedure = t.procedure.use(requireAuthenticatedIdentity)");
    expect(trpcCore).toContain("return authenticatedProcedure.use(");
  });
});

describe("✅ بعد الإصلاح — FinancialRoute", () => {
  it("مالك (user.role=admin) → DashboardLayout كما كان", () => {
    st.user = { id: 1, role: "admin" };
    render(<FinancialRoute permission="inventory_costing.view"><Page /></FinancialRoute>);
    expect(screen.getByTestId("dashboard-layout")).toBeTruthy();
    expect(screen.getByTestId("page")).toBeTruthy();
  });
  it("موظف مخزن (user=null) بصلاحية inventory_costing.view → الصفحة داخل EmployeeShell، ولا «يرجى تسجيل الدخول»", () => {
    st.permissions = ["dashboard.view", "orders.view", "inventory_costing.view"];
    render(<FinancialRoute permission="inventory_costing.view" employeeTitle="الجرد"><Page /></FinancialRoute>);
    expect(screen.getByTestId("employee-shell")).toBeTruthy();
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.getByTestId("employee-shell-user").textContent).toBe("موظف المخزن");
    expect(screen.queryByText("يرجى تسجيل الدخول للوصول إلى المنصة")).toBeNull();
    expect(screen.getByRole("button", { name: "رجوع" })).toBeTruthy();
    expect(screen.getByTestId("employee-shell-logout")).toBeTruthy();
  });
  it("موظف مخزن بلا inventory_costing.view (الافتراضي: dashboard.view + orders.view) → تحويل لبوابة الموظف، لا الصفحة", () => {
    st.permissions = ["dashboard.view", "orders.view"];
    render(<FinancialRoute permission="inventory_costing.view"><Page /></FinancialRoute>);
    expect(st.redirects).toEqual(["/employee-dashboard"]);
    expect(screen.queryByTestId("page")).toBeNull();
  });
  it("المحاسب (accounting.view + ledger.view + inventory_costing.view) → مصرَّح له فيرى الصفحة في EmployeeShell", () => {
    st.permissions = ["accounting.view", "ledger.view", "inventory_costing.view", "inventory_costing.manage"];
    render(<FinancialRoute permission="inventory_costing.view"><Page /></FinancialRoute>);
    expect(screen.getByTestId("employee-shell")).toBeTruthy();
  });
  it("المدير (جلسة admin صناعية، user موجود) → DashboardLayout", () => {
    st.user = { id: 5, role: "admin" }; st.permissions = ["dashboard.view", "inventory_costing.view"];
    render(<FinancialRoute permission="inventory_costing.view"><Page /></FinancialRoute>);
    expect(screen.getByTestId("dashboard-layout")).toBeTruthy();
  });
  it("بلا جلسة إطلاقًا → Home؛ أثناء التحميل → لا شيء", () => {
    render(<FinancialRoute permission="inventory_costing.view"><Page /></FinancialRoute>);
    expect(screen.getByTestId("home")).toBeTruthy();
    cleanup(); st.permLoading = true;
    const { container } = render(<FinancialRoute permission="inventory_costing.view"><Page /></FinancialRoute>);
    expect(container.textContent).toBe("");
  });
  it("bare → الأطفال مباشرة بلا أي قشرة (مساحة المحاسب كما هي)", () => {
    st.permissions = ["ledger.view"];
    render(<FinancialRoute permission="ledger.view" bare><Page /></FinancialRoute>);
    expect(screen.getByTestId("page")).toBeTruthy();
    expect(screen.queryByTestId("employee-shell")).toBeNull();
  });
  it("homeForPermissions كما كان", () => {
    expect(homeForPermissions(["dashboard.view"], true)).toBe("/dashboard");
    expect(homeForPermissions(["ledger.view"], false)).toBe("/ledger");
    expect(homeForPermissions(["accounting.view"], false)).toBe("/accounting-disabled");
    expect(homeForPermissions([], false)).toBe("/employee-dashboard");
  });
  it("App.tsx: /goods-receipt و/stocktake عبر FinancialRoute المستخرَج بعنوان قشرة الموظف؛ لا نسخة محلية من الحارس", () => {
    expect(app).toContain('import { FinancialRoute, homeForPermissions } from "./components/shell/FinancialRoute";');
    expect(app).not.toContain("function FinancialRoute(");
    expect(app).toContain('<FinancialRoute permission="inventory_costing.view" employeeTitle="استلام بضاعة" employeeIcon={PackagePlus}><GoodsReceipt /></FinancialRoute>');
    expect(app).toContain('<FinancialRoute permission="inventory_costing.view" employeeTitle="الجرد" employeeIcon={ClipboardCheck}><Stocktake /></FinancialRoute>');
  });
});
