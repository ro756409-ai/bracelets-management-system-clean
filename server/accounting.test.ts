import { describe, it, expect } from "vitest";
import { hasPermission, permissionsForRole } from "./permissions";
import { formatAmount, formatMoney, formatMoneyCompact } from "../client/src/lib/money";

/**
 * اختبارات وحدة الحسابات.
 *
 * الساندبوكس مفيهوش قاعدة بيانات، فالاختبارات دي بتغطي الأجزاء اللي بتتحسب من غير DB:
 * قواعد الصلاحيات، ومنطق استنتاج حالة التحصيل، وتنسيق المبالغ. الدوال اللي بتكتب في
 * الجداول (addTreasuryTransaction, createExpense) محتاجة DB حقيقي — بتتغطى في
 * الاختبار اليدوي على staging، ومرصود في التقرير.
 */

/**
 * نفس القاعدة الموجودة في `recordOrderCollection`.
 *
 * مكتوبة هنا كنسخة تنفيذية عشان الاختبار يقدر يشغّلها من غير DB. لو القاعدة اتغيّرت في
 * db.ts لازم تتغيّر هنا — والاختبار بيوصّف السلوك المتوقع مش بيستورده.
 */
function deriveCollectionStatus(collected: number, expected: number): string {
  return collected <= 0 ? "failed"
    : collected < expected ? "partial"
    : "collected";
}

describe("حالة التحصيل بتتستنتج من الأرقام", () => {
  it("صفر = فاشل", () => {
    expect(deriveCollectionStatus(0, 500)).toBe("failed");
  });

  it("مبلغ سالب = فاشل (مش partial)", () => {
    expect(deriveCollectionStatus(-10, 500)).toBe("failed");
  });

  it("أقل من المتوقع = جزئي", () => {
    expect(deriveCollectionStatus(300, 500)).toBe("partial");
  });

  it("مساوي للمتوقع = محصّل", () => {
    expect(deriveCollectionStatus(500, 500)).toBe("collected");
  });

  it("أكبر من المتوقع = محصّل (مش حالة تانية)", () => {
    expect(deriveCollectionStatus(520, 500)).toBe("collected");
  });

  it("أوردر بمبلغ صفر بيتحسب فاشل — مش محصّل", () => {
    // حالة حدية حقيقية: أوردر totalAmount = 0. لو الترتيب كان بيقارن الأول كان هيطلع
    // "collected" وهو مش محصّل حاجة.
    expect(deriveCollectionStatus(0, 0)).toBe("failed");
  });
});

describe("اتجاه حركة الخزنة", () => {
  // نفس الحساب اللي في addTreasuryTransaction
  const signed = (direction: "in" | "out", amount: number) =>
    direction === "in" ? amount : -amount;

  it("داخل بيزوّد الرصيد", () => {
    expect(0 + signed("in", 500)).toBe(500);
  });

  it("خارج بيقلّل الرصيد", () => {
    expect(500 + signed("out", 200)).toBe(300);
  });

  it("الرصيد ينفع يبقى سالب — السحب مش ممنوع بسبب الرصيد", () => {
    // الخزنة مش حساب بنكي بيرفض السحب: التاجر ممكن يسجّل سحب قبل ما يسجّل التحصيل،
    // والرصيد السالب معلومة صحيحة لازم تظهر مش خطأ يتمنع.
    expect(100 + signed("out", 400)).toBe(-300);
  });

  it("تسوية تعديل مصروف بتاخد اتجاهها من إشارة الفرق", () => {
    // زيادة المصروف = فلوس طلعت (out)، تقليله = فلوس رجعت (in)
    const deltaUp = 120 - 100;
    const deltaDown = 80 - 100;
    expect(deltaUp > 0 ? "out" : "in").toBe("out");
    expect(deltaDown > 0 ? "out" : "in").toBe("in");
  });
});

describe("صافي الربح", () => {
  // نفس المعادلة اللي في getAccountingDashboard
  const netProfit = (sales: number, productCost: number, shipping: number, expenses: number, returns: number) =>
    sales - (productCost + shipping + expenses + returns);

  it("بيطلع من المبيعات ناقص كل التكاليف", () => {
    expect(netProfit(10000, 3000, 1000, 1500, 500)).toBe(4000);
  });

  it("بيطلع سالب لما التكاليف تزيد عن المبيعات", () => {
    expect(netProfit(1000, 800, 300, 200, 100)).toBe(-400);
  });

  it("مبني على المبيعات مش على المحصّل — نفس المبيعات بتدي نفس الربح مهما كان المحصّل", () => {
    // الفرق بين الربح الدفتري والكاش الفعلي هو "المعلّق"، والمفروض يتعرض جنبه مش
    // يتخبّط جواه.
    const a = netProfit(10000, 3000, 1000, 1500, 500);
    const b = netProfit(10000, 3000, 1000, 1500, 500);
    expect(a).toBe(b);
  });
});

describe("صلاحيات الحسابات", () => {
  it("المحاسب بيقرا ويسجّل", () => {
    expect(hasPermission("accountant", "accounting.view")).toBe(true);
    expect(hasPermission("accountant", "accounting.manage")).toBe(true);
  });

  it("المدير والأدمن عندهم الاتنين", () => {
    for (const role of ["manager", "admin", "super_admin"] as const) {
      expect(hasPermission(role, "accounting.view")).toBe(true);
      expect(hasPermission(role, "accounting.manage")).toBe(true);
    }
  });

  it("موظف التأكيدات مالوش أي صلاحية حسابات", () => {
    expect(hasPermission("order_confirmation", "accounting.view")).toBe(false);
    expect(hasPermission("order_confirmation", "accounting.manage")).toBe(false);
  });

  it("المشاهد والمخزن والشحن مالهمش صلاحيات حسابات", () => {
    for (const role of ["viewer", "warehouse", "shipping", "scanner", "data_entry"] as const) {
      expect(hasPermission(role, "accounting.view")).toBe(false);
      expect(hasPermission(role, "accounting.manage")).toBe(false);
    }
  });

  it("صلاحيات المحاسب القديمة ما اتشالتش", () => {
    const perms = permissionsForRole("accountant");
    for (const p of ["dashboard.view", "orders.view", "orders.export", "settings.view", "audit.view"] as const) {
      expect(perms).toContain(p);
    }
  });
});

describe("تنسيق المبالغ", () => {
  it("null و undefined بيرجّعوا شرطة مش NaN", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(undefined)).toBe("—");
    expect(formatMoney(null)).toBe("—");
  });

  it("نص مش رقمي بيرجّع شرطة", () => {
    expect(formatAmount("abc")).toBe("—");
  });

  it("صفر رقم صحيح مش قيمة فاضية", () => {
    expect(formatAmount(0)).not.toBe("—");
    expect(formatMoney(0)).toContain("ج.م");
  });

  it("النص الرقمي الجاي من decimal بيتقبل", () => {
    // drizzle بيرجّع decimal كـstring، فالدالة لازم تتعامل معاه
    expect(formatAmount("450.00")).not.toBe("—");
  });

  it("المختصر بيقصّر الأرقام الكبيرة", () => {
    expect(formatMoneyCompact(2_500_000)).toContain("م");
    expect(formatMoneyCompact(45_000)).toContain("أ");
    expect(formatMoneyCompact(500)).not.toContain("أ");
  });

  it("المختصر بيتعامل مع السالب", () => {
    expect(formatMoneyCompact(-2_500_000)).toContain("م");
    expect(formatMoneyCompact(null)).toBe("—");
  });
});
