import { describe, it, expect } from "vitest";
import {
  calcBaseSalary, calcAbsenceDeduction, calcOvertime, calcCommission, calcPayrollLine,
  applyRounding, dailyRateFromMonthly, parseManualFields, mergeWithManualEdits,
  COMMISSION_BASIS_STATUS, toNumber,
  type PayrollSettingsInput, type SalaryProfileInput, type PayrollLineInput,
} from "./payrollCalc";

const SETTINGS: PayrollSettingsInput = {
  workingDaysPerMonth: 26,
  absenceDeductionBasis: "working_days",
  overtimeMode: "manual",
  overtimeMultiplier: "1.50",
  workHoursPerDay: "8.00",
  roundingMode: "none",
};

const EMPTY_LINE: PayrollLineInput = {
  attendanceDays: 0, absenceDays: 0, overtimeHours: 0, overtimeAmount: 0,
  bonuses: 0, deductions: 0, advances: 0,
  commissionOrderCount: 0, commissionOrderTotal: 0,
};

describe("toNumber — decimal بيرجع كنص من drizzle", () => {
  it("بيقبل النص الرقمي", () => expect(toNumber("3000.00")).toBe(3000));
  it("بيقبل الرقم", () => expect(toNumber(3000)).toBe(3000));
  it("null و undefined بيبقوا صفر مش NaN", () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber("")).toBe(0);
  });
  it("نص غير رقمي بيبقى صفر — سطر راتب مايقعش بسبب بيانات تالفة", () => {
    expect(toNumber("abc")).toBe(0);
  });
});

describe("أجر اليوم", () => {
  it("أيام العمل: ٣٠٠٠ ÷ ٢٦", () => {
    expect(dailyRateFromMonthly(3000, SETTINGS)).toBeCloseTo(115.38, 2);
  });
  it("أيام التقويم: ٣٠٠٠ ÷ ٣٠", () => {
    expect(dailyRateFromMonthly(3000, { ...SETTINGS, absenceDeductionBasis: "calendar_days" })).toBe(100);
  });
  it("workingDaysPerMonth = 0 مايعملش قسمة على صفر", () => {
    const r = dailyRateFromMonthly(3000, { ...SETTINGS, workingDaysPerMonth: 0 });
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBe(3000);
  });
});

describe("المرتب الأساسي حسب النوع", () => {
  it("شهري: قيمة ثابتة مهما كان الحضور", () => {
    const p: SalaryProfileInput = { salaryType: "monthly", baseSalary: "3000" };
    expect(calcBaseSalary(p, { attendanceDays: 26 })).toBe(3000);
    expect(calcBaseSalary(p, { attendanceDays: 10 })).toBe(3000);
  });
  it("يومي: أجر اليوم × أيام الحضور", () => {
    const p: SalaryProfileInput = { salaryType: "daily", dailyRate: "150" };
    expect(calcBaseSalary(p, { attendanceDays: 20 })).toBe(3000);
  });
  it("عمولة صافية: مفيش أساسي", () => {
    const p: SalaryProfileInput = { salaryType: "commission", baseSalary: "9999" };
    expect(calcBaseSalary(p, { attendanceDays: 26 })).toBe(0);
  });
  it("مختلط: بياخد الأساسي زي الشهري", () => {
    const p: SalaryProfileInput = { salaryType: "mixed", baseSalary: "2000" };
    expect(calcBaseSalary(p, { attendanceDays: 26 })).toBe(2000);
  });
});

describe("خصم الغياب", () => {
  it("يومين غياب على أيام العمل", () => {
    expect(calcAbsenceDeduction(3000, 2, SETTINGS)).toBeCloseTo(230.77, 2);
  });
  it("يومين غياب على أيام التقويم", () => {
    expect(calcAbsenceDeduction(3000, 2, { ...SETTINGS, absenceDeductionBasis: "calendar_days" })).toBe(200);
  });
  it("صفر غياب = صفر خصم", () => {
    expect(calcAbsenceDeduction(3000, 0, SETTINGS)).toBe(0);
  });
  it("🔑 مسقوف بالمرتب — غياب ٤٠ يوم مايطلعش خصمًا أكبر من المرتب", () => {
    expect(calcAbsenceDeduction(3000, 40, SETTINGS)).toBe(3000);
  });
  it("غياب سالب مايزوّدش المرتب", () => {
    expect(calcAbsenceDeduction(3000, -5, SETTINGS)).toBe(0);
  });
});

