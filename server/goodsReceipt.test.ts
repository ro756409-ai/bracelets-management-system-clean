import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  lineSubtotal, lineTotal, lineFinalUnitCost, documentTotal, outstandingAmount,
  workshopLineTotal, workshopReceiptTotal, workshopReceiptPieces,
} from "@shared/purchaseTotals";
import { applyStockIn, applyStockOut } from "@shared/inventoryCosting";

/**
 * إذن استلام البضاعة.
 *
 * أهم حاجة الاختبارات دي بتقفلها هي **الجسر**: النظام فيه تمثيلين للمخزون —
 * `inventory_balances` المحاسبي و`products/product_variants.currentStock` التشغيلي —
 * وapprovePurchaseReceipt كان بيكتب في الأول وبس. يعني استلام مية أسورة كان بيحرّك رقم
 * المحاسب ويسيب رقم أمين المخزن صفر.
 *
 * وبتقفل كمان إن مفيش دفتر تالت اتولد، وإن طريقة التكلفة فضلت المتوسط المرجّح الموجود.
 */

const service = fs.readFileSync("server/inventoryV2.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");
const page = fs.readFileSync("client/src/pages/GoodsReceipt.tsx", "utf-8");
const ledger = fs.readFileSync("client/src/pages/DailyLedger.tsx", "utf-8");

/** الكود من غير التعليقات — «لازم ماتحتويش» مالهاش معنى قدام شرح بيسمّي الحاجة. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

/** لازم يتقص من نفس النص اللي اتشالت منه التعليقات — الأرقام من النص الأصلي مش بتطابق. */
const serviceCode = codeOnly(service);
const between = (src: string, start: string, end?: string) => {
  const i = src.indexOf(start);
  const j = end ? src.indexOf(end, i + 1) : -1;
  return src.slice(i, j > i ? j : undefined);
};

const approveFn = between(
  serviceCode,
  "export async function approvePurchaseReceipt",
  "export async function voidPurchaseReceipt"
);
const voidFn = between(
  serviceCode,
  "export async function voidPurchaseReceipt",
  "export async function submitReturnInspection"
);
const mirrorFn = between(
  serviceCode,
  "async function mirrorLegacyStock",
  "export async function getInventoryControlData"
);
const createFn = between(
  serviceCode,
  "export async function createPurchaseReceiptDraft",
  "export async function submitPurchaseReceipt"
);

// ─────────────────────────── ١ · حسابات المستند ───────────────────────────

describe("حسابات البنود والمستند", () => {
  it("أساس البند = الكمية × تكلفة الوحدة", () => {
    expect(lineSubtotal({ quantity: 10, unitCost: 25 })).toBe(250);
  });

  it("🔑 إجمالي البند = الأساس − الخصم + التكلفة الإضافية", () => {
    expect(lineTotal({ quantity: 10, unitCost: 25, discount: 30, extraCost: 80 })).toBe(300);
  });

  it("🔑 تكلفة الوحدة النهائية بتوزّع الخصم والإضافة على الكمية", () => {
    // 250 − 30 + 80 = 300 على 10 قطع
    expect(lineFinalUnitCost({ quantity: 10, unitCost: 25, discount: 30, extraCost: 80 })).toBe(30);
  });

  it("كمية صفر بترجّع صفر مش NaN — النموذج بيحسب وإنت بتكتب", () => {
    expect(lineFinalUnitCost({ quantity: 0, unitCost: 25 })).toBe(0);
    expect(lineFinalUnitCost({ quantity: "", unitCost: "" })).toBe(0);
  });

  it("🔑 بنود متعددة بتتجمع صح", () => {
    const totals = documentTotal([
      { quantity: 10, unitCost: 25 },
      { quantity: 4, unitCost: 100, discount: 50 },
      { quantity: 2, unitCost: 15, extraCost: 20 },
    ]);
    expect(totals.linesTotal).toBe(250 + 350 + 50);
  });

  it("🔑 إجمالي المستند = البنود + الشحن − خصم الفاتورة", () => {
    const totals = documentTotal([{ quantity: 10, unitCost: 25 }], 120, 40);
    expect(totals.total).toBe(250 + 120 - 40);
  });

  it("المتبقي = الإجمالي − المدفوع، ومابينزلش تحت الصفر", () => {
    expect(outstandingAmount(1000, 300)).toBe(700);
    expect(outstandingAmount(1000, 0)).toBe(1000);
    expect(outstandingAmount(1000, 1200)).toBe(0);
  });
});

