import { describe, it, expect } from "vitest";
import fs from "fs";
import { netFromComponents, calcPayrollLine } from "@shared/payrollCalc";

/**
 * شاشة تجهيز المرتبات.
 *
 * الشرط الأساسي إنها **مابتعملش أي حركة مالية**. الدفع الشهري من شاشة المرتبات هو
 * المسار الوحيد اللي بينزّل قيود، وأي مسار تاني معناه إن نفس المرتب ممكن يتخصم مرتين.
 * الاختبارات دي بتثبّت ده على المصدر، وبتثبّت إن الصافي معادلة واحدة مش اتنين.
 */

const page = fs.readFileSync("client/src/pages/SalaryPreparation.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");

/** Source with comments stripped — a "must not appear" assertion is meaningless against
 *  prose that necessarily names the thing it explains. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("مفيش مسار فلوس تاني", () => {
  it("🔑 الشاشة مابتنادي أي إجراء بيحرّك فلوس", () => {
    for (const forbidden of [
      "treasuryCreate",
      "expenseCreate",
      "financialTransactionPost",
      "periodPay",
      "payPayrollPeriod",
      "advanceCreate",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 بتكتب في payroll_items عن طريق itemUpdate وبس", () => {
    const mutations = [...code.matchAll(/trpc\.[a-zA-Z]+\.([a-zA-Z]+)\.useMutation/g)].map(m => m[1]);
    expect(mutations).toEqual(["itemUpdate"]);
  });

  it("الاستعلامات قراءة بس: قائمة الدورات وتفاصيل الدورة", () => {
    const queries = [...code.matchAll(/trpc\.[a-zA-Z]+\.([a-zA-Z]+)\.useQuery/g)].map(m => m[1]);
    expect(new Set(queries)).toEqual(new Set(["periodList", "periodGet"]));
  });

  it("🔑 itemUpdate نفسه مابيلمسش أي جدول مالي", () => {
    const i = routers.indexOf("    itemUpdate: adminProcedure");
    const section = routers.slice(i, routers.indexOf("\n    period", i + 10));
    for (const forbidden of ["financialTransaction", "treasuryTransaction", "expenses"]) {
      expect(section, forbidden).not.toContain(forbidden);
    }
  });
});

describe("السلف مش قابلة للتعديل", () => {
  it("🔑 مفيش حقل إدخال للسلف", () => {
    // الحقول القابلة للتعديل معرّفة في نوع Draft — والسلف مش فيه.
    const draft = page.slice(page.indexOf("type Draft = {"), page.indexOf("};", page.indexOf("type Draft = {")));
    expect(draft).toContain("baseSalary");
    expect(draft).toContain("bonuses");
    expect(draft).toContain("commissions");
    expect(draft).toContain("deductions");
    expect(draft).toContain("notes");
    expect(draft).not.toContain("advances");
  });

  it("🔑 itemUpdate مابيقبلش advances أصلاً — الحاجز على السيرفر مش في الواجهة", () => {
    const i = routers.indexOf("    itemUpdate: adminProcedure");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    expect(input).toContain("bonuses");
    expect(input).toContain("deductions");
    expect(input).not.toContain("advances");
  });

  it("السلف بتتعرض من السطر المحفوظ", () => {
    expect(code).toContain("toNumber(selected.advances)");
  });
});

describe("الصافي معادلة واحدة", () => {
  it("🔑 الشاشة والسيرفر بيستخدموا نفس الدالة", () => {
    expect(code).toContain("netFromComponents({");
    const calc = fs.readFileSync("shared/payrollCalc.ts", "utf-8");
    expect(calc).toContain("export function netFromComponents");
    // calcPayrollLine بقت بتنادي نفس الدالة بدل ما تكرر المعادلة.
    const fn = calc.slice(calc.indexOf("export function calcPayrollLine"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("netFromComponents({");
  });

  it("الأساسي + بونص + عمولة − خصومات − سلف", () => {
    const net = netFromComponents({
      baseSalary: 5000, overtimeAmount: 0, bonuses: 500,
      commissions: 300, absenceDeduction: 0, deductions: 200, advances: 1000,
    });
    expect(net).toBe(4600);
  });

  it("الإضافي وخصم الغياب داخلين في نفس المعادلة", () => {
    const net = netFromComponents({
      baseSalary: 5000, overtimeAmount: 400, bonuses: 0,
      commissions: 0, absenceDeduction: 300, deductions: 0, advances: 0,
    });
    expect(net).toBe(5100);
  });

  it("🔑 القيم السالبة بتتقص عند صفر — الخصم مايبقاش إضافة", () => {
    const net = netFromComponents({
      baseSalary: 5000, overtimeAmount: 0, bonuses: -500,
      commissions: 0, absenceDeduction: 0, deductions: -200, advances: -100,
    });
    expect(net).toBe(5000);
  });

  it("calcPayrollLine ما اتغيّرش سلوكه بعد الاستخراج", () => {
    const profile = { salaryType: "monthly" as const, baseSalary: 6000, commissionType: null, commissionValue: 0, commissionBasis: null };
    const settings = {
      workingDaysPerMonth: 26, absenceDeductionBasis: "working_days" as const,
      weekendDays: "5,6", overtimeMode: "manual" as const, overtimeMultiplier: 1.5,
      workHoursPerDay: 8, roundingMode: "none" as const,
    };
    const line = {
      attendanceDays: 26, absenceDays: 0, overtimeHours: 0, overtimeAmount: 0,
      bonuses: 500, deductions: 100, advances: 400, commissionOrders: 0, commissionAmount: 0,
    };
    const r = calcPayrollLine(profile as any, line as any, settings as any);
    expect(r.netSalary).toBe(6000 + 500 - 100 - 400);
  });
});

describe("الأرقام مقفولة بعد الاعتماد", () => {
  it("🔑 التعديل ممنوع لما الدورة مش مسودة", () => {
    expect(code).toContain('period.status !== "draft"');
    expect(code).toContain("disabled={locked}");
    expect(code).toContain("hasErrors || locked");
  });
});

describe("الشاشة بتقول للمحاسب إنها مابتحركش فلوس", () => {
  it("فيه نص صريح إن مفيش حركة مالية", () => {
    expect(page).toContain("مفيش أي حركة مالية بتتعمل منها");
  });

  it("وفيه طريق واضح للدفع في مكانه الصح", () => {
    expect(page).toContain('href="/payroll"');
    expect(page).toContain("الاعتماد والدفع");
  });
});
