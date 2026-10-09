import { describe, it, expect } from "vitest";
import { hasPermission, MANAGER_GRANT_ONLY_PERMISSIONS } from "./permissions";

/** مصفوفة صلاحيات الحضور والأداء الافتراضية (قرارات المالك) — قبل أي منح لكل شركة. */
const SELF = ["attendance.clock_self", "attendance.view_self", "attendance.request_correction", "employee_performance.view_self"] as const;
const ADMIN_ONLY = ["attendance.view_all", "attendance.manage_shifts", "attendance.correct", "attendance.approve_corrections", "attendance.manage_leaves", "attendance.export", "employee_performance.view_all", "employee_performance.export"] as const;
const OPERATIONAL = ["warehouse", "agent", "order_confirmation", "moderator", "shipping", "scanner", "data_entry", "facebook_entry", "accountant"];

describe("مصفوفة الحضور والأداء — الافتراضي", () => {
  it("المالك والأدمن: كل شيء", () => {
    for (const p of [...SELF, ...ADMIN_ONLY]) { expect(hasPermission("super_admin", p), p).toBe(true); expect(hasPermission("admin", p), p).toBe(true); }
  });
  it("المدير: الذاتي فقط افتراضيًا، والإدارة بالمنح", () => {
    for (const p of SELF) expect(hasPermission("manager", p), p).toBe(true);
    for (const p of ADMIN_ONLY) { expect(hasPermission("manager", p), p).toBe(false); expect(MANAGER_GRANT_ONLY_PERMISSIONS, p).toContain(p); }
  });
  it("كل دور تشغيلي: الذاتي فقط، بلا أي صلاحية إدارية أو مقارنة", () => {
    for (const r of OPERATIONAL) {
      for (const p of SELF) expect(hasPermission(r, p), `${r}:${p}`).toBe(true);
      for (const p of ADMIN_ONLY) expect(hasPermission(r, p), `${r}:${p}`).toBe(false);
    }
  });
  it("viewer: لا شيء", () => {
    for (const p of [...SELF, ...ADMIN_ONLY]) expect(hasPermission("viewer", p), p).toBe(false);
  });
});

describe("مصفوفة المخزون والمهام — الافتراضي", () => {
  const ALL_ROLES = ["super_admin", "admin", "manager", "warehouse", "agent", "order_confirmation", "moderator", "shipping", "scanner", "data_entry", "facebook_entry", "accountant", "viewer"];
  it("inventory.view/adjust: المالك والأدمن والمدير والمخزن فقط — والمخزن بلا تكلفة", () => {
    for (const r of ALL_ROLES) {
      const yes = ["super_admin", "admin", "manager", "warehouse"].includes(r);
      expect(hasPermission(r, "inventory.view"), r).toBe(yes);
      expect(hasPermission(r, "inventory.adjust"), r).toBe(yes);
    }
    expect(hasPermission("warehouse", "inventory_costing.view")).toBe(false);
    expect(hasPermission("manager", "inventory_costing.view")).toBe(true);
  });
  it("tasks.view_own للأدوار التشغيلية؛ إدارة المهام employees.manage للإدارة فقط (بلا توسيع للمشرف)", () => {
    for (const r of OPERATIONAL) expect(hasPermission(r, "tasks.view_own"), r).toBe(true);
    expect(hasPermission("viewer", "tasks.view_own")).toBe(false);
    expect(hasPermission("moderator", "employees.manage")).toBe(false);
    for (const r of ["super_admin", "admin", "manager"]) expect(hasPermission(r, "employees.manage"), r).toBe(true);
  });
});
