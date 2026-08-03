import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  ALL_PERMISSIONS,
  hasPermission,
  permissionsForRole,
  EMPLOYEE_ROLE_VALUES,
  isAdminTierRole,
} from "./permissions";

/**
 * الطبقة الدقيقة لصلاحيات الحسابات — Sprint 1.
 *
 * `accounting.manage` كانت بتعني إدخال حركة واعتماد تسوية وإقفال يوم، كلهم مع بعض. الفصل
 * بيخلّي المالك يدّي مدير الحسابات حق الإدخال من غير حق الاعتماد، وده أهم حاجز إداري في
 * نظام بيحرّك فلوس كل يوم.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");

/**
 * Source with comments removed.
 *
 * Assertions of the form "this pattern must NOT appear" are worthless against raw source:
 * the comment explaining why a thing was changed necessarily contains the thing's name, so
 * the assertion matches the explanation and fails on correct code. Strip comments and the
 * assertion is about the code again.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

const routersCode = codeOnly(routers);

const NEW_PERMISSIONS = [
  "accounting.create",
  "accounting.approve",
  "treasury.transfer",
  "settlements.create",
  "reports.view_profit",
] as const;

describe("الصلاحيات الجديدة", () => {
  it("الخمسة مضافين للقائمة المركزية", () => {
    for (const p of NEW_PERMISSIONS) {
      expect(ALL_PERMISSIONS, p).toContain(p);
    }
  });

  it("🔑 المالك وطبقة الإدارة عندهم الخمسة", () => {
    for (const role of ["super_admin", "admin", "manager"] as const) {
      for (const p of NEW_PERMISSIONS) {
        expect(hasPermission(role, p), `${role}/${p}`).toBe(true);
      }
    }
  });

  it("🔑 المحاسب بيدخّل ويحوّل ويسجّل تسويات", () => {
    expect(hasPermission("accountant", "accounting.create")).toBe(true);
    expect(hasPermission("accountant", "treasury.transfer")).toBe(true);
    expect(hasPermission("accountant", "settlements.create")).toBe(true);
  });

  it("🔑 المحاسب مابيعتمدش ومابيشوفش الأرباح — فصل المهام", () => {
    // الاتنين دول المالك بيمنحهم يدويًا لو حب، عن طريق tenant_role_permissions.
    expect(hasPermission("accountant", "accounting.approve")).toBe(false);
    expect(hasPermission("accountant", "reports.view_profit")).toBe(false);
  });

  it("🔑 كل الأدوار غير الإدارية وغير المحاسب ممنوعة من الخمسة", () => {
    for (const role of EMPLOYEE_ROLE_VALUES) {
      if (isAdminTierRole(role) || role === "accountant") continue;
      for (const p of NEW_PERMISSIONS) {
        expect(hasPermission(role, p), `${role}/${p}`).toBe(false);
      }
    }
  });

  it("موظف التأكيدات وموظف الشحن مالهمش أي صلاحية حسابات", () => {
    for (const role of ["order_confirmation", "shipping", "warehouse", "viewer"] as const) {
      for (const p of [...NEW_PERMISSIONS, "accounting.view", "accounting.manage"] as const) {
        expect(hasPermission(role, p), `${role}/${p}`).toBe(false);
      }
    }
  });

  it("صلاحيات المحاسب القديمة ما اتشالتش", () => {
    const perms = permissionsForRole("accountant");
    for (const p of ["accounting.view", "accounting.manage", "payroll.pay", "closing.create"] as const) {
      expect(perms, p).toContain(p);
    }
  });
});

describe("تسريب الأرباح اتقفل", () => {
  it("🔑 لوحة الحسابات بقت وراء reports.view_profit مش adminProcedure", () => {
    const start = routersCode.indexOf("\n  accounting: router({");
    const section = routersCode.slice(start, start + 2000);
    expect(section).toContain('dashboard: permissionProcedure("reports.view_profit")');
    expect(section).not.toContain("dashboard: adminProcedure");
  });

  it("مفيش إجراء حسابات فاضل على adminProcedure", () => {
    // adminProcedure معناها «أي حساب إداري»، وهي مش تعبير عن صلاحية مالية. كل إجراء
    // في راوتر الحسابات لازم يقول بالظبط أي صلاحية بيطلبها.
    const start = routersCode.indexOf("\n  accounting: router({");
    const end = routersCode.indexOf("\n  payroll: router({", start);
    const section = routersCode.slice(start, end);
    expect(section).not.toContain(": adminProcedure");
  });
});

describe("لسه مافيش كتابة جديدة في الدفتر القديم", () => {
  it("عدد كتّاب treasury_transactions ما زادش عن الاتنين المعروفين", () => {
    // إيداع/سحب يدوي، وتحصيل أوردر. Sprint 1 هيحوّلهم للدفتر الموحّد؛ الاختبار ده
    // بيمنع إضافة كاتب تالت من غير ما حد ياخد باله.
    const callers = (routersCode.match(/addTreasuryTransaction\(/g) ?? []).length;
    const db = codeOnly(fs.readFileSync("server/db.ts", "utf-8"));
    const dbCallers = (db.match(/await addTreasuryTransaction\(/g) ?? []).length;
    expect(callers + dbCallers).toBeLessThanOrEqual(3); // ١ في routers + ١ في db + التعريف
  });
});