describe("الأوفرتايم", () => {
  it("يدوي: بياخد المبلغ زي ما هو ويتجاهل الساعات", () => {
    expect(calcOvertime(3000, { overtimeHours: 99, overtimeAmount: 250 }, SETTINGS)).toBe(250);
  });
  it("يدوي: مبلغ سالب بيبقى صفر", () => {
    expect(calcOvertime(3000, { overtimeHours: 0, overtimeAmount: -100 }, SETTINGS)).toBe(0);
  });
  it("بالمضاعف: أجر الساعة × الساعات × المضاعف", () => {
    // ٣٠٠٠ ÷ ٢٦ = ١١٥.٣٨ لليوم ÷ ٨ = ١٤.٤٢ للساعة × ١٠ ساعات × ١.٥
    const r = calcOvertime(3000, { overtimeHours: 10, overtimeAmount: 0 },
      { ...SETTINGS, overtimeMode: "hourly_multiplier" });
    expect(r).toBeCloseTo(216.35, 2);
  });
  it("بالمضاعف مع صفر ساعات = صفر", () => {
    expect(calcOvertime(3000, { overtimeHours: 0, overtimeAmount: 500 },
      { ...SETTINGS, overtimeMode: "hourly_multiplier" })).toBe(0);
  });
});

describe("العمولة", () => {
  it("لكل أوردر: القيمة × العدد", () => {
    const p: SalaryProfileInput = { salaryType: "commission", commissionType: "per_order", commissionValue: "5" };
    expect(calcCommission(p, { commissionOrderCount: 120, commissionOrderTotal: 0 })).toBe(600);
  });
  it("بالنسبة: نسبة من إجمالي قيمة الأوردرات", () => {
    const p: SalaryProfileInput = { salaryType: "commission", commissionType: "percentage", commissionValue: "2.5" };
    expect(calcCommission(p, { commissionOrderCount: 0, commissionOrderTotal: 40000 })).toBe(1000);
  });
  it("نوع عمولة غير محدد = صفر مش خطأ", () => {
    const p: SalaryProfileInput = { salaryType: "commission", commissionValue: "5" };
    expect(calcCommission(p, { commissionOrderCount: 100, commissionOrderTotal: 0 })).toBe(0);
  });
  it("قيمة صفر = صفر", () => {
    const p: SalaryProfileInput = { salaryType: "commission", commissionType: "per_order", commissionValue: "0" };
    expect(calcCommission(p, { commissionOrderCount: 100, commissionOrderTotal: 0 })).toBe(0);
  });
});

describe("أساس العمولة — الأربع حالات", () => {
  it("بيغطي الأربعة المطلوبين", () => {
    expect(Object.keys(COMMISSION_BASIS_STATUS).sort())
      .toEqual(["confirmed", "delivered", "prepared", "shipped"]);
  });
  it("كل واحد بيربط بحالة أوردر حقيقية", () => {
    // الحالات دي لازم تكون موجودة في enum جدول orders
    const orderStatuses = ["new", "confirmed", "postponed", "cancelled", "preparing",
      "shipped", "delivered", "no_answer", "returned", "printed"];
    for (const status of Object.values(COMMISSION_BASIS_STATUS)) {
      expect(orderStatuses).toContain(status);
    }
  });
});

describe("التقريب", () => {
  it("none بيقرّب لمنزلتين — نفس دقة العمود", () => {
    expect(applyRounding(2884.6153, "none")).toBe(2884.62);
  });
  it("لأقرب جنيه", () => expect(applyRounding(2884.62, "nearest_1")).toBe(2885));
  it("لأقرب ٥", () => expect(applyRounding(2884.62, "nearest_5")).toBe(2885));
  it("لأقرب ١٠", () => expect(applyRounding(2884.62, "nearest_10")).toBe(2880));
});

