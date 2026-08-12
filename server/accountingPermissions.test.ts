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

describe("كتّاب الخزنة معروفين بالاسم", () => {
  /**
   * الخزنة هي الرقم اللي التاجر بيصدّقه. أي مسار جديد بيحرّكها لازم يبقى قرار واعي مش
   * سطر بيعدّي في مراجعة. الاختبار ده بيقفل حاجتين: إن فيه **مكان واحد** بيعمل insert
   * في الجدول، وإن قايمة اللي بينادوا عليه مقفولة بالاسم.
   *
   * لو ضفت مسار جديد بيحرّك الخزنة، الاختبار ده هيقع — وده المطلوب. ضيف الملف للقايمة
   * تحت بعد ما تتأكد إن الحركة بتتكتب مرة واحدة بالظبط.
   */
  const serverFiles = fs
    .readdirSync("server")
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map(f => ({ name: f, code: codeOnly(fs.readFileSync(`server/${f}`, "utf-8")) }));

  it("🔑 مكان واحد بس بيعمل insert في treasury_transactions", () => {
    const inserters = serverFiles.filter(f =>
      f.code.includes("insert(treasuryTransactions)")
    );
    expect(inserters.map(f => f.name)).toEqual(["db.ts"]);
    expect(
      (inserters[0].code.match(/insert\(treasuryTransactions\)/g) ?? []).length
    ).toBe(1);
  });

  it("🔑 والمسارات اللي بتحرّك الخزنة هي دي وبس", () => {
    const callers = serverFiles
      .filter(f => /addTreasuryTransaction(InTransaction)?\(/.test(f.code))
      .map(f => f.name)
      .sort();
    expect(callers).toEqual(
      [
        "db.ts", // التعريف + تحصيل الأوردر
        "expensesV2.service.ts", // دفع مصروف (والإعلانات معاه)
        "payrollV2.service.ts", // صرف المرتبات
        "advancesV2.service.ts", // صرف سُلفة لموظف
        "supplierLedger.service.ts", // دفعة للمصنع
        "accountingV2.service.ts", // إيداع/سحب يدوي (recordManualTreasuryEntry بمفتاح idempotency)
        "settlementsV2.service.ts", // تحصيل اليوم من شركة الشحن
      ].sort()
    );
  });

  it("🔑 الجسر جوه الترانزاكشن مش في واحدة لوحده", () => {
    // لو الدفع نادى الصيغة اللي بتفتح ترانزاكشن بتاعتها، كان ممكن القيد المالي ينجح
    // والخزنة تفشل — والدفترين يفضلوا مختلفين من غير ما حد ياخد باله.
    for (const file of ["expensesV2.service.ts", "payrollV2.service.ts"]) {
      const code = codeOnly(fs.readFileSync(`server/${file}`, "utf-8"));
      expect(code, file).toContain("addTreasuryTransactionInTransaction(tx, {");
      expect(code, file).not.toMatch(/await addTreasuryTransaction\(/);
    }
  });
});
