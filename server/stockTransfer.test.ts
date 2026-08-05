import { describe, it, expect } from "vitest";
import fs from "fs";
import { applyStockIn, applyStockOut } from "@shared/inventoryCosting";

/**
 * تحويل المخزون — ومسار الورشة اللي مبني عليه.
 *
 * الشرط اللي الاختبارات دي بتقفله: **مفيش مخزون بيتخلق ولا بيتمسح**. التحويل خروج
 * ودخول بنفس الكمية وبنفس التكلفة، فإجمالي الكمية وإجمالي القيمة على مستوى النشاط
 * مابيتغيروش. وبتقفل إن الورشة مخزن مش كيان جديد، وإن التاريخ بيفضل كامل.
 */

const service = fs.readFileSync("server/inventoryV2.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const page = fs.readFileSync("client/src/pages/StockTransfer.tsx", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const serviceCode = codeOnly(service);
const transferFn = serviceCode.slice(
  serviceCode.indexOf("export async function transferStock"),
  serviceCode.indexOf("export async function submitReturnInspection")
);

describe("الحساب: القيمة بتتنقل مش بتتخلق", () => {
  it("🔑 خروج ١٠ ثم دخول ١٠ بنفس التكلفة = إجمالي ثابت", () => {
    const source = { quantity: 100, inventoryValue: "1500.0000", movingAverageCost: "15.0000" };
    const target = { quantity: 0, inventoryValue: "0.0000", movingAverageCost: "0.0000" };

    const out = applyStockOut(source, 10);
    const inn = applyStockIn(target, 10, out.unitCostSnapshot);

    expect(out.quantity + inn.quantity).toBe(100);
    expect(Number(out.inventoryValue) + Number(inn.inventoryValue)).toBeCloseTo(1500, 4);
    // المتوسط في المصدر مابيتغيرش لما الخروج بمتوسطه
    expect(Number(out.movingAverageCost)).toBeCloseTo(15, 4);
    expect(Number(inn.movingAverageCost)).toBeCloseTo(15, 4);
  });

  it("🔑 الدخول لمخزن فيه رصيد بتكلفة مختلفة بيعمل متوسط مرجّح صح", () => {
    const out = applyStockOut(
      { quantity: 50, inventoryValue: "1000.0000", movingAverageCost: "20.0000" }, 20
    );
    const inn = applyStockIn(
      { quantity: 30, inventoryValue: "300.0000", movingAverageCost: "10.0000" },
      20, out.unitCostSnapshot
    );
    // (30×10 + 20×20) ÷ 50 = 14
    expect(inn.quantity).toBe(50);
    expect(Number(inn.movingAverageCost)).toBeCloseTo(14, 4);
    // الإجمالي: 600 فضلوا في المصدر + 700 في الهدف = 1300 = 1000 + 300
    expect(Number(out.inventoryValue) + Number(inn.inventoryValue)).toBeCloseTo(1300, 4);
  });
});

describe("🔑 الورشة مخزن، مش كيان جديد", () => {
  it("مفيش جدول ورشة ولا عهدة اتعمل", () => {
    expect(schema).not.toContain("workshops");
    expect(schema).not.toContain("custody");
  });

  it("التحويل بيشتغل على warehouses الموجود", () => {
    expect(transferFn).toContain("fromWarehouseId");
    expect(transferFn).toContain("toWarehouseId");
    expect(page).toContain("trpc.businesses.warehouses.useQuery");
  });

  it("الشاشة مش مخصوصة بالورشة — أي مخزنين", () => {
    expect(page).toContain("تحويل مخزون");
    expect(page).toContain("الورشة");
  });
});

describe("🔑 مفيش مخزون بيتخلق من العدم", () => {
  it("الوارد بتكلفة الصادر — مش تكلفة جديدة من المستخدم", () => {
    expect(transferFn).toContain("out.unitCostSnapshot");
    const inputSchema = transferFn.slice(0, transferFn.indexOf("const db ="));
    expect(inputSchema).not.toContain("unitCost");
  });

  it("العقد على السيرفر مابياخدش تكلفة أصلاً", () => {
    const i = routers.indexOf("    stockTransfer: permissionProcedure");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    expect(input).toContain("quantity: z.number().int().positive()");
    expect(input).not.toContain("unitCost");
  });

  it("🔑 التحويل بيستخدم applyStockOut و applyStockIn — مفيش حساب تاني", () => {
    expect(transferFn).toContain("applyStockOut({");
    expect(transferFn).toContain("applyStockIn({");
  });

  it("🔑 مايتحوّلش أكتر من المتاح", () => {
    expect(transferFn).toContain("line.quantity > source.onHandQuantity");
  });

  it("صف الرصيد في المخزن المستقبِل بيتعمل بصفر — ده مش مخزون", () => {
    const create = transferFn.slice(transferFn.indexOf("for (const line of input.lines)"));
    expect(create.slice(0, create.indexOf("const targetBalances"))).toContain(
      "tx.insert(inventoryBalances).values({"
    );
    expect(create.slice(0, create.indexOf("const targetBalances"))).not.toContain("onHandQuantity:");
  });
});

describe("التاريخ بيفضل كامل", () => {
  it("🔑 حركتين في دفتر V2: خروج ودخول", () => {
    expect(transferFn).toContain('transactionType: "transfer_out"');
    expect(transferFn).toContain('transactionType: "transfer_in"');
    expect(transferFn).toContain("quantityDelta: -line.quantity");
    expect(transferFn).toContain("quantityDelta: line.quantity");
  });

  it("🔑 وحركتين في الدفتر التشغيلي — صافيهم صفر على العدّاد", () => {
    expect((transferFn.match(/mirrorLegacyStock\(tx, \{/g) ?? []).length).toBe(2);
    expect(transferFn).toContain("reason: `stock_transfer_out:${input.reference}`");
    expect(transferFn).toContain("reason: `stock_transfer_in:${input.reference}`");
  });

  it("الاتنين مربوطين بنفس الحدث", () => {
    expect(transferFn).toContain('eventType: "inventory.stock_transfer"');
    expect((transferFn.match(/businessEventId: eventId/g) ?? []).length).toBe(2);
  });
});

describe("منع التكرار", () => {
  it("🔑 مفتاح idempotency على رقم الإذن", () => {
    expect(transferFn).toContain(
      "idempotencyKey: `stock-transfer:${input.businessId}:${input.reference}`"
    );
    expect(transferFn).toContain("if (eventResult.duplicate) return");
  });

  it("رقم الإذن إجباري — من غيره مفيش منع تكرار", () => {
    expect(transferFn).toContain("التحويل يتطلب رقم إذن");
    const i = routers.indexOf("    stockTransfer: permissionProcedure");
    expect(routers.slice(i, routers.indexOf(".mutation(", i))).toContain(
      "reference: z.string().min(1).max(100)"
    );
  });

  it("🔑 الواجهة بتقول للمستخدم لما الإذن يتكرر بدل ما تدّعي نجاح", () => {
    expect(page).toContain("r.duplicate");
    expect(page).toContain("اتسجّل قبل كده");
  });
});

describe("التحقق", () => {
  it("🔑 نفس المخزن مرفوض على الخدمة وعلى الشاشة", () => {
    expect(transferFn).toContain("input.fromWarehouseId === input.toWarehouseId");
    expect(page).toContain("مكان الإرسال والاستلام لازم يكونوا مختلفين");
  });

  it("الشاشة بتشيل مكان الإرسال من قائمة الاستلام أصلاً", () => {
    expect(page).toContain('wh.filter(w => String(w.id) !== fromWarehouseId)');
  });

  it("كمية صحيحة موجبة", () => {
    expect(transferFn).toContain("!Number.isInteger(line.quantity) || line.quantity <= 0");
  });

  it("النوع لازم يكون تابع للصنف", () => {
    expect(page).toContain("النوع ده مش تابع للصنف المختار");
  });

  it("سبب التحويل إجباري — العهدة من غير سبب مالهاش معنى", () => {
    expect(page).toContain("سبب التحويل مطلوب");
    const i = routers.indexOf("    stockTransfer: permissionProcedure");
    expect(routers.slice(i, routers.indexOf(".mutation(", i))).toContain(
      "reason: z.string().min(1).max(500)"
    );
  });
});

describe("الصلاحية والواجهة", () => {
  it("manage مش approve — نقل عهدة داخلي مش قرار مالي", () => {
    expect(routers).toContain(
      'stockTransfer: permissionProcedure("inventory_costing.manage")'
    );
  });

  it("عربي RTL وأصناف متعددة", () => {
    expect(page).toContain('dir="rtl"');
    expect(page).toContain("صنف جديد");
    expect(page).toContain("lines.map((l, i)");
  });

  it("موبايل: الشبكة بتنزل عمود واحد", () => {
    expect(page).toContain("grid-cols-1 gap-2 sm:grid-cols-3");
  });
});
