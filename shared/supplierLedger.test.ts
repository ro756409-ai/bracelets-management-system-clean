import { describe, it, expect } from "vitest";
import {
  buildStatement,
  summariseStatement,
  summariseSuppliers,
  describeBalance,
  signedAmount,
  quickRange,
  MOVEMENT_LABELS,
  type SupplierMovement,
} from "./supplierLedger";

/**
 * حساب المصنع الجاري.
 *
 * الرصيد مش متخزّن — بيتحسب هنا. الاختبارات دي هي اللي بتضمن إن الحساب ده صح، لأن مفيش
 * رقم محفوظ في قاعدة البيانات يراجَع عليه.
 */

const at = (iso: string) => new Date(iso);

let seq = 0;
const move = (
  type: SupplierMovement["type"],
  amount: number,
  iso: string,
  over: Partial<SupplierMovement> = {}
): SupplierMovement => ({
  id: over.id ?? ++seq,
  type,
  amount,
  occurredAt: at(iso),
  reference: over.reference ?? null,
  description: over.description ?? "",
  createdByName: over.createdByName ?? "المالك",
  createdAt: over.createdAt ?? at(iso),
  ...over,
});

// ───────────────── المثال اللي في الطلب ─────────────────

describe("🔑 المثال بالحرف", () => {
  const rows = buildStatement([
    move("goods_received", 50000, "2026-01-01T10:00:00Z"),
    move("goods_received", 10000, "2026-01-02T10:00:00Z"),
    move("payment", 20000, "2026-01-03T10:00:00Z"),
    move("return_credit", 5000, "2026-01-04T10:00:00Z"),
    move("rework_fee", 1000, "2026-01-05T10:00:00Z"),
    move("payment", 10000, "2026-01-06T10:00:00Z"),
  ]);

  it("🔑 السلسلة بالظبط زي ما المطلوب", () => {
    expect(rows.map(r => r.balanceAfter)).toEqual([
      50000, 60000, 40000, 35000, 36000, 26000,
    ]);
  });

  it("🔑 والرصيد قبل كل حركة = الرصيد بعد اللي قبلها", () => {
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].balanceBefore).toBe(rows[i - 1].balanceAfter);
    }
    expect(rows[0].balanceBefore).toBe(0);
  });

  it("🔑 الإشارة مستحيل تتلخبط", () => {
    expect(rows[0].signedAmount).toBe(+50000); // استلام
    expect(rows[2].signedAmount).toBe(-20000); // دفعة
    expect(rows[3].signedAmount).toBe(-5000); // مرتجع
    expect(rows[4].signedAmount).toBe(+1000); // تشطيب
  });
});

// ───────────────── ١–٩: قواعد الحركات ─────────────────

describe("🔑 استلام البضاعة", () => {
  it("١+٢ · استلام ٥٠ ألف بعدين ١٠ آلاف = ٦٠ ألف عليك", () => {
    const rows = buildStatement([
      move("goods_received", 50000, "2026-01-01T10:00:00Z"),
      move("goods_received", 10000, "2026-01-02T10:00:00Z"),
    ]);
    expect(rows[1].balanceAfter).toBe(60000);
  });

  it("٥ · إلغاء الاستلام بيعكس مرة واحدة", () => {
    const rows = buildStatement([
      move("goods_received", 50000, "2026-01-01T10:00:00Z"),
      move("receipt_reversed", 50000, "2026-01-02T10:00:00Z"),
    ]);
    expect(rows[1].balanceAfter).toBe(0);
  });
});

describe("🔑 الدفعات والمرتجعات", () => {
  it("٣ · دفعة ٢٠ ألف بتنقّص الرصيد ٢٠ ألف", () => {
    const rows = buildStatement([
      move("goods_received", 60000, "2026-01-01T10:00:00Z"),
      move("payment", 20000, "2026-01-02T10:00:00Z"),
    ]);
    expect(rows[1].balanceAfter).toBe(40000);
  });

  it("٦ · المرتجع نوع أ بيخصم مرة واحدة", () => {
    const rows = buildStatement([
      move("goods_received", 40000, "2026-01-01T10:00:00Z"),
      move("return_credit", 5000, "2026-01-02T10:00:00Z"),
    ]);
    expect(rows[1].balanceAfter).toBe(35000);
  });

  it("🔑 ٧ · إعادة التشطيب مالهاش نوع حركة بتقلّل الحساب", () => {
    // القاعدة نفسها: المخزون بيتحرّك، والدَّيْن مايتغيّرش. مفيش نوع حركة اسمه
    // «رجعت للورشة» — فمستحيل الكود يقلّل الحساب لمجرد إن البضاعة اتحركت.
    const names = Object.keys(MOVEMENT_LABELS);
    expect(names).not.toContain("rework_sent");
    expect(names).not.toContain("rework_returned");
  });

  it("٨ · رسم التشطيب بيزوّد مرة واحدة", () => {
    const rows = buildStatement([
      move("goods_received", 35000, "2026-01-01T10:00:00Z"),
      move("rework_fee", 1000, "2026-01-02T10:00:00Z"),
    ]);
    expect(rows[1].balanceAfter).toBe(36000);
  });
});

