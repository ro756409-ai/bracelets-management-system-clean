import { describe, it, expect } from "vitest";
import fs from "fs";
import { TRPCError } from "@trpc/server";
import { router, permissionProcedure } from "./_core/trpc";

/**
 * تعديلان في مساحة المحاسب:
 *  1) استلام البضاعة: المورد بيتحدد تلقائيًا (أول مورد نشط، أو «الورشة») — مفيش اختيار
 *     يدوي، والـfallback مابيعملش duplicate (upsert مرة واحدة لو مفيش مورد خالص).
 *  2) المرتبات: endpoint محدود payrollEmployeeCreate (payroll.manage) بينشئ موظف
 *     رواتب بدور viewer بدون credentials + ملف راتب في transaction واحدة (rollback لو فشل).
 */

const goods = fs.readFileSync("client/src/pages/accountant/AccGoodsReceipt.tsx", "utf-8");
const payrollUi = fs.readFileSync("client/src/pages/accountant/AccPayroll.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const dbSrc = fs.readFileSync("server/db.ts", "utf-8");
const svcFn = dbSrc.slice(
  dbSrc.indexOf("export async function createPayrollEmployee"),
  dbSrc.indexOf("export async function createPayrollEmployee") + 1400
);

// ───────────────── المورد التلقائي ─────────────────

describe("🔑 مورد الورشة بيتحدد بالاسم «الورشة» — مش أول مورد نشط", () => {
  it("🔑 مفيش activeSups[0] — الاختيار مش بترتيب القايمة", () => {
    // ده الحارس ضد ربط الاستلام بمورد تاني بالخطأ.
    expect(goods).not.toContain("activeSups[0]");
    expect(goods).not.toContain("activeSups");
  });
  it("🔑 الاسم المعتمد ثابت والبحث بالاسم", () => {
    expect(goods).toContain('const WORKSHOP_SUPPLIER = "الورشة"');
    expect(goods).toContain("(s: any) => s.name === WORKSHOP_SUPPLIER");
  });
  it("🔑 auto-select = «الورشة» تحديدًا (حتى لو فيه موردين تانيين)", () => {
    expect(goods).toContain("setSupplierName(WORKSHOP_SUPPLIER)");
    expect(goods).toContain("effectiveSupplier = supplierName.trim() || WORKSHOP_SUPPLIER");
  });
  it("🔑 الـdropdown اتشال — المورد read-only، والتسجيل مايتوقفش على المستخدم", () => {
    expect(goods).toContain("value={effectiveSupplier} disabled");
    expect(goods).not.toContain("s.name}>{s.name}");
    const fn = goods.slice(goods.indexOf("const save = async"));
    const body = fn.slice(0, fn.indexOf("const startEdit"));
    expect(body).not.toContain("اختار المورد");
    expect(body).toContain("supplierName: effectiveSupplier");
  });
  it("🔑 إنشاء «الورشة» عند غيابها/تعطّلها — حتى لو فيه مورد آخر نشط، وبدون duplicate", () => {
    // الشرط على وجود/تنشيط مورد الورشة نفسه — مش على activeSups.length===0.
    expect(goods).toContain("!workshopSup || !workshopSup.isActive");
    // upsert بالاسم المعتمد (مفتاح ثابت في الباك) → مفيش duplicate + reactivation.
    expect(goods).toContain("saveSupplier.mutateAsync({ businessId, name: WORKSHOP_SUPPLIER, isActive: true })");
    expect(goods).not.toContain("mysqlTable");
  });
});

// ───────────────── إنشاء موظف رواتب — الخدمة ─────────────────

describe("🔑 createPayrollEmployee: viewer، بدون دخول، transaction واحدة", () => {
  it("🔑 دور ثابت غير إداري viewer", () => {
    expect(svcFn).toContain('role: "viewer"');
    // مفيش أي دور إداري
    for (const admin of ['"admin"', '"super_admin"', '"manager"']) {
      expect(svcFn, admin).not.toContain(`role: ${admin}`);
    }
  });
  it("🔑 بدون username/passwordHash (لا دخول)", () => {
    expect(svcFn).not.toContain("username");
    expect(svcFn).not.toContain("passwordHash");
  });
  it("🔑 الموظف + ملف الراتب في transaction واحدة (rollback لو الملف فشل)", () => {
    expect(svcFn).toContain("db.transaction");
    expect(svcFn).toContain("tx.insert(employees)");
    expect(svcFn).toContain("tx.insert(employeeSalaryProfiles)");
    // الاتنين جوه نفس الـtx — فأي فشل في الملف بيرجّع الموظف
    const txStart = svcFn.indexOf("db.transaction");
    expect(svcFn.indexOf("tx.insert(employees)")).toBeGreaterThan(txStart);
    expect(svcFn.indexOf("tx.insert(employeeSalaryProfiles)")).toBeGreaterThan(txStart);
  });
  it("🔑 jobTitle في notes، monthly، effectiveFrom = startDate، tenant-scoped", () => {
    expect(svcFn).toContain("notes: input.jobTitle");
    expect(svcFn).toContain('salaryType: "monthly"');
    expect(svcFn).toContain("effectiveFrom: input.effectiveFrom");
    expect(svcFn).toContain("tenantId: input.tenantId");
  });
});

describe("🔑 endpoint payrollEmployeeCreate — على payroll.manage مش admin", () => {
  it("🔑 على permissionProcedure(payroll.manage)", () => {
    expect(routers).toContain('payrollEmployeeCreate: permissionProcedure("payroll.manage")');
  });
  it("🔑 مفيش توسيع لـemployees.create (لسه adminProcedure)", () => {
    expect(routers).toContain("create: adminProcedure");
  });
});

// البوابة الحقيقية: المحاسب بيعدّي على payroll.manage؛ دور تشغيلي بيترفض.
const gate = router({
  addEmp: permissionProcedure("payroll.manage").query(() => "ok" as const),
});
const empCtx = (role: string) => ({ user: null, employee: { id: 9, role }, tenantId: 1 });
async function allowed(ctx: any) {
  try { await gate.createCaller(ctx).addEmp(); return true; }
  catch (e) { if (e instanceof TRPCError && e.code === "FORBIDDEN") return false; throw e; }
}

describe("🔑 بوابة إضافة الموظف", () => {
  it("🔑 المحاسب يقدر", async () => {
    expect(await allowed(empCtx("accountant"))).toBe(true);
  });
  it("🔑 دور تشغيلي (تأكيدات/إدخال/مودريتور) يترفض", async () => {
    for (const role of ["order_confirmation", "data_entry", "moderator"]) {
      expect(await allowed(empCtx(role)), role).toBe(false);
    }
  });
});

describe("🔑 الواجهة: زر إضافة موظف + ظهور فوري", () => {
  it("🔑 زر «إضافة موظف» + فورم (اسم/وظيفة/أساسي/هاتف/تاريخ)", () => {
    expect(payrollUi).toContain("إضافة موظف");
    expect(payrollUi).toContain("payrollEmployeeCreate");
    for (const f of ["setEmpName", "setEmpJob", "setEmpBase", "setEmpPhone", "setEmpStart"]) {
      expect(payrollUi, f).toContain(f);
    }
  });
  it("🔑 بعد النجاح refresh للموظفين والمرتبات فيظهر فورًا", () => {
    expect(payrollUi).toContain("utils.employees.list.invalidate()");
    expect(payrollUi).toContain("utils.payroll.salarySummary.invalidate()");
  });
});
