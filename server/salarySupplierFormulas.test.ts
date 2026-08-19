import { describe, it, expect } from "vitest";
import { computeNetSalary } from "../shared/salaryMath";
import {
  buildStatement,
  summariseStatement,
  describeBalance,
  type SupplierMovement,
} from "../shared/supplierLedger";

/**
 * المعادلتين اللي التاجر بيصدّقهما — دوال نقية، تعريف واحد للاتنين على السيرفر والواجهة.
 */

describe("🔑 صافي المرتب = الأساسي + البونص − السُلف", () => {
  it("الحالة العادية", () => {
    expect(computeNetSalary({ baseSalary: 5000, bonuses: 800, advances: 1200 })).toBe(4600);
  });

  it("مفيش بونص ولا سُلف = الأساسي", () => {
    expect(computeNetSalary({ baseSalary: 5000, bonuses: 0, advances: 0 })).toBe(5000);
  });

  it("🔑 السُلف أكتر من الأساسي + البونص → صافي بالسالب (عليه للشركة)", () => {
    expect(computeNetSalary({ baseSalary: 3000, bonuses: 500, advances: 4000 })).toBe(-500);
  });

  it("بيقرّب لأقرب قرشين", () => {
    expect(computeNetSalary({ baseSalary: 5000.1, bonuses: 0.05, advances: 0.02 })).toBe(5000.13);
  });
});

describe("🔑 رصيد المورد = إجمالي البضاعة المستلمة − إجمالي المدفوع", () => {
  const mv = (id: number, type: SupplierMovement["type"], amount: number, day: number): SupplierMovement => ({
    id,
    type,
    amount,
    occurredAt: new Date(2026, 0, day),
    reference: null,
    description: "",
    createdByName: null,
    createdAt: null,
  });

  it("🔑 استلمت بـ١٠٠٠ ودفعت ٣٠٠ → الرصيد ٧٠٠ عليك للمصنع", () => {
    const rows = buildStatement([
      mv(1, "goods_received", 1000, 1),
      mv(2, "payment", 300, 2),
    ]);
    const summary = summariseStatement(rows);
    expect(summary.goodsReceived).toBe(1000);
    expect(summary.paid).toBe(300);
    expect(summary.balance).toBe(700); // 1000 − 300
    expect(describeBalance(summary.balance).tone).toBe("owed");
  });

  it("🔑 دفعت أكتر من قيمة البضاعة → لك عند المصنع", () => {
    const rows = buildStatement([
      mv(1, "goods_received", 500, 1),
      mv(2, "payment", 800, 2),
    ]);
    const summary = summariseStatement(rows);
    expect(summary.balance).toBe(-300); // 500 − 800
    expect(describeBalance(summary.balance).tone).toBe("credit");
  });

  it("🔑 دفعت بالظبط قيمة البضاعة → الحساب متعادل", () => {
    const rows = buildStatement([
      mv(1, "goods_received", 600, 1),
      mv(2, "payment", 600, 2),
    ]);
    const summary = summariseStatement(rows);
    expect(summary.balance).toBe(0);
    expect(describeBalance(summary.balance).tone).toBe("settled");
  });

  it("استلامات متعددة بتتجمّع", () => {
    const rows = buildStatement([
      mv(1, "goods_received", 1000, 1),
      mv(2, "goods_received", 500, 2),
      mv(3, "payment", 400, 3),
    ]);
    const summary = summariseStatement(rows);
    expect(summary.goodsReceived).toBe(1500);
    expect(summary.balance).toBe(1100); // 1500 − 400
  });
});
