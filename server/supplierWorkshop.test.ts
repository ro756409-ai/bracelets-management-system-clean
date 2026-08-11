import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  buildStatement,
  MOVEMENT_SIGN,
  signedAmount,
  summariseStatement,
  type SupplierMovement,
} from "../shared/supplierLedger";

/**
 * صفحة الورشة — التلات أرقام، الشغل المستلم، والإلغاء بحركة عكسية.
 *
 * الأرقام كلها من نفس المحرّك اللي كان موجود؛ الاختبارات دي بتثبّت إن الشاشة **بتعرض**
 * منه ومابتحسبش لوحدها، وإن الإلغاء بيرجّع الرصيد من غير ما يمسح سطر.
 */

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

const at = (day: number) => new Date(2026, 7, day, 12, 0, 0);
let nextId = 1;
function movement(
  type: SupplierMovement["type"],
  amount: number,
  day: number
): SupplierMovement {
  return {
    id: nextId++,
    type,
    occurredAt: at(day),
    amount,
    reference: null,
    description: "",
    createdByName: null,
    createdAt: null,
  };
}

// ==================== ١ · التلات أرقام ====================

describe("🔑 التلات أرقام اللي فوق الصفحة", () => {
  it("مثال التاجر بالحرف: سلّمني ١٠٠٬٠٠٠ · حوّلت ٦٥٬٠٠٠ · الباقي ٣٥٬٠٠٠", () => {
    const totals = summariseStatement(
      buildStatement([
        movement("goods_received", 100000, 1),
        movement("payment", 65000, 2),
      ])
    );
    expect(totals.goodsReceived).toBe(100000);
    expect(totals.paid).toBe(65000);
    expect(totals.balance).toBe(35000);
  });

  it("🔑 الباقي بياخد المرتجعات وإعادة التشطيب والتسويات — مش الفرق البسيط", () => {
    const totals = summariseStatement(
      buildStatement([
        movement("goods_received", 100000, 1),
        movement("rework_fee", 4000, 2),
        movement("payment", 65000, 3),
        movement("return_credit", 6000, 4),
        movement("adjustment", -1000, 5),
      ])
    );
    // 100000 + 4000 − 65000 − 6000 − 1000
    expect(totals.balance).toBe(32000);
    // والفرق البسيط كان هيقول 35000 — الفرق ده هو اللي الكارت لازم يقوله صح.
    expect(totals.goodsReceived - totals.paid).toBe(35000);
  });

  it("🔑 الرصيد العكسي بيتعرض كـ«ليك عند الورشة» مش برقم سالب", () => {
    const totals = summariseStatement(
      buildStatement([
        movement("goods_received", 10000, 1),
        movement("payment", 15000, 2),
      ])
    );
    expect(totals.balance).toBe(-5000);
    const page = fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8");
    expect(page).toContain('balance >= 0 ? "المتبقي للورشة" : "ليك عند الورشة"');
    // الرقم المعروض مطلق — السالب في الجملة مش في الخانة.
    expect(page).toContain("formatMoney(Math.abs(balance))");
  });

  it("🔑 تلات كروت بس فوق — مش ستة", () => {
    const page = codeOnly(fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8"));
    const statement = page.slice(page.indexOf("function SupplierStatement("));
    const header = statement.slice(0, statement.indexOf("<SupplierPaymentDrawer"));
    expect((header.match(/<Kpi\b/g) ?? []).length).toBe(3);
    for (const label of ["الورشة سلمتني", "حولت للورشة"]) {
      expect(header, label).toContain(label);
    }
    // المرتجعات والتشطيب مابقوش كروت رئيسية — الفحص على **عناوين** الكروت، مش على
    // ظهور الكلمة في أي مكان: الكارت التالت بيذكرهم في سطر التفسير بتاعه وده مقصود.
    const labels = [...header.matchAll(/label=\{?"?([^"}\n]+)"?\}?/g)].map(m => m[1]);
    for (const gone of ["الرصيد الافتتاحي", "إجمالي المرتجعات", "إعادة التشطيب", "الرصيد الحالي"]) {
      expect(labels, gone).not.toContain(gone);
    }
    expect(page).toContain("مرتجعات · إعادة تشطيب · تسويات");
  });
});

// ==================== ٢ · الشغل المستلم ====================

describe("🔑 جدول «الشغل اللي استلمته من الورشة»", () => {
  const page = fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8");

  it("الأعمدة اللي طلبها كلها موجودة", () => {
    for (const column of [
      "التاريخ",
      "بيان الشغل",
      "الصنف",
      "النوع / الحفر",
      "الكمية",
      "سعر القطعة",
      "إجمالي الاستلام",
      "ملاحظات",
      "الإجراءات",
    ]) {
      expect(page, column).toContain(column);
    }
    expect(page).toContain("إجمالي الشغل المستلم");
  });

  it("🔑 الإجمالي تحت بيجمع المعتمد بس — عشان يساوي الكارت فوق", () => {
    const body = page.slice(page.indexOf("const approvedTotal"));
    expect(body.slice(0, 200)).toContain("row.countsInBalance");
  });

  it("🔑 الاستلام متعدد الأصناف بيتفتح — مابيتفردش في الجدول", () => {
    expect(page).toContain("row.items.length === 1 ? row.items[0] : null");
    expect(page).toContain("أصناف ·");
  });

  it("🔑 مفيش جدول بيانات جديد — القراءة من purchase_receipts", () => {
    const service = codeOnly(fs.readFileSync("server/supplierLedger.service.ts", "utf-8"));
    const fn = service.slice(service.indexOf("export async function listSupplierReceipts"));
    expect(fn).toContain(".from(purchaseReceipts)");
    expect(fn).toContain(".from(purchaseReceiptItems)");
    expect(fn).not.toContain("insert(");
    const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(schema).not.toContain("workshopReceipts");
    expect(schema).not.toContain("supplierReceipts");
  });
});

// ==================== ٣ · الإلغاء = حركة عكسية ====================

describe("🔑 الإلغاء بيرجّع الرصيد ومابيمسحش التاريخ", () => {
  it("🔑 عكس الدفعة بيرجّع الرصيد لمكانه بالظبط", () => {
    const before = summariseStatement(
      buildStatement([
        movement("goods_received", 100000, 1),
        movement("payment", 65000, 2),
      ])
    );
    expect(before.balance).toBe(35000);

    // العكسية بتتسجّل كـ`adjustment` بالإشارة المعاكسة — نفس اللي الخدمة بتعمله.
    const after = summariseStatement(
      buildStatement([
        movement("goods_received", 100000, 1),
        movement("payment", 65000, 2),
        movement("adjustment", +65000, 3),
      ])
    );
    expect(after.balance).toBe(100000);
    // والسطر الأصلي لسه موجود — التاريخ المالي مااتمسحش.
    expect(after.movementCount).toBe(3);
    expect(after.paid).toBe(65000);
  });

  it("🔑 عكس المرتجع وعكس رسم التشطيب بيرجّعوا الرصيد كمان", () => {
    const base = [movement("goods_received", 50000, 1)];
    const withReturn = summariseStatement(
      buildStatement([...base, movement("return_credit", 8000, 2)])
    );
    expect(withReturn.balance).toBe(42000);
    const reversed = summariseStatement(
      buildStatement([
        ...base,
        movement("return_credit", 8000, 2),
        movement("adjustment", +8000, 3),
      ])
    );
    expect(reversed.balance).toBe(50000);

    const withRework = summariseStatement(
      buildStatement([...base, movement("rework_fee", 3000, 2)])
    );
    expect(withRework.balance).toBe(53000);
    const reworkReversed = summariseStatement(
      buildStatement([
        ...base,
        movement("rework_fee", 3000, 2),
        movement("adjustment", -3000, 3),
      ])
    );
    expect(reworkReversed.balance).toBe(50000);
  });

  it("🔑 العكسية لازم تكون adjustment — أي نوع تاني إشارته مقفولة", () => {
    // دفعة بمبلغ سالب بتفضل تنقّص، فمش هتلغي حاجة.
    expect(signedAmount({ type: "payment", amount: -65000 })).toBe(-65000);
    // التسوية هي النوع الوحيد اللي الاتجاه فيه جاي مع الرقم.
    expect(MOVEMENT_SIGN.adjustment).toBe(0);
    expect(signedAmount({ type: "adjustment", amount: +65000 })).toBe(65000);
  });

  it("🔑 والخدمة بتسجّل عكسية مربوطة بالأصل — مش DELETE", () => {
    const service = codeOnly(fs.readFileSync("server/supplierLedger.service.ts", "utf-8"));
    const fn = service.slice(
      service.indexOf("export async function reverseSupplierMovement"),
      service.indexOf("export async function listSupplierReceipts")
    );
    expect(fn).toContain('eventType: "supplier.adjustment"');
    expect(fn).toContain("reversesEventId: original.id");
    expect(fn).toContain("const reversalAmount = -originalSigned");
    // مفيش حذف من قاعدة البيانات في المسار ده.
    expect(fn).not.toContain(".delete(");
    // السبب مطلوب.
    expect(fn).toContain("إلغاء الحركة يتطلب سببًا موثقًا");
    // والدفعة بس هي اللي بترجّع فلوس للخزنة.
    expect(fn).toContain('movementType === "payment"');
    expect(fn).toContain('direction: "in"');
  });

  it("🔑 والدوسة التانية على «إلغاء» مابتلغيش مرتين", () => {
    const service = codeOnly(fs.readFileSync("server/supplierLedger.service.ts", "utf-8"));
    const fn = service.slice(service.indexOf("export async function reverseSupplierMovement"));
    expect(fn).toContain("reversal:${original.id}");
    expect(fn).toContain("الحركة دي اتلغت خلاص");
  });

  it("🔑 إلغاء الاستلام مساره التاني — لأنه بيمس المخزون كمان", () => {
    const page = codeOnly(fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8"));
    expect(page).toContain("purchaseReceiptVoid");
    // ومسار الاستلام نفسه بيفرّق بين المسودة والمعتمد.
    const inventory = codeOnly(fs.readFileSync("server/inventoryV2.service.ts", "utf-8"));
    const fn = inventory.slice(inventory.indexOf("export async function voidPurchaseReceipt"));
    expect(fn).toContain('if (receipt.status !== "approved")');
    expect(fn).toContain('eventType: "inventory.purchase_reversed"');
  });

  it("🔑 التأكيد بيقول للتاجر إن دي حركة عكسية مش حذف", () => {
    const page = fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8");
    expect(page).toContain("هيعمل حركة عكسية ويحافظ على السجل");
    expect(page).toContain("لسه مسودة ومأثرش على أي حساب");
  });
});

// ==================== ٤ · درج الدفعة ====================

describe("🔑 دفعة الورشة — درج صغير على نفس المسار", () => {
  const drawer = fs.readFileSync(
    "client/src/components/accounting/SupplierPaymentDrawer.tsx",
    "utf-8"
  );

  it("الحقول الخمسة بس — والمصنع معروف من الصفحة", () => {
    for (const field of ["التاريخ", "المبلغ", "الفلوس هتخرج من", "رقم المرجع", "ملاحظة"]) {
      expect(drawer, field).toContain(field);
    }
    expect(drawer).toContain("supplierKey");
    // مفيش قايمة اختيار مصنع جوه الدرج.
    expect(codeOnly(drawer)).not.toContain("اختار المصنع");
  });

  it("🔑 نفس مسار الدفع — مفيش مسار تاني ومفيش مصروف", () => {
    expect(drawer).toContain("trpc.suppliers.payment.useMutation");
    expect(codeOnly(drawer)).not.toContain("expense");

    const service = codeOnly(fs.readFileSync("server/supplierLedger.service.ts", "utf-8"));
    const fn = service.slice(
      service.indexOf("export async function recordSupplierPayment"),
      service.indexOf("export async function recordSupplierReturnCredit")
    );
    // حركة خزنة واحدة خارجة، ومفيش لمس لجداول المصروفات.
    expect((fn.match(/addTreasuryTransactionInTransaction/g) ?? []).length).toBe(1);
    expect(fn).toContain('direction: "out"');
    expect(fn).not.toContain("expenses");
    expect(fn).not.toContain("expensePayments");
  });

  it("🔑 والدرج بيقفل ويحدّث الشاشة بعد الحفظ", () => {
    expect(drawer).toContain("onClose();");
    expect(drawer).toContain("await onSaved();");
    const page = fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8");
    const refresh = page.slice(page.indexOf("const refresh = async () =>"));
    expect(refresh.slice(0, 500)).toContain("suppliers.statement.invalidate");
    expect(refresh.slice(0, 500)).toContain("suppliers.receipts.invalidate");
    expect(refresh.slice(0, 500)).toContain("treasuryHistory.invalidate");
  });

  it("🔑 والفورم الكبير مابقاش ثابت في الصفحة", () => {
    const page = codeOnly(fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8"));
    const statement = page.slice(
      page.indexOf("function SupplierStatement("),
      page.indexOf("function MovementRow(")
    );
    // `SupplierActions` (الفورم الكبير) بقى جوه <details> مطويّة.
    const details = statement.indexOf("مرتجعات · إعادة تشطيب · تسويات");
    expect(details).toBeGreaterThan(-1);
    expect(statement.indexOf("<SupplierActions")).toBeGreaterThan(details);
  });
});

// ==================== ٥ · السجل ====================

describe("🔑 سجل الإلغاء بالنظام الموجود", () => {
  it("العكسية بتتسجّل كحدث فيه المنفّذ والوقت والسبب والربط بالأصل", () => {
    const service = codeOnly(fs.readFileSync("server/supplierLedger.service.ts", "utf-8"));
    const fn = service.slice(
      service.indexOf("export async function reverseSupplierMovement"),
      service.indexOf("export async function listSupplierReceipts")
    );
    expect(fn).toContain("actor: input.actor");
    expect(fn).toContain("occurredAt: new Date()");
    expect(fn).toContain("input.reason.trim()");
    expect(fn).toContain("reversesEventId");
    // مفيش جدول سجل جديد.
    const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(schema).not.toContain("supplierAuditLogs");
    expect(schema).not.toContain("ledgerAuditLogs");
  });
});