describe("سادة ومحفور في صف واحد", () => {
  const line = {
    plainQuantity: 40, plainUnitCost: 25,
    engravedQuantity: 10, engravedUnitCost: 32,
  };

  it("🔑 إجمالي الصنف = (سادة × تكلفتها) + (محفور × تكلفته)", () => {
    // 40×25 = 1000، 10×32 = 320
    expect(workshopLineTotal(line)).toBe(1320);
  });

  it("الحالة الواحدة لوحدها بتتحسب صح", () => {
    expect(workshopLineTotal({ ...line, engravedQuantity: 0, engravedUnitCost: "" })).toBe(1000);
    expect(workshopLineTotal({ ...line, plainQuantity: 0, plainUnitCost: "" })).toBe(320);
  });

  it("الصف الفاضي بيرجّع صفر مش NaN — النموذج بيحسب وإنت بتكتب", () => {
    expect(workshopLineTotal({
      plainQuantity: "", plainUnitCost: "", engravedQuantity: "", engravedUnitCost: "",
    })).toBe(0);
  });

  it("🔑 إجمالي الإذن = مجموع الصفوف، من غير خصم ولا شحن", () => {
    expect(workshopReceiptTotal([line, { ...line, plainQuantity: 5, engravedQuantity: 0 }]))
      .toBe(1320 + 125);
  });

  it("🔑 عدد القطع بيجمع الحالتين — ده اللي أمين المخزن بيعدّه", () => {
    expect(workshopReceiptPieces([line])).toBe(50);
    expect(workshopReceiptPieces([line, line])).toBe(100);
  });
});

// ─────────────────────────── ٢ · طريقة التكلفة ───────────────────────────

