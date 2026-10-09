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
/** فحص الدور الحرفي manager/warehouse القديم — يتحوّل لـinventory.view/adjust في الخطوة التالية (لوحة المدير). */
const INVENTORY_LEGACY = ["productsList", "lowStockProducts", "addInventoryMovement", "inventoryMovements"];

describe("🔐 البوابة — حارس موحّد", () => {
  it("لا حارس ثابت قديم ولا جلسة مالك داخل البوابة", () => {
    expect(code).not.toContain("function requireEmployeePermission(");
    expect(portal).not.toMatch(/: (permissionProcedure|protectedProcedure|adminProcedure|authenticatedProcedure)\b/);
    expect(fbEntry).not.toMatch(/: (permissionProcedure|protectedProcedure|adminProcedure|authenticatedProcedure)\b/);
  });
  it("كل إجراء: requireEmployeeTenantPermission أو managerPortalProcedure — والمستثنى بهوية فقط محدد بالاسم", () => {
    const all = [...procs(portal), ...procs(fbEntry)].filter(p => p.guard.endsWith("Procedure") || p.guard.startsWith("require") || p.guard === "router");
    expect(all.length).toBeGreaterThan(40);
    for (const p of all) {
      if (p.guard === "router") continue;
      if (IDENTITY_ONLY.includes(p.name) || INVENTORY_LEGACY.includes(p.name)) { expect(p.guard, p.name).toBe("employeePortalProcedure"); continue; }
      expect(["requireEmployeeTenantPermission", "managerPortalProcedure"], `${p.name}: ${p.guard}`).toContain(p.guard);
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
});
