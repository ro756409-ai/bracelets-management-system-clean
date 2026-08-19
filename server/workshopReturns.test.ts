import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * مرتجعات الورشة.
 *
 * الشرط اللي الاختبارات دي بتقفله: **مفيش جدول مرتجعات ومفيش عمود حالة**. الإرسال
 * والاستلام تحويلين مخزون بنفس `transferStock` الموجود، والحالة مقروءة من الحركات.
 *
 * ليه ده مهم: عمود حالة ينفع يبقى غلط ويقول «رجعت» والمخزون بيقول العكس. الاشتقاق
 * مستحيل يختلف عن الحركة اللي هو مبني عليها.
 *
 * وبتقفل كمان إن **تكلفة الإصلاح مابتعملش مصروف ولا بتلمس خزنة** لمجرد إرسال المرتجع.
 */

const service = fs.readFileSync("server/inventoryV2.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const page = fs.readFileSync("client/src/pages/WorkshopReturns.tsx", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const serviceCode = codeOnly(service);
const listFn = serviceCode.slice(
  serviceCode.indexOf("export async function listWorkshopReturns"),
  serviceCode.indexOf("export async function submitReturnInspection")
);
const transferFn = serviceCode.slice(
  serviceCode.indexOf("export async function transferStock"),
  serviceCode.indexOf("export async function listWorkshopReturns")
);
// الإرسال والاستلام بقوا في السيرفر — الفرونت بيغلّفهم بس. المنطق (اتجاه التحويل،
// ربط الإذن، اشتقاق رقم الرجوع) اتنقل هنا فالاختبارات بتقفله في مكانه الجديد.
const sendFn = serviceCode.slice(
  serviceCode.indexOf("export async function sendToWorkshop"),
  serviceCode.indexOf("export async function receiveFromWorkshop")
);
const receiveFn = serviceCode.slice(
  serviceCode.indexOf("export async function receiveFromWorkshop"),
  serviceCode.indexOf("export async function listWorkshopBatches")
);

// ───────────────── اشتقاق الحالة ─────────────────

/** نفس منطق السيرفر: الدفعة مقفولة لو فيه تحويل راجع بيشاور على رقمها. */
type Ev = { ref: string; from: number; to: number; linked?: string | null };
function derive(events: Ev[], workshop: number) {
  const closed = new Set(
    events.filter(e => e.from === workshop && e.linked).map(e => e.linked as string)
  );
  return events
    .filter(e => e.to === workshop)
    .map(e => ({ ref: e.ref, status: closed.has(e.ref) ? "received" : "at_workshop" }));
}

describe("🔑 الحالة مشتقّة من الحركات", () => {
  const OFFICE = 1, WORKSHOP = 2;

  it("دفعة راحت الورشة ومرجعتش = عند الورشة", () => {
    expect(derive([{ ref: "RET-1", from: OFFICE, to: WORKSHOP }], WORKSHOP))
      .toEqual([{ ref: "RET-1", status: "at_workshop" }]);
  });

  it("🔑 رجعت لما يتعمل تحويل عكسي بيشاور عليها", () => {
    const events: Ev[] = [
      { ref: "RET-1", from: OFFICE, to: WORKSHOP },
      { ref: "RET-1-R", from: WORKSHOP, to: OFFICE, linked: "RET-1" },
    ];
    expect(derive(events, WORKSHOP)).toEqual([{ ref: "RET-1", status: "received" }]);
  });

  it("🔑 تحويل راجع من غير رابط مابيقفلش أي دفعة", () => {
    const events: Ev[] = [
      { ref: "RET-1", from: OFFICE, to: WORKSHOP },
      { ref: "MISC-9", from: WORKSHOP, to: OFFICE, linked: null },
    ];
    expect(derive(events, WORKSHOP)).toEqual([{ ref: "RET-1", status: "at_workshop" }]);
  });

  it("🔑 الرابط الغلط مايقفلش الدفعة الغلط", () => {
    const events: Ev[] = [
      { ref: "RET-1", from: OFFICE, to: WORKSHOP },
      { ref: "RET-2", from: OFFICE, to: WORKSHOP },
      { ref: "RET-2-R", from: WORKSHOP, to: OFFICE, linked: "RET-2" },
    ];
    expect(derive(events, WORKSHOP)).toEqual([
      { ref: "RET-1", status: "at_workshop" },
      { ref: "RET-2", status: "received" },
    ]);
  });

  it("التحويلات بين مخازن تانية مش دفعات مرتجع", () => {
    expect(derive([{ ref: "TR-5", from: 1, to: 3 }], WORKSHOP)).toEqual([]);
  });
});

describe("🔑 مفيش جدول ولا عمود حالة", () => {
  it("مفيش جدول مرتجعات ورشة في السكيمة", () => {
    expect(schema).not.toContain("workshop_returns");
    expect(schema).not.toContain("workshop_repairs");
  });

  it("🔑 الدالة بتقرا business_events مش جدول حالة", () => {
    expect(listFn).toContain("from(businessEvents)");
    expect(listFn).toContain('eq(businessEvents.eventType, "inventory.stock_transfer")');
  });

  it("🔑 والحالة بتتحسب من linkedReference مش بتتقري من عمود", () => {
    expect(listFn).toContain("closedBy");
    expect(listFn).toContain("payload.linkedReference");
    expect(listFn).toContain('closed ? ("received" as const) : ("at_workshop" as const)');
  });

  it("قراءة بحتة — مفيش كتابة في الدالة", () => {
    expect(listFn).not.toContain(".insert(");
    expect(listFn).not.toContain(".update(");
    expect(listFn).not.toContain(".delete(");
  });

  it("🔑 الأحداث الملغية مش محسوبة", () => {
    expect(listFn).toContain('eq(businessEvents.status, "active"');
  });

  it("payload مكسور مايوقعش الصفحة", () => {
    expect(listFn).toContain("try {");
    expect(listFn).toContain("catch");
  });
});

describe("🔑 تكلفة الإصلاح مابتعملش مصروف", () => {
  it("بتتخزّن في الحدث وبس", () => {
    expect(transferFn).toContain("repairCostPerPiece: input.repairCostPerPiece ?? null");
  });

  it("🔑 ومفيش أي مسار فلوس في التحويل كله", () => {
    for (const forbidden of [
      "financialTransactions", "treasuryTransactions", "expenses",
      "createExpense", "addTreasuryTransaction",
    ]) {
      expect(transferFn, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 والشاشة بتقول ده صراحة", () => {
    expect(page).toContain("مابتخصمش من الخزنة");
    expect(page).toContain("ومابتتسجّلش كمصروف");
  });
});

describe("الإرسال والاستلام تحويلين", () => {
  it("🔑 الاتنين بينادوا transferStock — مفيش مسار مخزون جديد", () => {
    // الفرونت بيغلّف بس (workshopSend/workshopReceive)؛ التحويل الحقيقي في السيرفر.
    expect(sendFn).toContain("await transferStock({");
    expect(receiveFn).toContain("await transferStock({");
    // ومحدش فيهم بيكتب مخزون بإيده — كله ماشي على البريمِتيف الواحد.
    for (const fn of [sendFn, receiveFn]) {
      expect(fn).not.toContain(".insert(");
      expect(fn).not.toContain(".update(");
      expect(fn).not.toContain(".delete(");
    }
  });

  it("🔑 الإرسال مكتب←ورشة والاستلام بيعكس الاتجاه", () => {
    expect(sendFn).toContain("fromWarehouseId: officeWarehouseId");
    expect(sendFn).toContain("toWarehouseId: workshopWarehouseId");
    expect(receiveFn).toContain("fromWarehouseId: workshopWarehouseId");
    expect(receiveFn).toContain("toWarehouseId: officeWarehouseId");
  });

  it("🔑 الاستلام بيربط بإذن الإرسال ونفس البنود بترجع", () => {
    expect(receiveFn).toContain("linkedReference: input.sendReference");
    // نفس البنود اللي راحت — مش كميات جديدة يكتبها المستخدم
    const rb = page.slice(page.indexOf("const receiveBack ="));
    expect(rb.slice(0, rb.indexOf("\n  const showError"))).toContain("lines: batch.lines");
  });

  it("🔑 رقم إذن الرجوع مشتق من الأصلي فمابيتكررش", () => {
    expect(receiveFn).toContain("${input.sendReference}-R");
  });

  it("زرار الاستلام بيظهر للمفتوح بس", () => {
    expect(page).toContain('b.status === "at_workshop" && (');
    expect(page).toContain("استلام من الورشة");
  });
});

describe("الواجهة", () => {
  it("🔑 الأعمدة اللي طلبها التاجر", () => {
    for (const col of [
      "التاريخ", "رقم الإذن", "الصنف / النوع", "العدد",
      "تكلفة الإصلاح للقطعة", "الإجمالي", "الحالة",
    ]) {
      expect(page, col).toContain(col);
    }
  });

  it("🔑 الحالة بالعربي: عند الورشة / تم الاستلام", () => {
    expect(page).toContain('"تم الاستلام" : "عند الورشة"');
  });

  it("عربي RTL وموبايل", () => {
    expect(page).toContain('dir="rtl"');
    expect(page).toContain("grid-cols-1 gap-2 sm:grid-cols-3");
    expect(page).toContain("overflow-x-auto");
  });

  it("الخطأ بيتقال بالعربي", () => {
    expect(page).toContain("مش قادر أجيب دفعات الورشة");
    expect(page).toContain("batches.error?.message");
  });

  it("التحقق كامل", () => {
    const v = page.slice(page.indexOf("const validate = ()"));
    const body = v.slice(0, v.indexOf("\n  };"));
    // المخزن ورقم الإذن بقوا تلقائيين — فمفيش تحقق عليهم في الفرونت
    expect(body).not.toContain("المخزنين لازم يكونوا مختلفين");
    expect(body).not.toContain("رقم الإذن مطلوب");
    expect(body).toContain("سبب الإرسال مطلوب");
    expect(body).toContain("الكمية لازم تكون رقم صحيح أكبر من صفر");
    expect(body).toContain("النوع ده مش تابع للصنف المختار");
  });
});

describe("الصلاحية", () => {
  it("القراءة على view مش manage", () => {
    expect(routers).toContain(
      'workshopReturns: permissionProcedure("inventory_costing.view")'
    );
  });
});
