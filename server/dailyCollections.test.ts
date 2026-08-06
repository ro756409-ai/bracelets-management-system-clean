import { describe, it, expect } from "vitest";
import fs from "fs";
import { manualSettlementHash } from "./settlementsV2.service";

/**
 * تحصيل اليوم ومصروف اليوم — المرحلة الرابعة.
 *
 * الاتنين بيتسجّلوا في **نفس الجداول** بتاعة المسار الكامل، مش في جداول جديدة: التحصيل
 * في `carrier_settlements`، والمصروف في `expenses`. اللي جديد هو **الطريق** مش المخزن —
 * إدخال واحد بدل استيراد ملف، وخطوة واحدة بدل أربعة.
 *
 * الاختبارات بتقفل: حركة خزنة واحدة بالصافي، ومفيش تسجيل مرتين، ومفيش migration.
 */

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const read = (f: string) => codeOnly(fs.readFileSync(f, "utf-8"));

const settlements = read("server/settlementsV2.service.ts");
const expensesSvc = read("server/expensesV2.service.ts");
const routers = read("server/routers.ts");
const page = fs.readFileSync("client/src/pages/DailyCollections.tsx", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");

const between = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, `مالقيتش «${start}»`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j > -1 ? j : undefined);
};

const recordFn = between(
  settlements,
  "export async function recordDailySettlement",
  "export async function listDailySettlements"
);
const listFn = settlements.slice(
  settlements.indexOf("export async function listDailySettlements")
);
const simpleExpenseFn = expensesSvc.slice(
  expensesSvc.indexOf("export async function recordSimpleExpense")
);

// ───────────────── البصمة اللي بتمنع التسجيل مرتين ─────────────────

const base = {
  businessShippingProviderId: 3,
  statementDate: new Date("2026-08-06T12:00:00Z"),
  reference: "TRX-1",
  grossCollected: "5000",
  totalCharges: "700",
};

describe("🔑 بصمة التحصيل", () => {
  it("نفس التحصيل بالظبط = نفس البصمة", () => {
    expect(manualSettlementHash(base)).toBe(manualSettlementHash({ ...base }));
  });

  it("🔑 والساعة مابتفرقش — اليوم هو الوحدة", () => {
    expect(
      manualSettlementHash({
        ...base,
        statementDate: new Date("2026-08-06T23:30:00Z"),
      })
    ).toBe(manualSettlementHash(base));
  });

  it("🔑 مبلغ مختلف = بصمة مختلفة — تحويلين في يوم واحد مسموحين", () => {
    expect(manualSettlementHash({ ...base, grossCollected: "5001" })).not.toBe(
      manualSettlementHash(base)
    );
    expect(manualSettlementHash({ ...base, totalCharges: "701" })).not.toBe(
      manualSettlementHash(base)
    );
  });

  it("شركة مختلفة أو يوم مختلف أو مرجع مختلف = بصمة مختلفة", () => {
    for (const variant of [
      { businessShippingProviderId: 4 },
      { statementDate: new Date("2026-08-07T12:00:00Z") },
      { reference: "TRX-2" },
    ]) {
      expect(manualSettlementHash({ ...base, ...variant })).not.toBe(
        manualSettlementHash(base)
      );
    }
  });

  it("المسافات الزايدة في المرجع مابتعملش تحصيل جديد", () => {
    expect(manualSettlementHash({ ...base, reference: "  TRX-1  " })).toBe(
      manualSettlementHash(base)
    );
  });

  it("الصفر بيتطبّع — «0» و«0.00» نفس البصمة", () => {
    expect(manualSettlementHash({ ...base, totalCharges: "0.00" })).toBe(
      manualSettlementHash({ ...base, totalCharges: "0" })
    );
  });
});

// ───────────────── التحصيل: حركة واحدة بالصافي ─────────────────

