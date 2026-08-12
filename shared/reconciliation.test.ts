import { describe, it, expect } from "vitest";
import {
  reconcileTreasury,
  reconcileTreasuryByDirection,
  reconcileCollections,
  classifyTreasuryType,
  reconcileSupplier,
  reconcileOnce,
  buildReport,
  formatReport,
} from "./reconciliation";

describe("تدقيق الخزنة بالاتجاه — كامل مهما كانت الأنواع", () => {
  it("الافتتاحي + الداخل − الخارج = الرصيد الحالي", () => {
    const c = reconcileTreasuryByDirection({
      openingBalance: 1000,
      totalIn: 5000,
      totalOut: 3200,
      currentBalance: 2800,
    });
    expect(c.ok).toBe(true);
    expect(c.difference).toBe(0);
  });

  it("بيمسك فرق لو حركة سقطت من الرصيد", () => {
    const c = reconcileTreasuryByDirection({
      openingBalance: 0,
      totalIn: 1000,
      totalOut: 300,
      currentBalance: 650, // المفروض ٧٠٠
    });
    expect(c.ok).toBe(false);
    expect(c.difference).toBe(-50);
  });

  it("المرتجع والتسوية بيدخلوا الحساب بالاتجاه — مش بيسقطوا", () => {
    // مرتجع خارج ٢٠٠ + تسوية داخلة ٥٠ ضمن totalIn/totalOut، فالمعادلة بتفضل تقفل.
    const c = reconcileTreasuryByDirection({
      openingBalance: 100,
      totalIn: 1000 + 50, // تحصيل + تسوية داخلة
      totalOut: 400 + 200, // مصروف + مرتجع خارج
      currentBalance: 550,
    });
    expect(c.ok).toBe(true);
  });
});

describe("تصنيف أنواع الخزنة", () => {
  it("بيصنّف الأنواع المعروفة صح", () => {
    expect(classifyTreasuryType("collection")).toBe("INFLOW");
    expect(classifyTreasuryType("deposit")).toBe("INFLOW");
    expect(classifyTreasuryType("expense")).toBe("OUTFLOW");
    expect(classifyTreasuryType("withdrawal")).toBe("OUTFLOW");
    expect(classifyTreasuryType("refund")).toBe("REVERSAL_ADJUSTMENT");
    expect(classifyTreasuryType("adjustment")).toBe("REVERSAL_ADJUSTMENT");
  });

  it("النوع المجهول بيتحطّ في تسوية مش بيتجاهل", () => {
    expect(classifyTreasuryType("carrier_settlement")).toBe("REVERSAL_ADJUSTMENT");
  });
});

describe("تدقيق التحصيل — الخزنة مقابل الأوردرات", () => {
  it("بيتساوى لما التحصيل متطابق", () => {
    const c = reconcileCollections({
      treasuryCollectionsNet: 12500,
      ordersCollected: 12500,
    });
    expect(c.ok).toBe(true);
  });

  it("بيمسك تحصيل اتسجّل في مكان من غير التاني", () => {
    const c = reconcileCollections({
      treasuryCollectionsNet: 12500,
      ordersCollected: 12000,
    });
    expect(c.ok).toBe(false);
    expect(c.difference).toBe(500);
  });

  it("تصحيح التحصيل بالسالب بيدخل الصافي صح", () => {
    // تحصيل ٤٠٠ بعدين تصحيح −٥٠ = صافي ٣٥٠، والأوردر بيقول ٣٥٠.
    const c = reconcileCollections({
      treasuryCollectionsNet: 350,
      ordersCollected: 350,
    });
    expect(c.ok).toBe(true);
  });
});

/**
 * تدقيق الأرقام.
 *
 * الاختبارات دي بتتأكد إن **التدقيق نفسه بيمسك الغلط** — مش إن الأرقام صح. بندّيه
 * أرقام مكسورة عن قصد ونتأكد إنه بيصرخ، لأن مدقّق بيقول «تمام» على كل حاجة أسوأ من
 * إنه مايكونش موجود.
 */

const treasury = {
  openingBalance: 10000,
  collections: 354502,
  deposits: 5000,
  expensesPaid: 4000,
  advertisingPaid: 1000,
  payrollPaid: 8000,
  factoryPayments: 2000,
  withdrawals: 500,
  currentBalance: 354002,
};

describe("🔑 معادلة الخزنة", () => {
  it("🔑 الافتتاحي + الداخل − الخارج = الحالي", () => {
    // 10000 + 354502 + 5000 − 4000 − 1000 − 8000 − 2000 − 500 = 354002
    expect(reconcileTreasury(treasury).ok).toBe(true);
  });

  it("🔑 وبيمسك جنيه ناقص", () => {
    const broken = reconcileTreasury({ ...treasury, currentBalance: 354001 });
    expect(broken.ok).toBe(false);
    expect(broken.difference).toBe(-1);
  });

  it("🔑 وبيمسك مصروف اتحسب مرتين", () => {
    // نفس المصروف اتسجّل حركتين خزنة — الرصيد الحالي أقل من المتوقع بـ4000.
    const broken = reconcileTreasury({
      ...treasury,
      expensesPaid: 8000,
      currentBalance: 354002,
    });
    expect(broken.ok).toBe(false);
    expect(broken.difference).toBe(4000);
  });

  it("🔑 وبيمسك تحصيل مادخلش الخزنة", () => {
    const broken = reconcileTreasury({ ...treasury, currentBalance: 0 });
    expect(broken.ok).toBe(false);
  });

  it("خزنة فاضية من الأول بتعدّي", () => {
    expect(
      reconcileTreasury({
        openingBalance: 0,
        collections: 0,
        deposits: 0,
        expensesPaid: 0,
        advertisingPaid: 0,
        payrollPaid: 0,
        factoryPayments: 0,
        withdrawals: 0,
        currentBalance: 0,
      }).ok
    ).toBe(true);
  });

  it("الرصيد السالب مش غلط في حد ذاته", () => {
    // التاجر يقدر يصرف أكتر من اللي في الدُرج — المهم إن المعادلة تقفل.
    expect(
      reconcileTreasury({
        openingBalance: 0,
        collections: 0,
        deposits: 0,
        expensesPaid: 4000,
        advertisingPaid: 0,
        payrollPaid: 0,
        factoryPayments: 0,
        withdrawals: 0,
        currentBalance: -4000,
      }).ok
    ).toBe(true);
  });

  it("كسور القروش مابتوقّعش الفحص", () => {
    expect(
      reconcileTreasury({ ...treasury, currentBalance: 354002.004 }).ok
    ).toBe(true);
  });
});