// ───────────────── ١٠: الرصيد الافتتاحي ─────────────────

describe("🔑 ١٠ · الرصيد الافتتاحي في الاتجاهين", () => {
  it("عليّا للمصنع — موجب", () => {
    const rows = buildStatement([
      move("opening_balance", 15000, "2026-01-01T00:00:00Z"),
    ]);
    expect(rows[0].balanceAfter).toBe(15000);
    expect(describeBalance(rows[0].balanceAfter).tone).toBe("owed");
  });

  it("ليّا عند المصنع — سالب", () => {
    const rows = buildStatement([
      move("opening_balance", -8000, "2026-01-01T00:00:00Z"),
    ]);
    expect(rows[0].balanceAfter).toBe(-8000);
    expect(describeBalance(rows[0].balanceAfter).tone).toBe("credit");
  });

  it("🔑 الاتجاه جاي مع الرقم — مش مفروض عليه", () => {
    expect(signedAmount({ type: "opening_balance", amount: -8000 })).toBe(-8000);
    expect(signedAmount({ type: "adjustment", amount: -300 })).toBe(-300);
    // على عكس الأنواع اللي إشارتها ثابتة:
    expect(signedAmount({ type: "payment", amount: 500 })).toBe(-500);
    expect(signedAmount({ type: "payment", amount: -500 })).toBe(-500);
  });
});

// ───────────────── ١١: التاريخ الرجعي ─────────────────

describe("🔑 ١١ · حركة بتاريخ قديم بتقع في مكانها", () => {
  const withoutBackdated = [
    move("goods_received", 50000, "2026-01-01T10:00:00Z", { id: 1 }),
    move("payment", 20000, "2026-01-10T10:00:00Z", { id: 2 }),
  ];

  it("🔑 بتتحط في نص السلسلة مش في آخرها", () => {
    // دفعة يوم ٥ اتسجّلت يوم ١٥ — بتتحط بين الاتنين.
    const rows = buildStatement([
      ...withoutBackdated,
      move("payment", 5000, "2026-01-05T10:00:00Z", { id: 3 }),
    ]);
    expect(rows.map(r => r.id)).toEqual([1, 3, 2]);
  });

  it("🔑 وكل الأرصدة بعدها بتتعاد", () => {
    const before = buildStatement(withoutBackdated);
    expect(before.map(r => r.balanceAfter)).toEqual([50000, 30000]);

    const after = buildStatement([
      ...withoutBackdated,
      move("payment", 5000, "2026-01-05T10:00:00Z", { id: 3 }),
    ]);
    expect(after.map(r => r.balanceAfter)).toEqual([50000, 45000, 25000]);
  });

  it("🔑 وترتيب ثابت لما الوقت يتساوى", () => {
    // من غير كسر التعادل بالـid، الاتنين ممكن يترتبوا مختلف كل قراءة والرصيد
    // قبل/بعد يتبدّلوا قدام التاجر من غير سبب.
    const same = "2026-01-01T10:00:00Z";
    const a = move("goods_received", 100, same, { id: 9 });
    const b = move("payment", 40, same, { id: 4 });
    expect(buildStatement([a, b]).map(r => r.id)).toEqual([4, 9]);
    expect(buildStatement([b, a]).map(r => r.id)).toEqual([4, 9]);
  });
});

// ───────────────── الإجماليات ─────────────────