describe("🔑 التحصيل بيدخل الخزنة مرة واحدة بالصافي", () => {
  it("حركة خزنة واحدة بالظبط", () => {
    expect(
      (recordFn.match(/addTreasuryTransactionInTransaction\(/g) ?? []).length
    ).toBe(1);
  });

  it("🔑 داخلة، نوعها تحصيل، وبالصافي مش بالإجمالي", () => {
    const call = between(recordFn, "addTreasuryTransactionInTransaction", "});");
    expect(call).toContain('direction: "in"');
    expect(call).toContain('type: "collection"');
    expect(call).toContain("amount: netTransferred");
    expect(call).not.toContain("grossMinor");
  });

  it("🔑 الرسوم مابتنزلش حركة تانية — مادخلتش الدُرج أصلاً", () => {
    // لو الرسوم نزلت حركة خارجة، الصرف كان هيتعدّ مرتين: مرة كرسوم ومرة كفرق بين
    // الإجمالي والصافي.
    expect(recordFn).not.toContain('direction: "out"');
    expect(recordFn).not.toContain("insert(expenses)");
  });

  it("🔑 الصافي = الإجمالي − الرسوم، والسالب مرفوض", () => {
    expect(recordFn).toContain("const netMinor = grossMinor - chargesMinor");
    expect(recordFn).toContain("رسوم الشحن أكبر من إجمالي التحصيل");
    expect(recordFn).toContain("إجمالي التحصيل لازم يكون أكبر من صفر");
    expect(recordFn).toContain("ما تكونش بالسالب");
  });

  it("🔑 التسجيل المكرر بيترفض برسالة مفهومة", () => {
    expect(recordFn).toContain("التحصيل ده متسجّل خلاص");
    expect(recordFn).toContain("carrierSettlements.importHash");
  });

  it("🔑 كله في ترانزاكشن واحدة", () => {
    const start = recordFn.indexOf("db.transaction(async tx =>");
    expect(start).toBeGreaterThan(-1);
    for (const step of [
      "insert(carrierSettlements)",
      "insert(carrierSettlementLines)",
      "createBusinessEventInTransaction",
      "postFinancialTransactionInTransaction",
      "addTreasuryTransactionInTransaction",
    ]) {
      expect(recordFn.indexOf(step), step).toBeGreaterThan(start);
    }
    expect(recordFn).toContain("if (!treasury) throw new Error");
  });

  it("بيدخل الخزنة الرئيسية — مصدر بره النظام فمفيش sourceAccountId", () => {
    const call = between(
      recordFn,
      "postFinancialTransactionInTransaction",
      "});"
    );
    expect(call).toContain("targetAccountId: treasuryAccount.id");
    expect(call).not.toContain("sourceAccountId");
  });

  it("عدد الأوردرات لازم رقم صحيح موجب", () => {
    expect(recordFn).toContain("Number.isInteger(input.ordersCount)");
  });

  it("🔑 التسوية بملف لسه شغّالة زي ما هي", () => {
    expect(settlements).toContain("export async function importCarrierSettlement");
    expect(settlements).toContain("export async function approveCarrierSettlement");
  });
});

// ───────────────── المصروف البسيط ─────────────────

describe("🔑 المصروف بخطوة واحدة", () => {
  it("بيمشي على نفس الدوال بنفس الترتيب — مش مسار موازي", () => {
    const order = ["createExpenseDraft(", "submitExpense(", "approveExpense(", "payExpense("];
    let cursor = -1;
    for (const step of order) {
      const at = simpleExpenseFn.indexOf(step);
      expect(at, step).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("🔑 ومابيكتبش في أي جدول بنفسه", () => {
    for (const forbidden of ["insert(", "update(", "treasuryTransactions", "db.transaction"]) {
      expect(simpleExpenseFn, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 «سجّل بس» بيقف عند مستحق — مفيش حركة خزنة", () => {
    const at = simpleExpenseFn.indexOf("if (!input.payNow)");
    const pay = simpleExpenseFn.indexOf("payExpense(");
    expect(at).toBeGreaterThan(-1);
    expect(pay).toBeGreaterThan(at);
    expect(simpleExpenseFn).toContain('status: "accrued" as const, paid: false');
  });

  it("🔑 «سجّل وادفع» بيدفع المبلغ كامل من الخزنة الرئيسية", () => {
    const call = between(simpleExpenseFn, "await payExpense({", "});");
    expect(call).toContain("amount: input.amount");
    expect(call).not.toContain("sourceAccountId");
  });

  it("فترة الخدمة يوم واحد — يوم المصروف", () => {
    expect(simpleExpenseFn).toContain("serviceFrom: input.expenseDate");
    expect(simpleExpenseFn).toContain("serviceTo: input.expenseDate");
  });

  it("🔑 حاجز الاعتماد لسه قايم — بيتفتح للمالك بس", () => {
    const approve = between(
      expensesSvc,
      "export async function approveExpense",
      "export async function payExpense"
    );
    expect(approve).toContain(
      "if (expense.createdBy === input.actor.id && !input.allowSelfApproval)"
    );
    const router = between(routers, "expenseApprove: permissionProcedure", "adSpendCreate");
    expect(router).toContain("allowSelfApproval: isOwnerRole(ctx.employee?.role)");
  });
});

// ───────────────── العقود ─────────────────

describe("العقود", () => {
  it("التحصيل بيطلب صلاحية إدارة الشحن المالي", () => {
    expect(routers).toContain(
      'dailySettlementRecord: permissionProcedure("shipping_finance.manage")'
    );
    expect(routers).toContain(
      'dailySettlementList: permissionProcedure("shipping_finance.view")'
    );
  });

  it("والمصروف بيطلب accounting.manage", () => {
    expect(routers).toContain(
      'expenseRecordSimple: permissionProcedure("accounting.manage")'
    );
  });

  it("🔑 المرجع والملاحظات والمرفق اختياريين — التحصيل بيتسجّل كل يوم", () => {
    const input = between(
      routers,
      "dailySettlementRecord: permissionProcedure",
      ".mutation("
    );
    for (const optional of ["reference", "notes", "evidenceUrl"]) {
      expect(input, optional).toMatch(
        new RegExp(`${optional}: z\\.string\\(\\)\\.max\\(\\d+\\)\\.optional\\(\\)`)
      );
    }
    expect(input).toContain("ordersCount: z.number().int().min(1)");
  });

  it("القراءة query والكتابة mutation", () => {
    const listBlock = between(
      routers,
      "dailySettlementList: permissionProcedure",
      "dailySettlementRecord:"
    );
    expect(listBlock).toContain(".query(");
    expect(listBlock).not.toContain(".mutation(");
  });

  it("🔑 القايمة قراءة بحتة", () => {
    for (const forbidden of [".insert(", ".update(", ".delete(", "transaction("]) {
      expect(listFn, forbidden).not.toContain(forbidden);
    }
  });

  it("وبتقرا عدد الأوردرات من سطر الملخّص ومابتقعش على بيانات مكسورة", () => {
    expect(listFn).toContain("JSON.parse(line.rawLineJson)");
    expect(listFn).toContain("catch");
    expect(listFn).toContain('parsed?.entryMode === "manual-daily"');
  });
});

// ───────────────── الشاشة ─────────────────

describe("الشاشة", () => {
  it("🔑 عربي RTL وبتستخدم مصدر الأنشطة الموحّد", () => {
    expect(page).toContain('dir="rtl"');
    expect(page).toContain('from "@/hooks/useBrandOptions"');
  });

  it("🔑 الحقول اللي اتطلبت للتحصيل", () => {
    for (const label of [
      "التاريخ", "شركة الشحن", "رقم التحويل", "عدد الأوردرات",
      "إجمالي التحصيل", "رسوم الشحن", "الصافي اللي هيدخل الخزنة", "ملاحظات",
    ]) {
      expect(page, label).toContain(label);
    }
  });

  it("🔑 وحقول المصروف", () => {
    for (const label of ["التاريخ", "المبلغ", "التصنيف", "المصروف بيخص إيه"]) {
      expect(page, label).toContain(label);
    }
    expect(page).toContain("صورة الفاتورة (اختياري)");
  });

  it("🔑 الزرارين: سجّل بس، وسجّل وادفع", () => {
    expect(page).toContain("سجّل بس (مستحق)");
    expect(page).toContain("سجّل وادفع");
    expect(page).toContain("submit(false)");
    expect(page).toContain("submit(true)");
  });

  it("🔑 وبتقول للتاجر إن الرسوم مش حركة تانية", () => {
    expect(page).toContain("مادخلتش الدُرج أصلاً");
    expect(page).toContain("حركة واحدة");
  });

  it("🔑 اللوحة بتتحدّث فورًا بعد كل تسجيل", () => {
    expect(
      (page.match(/utils\.accounting\.controlCenter\.invalidate\(\)/g) ?? []).length
    ).toBe(2);
    expect(
      (page.match(/utils\.accounting\.dashboard\.invalidate\(\)/g) ?? []).length
    ).toBe(2);
  });

  it("🔑 الشاشة مابتحسبش الصافي وبتبعته — بتبعت الإجمالي والرسوم", () => {
    const call = between(page, "record.mutate({", "});");
    expect(call).toContain("grossCollected: gross");
    expect(call).toContain("totalCharges: charges");
    expect(call).not.toContain("net");
  });

  it("موبايل والجدول بيسكرول لوحده", () => {
    expect(page).toContain("lg:grid-cols-2");
    expect(page).toContain("overflow-x-auto");
  });
});

// ───────────────── مفيش تغيير في قاعدة البيانات ─────────────────

describe("🔑 المرحلة الرابعة مااحتاجتش migration", () => {
  it("بتستخدم carrier_settlements الموجود", () => {
    expect(schema).toContain('carrierSettlements = mysqlTable(\n  "carrier_settlements"');
    const table = between(
      schema,
      "carrierSettlements = mysqlTable(",
      "export const carrierSettlementLines"
    );
    for (const col of ["grossCollected", "totalCharges", "netTransferred", "statementDate", "importHash"]) {
      expect(table, col).toContain(col);
    }
  });

  it("🔑 وعدد الأوردرات والملاحظة في السطر — مش أعمدة جديدة", () => {
    expect(recordFn).toContain('entryMode: "manual-daily"');
    expect(recordFn).toContain("ordersCount: input.ordersCount");
    // الترويسة لوحدها — سطور التسوية تحتها ليها `notes` بتاعها وده مش موضوعنا.
    const table = between(
      schema,
      "carrierSettlements = mysqlTable(",
      "export const carrierSettlementLines"
    );
    expect(table).not.toContain("ordersCount");
    expect(table).not.toContain('notes: text');
  });
});