describe("🔑 معادلة المصنع", () => {
  const supplier = {
    openingBalance: 5000,
    goodsReceived: 60000,
    reworkFees: 1000,
    payments: 20000,
    returnCredits: 5000,
    reversals: 0,
    currentBalance: 41000,
  };

  it("🔑 الافتتاحي + البضاعة + التشطيب − الدفعات − المرتجعات = الحالي", () => {
    // 5000 + 60000 + 1000 − 20000 − 5000 = 41000
    expect(reconcileSupplier("مصنع أ", supplier).ok).toBe(true);
  });

  it("🔑 والعكس بيقلّل الدَّيْن", () => {
    expect(
      reconcileSupplier("مصنع أ", {
        ...supplier,
        reversals: 60000,
        currentBalance: -19000,
      }).ok
    ).toBe(true);
  });

  it("🔑 وبيمسك دفعة اتخصمت مرتين", () => {
    const broken = reconcileSupplier("مصنع أ", {
      ...supplier,
      currentBalance: 21000,
    });
    expect(broken.ok).toBe(false);
    expect(broken.difference).toBe(-20000);
  });

  it("🔑 وبيمسك تشطيب قلّل الحساب بدل ما يزوّده", () => {
    // الغلط الكلاسيكي: البضاعة اتحركت للمصنع فالكود خصم القيمة.
    const broken = reconcileSupplier("مصنع أ", {
      ...supplier,
      currentBalance: 39000,
    });
    expect(broken.ok).toBe(false);
  });

  it("الاسم بيظهر في الفحص عشان تعرف أنهي مصنع", () => {
    expect(reconcileSupplier("ورشه فرحات", supplier).label).toBe(
      "حساب ورشه فرحات"
    );
  });
});

describe("🔑 مرة واحدة بالظبط", () => {
  it("🔑 حدث واحد = حركة خزنة واحدة بنفس المبلغ", () => {
    const checks = reconcileOnce({
      label: "دفع المصروفات",
      events: 12,
      treasuryMovements: 12,
      eventsTotal: 4000,
      treasuryTotal: 4000,
    });
    expect(checks.every(c => c.ok)).toBe(true);
  });

  it("🔑 بيمسك حركة زيادة", () => {
    const checks = reconcileOnce({
      label: "دفع المصروفات",
      events: 12,
      treasuryMovements: 13,
      eventsTotal: 4000,
      treasuryTotal: 4200,
    });
    expect(checks.filter(c => !c.ok)).toHaveLength(2);
  });

  it("🔑 والعدد والمبلغ الاتنين لازم — واحد لوحده بيفوّت أغلاط", () => {
    // نفس العدد، مبلغ غلط: حركة اتسجّلت بمبلغ مختلف.
    const wrongAmount = reconcileOnce({
      label: "دفع المصروفات",
      events: 12,
      treasuryMovements: 12,
      eventsTotal: 4000,
      treasuryTotal: 3800,
    });
    expect(wrongAmount[0].ok).toBe(true);
    expect(wrongAmount[1].ok).toBe(false);

    // نفس المبلغ، عدد غلط: الدفعة اتقسمت لحركتين.
    const wrongCount = reconcileOnce({
      label: "دفع المصروفات",
      events: 12,
      treasuryMovements: 13,
      eventsTotal: 4000,
      treasuryTotal: 4000,
    });
    expect(wrongCount[0].ok).toBe(false);
    expect(wrongCount[1].ok).toBe(true);
  });

  it("🔑 ودفعة المصنع مالهاش أثر على المصروفات", () => {
    // الدفعة بتقلّل الدَّيْن وبتنقّص الخزنة — ومابتزوّدش المصروفات التشغيلية.
    const checks = reconcileOnce({
      label: "دفعات المصانع",
      events: 3,
      treasuryMovements: 3,
      eventsTotal: 2000,
      treasuryTotal: 2000,
    });
    expect(checks.every(c => c.ok)).toBe(true);
  });
});

describe("التقرير", () => {
  it("بيجمّع الفشل", () => {
    const report = buildReport([
      reconcileTreasury(treasury),
      reconcileTreasury({ ...treasury, currentBalance: 1 }),
    ]);
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
  });

  it("🔑 وبيقول الفرق بالرقم مش «فيه مشكلة»", () => {
    const text = formatReport(
      buildReport([reconcileTreasury({ ...treasury, currentBalance: 354000 })])
    );
    expect(text).toContain("فرق");
    expect(text).toContain("-2.00");
    expect(text).toContain("❌");
  });

  it("والنجاح بيتقال بوضوح", () => {
    const text = formatReport(buildReport([reconcileTreasury(treasury)]));
    expect(text).toContain("✅ كل الفحوص عدّت");
  });
});
