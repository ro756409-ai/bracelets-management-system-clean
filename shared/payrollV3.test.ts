import { describe, it, expect } from "vitest";
import { commissionEligibility, computePayrollV3, type PayrollV3Input } from "./payrollV3";

const base = (o: Partial<PayrollV3Input> = {}): PayrollV3Input => ({
  salaryType: "monthly", baseSalary: "6000", dailyRate: null, workingDaysPerMonth: 30, workHoursPerDay: 8, overtimeMultiplier: "1.5",
  lateDeductionEnabled: false, lateGraceMinutesPerMonth: 60,
  attendance: { presentDays: 26, absentDays: 0, lateMinutes: 0, approvedOvertimeMinutes: 0 },
  commission: { type: null, value: "0", eligible: [], clawback: [] }, bonuses: [], deductions: [], advanceInstallments: [], ...o,
});
const ok = (r: ReturnType<typeof computePayrollV3>) => { if (r.status !== "ok") throw new Error(r.reason); return r; };

describe("🧮 محرك المرتب V3 — قواعد معلنة بلا float", () => {
  it("شهري: غياب يومين = (6000 ÷ 30) × 2؛ التأخير بعد السماح بأجر الدقيقة؛ الأوفرتايم المعتمد فقط × 1.5", () => {
    const r = ok(computePayrollV3(base({ lateDeductionEnabled: true, attendance: { presentDays: 24, absentDays: 2, lateMinutes: 90, approvedOvertimeMinutes: 120 } })));
    expect(r.deductions.find(d => d.key === "absence")?.amount).toBe("400.0000");
    // أجر الدقيقة = 200 ÷ 480 = 0.4167 ؛ تأخير 30 دقيقة بعد سماح 60
    expect(r.deductions.find(d => d.key === "late")?.amount).toBe("12.5010");
    expect(r.earnings.find(e => e.key === "overtime")?.amount).toBe("75.0060"); // 0.4167 × 120 × 1.5
    expect(r.gross).toBe("6075.0060");
    expect(r.net).toBe("5662.5050");
  });
  it("الغياب لا يتجاوز الأساسي، ويومي: أجر × أيام الحضور بلا خصم غياب", () => {
    expect(ok(computePayrollV3(base({ attendance: { presentDays: 0, absentDays: 45, lateMinutes: 0, approvedOvertimeMinutes: 0 } }))).net).toBe("0.0000");
    const d = ok(computePayrollV3(base({ salaryType: "daily", dailyRate: "250", attendance: { presentDays: 20, absentDays: 6, lateMinutes: 0, approvedOvertimeMinutes: 0 } })));
    expect([d.gross, d.deductions.length]).toEqual(["5000.0000", 0]);
    expect(computePayrollV3(base({ salaryType: "daily", dailyRate: null }))).toMatchObject({ status: "review" });
  });
  it("العمولة: بالعدد أو بالنسبة، بلا تكرار لنفس الأوردر؛ والاسترداد للمرتجع بعد صرف العمولة", () => {
    const per = ok(computePayrollV3(base({ salaryType: "mixed", commission: { type: "per_order", value: "15", eligible: [{ orderId: 1, amount: "500" }, { orderId: 1, amount: "500" }, { orderId: 2, amount: "300" }], clawback: [{ orderId: 9, amount: "15" }] } })));
    expect(per.earnings.find(e => e.key === "commission")?.amount).toBe("30.0000");
    expect(per.deductions.find(d => d.key === "commission_clawback")?.amount).toBe("15.0000");
    expect(per.commissionOrders.map(o => o.orderId)).toEqual([1, 2]);
    const pct = ok(computePayrollV3(base({ salaryType: "commission", commission: { type: "percent", value: "5", eligible: [{ orderId: 3, amount: "500" }], clawback: [] } })));
    expect([pct.gross, pct.net]).toEqual(["25.0000", "25.0000"]);
  });
  it("أقساط السلف بحد الصافي المتاح والباقي يُرحّل صراحة؛ الخصومات اليدوية الأكبر من الإجمالي = مراجعة لا صافٍ مخمّن", () => {
    const r = ok(computePayrollV3(base({ baseSalary: "1000", deductions: [{ label: "تلف عهدة", amount: "300" }], advanceInstallments: [{ advanceId: 7, amount: "500" }, { advanceId: 8, amount: "400" }] })));
    expect(r.advancesDeducted).toEqual([{ advanceId: 7, amount: "500.0000" }, { advanceId: 8, amount: "200.0000" }]);
    expect(r.advancesCarried).toEqual([{ advanceId: 8, amount: "200.0000" }]);
    expect(r.net).toBe("0.0000");
    expect(computePayrollV3(base({ baseSalary: "1000", deductions: [{ label: "خصم", amount: "1500" }] }))).toMatchObject({ status: "review" });
  });
  it("أهلية العمولة: المسلّم غير المرتد وغير المصروف فقط؛ الاسترداد للمصروف ثم المرتد بنفس مبلغه", () => {
    const r = commissionEligibility([
      { orderId: 1, amount: "500", deliveredInPeriod: true, returnedInPeriod: false, paidCommission: null },
      { orderId: 2, amount: "300", deliveredInPeriod: true, returnedInPeriod: true, paidCommission: null },
      { orderId: 3, amount: "200", deliveredInPeriod: false, returnedInPeriod: true, paidCommission: "15.0000" },
      { orderId: 4, amount: "200", deliveredInPeriod: true, returnedInPeriod: false, paidCommission: "15.0000" },
    ]);
    expect(r.eligible.map(o => o.orderId)).toEqual([1]);
    expect(r.clawback).toEqual([{ orderId: 3, amount: "15.0000" }]);
  });
  it("إعدادات غير صالحة = مراجعة", () => {
    expect(computePayrollV3(base({ workingDaysPerMonth: 0 }))).toMatchObject({ status: "review" });
    expect(computePayrollV3(base({ attendance: { presentDays: -1, absentDays: 0, lateMinutes: 0, approvedOvertimeMinutes: 0 } }))).toMatchObject({ status: "review" });
  });
});
