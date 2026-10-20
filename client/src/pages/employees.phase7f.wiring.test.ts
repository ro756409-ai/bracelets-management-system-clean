/**
 * المرحلة 7F — حارس نصّي للموظفين/الصلاحيات/الأداء: نفس الاستعلامات والـmutations قبل = بعد، نفس
 * الأدوار (لا دور جديد)، نفس التحقق والـpayload، الصلاحيات من السيرفر مع invalidate فوري، ما هو للمالك
 * فقط مقفول في الواجهة والسيرفر، لا ألوان خام، أهداف لمس 44px، وحارس ضغط مكرر على كل إجراء كتابة.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (p: string) => strip(readFileSync(path.join(root, p), "utf8"));
const hooks = (src: string) => [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

describe("🔌 Queries/Mutations قبل = بعد", () => {
  it("Employees: نفس التسعة بالترتيب نفسه", () => {
    expect(hooks(read("pages/Employees.tsx"))).toEqual([
      "trpc.employees.roleSupport.useQuery", "trpc.employees.list.useQuery", "trpc.employees.allInventory.useQuery", "trpc.reports.employeePerformance.useQuery",
      "trpc.employees.create.useMutation", "trpc.employees.update.useMutation", "trpc.employees.update.useMutation",
      "trpc.employees.setCredentials.useMutation", "trpc.employees.delete.useMutation", "trpc.orders.unassignEmployeeOrders.useMutation",
    ]);
  });
  it("PermissionSettings: permissionConfiguration + rolePermissionSave فقط، مع invalidate لـauth.myPermissions", () => {
    const p = read("components/PermissionSettings.tsx");
    expect(hooks(p)).toEqual(["trpc.accountingV2.permissionConfiguration.useQuery", "trpc.accountingV2.rolePermissionSave.useMutation"]);
    expect(p).toContain("await utils.accountingV2.permissionConfiguration.invalidate(); await utils.auth.myPermissions.invalidate();");
  });
  it("ManagerDashboard و EmployeeDashboard: لم تتغيّر hooks (لمسات 44px وtokens فقط)", () => {
    // + employeePortal.myPermissions (صلاحية لكل تبويب وفعل في لوحة المدير)
    expect(hooks(read("pages/ManagerDashboard.tsx")).length).toBe(32);
    // 23 أصلية + employeePortal.myPermissions (روابط الشحن حسب صلاحية هوية البوابة — إضافة مقصودة)
    // + performance.status (رابط «أدائي» بعد تفعيل سجل الأحداث)
    // + attendance.status (رابط «حضوري» بعد تفعيل الحضور)
    // + employeePortal.team.myTeams (رابط «فريقي» للقائد الفعّال فقط)
    expect(hooks(read("pages/EmployeeDashboard.tsx")).length).toBe(27);
  });
});

describe("👥 الأدوار والتحقق كما هي", () => {
  const p = read("pages/Employees.tsx");
  it("لا دور جديد: قائمة الأدوار والأدوار القابلة للإسناد كما كانت", () => {
    expect(p).toContain('"agent", "warehouse", "manager", "facebook_entry", "scanner",');
    expect(p).toContain('"super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",');
    expect(p).toContain('"moderator", "agent", "data_entry", "accountant", "manager",');
    expect(p).toContain('super_admin: "المالك (كل الصلاحيات)"');
  });
  it("التحقق والـpayload كما كانا", () => {
    for (const s of [
      'if (!form.name.trim()) { toast.error("اسم الموظف مطلوب"); return; }',
      'toast.error("اختر النشاط اللي هيتبعله الموظف");',
      "name: form.name, phone: form.phone, email: form.email.trim() || undefined, role: form.role,", // BUG-41
      "businessId: resolvedBusinessId ?? undefined,",
      'if (!credUsername.trim()) { toast.error("اسم المستخدم مطلوب"); return; }',
      'if (credPassword.length < 6) { toast.error("كلمة المرور يجب أن تكون 6 أحرف على الأقل"); return; }',
      "username: credUsername.trim(),",
      "const isAdmin = user?.role === 'admin';",
    ]) expect(p, s).toContain(s);
  });
  it("حارس الضغط المكرر على كل إجراء كتابة (إضافة/تعديل/بيانات دخول/حذف/سحب/تفعيل)", () => {
    expect(p).toContain("createInFlightGuard");
    for (const k of ['guard.run("save"', 'guard.run("cred"', 'guard.run("delete"', 'guard.run("reclaim"', "guard.run(`toggle:${emp.id}`"]) expect(p, k).toContain(k);
    expect(p).not.toMatch(/\.mutate\(\{ id: editingId, \.\.\.payload \}\)\s*;/);
  });
  it("غير المدير يرى PermissionDeniedState بدل الصفحة", () => {
    expect(p).toContain("if (!isAdmin) {");
    expect(p).toContain("<PermissionDeniedState");
  });
});

describe("🔐 الصلاحيات", () => {
  const p = read("components/PermissionSettings.tsx");
  it("ما هو للمالك فقط مقفول في الواجهة لغير super_admin — ونفس القائمة على السيرفر", () => {
    expect(p).toContain('new Set(["ledger.period.reopen", "ledger.activate"])');
    expect(p).toContain("const locked = OWNER_ONLY.has(permission) && !ownerRole;");
    expect(p).toContain("disabled={save.isPending || locked}");
    const server = readFileSync(path.resolve(root, "../../server/permissions.ts"), "utf8");
    expect(server).toContain('LEDGER_OWNER_ONLY_PERMISSIONS: readonly Permission[] = ["ledger.period.reopen", "ledger.activate"]');
  });
  it("الأسماء العربية من المصدر المشترك، والحفظ بنفس الـpayload", () => {
    expect(p).toContain("permissionLabel(permission)");
    expect(p).toContain("save.mutate({ role: role as any, permission: permission as any, isAllowed })");
  });
});

describe("🎨 الهوية", () => {
  for (const f of ["pages/Employees.tsx", "components/PermissionSettings.tsx", "pages/ManagerDashboard.tsx", "pages/EmployeeDashboard.tsx"]) {
    it(`${f}: لا ألوان Tailwind خام`, () => {
      expect(read(f)).not.toMatch(/\b(bg|text|border)-(gray|stone|slate|blue|amber|emerald|green|red|purple|violet|indigo|cyan|teal|sky|rose)-\d{2,3}\b/);
    });
  }
  for (const f of ["pages/Employees.tsx", "pages/EmployeeDashboard.tsx"]) {
    it(`${f}: كل Button بهدف لمس 44px على الهاتف`, () => {
      const buttons = read(f).match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) expect(b, f + " " + b.slice(0, 70)).toMatch(/min-h-1[12]|\bh-1[0-4]\b|\{TOUCH\}|\$\{TOUCH\}|\{ICON_BTN\}|\$\{ICON_BTN\}/);
    });
  }
  it("Employees: جداول الجرد والأداء عبر ResponsiveDataTable (بطاقات على الهاتف) بلا <table> يدوي؛ الأداء بلا حساب جديد", () => {
    const p = read("pages/Employees.tsx");
    expect((p.match(/<ResponsiveDataTable/g) ?? []).length).toBe(2);
    expect(p).not.toContain("<table");
    expect(p).toContain("rate={e.confirmRate}"); // النسبة من السيرفر كما هي
  });
});