describe("سطر راتب كامل", () => {
  it("الصيغة كاملة: أساسي + أوفرتايم + حوافز + عمولة − غياب − خصومات − سُلف", () => {
    const p: SalaryProfileInput = {
      salaryType: "mixed", baseSalary: "3000",
      commissionType: "per_order", commissionValue: "5",
    };
    const line: PayrollLineInput = {
      ...EMPTY_LINE, attendanceDays: 24, absenceDays: 2,
      overtimeAmount: 250, bonuses: 300, deductions: 100, advances: 500,
      commissionOrderCount: 120,
    };
    const r = calcPayrollLine(p, line, SETTINGS);
    expect(r.baseSalary).toBe(3000);
    expect(r.absenceDeduction).toBeCloseTo(230.77, 2);
    expect(r.overtimeAmount).toBe(250);
    expect(r.commissions).toBe(600);
    // 3000 + 250 + 300 + 600 − 230.77 − 100 − 500
    expect(r.netSalary).toBeCloseTo(3319.23, 2);
  });

  it("الشهري الصافي مالوش عمولة حتى لو الإعداد موجود", () => {
    const p: SalaryProfileInput = {
      salaryType: "monthly", baseSalary: "3000",
      commissionType: "per_order", commissionValue: "5",
    };
    const r = calcPayrollLine(p, { ...EMPTY_LINE, commissionOrderCount: 100 }, SETTINGS);
    expect(r.commissions).toBe(0);
    expect(r.netSalary).toBe(3000);
  });

  it("اليومي مابيتخصمش منه غياب — عقاب مزدوج", () => {
    const p: SalaryProfileInput = { salaryType: "daily", dailyRate: "150" };
    const r = calcPayrollLine(p, { ...EMPTY_LINE, attendanceDays: 20, absenceDays: 6 }, SETTINGS);
    expect(r.absenceDeduction).toBe(0);
    expect(r.netSalary).toBe(3000);
  });

  it("🔑 الصافي ينفع يبقى سالب — سُلف أكبر من المستحق لازم تبان", () => {
    const p: SalaryProfileInput = { salaryType: "monthly", baseSalary: "1000" };
    const r = calcPayrollLine(p, { ...EMPTY_LINE, advances: 1500 }, SETTINGS);
    expect(r.netSalary).toBe(-500);
  });

  it("العمولة الصافية: الدخل كله من العمولة", () => {
    const p: SalaryProfileInput = {
      salaryType: "commission", commissionType: "percentage", commissionValue: "3",
    };
    const r = calcPayrollLine(p, { ...EMPTY_LINE, commissionOrderTotal: 50000 }, SETTINGS);
    expect(r.baseSalary).toBe(0);
    expect(r.netSalary).toBe(1500);
  });

  it("التقريب بيتطبّق على الصافي فقط مش على المكوّنات", () => {
    const p: SalaryProfileInput = { salaryType: "monthly", baseSalary: "3000" };
    const r = calcPayrollLine(p, { ...EMPTY_LINE, absenceDays: 2 },
      { ...SETTINGS, roundingMode: "nearest_5" });
    expect(r.absenceDeduction).toBeCloseTo(230.77, 2); // المكوّن دقيق
    expect(r.netSalary).toBe(2770);                     // الصافي مقرّب
  });
});

describe("التعديلات اليدوية — لا يُكتب فوقها", () => {
  it("parseManualFields بيقرا JSON سليم", () => {
    expect(parseManualFields('["commissions","bonuses"]')).toEqual(["commissions", "bonuses"]);
  });
  it("JSON تالف مايوقفش الدورة", () => {
    expect(parseManualFields("{{{")).toEqual([]);
    expect(parseManualFields(null)).toEqual([]);
    expect(parseManualFields('"نص مش مصفوفة"')).toEqual([]);
  });

  const computed = { baseSalary: 3000, absenceDeduction: 0, overtimeAmount: 0, commissions: 600, netSalary: 3600 };
  const stored = { baseSalary: 3000, absenceDeduction: 0, overtimeAmount: 0, commissions: 800, netSalary: 3800 };
  const line = { bonuses: 0, deductions: 0, advances: 0 };

  it("🔑 الحقل المقفول بيفضل بقيمته اليدوية", () => {
    const m = mergeWithManualEdits(computed, stored, ["commissions"], line, "none");
    expect(m.commissions).toBe(800);
  });

  it("🔑 الصافي بيتعاد حسابه من القيمة اليدوية — مش من الحساب الخام", () => {
    const m = mergeWithManualEdits(computed, stored, ["commissions"], line, "none");
    // 3000 + 0 + 0 + 800 − 0 − 0 − 0 = 3800، مش 3600
    expect(m.netSalary).toBe(3800);
  });

  it("قفل الصافي نفسه بيمنع أي إعادة حساب له", () => {
    const m = mergeWithManualEdits(computed, stored, ["netSalary"], line, "none");
    expect(m.commissions).toBe(600); // ده اتحدّث
    expect(m.netSalary).toBe(3800);  // وده لأ
  });

  it("بدون أي قفل كل حاجة بتتحدّث", () => {
    const m = mergeWithManualEdits(computed, stored, [], line, "none");
    expect(m).toEqual(computed);
  });

  it("الحوافز والخصومات والسُلف بتدخل الصافي المعاد حسابه", () => {
    const m = mergeWithManualEdits(computed, stored, ["commissions"],
      { bonuses: 200, deductions: 100, advances: 300 }, "none");
    // 3000 + 800 + 200 − 100 − 300
    expect(m.netSalary).toBe(3600);
  });
});