describe("🔑 إجماليات الكشف", () => {
  const rows = buildStatement([
    move("opening_balance", 5000, "2026-01-01T00:00:00Z"),
    move("goods_received", 50000, "2026-01-02T10:00:00Z"),
    move("goods_received", 10000, "2026-01-03T10:00:00Z"),
    move("payment", 20000, "2026-01-04T10:00:00Z"),
    move("return_credit", 5000, "2026-01-05T10:00:00Z"),
    move("rework_fee", 1000, "2026-01-06T10:00:00Z"),
  ]);
  const totals = summariseStatement(rows);

  it("كل نوع لوحده", () => {
    expect(totals.openingBalance).toBe(5000);
    expect(totals.goodsReceived).toBe(60000);
    expect(totals.paid).toBe(20000);
    expect(totals.returns).toBe(5000);
    expect(totals.reworkFees).toBe(1000);
  });

  it("🔑 والرصيد = الافتتاحي + البضاعة + التشطيب − المدفوع − المرتجع", () => {
    expect(totals.balance).toBe(5000 + 60000 + 1000 - 20000 - 5000);
    expect(totals.balance).toBe(rows[rows.length - 1].balanceAfter);
  });

  it("آخر حركة", () => {
    expect(totals.lastMovementAt).toEqual(at("2026-01-06T10:00:00Z"));
    expect(totals.movementCount).toBe(6);
  });

  it("كشف فاضي مابيقعش", () => {
    const empty = summariseStatement([]);
    expect(empty.balance).toBe(0);
    expect(empty.lastMovementAt).toBeNull();
  });
});

// ───────────────── ١٦: اللوحة ─────────────────

describe("🔑 ١٦ · إجماليات اللوحة = مجموع أرصدة المصانع", () => {
  it("بتفصل اللي عليك عن اللي ليك", () => {
    const totals = summariseSuppliers([35000, -5000, 12000, 0]);
    expect(totals.owedToFactories).toBe(47000);
    expect(totals.owedByFactories).toBe(5000);
    expect(totals.net).toBe(42000);
  });

  it("🔑 الاتنين مابيتقاصّوش في الرقمين الأولانيين", () => {
    // لو اتقاصّوا، تاجر ليه ٥٠ ألف عند مصنع وعليه ٥٠ ألف لمصنع تاني كان هيشوف
    // صفر في الاتنين — وهو في الحقيقة مربوط بمية ألف.
    const totals = summariseSuppliers([50000, -50000]);
    expect(totals.owedToFactories).toBe(50000);
    expect(totals.owedByFactories).toBe(50000);
    expect(totals.net).toBe(0);
  });

  it("مفيش مصانع = أصفار", () => {
    expect(summariseSuppliers([])).toEqual({
      owedToFactories: 0,
      owedByFactories: 0,
      net: 0,
    });
  });
});

// ───────────────── اللغة ─────────────────

describe("🔑 الرصيد بلغة التاجر", () => {
  it("عليك / ليك / متعادل", () => {
    expect(describeBalance(35000).text).toContain("عليك للمصنع");
    expect(describeBalance(-5000).text).toContain("ليك عند المصنع");
    expect(describeBalance(0).text).toBe("الحساب متعادل");
  });

  it("🔑 والسالب بيتعرض موجب مع كلمة «ليك» — مفيش إشارة ناقص قدام التاجر", () => {
    expect(describeBalance(-5000).text).not.toContain("-");
    expect(describeBalance(-5000).text).not.toContain("−");
  });

  it("الكسور الصغيرة بتتعامل كتعادل", () => {
    expect(describeBalance(0.004).tone).toBe("settled");
  });

  it("🔑 مفيش مصطلحات محاسبة في أي اسم حركة", () => {
    const all = Object.values(MOVEMENT_LABELS).join(" ");
    for (const jargon of ["مدين", "دائن", "قيد", "Debit", "Credit", "Payable"]) {
      expect(all, jargon).not.toContain(jargon);
    }
  });
});

// ───────────────── الفلاتر ─────────────────

describe("الفلاتر السريعة", () => {
  const now = new Date(2026, 7, 8, 15, 30); // السبت ٨ أغسطس ٢٠٢٦

  it("النهاردة من أول اليوم", () => {
    expect(quickRange("today", now).from).toEqual(new Date(2026, 7, 8));
  });

  it("🔑 الأسبوع بيبدأ السبت — مش الأحد ولا الاثنين", () => {
    // ٨ أغسطس ٢٠٢٦ سبت، فبداية الأسبوع هي نفس اليوم.
    expect(quickRange("week", now).from).toEqual(new Date(2026, 7, 8));
    const tuesday = new Date(2026, 7, 11, 9, 0);
    expect(quickRange("week", tuesday).from).toEqual(new Date(2026, 7, 8));
  });

  it("الشهر والشهر اللي فات", () => {
    expect(quickRange("month", now).from).toEqual(new Date(2026, 7, 1));
    const last = quickRange("last_month", now);
    expect(last.from).toEqual(new Date(2026, 6, 1));
    expect(last.to).toEqual(new Date(2026, 7, 1));
  });

  it("الكل من غير حدود", () => {
    expect(quickRange("all", now)).toEqual({ from: null, to: null });
  });
});
