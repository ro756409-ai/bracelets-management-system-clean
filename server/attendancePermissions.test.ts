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
