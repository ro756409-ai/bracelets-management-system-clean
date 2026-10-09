import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس نصّي: كل إجراء في البوابة (employeePortal + facebookEntry) يمر بحارس واحد لهوية كوكي الموظف
 * وصلاحية الدور بتجاوزات الشركة — `requireEmployeeTenantPermission` — أو بحارس المدير. لا جلسة مالك
 * (permissionProcedure/protectedProcedure/adminProcedure) داخل البوابة، ولا حارس ثابت قديم.
 */
const code = fs.readFileSync("server/routers.ts", "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !l.trim().startsWith("//")).join("\n");
const block = (start: string, end: string) => code.slice(code.indexOf(start), code.indexOf(end, code.indexOf(start)));
const portal = block("\n  employeePortal: router({", "\n  duplicates: router({");
const fbEntry = block("\n  facebookEntry: router({", "\n  }),\n");
const procs = (src: string) => [...src.matchAll(/^ {4,6}([a-zA-Z]+): ([a-zA-Z]+)(\(([^)]*)\))?/gm)].map(m => ({ name: m[1], guard: m[2], arg: m[4] ?? null }));

/** بهوية فقط بلا صلاحية (قراءة الذات/الإعلان) — مقصود وموثّق. */
const IDENTITY_ONLY = ["me", "myPermissions", "activeBroadcast"];

describe("🔐 البوابة — حارس موحّد", () => {
  it("لا حارس ثابت قديم ولا جلسة مالك داخل البوابة", () => {
    expect(code).not.toContain("function requireEmployeePermission(");
    expect(portal).not.toMatch(/: (permissionProcedure|protectedProcedure|adminProcedure|authenticatedProcedure)\b/);
    expect(fbEntry).not.toMatch(/: (permissionProcedure|protectedProcedure|adminProcedure|authenticatedProcedure)\b/);
  });
  it("كل إجراء: requireEmployeeTenantPermission أو requireManagerPortalPermission — والمستثنى بهوية فقط محدد بالاسم", () => {
    const all = [...procs(portal), ...procs(fbEntry)].filter(p => p.guard.endsWith("Procedure") || p.guard.startsWith("require") || p.guard === "router");
    expect(all.length).toBeGreaterThan(40);
    for (const p of all) {
      if (p.guard === "router") continue;
      if (IDENTITY_ONLY.includes(p.name)) { expect(p.guard, p.name).toBe("employeePortalProcedure"); continue; }
      expect(["requireEmployeeTenantPermission", "requireManagerPortalPermission"], `${p.name}: ${p.guard}`).toContain(p.guard);
    }
  });
  it("مهامي: قراءة وتحديث حالة فقط، strict، بلا employeeId من العميل، والملكية في الشرط", () => {
    const t = block("    tasks: router({", "\n    }),");
    expect(t).toContain('listMine: requireEmployeeTenantPermission("tasks.view_own")');
    expect(t).toContain('updateMyStatus: requireEmployeeTenantPermission("tasks.view_own")');
    expect(t).not.toMatch(/\b(create|delete|assign)\w*:/);
    expect(t.match(/\.strict\(\)/g)!.length).toBe(2);
    expect(t).not.toContain("employeeId");
    expect(t).toContain("or(eq(tasks.assignedTo, emp.id), isNull(tasks.assignedTo))");
    expect(t.match(/taskScopeCondition\(scope\)/g)!.length).toBe(2);
  });
  it("لوحة المدير: دور إداري + صلاحية لكل إجراء؛ لا فحص دور حرفي للمخزون؛ والتكلفة خلف صلاحيتها", () => {
    expect(code).toContain("function requireManagerPortalPermission(permission: Permission) {\n  return managerPortalProcedure.use(");
    expect(portal).not.toMatch(/: managerPortalProcedure\b/);
    expect(code).not.toContain('emp.role !== "manager" && emp.role !== "warehouse"');
    const want: Record<string, string> = {
      dashboardStats: "dashboard.view", allOrders: "orders.view", assignOrder: "orders.update", bulkAssignOrders: "orders.update", createOrder: "orders.create",
      employeePerformance: "dashboard.view", cancellationReasons: "dashboard.view", dailyChart: "dashboard.view",
      employeesList: "employees.view", activeEmployeesList: "employees.view", createEmployee: "employees.manage", updateEmployee: "employees.manage",
      deleteEmployee: "employees.manage", setEmployeeCredentials: "employees.manage", changeEmployeePassword: "employees.manage",
      sendBroadcast: "employees.manage", clearBroadcast: "employees.manage",
      productsList: "inventory.view", lowStockProducts: "inventory.view", inventoryMovements: "inventory.view", addInventoryMovement: "inventory.adjust",
    };
    const got = Object.fromEntries(procs(portal).map(p => [p.name, p.arg?.replace(/"/g, "")]));
    for (const [name, perm] of Object.entries(want)) expect(got[name], name).toBe(perm);
    for (const name of ["productsList", "lowStockProducts", "stockLevels", "stockVariants"]) expect(block(`    ${name}: `, "}),"), name).toContain("stripCostUnlessAllowed(ctx,");
    expect(code).toContain('hasTenantPermission(requireTenantId(emp), emp.role, "inventory_costing.view")');
  });
  it("مهام الويب (لوحة المدير): القراءة employees.view والكتابة employees.manage", () => {
    const t = block("\n  tasks: router({", "سجل الطباعات");
    expect(t.match(/await requireSessionPermission\(ctx, "employees\.manage"\);/g)!.length).toBe(3);
    expect(t.match(/await requireSessionPermission\(ctx, "employees\.view"\);/g)!.length).toBe(1);
  });
  it("التوحيد بلا تغيير افتراضي: قراءات الكتالوج/الإدخال على orders.view (كانت لأي موظف، وكل الأدوار معها orders.view)", () => {
    const got = Object.fromEntries(procs(fbEntry).map(p => [p.name, p.arg?.replace(/"/g, "")]));
    for (const name of ["products", "catalog", "entryConfig", "parsePaste", "productVariants", "scanLogs"]) expect(got[name], name).toBe("orders.view");
    for (const name of ["addOrder", "updateOrder", "deleteOrder"]) expect(got[name], name).toBe("orders.create");
  });
});
