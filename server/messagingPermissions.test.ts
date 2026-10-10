import { describe, it, expect } from "vitest";
import fs from "fs";
import { ALL_PERMISSIONS, EMPLOYEE_ROLE_VALUES, LOCKED_OWNER_PERMISSIONS, hasPermission, permissionsForRole } from "./permissions";
import { PERMISSION_LABELS } from "../shared/permissionLabels";

/** صلاحيات الرسائل: الافتراضي لكل دور، و`messages.view_private` مقفولة للجميع افتراضيًا (حتى المالك). */
describe("💬 صلاحيات الرسائل — الافتراضي", () => {
  const MSG = ["messages.use", "messages.voice", "messages.announce", "messages.manage_groups", "messages.view_private"] as const;

  it("الخمس موجودة ولكلٍ منها اسم عربي", () => {
    for (const p of MSG) { expect(ALL_PERMISSIONS).toContain(p); expect(PERMISSION_LABELS[p]).toBeTruthy(); }
    expect(LOCKED_OWNER_PERMISSIONS).toEqual(["messages.view_private"]);
  });

  it("كل الأدوار: المحادثة والصوت؛ الإعلانات والمجموعات للإدارة فقط", () => {
    for (const role of EMPLOYEE_ROLE_VALUES) {
      expect(hasPermission(role, "messages.use")).toBe(true);
      expect(hasPermission(role, "messages.voice")).toBe(true);
      const admin = ["super_admin", "admin", "manager"].includes(role);
      expect(hasPermission(role, "messages.announce")).toBe(admin);
      expect(hasPermission(role, "messages.manage_groups")).toBe(admin);
    }
  });

  it("view_private خارج كل الأدوار افتراضيًا — المالك نفسه يحتاج منحًا صريحًا", () => {
    for (const role of EMPLOYEE_ROLE_VALUES) {
      expect(permissionsForRole(role)).not.toContain("messages.view_private");
      expect(hasPermission(role, "messages.view_private")).toBe(false);
    }
  });

  it("الحراس في الكود: الحفظ يرفض المنح لغير المالك، والتقييم يتجاهله، وقائمة جلسة المالك تستبعدها", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    expect(routers).toMatch(/isLockedOwnerPermission\(input\.permission\) && !isOwnerRole\(input\.role\)/);
    expect(routers).toContain("return ALL_PERMISSIONS.filter(p => !isLockedOwnerPermission(p));");
    const perms = fs.readFileSync("server/permissions.ts", "utf-8");
    expect(perms).toContain("if (isLockedOwnerPermission(permission) && !isOwnerRole(role)) return false;");
  });
});