describe("المتوسط المرجّح — الموجود، مش جديد", () => {
  it("🔑 المتوسط الجديد = (القيمة القديمة + قيمة الوارد) ÷ (الكمية الكلية)", () => {
    // 100 قطعة بمتوسط 10 = 1000، يدخل 100 بـ20 = 2000 → 3000 ÷ 200 = 15
    const next = applyStockIn(
      { quantity: 100, inventoryValue: "1000.0000", movingAverageCost: "10.0000" },
      100, "20.0000"
    );
    expect(next.quantity).toBe(200);
    expect(Number(next.movingAverageCost)).toBe(15);
    expect(Number(next.inventoryValue)).toBe(3000);
  });

  it("الاستلام على رصيد صفر بيحط التكلفة نفسها كمتوسط", () => {
    const next = applyStockIn(
      { quantity: 0, inventoryValue: "0.0000", movingAverageCost: "0.0000" },
      50, "12.5000"
    );
    expect(Number(next.movingAverageCost)).toBe(12.5);
  });

  it("🔑 الاعتماد بينادي applyStockIn — مفيش معادلة تكلفة مكتوبة في الخدمة", () => {
    expect(approveFn).toContain("applyStockIn(");
    expect(approveFn).not.toMatch(/movingAverageCost\s*[:=]\s*[^,)\n]*[+/*]/);
  });

  it("🔑 والعكس بينادي applyStockOut — مش بيرجّع بسعر الشراء", () => {
    // الخروج بالمتوسط الحالي هو سلوك كل حركة صادرة في النظام. لو الإلغاء رجّع
    // بسعر الشراء الأصلي يبقى ده طريقة تكلفة تانية من الباب الخلفي.
    expect(voidFn).toContain("applyStockOut(");
  });
});

// ─────────────────────────── ٣ · الجسر ───────────────────────────

describe("🔑 الجسر بين المخزونين", () => {
  it("الاعتماد بيكتب في الاتنين: الرصيد المحاسبي والعدّاد التشغيلي", () => {
    expect(approveFn).toContain("inventoryTransactions");
    expect(approveFn).toContain("inventoryBalances");
    expect(approveFn).toContain("mirrorLegacyStock(tx, {");
  });

  it("مفيش دفتر تالت — المرآة بتكتب في inventory_movements الموجود", () => {
    expect(mirrorFn).toContain("tx.insert(inventoryMovements)");
    expect(mirrorFn).toContain("productVariants.currentStock");
    expect(mirrorFn).toContain("products.currentStock");
  });

  it("🔑 بند بنوع بيحرّك عدّاد النوع بس — المنتج الأب مابيمسكش مخزون", () => {
    const variantBranch = mirrorFn.slice(mirrorFn.indexOf("if (input.variantId != null)"));
    expect(variantBranch.slice(0, variantBranch.indexOf("return;"))).toContain("productVariants");
    expect(variantBranch.slice(0, variantBranch.indexOf("return;"))).not.toContain("update(products)");
  });

  it("🔑 كله جوه نفس الترانزاكشن — مفيش نص استلام", () => {
    expect(mirrorFn).not.toContain("getDb()");
    expect(mirrorFn).toContain("tx: any");
  });

  it("المرآة بتربط الحركة بإذن الاستلام وبالمورد", () => {
    expect(approveFn).toContain("reason: `purchase_receipt:${receipt.id}`");
    expect(approveFn).toContain("notes: receipt.supplierName");
  });
});

// ─────────────────────────── ٤ · دورة الحياة ───────────────────────────

describe("دورة حياة الإذن", () => {
  it("🔑 المسودة مابتحركش مخزون — الإنشاء بيكتب في الجداول الورقية بس", () => {
    expect(createFn).toContain("purchaseReceipts");
    expect(createFn).toContain("purchaseReceiptItems");
    expect(createFn).not.toContain("inventoryBalances");
    expect(createFn).not.toContain("mirrorLegacyStock");
    expect(createFn).toContain('status: "draft"');
  });

  it("المعتمد بس هو اللي بيزوّد — الاعتماد بيرفض أي حالة تانية", () => {
    expect(approveFn).toContain('receipt.status !== "pending_approval"');
  });

  it("🔑 الاعتماد المكرر ممنوع بمفتاح idempotency", () => {
    expect(approveFn).toContain("idempotencyKey: `purchase-receipt:${receipt.id}:approved`");
    expect(approveFn).toContain("if (eventResult.duplicate) return");
  });

  it("🔑 الإلغاء بحركة عكسية مش بمسح", () => {
    expect(voidFn).toContain("quantityDelta: -line.quantity");
    expect(voidFn).toContain('transactionType: "purchase_reversal"');
    expect(voidFn).toContain("idempotencyKey: `purchase-receipt:${receipt.id}:voided`");
    expect(voidFn).not.toContain("tx.delete(");
  });

  it("🔑 الإلغاء بيعكس العدّاد التشغيلي كمان", () => {
    expect(voidFn).toContain("mirrorLegacyStock(tx, {");
    expect(voidFn).toContain("quantityDelta: -line.quantity");
  });

  it("إلغاء مسودة بيغيّر الحالة وبس — مفيش حركة عكسية لحاجة ماحصلتش", () => {
    const draftBranch = voidFn.slice(voidFn.indexOf('if (receipt.status !== "approved")'));
    expect(draftBranch.slice(0, draftBranch.indexOf("}"))).toContain('status: "voided"');
    expect(draftBranch.slice(0, draftBranch.indexOf("}"))).not.toContain("inventoryTransactions");
  });

  it("الإلغاء بيرفض لو الكمية اتصرّفت — أحسن من رصيد سالب يقفل التقفيل", () => {
    expect(voidFn).toContain("line.quantity > balance.onHandQuantity");
  });

  it("إلغاء إذن ملغي ممنوع", () => {
    expect(voidFn).toContain('receipt.status === "voided"');
  });

  it("الإلغاء لازم سبب", () => {
    expect(voidFn).toContain("إلغاء إذن الاستلام يتطلب سببًا موثقًا");
  });
});

// ─────────────────────────── ٥ · المحاسبة والخزنة ───────────────────────────

describe("🔑 الاستلام مابيخصمش خزنة", () => {
  it("مفيش أي قيد مالي في مسار الاستلام كله", () => {
    const all = codeOnly(service);
    expect(all).not.toContain("financialTransactions");
    expect(all).not.toContain("treasuryTransactions");
    expect(all).not.toContain("postFinancialTransaction");
  });

  it("الفاتورة غير المدفوعة بتظهر مستحق مورد مش مصروف مدفوع", () => {
    const fn = db.slice(
      db.indexOf("export async function getDailyLedgerSummary"),
      db.indexOf("// ==================== PAYROLL")
    );
    const due = fn.slice(fn.indexOf("const [supplierDue]"));
    expect(due).toContain('inArray(purchaseReceipts.paymentStatus, ["unpaid", "partially_paid"]');
    expect(due).toContain('eq(purchaseReceipts.status, "approved"');
    // المستحق مش محدود باليوم — فاتورة الشهر اللي فات لسه عليك
    expect(due.slice(0, due.indexOf("const movements"))).not.toContain("toExclusive");
  });

  it("🔑 البضاعة المستلمة بتتحسب لحظة الترحيل مش تاريخ الورقة", () => {
    const fn = db.slice(db.indexOf("export async function getDailyLedgerSummary"));
    const received = fn.slice(fn.indexOf("const [goodsReceived]"));
    expect(received.slice(0, received.indexOf("const [supplierDue]"))).toContain(
      "gte(purchaseReceipts.approvedAt, from)"
    );
  });

  it("🔑 مدفوعات الموردين بترجع null مش صفر — الفرق بين «مادفعناش» و«مابنسجّلش»", () => {
    const fn = db.slice(db.indexOf("export async function getDailyLedgerSummary"));
    expect(fn).toContain("supplierPaid: null as number | null");
    expect(ledger).toContain("لسه مفيش مسار دفع موردين");
  });

  it("التلات حقائق بتتعرض منفصلة في الدفتر اليومي", () => {
    expect(ledger).toContain('label: "بضاعة مستلمة"');
    expect(ledger).toContain('label: "مدفوعات موردين"');
    expect(ledger).toContain('label: "مستحق للموردين"');
  });
});

// ─────────────────────────── ٦ · الصلاحيات والواجهة ───────────────────────────

describe("الصلاحيات", () => {
  it("🔑 الإلغاء على طبقة الاعتماد مش الإدخال", () => {
    expect(routers).toContain(
      'purchaseReceiptVoid: permissionProcedure("inventory_costing.approve")'
    );
  });

  it("الإلغاء بياخد سبب إجباري من الـAPI كمان", () => {
    const i = routers.indexOf("    purchaseReceiptVoid:");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    expect(input).toContain("reason: z.string().min(1).max(500)");
  });

  it("🔑 الموظف اللي سجّل الإذن مايعتمدش إذنه", () => {
    expect(approveFn).toContain("receipt.createdBy === input.actor.id && !input.allowSelfApproval");
    expect(approveFn).toContain("اللي سجّل الإذن مايقدرش يعتمده");
  });

  it("🔑 والاستثناء للمالك بس، والراوتر هو اللي بيحسبه من الدور", () => {
    const i = routers.indexOf("    purchaseReceiptApprove:");
    const block = routers.slice(i, routers.indexOf("    stockTransfer:", i));
    expect(block).toContain("allowSelfApproval: isOwnerRole(ctx.employee?.role)");
  });
});

describe("الشاشة", () => {
  it("🔑 عربي RTL", () => {
    expect(page).toContain('dir="rtl"');
    expect(page).toContain("استلام بضاعة من الورشة");
  });

  it("🔑 مفيش لغة محاسبية — لا إذن شراء ولا فاتورة مورد", () => {
    const code = codeOnly(page);
    for (const term of ["إذن شراء", "فاتورة مورد", "المورد <"]) {
      expect(code, term).not.toContain(term);
    }
  });

  it("🔑 أصناف متعددة", () => {
    expect(page).toContain("صنف جديد");
    expect(page).toContain("setLines(ls => [...ls, newLine()])");
    expect(page).toContain("lines.map((l, i)");
  });

  it("كل الحقول المطلوبة موجودة", () => {
    for (const label of [
      "التاريخ", "الورشة", "مكان الاستلام", "الصنف", "نوع الحفر",
      "كمية سادة", "تكلفة السادة", "كمية محفور", "تكلفة المحفور",
      "ملاحظات", "مرفق",
    ]) {
      expect(page, label).toContain(label);
    }
  });

  it("🔑 الشاشة مابتحسبش بنفسها — بتنادي المعادلة المشتركة", () => {
    expect(page).toContain("from \"@shared/purchaseTotals\"");
    expect(page).toContain("workshopReceiptTotal(lines)");
    expect(page).toContain("workshopLineTotal(l)");
  });

  it("🔑 الصف الواحد بيتحوّل لسطرين: سادة برصيد المنتج ومحفور برصيد النوع", () => {
    const fn = page.slice(page.indexOf("const toItems ="));
    const body = fn.slice(0, fn.indexOf("\n  const save"));
    expect(body).toContain("if (plain > 0)");
    expect(body).toContain("if (engraved > 0)");
    // السادة من غير variantId — هو المنتج نفسه من غير حفر
    expect(body).toContain("out.push({ productId: Number(l.productId), quantity: plain");
    expect(body).toContain("variantId: Number(l.variantId)");
  });

  it("🔑 كمية صفر مابتتبعتش سطر أصلاً", () => {
    const fn = page.slice(page.indexOf("const toItems ="));
    expect(fn.slice(0, fn.indexOf("\n  const save"))).toContain("> 0");
  });

  it("🔑 الشاشة مابتلمسش رصيد — بتنادي نقاط الخدمة الموجودة وبس", () => {
    const mutations = [...page.matchAll(/trpc\.accountingV2\.(\w+)\.useMutation/g)].map(m => m[1]);
    expect(new Set(mutations)).toEqual(new Set([
      "purchaseReceiptCreate", "purchaseReceiptSubmit",
      "purchaseReceiptApprove", "purchaseReceiptVoid",
    ]));
  });

  it("النوع ثابت purchase — مش قايمة بتقرا جدول إعدادات فاضي", () => {
    expect(codeOnly(page)).toContain('receiptType: "purchase"');
    expect(codeOnly(page)).not.toContain('namespace: "inventory_receipt_type"');
  });

  it("🔑 التحقق: كمية موجبة، تكلفة غير سالبة، نوع تابع لمنتجه", () => {
    const validate = page.slice(page.indexOf("const validate = ()"));
    const body = validate.slice(0, validate.indexOf("\n  };"));
    expect(body).toContain("اكتب كمية سادة أو محفور");
    expect(body).toContain("الكمية ماتكونش بالسالب");
    expect(body).toContain("التكلفة ماتكونش بالسالب");
    expect(body).toContain("النوع ده مش تابع للصنف المختار");
    expect(body).toContain("اختار مكان الاستلام");
  });

  it("الأخطاء بتظهر جنب حقولها بالعربي — مفيش فشل صامت", () => {
    expect(page).toContain("const showError =");
    expect(page).toContain("text-destructive");
    expect(page).toContain("فيه حقول ناقصة");
  });

  it("موبايل: الشبكة بتنزل عمود واحد والجدول بيسكرول لوحده", () => {
    expect(page).toContain("grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4");
    expect(page).toContain("grid-cols-2 gap-2 lg:grid-cols-4");
    expect(page).toContain("overflow-x-auto");
  });
});
