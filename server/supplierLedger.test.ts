import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حساب المصنع الجاري — الحواجز.
 *
 * حساب الرصيد نفسه متغطّى في `shared/supplierLedger.test.ts` (٣٠ اختبار بيشغّلوا
 * الدوال فعلًا). الملف ده بيقفل القرارات المعمارية اللي لو اتكسرت الأرقام تبقى غلط من
 * غير ما اختبار حسابي يلاحظ: مفيش جدول أرصدة، الدفعة مش مصروف، المسودة مالهاش أثر،
 * والأسماء القديمة مابتتدمجش لوحدها.
 */

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const read = (f: string) => codeOnly(fs.readFileSync(f, "utf-8"));

const service = read("server/supplierLedger.service.ts");
const routers = read("server/routers.ts");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
const page = fs.readFileSync("client/src/pages/SupplierStatements.tsx", "utf-8");
const control = fs.readFileSync(
  "client/src/pages/accounting/ControlCenter.tsx",
  "utf-8"
);

const fn = (name: string) => {
  const at = service.indexOf(`export async function ${name}`);
  expect(at, name).toBeGreaterThan(-1);
  const next = service.indexOf("\nexport ", at + 1);
  return service.slice(at, next > at ? next : undefined);
};

// ───────────────── مفيش محرّك تاني ─────────────────

describe("🔑 الكشف مشتق — مفيش رصيد متخزّن", () => {
  it("🔑 مفيش جدول أرصدة موردين اتضاف", () => {
    for (const table of [
      "supplier_balances",
      "supplier_ledger",
      "supplier_statements",
      "supplier_movements",
    ]) {
      expect(schema, table).not.toContain(`mysqlTable("${table}"`);
    }
  });

  it("🔑 ولا حتى جدول موردين — المصنع صف في جدول الإعدادات", () => {
    expect(schema).not.toContain('mysqlTable("suppliers"');
    expect(schema).not.toContain('mysqlTable("supplier_payments"');
    expect(service).toContain('SUPPLIER_NAMESPACE = "supplier"');
    expect(service).toContain("businessConfigurationValues");
  });

  it("🔑 والخدمة مابتكتبش أي رصيد — بتقرا وتحسب", () => {
    // لو فيه عمود رصيد بيتحدّث، أي حدث بينجح وتحديثه بيفشل بيسيب رقمين مختلفين للأبد.
    expect(service).not.toContain("balanceAfter:");
    expect(service).not.toContain("currentBalance");
  });

  it("🔑 ومفيش migration جديدة", () => {
    const sql = fs.readdirSync("drizzle").filter(f => f.endsWith(".sql"));
    expect(sql.filter(f => /supplier/i.test(f))).toEqual([
      "0034_supplier_ledger.sql",
    ]);
    // و0034 لسه مربوطتش — الحاجز بتاعها لسه شغّال.
    expect(fs.existsSync("server/preDeploy0034.test.ts")).toBe(true);
  });
});

// ───────────────── ١ · ٢ · ٥ · استلام البضاعة ─────────────────

describe("🔑 ١·٢·٥ · الاستلام من الأحداث الموجودة", () => {
  const collect = service.slice(service.indexOf("async function collectMovements"));

  it("🔑 بيقرا الأحداث اللي كانت موجودة أصلاً — مفيش حدث دَيْن تاني", () => {
    expect(collect).toContain('"inventory.purchase_received"');
    expect(collect).toContain('"inventory.purchase_reversed"');
    expect(service).not.toContain("supplier.goods_received");
  });

  it("🔑 المسودة مالهاش أثر — لأن مالهاش حدث اعتماد أصلاً", () => {
    // الكشف بيتبني من الأحداث. `approvePurchaseReceipt` هو اللي بيعمل الحدث،
    // فالمسودة مستحيل تظهر — مش لأننا فلترناها، لأنها مش موجودة.
    const inventory = read("server/inventoryV2.service.ts");
    expect(inventory).toContain('idempotencyKey: `purchase-receipt:${receipt.id}:approved`');
    expect(collect).not.toContain('status, "draft"');
  });

  it("🔑 والقيمة من الإذن — الحدث بيقول «حصل»، الإذن بيقول «بكام»", () => {
    expect(collect).toContain("purchaseReceipts");
    expect(collect).toContain("receipt.totalAmount");
  });

  it("🔑 والإلغاء نوع حركة عكسية مش حذف", () => {
    expect(collect).toContain('"receipt_reversed"');
    expect(service).not.toContain(".delete(");
  });
});

// ───────────────── ٣ · ٤ · ١٤ · ١٥ · ١٧ · الدفعة ─────────────────

describe("🔑 ٣·١٤·١٥ · الدفعة مش مصروف", () => {
  const payment = fn("recordSupplierPayment");

  it("🔑 مابتلمسش expenses ولا expense_payments خالص", () => {
    // لو مرّت على `expenses` كان نفس الجنيه هيتحسب مرتين: مرة في تكلفة البضاعة
    // ومرة كمصروف تشغيلي.
    for (const forbidden of ["expenses", "expensePayments", "recordSimpleExpense", "payExpense"]) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 ومابتغيّرش تكلفة البضاعة", () => {
    for (const forbidden of ["inventoryBalances", "applyStockIn", "applyStockOut", "cogs"]) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 بتنزّل حركة خزنة واحدة خارجة", () => {
    expect(payment).toContain("addTreasuryTransactionInTransaction");
    expect(payment).toContain('direction: "out"');
    expect((payment.match(/addTreasuryTransactionInTransaction/g) ?? []).length).toBe(1);
  });

  it("🔑 ١٧ · الحدث وحركة الخزنة في ترانزاكشن واحدة", () => {
    const record = service.slice(service.indexOf("async function recordSupplierEvent"));
    expect(record).toContain("db.transaction(async tx =>");
    expect(record).toContain("createBusinessEventInTransaction(tx,");
    expect(record).toContain("input.alsoInTransaction?.(tx,");
    expect(payment).toContain("alsoInTransaction:");
  });

  it("🔑 ٤ · الدفعة المكررة بتترفض قبل ما الخزنة تتحرّك", () => {
    const record = service.slice(service.indexOf("async function recordSupplierEvent"));
    const dup = record.indexOf("if (event.duplicate)");
    // موضع **النداء**، مش تعريف الوسيط في التوقيع فوق.
    const treasury = record.indexOf("input.alsoInTransaction?.(");
    expect(dup).toBeGreaterThan(-1);
    expect(treasury).toBeGreaterThan(dup);
    expect(record).toContain("الحركة دي متسجّلة خلاص");
  });

  it("والمفتاح بيفرّق بين دفعتين حقيقيتين ودوسة مكررة", () => {
    // نفس اليوم ونفس المبلغ ونفس المرجع = تكرار. مرجع مختلف = دفعتين.
    expect(payment).toContain("payment:${dayKey}:${money(input.amount)}:${input.reference ?? \"\"}");
  });
});

// ───────────────── ٦ · ٧ · ٨ · ٩ · المرتجعات ─────────────────

describe("🔑 ٦·٧·٨·٩ · المرتجع والتشطيب", () => {
  it("٦ · مرتجع الخصم بيقلّل الحساب", () => {
    expect(fn("recordSupplierReturnCredit")).toContain('"supplier.return_credit"');
  });

  it("🔑 ٧·٩ · تحويل البضاعة للمصنع مالوش أي أثر على الحساب", () => {
    // الحماية هنا **إن المسار مش موجود**: `transferStock` مش بيعمل أي حدث
    // `supplier.*`، والكشف مابيقراش أحداث المخزون غير الاستلام والإلغاء.
    const inventory = read("server/inventoryV2.service.ts");
    const transfer = inventory.slice(inventory.indexOf("export async function transferStock"));
    expect(transfer).not.toContain("supplier.");
    const collect = service.slice(service.indexOf("async function collectMovements"));
    expect(collect).not.toContain("inventory.stock_transfer");
  });

  it("🔑 ٨ · رسم التشطيب بيزوّد الحساب — لما يستحق، بحركة صريحة", () => {
    const rework = fn("recordReworkFee");
    expect(rework).toContain('"supplier.rework_fee"');
    // مش مربوط بحركة المخزون: التاجر هو اللي بيقول الرسم استحق.
    expect(rework).not.toContain("transferStock");
  });

  it("🔑 والمصنع ليه وضع افتراضي وينفع يتغيّر على الحركة", () => {
    expect(service).toContain('returnMode === "rework" ? "rework" : "credit"');
    expect(page).toContain("ده الافتراضي بس — تقدر تغيّره على كل مرتجع لوحده");
  });
});

// ───────────────── ١٠ · الرصيد الافتتاحي ─────────────────

describe("🔑 ١٠ · الرصيد الافتتاحي", () => {
  const opening = fn("recordOpeningBalance");

  it("🔑 حدث — مش بضاعة وهمية ولا فلوس وهمية", () => {
    expect(opening).toContain('"supplier.opening_balance"');
    expect(opening).not.toContain("addTreasuryTransaction");
    expect(opening).not.toContain("inventory");
  });

  it("🔑 مرة واحدة لكل مصنع — المفتاح ثابت", () => {
    expect(opening).toContain('idempotencySuffix: "opening"');
  });

  it("🔑 وللمالك بس", () => {
    const block = routers.slice(
      routers.indexOf("openingBalance: ownerProcedure"),
      routers.indexOf("adjustment: ownerProcedure")
    );
    expect(block).toContain("ownerProcedure");
    expect(routers).toContain("adjustment: ownerProcedure");
  });

  it("🔑 والتسوية لازم يكون ليها سبب", () => {
    expect(fn("recordSupplierAdjustment")).toContain(
      "سبب التسوية مطلوب"
    );
  });
});

// ───────────────── ١١ · ١٨ · التاريخ والتاريخ الرجعي ─────────────────

describe("🔑 ١١·١٨ · التاريخ الرجعي والسجل", () => {
  it("🔑 الرصيد بيتحسب وقت القراءة — مفيش رقم بيبقى قديم", () => {
    expect(service).toContain("buildStatement(movements)");
    const statement = fn("getSupplierStatement");
    expect(statement).toContain("const full = buildStatement(movements)");
  });

  it("🔑 والفلتر بيتطبّق **بعد** الحساب مش قبله", () => {
    // لو الفلتر اتطبّق الأول، أول سطر معروض كان هيبدأ من صفر وهو مش صفر.
    const statement = fn("getSupplierStatement");
    const built = statement.indexOf("buildStatement(movements)");
    const filtered = statement.indexOf("full.filter(");
    expect(built).toBeGreaterThan(-1);
    expect(filtered).toBeGreaterThan(built);
  });

  it("🔑 ١٨ · مفيش حذف لأي حركة — العكس بحركة", () => {
    expect(service).not.toContain("delete(businessEvents)");
    expect(service).not.toContain(".delete(");
  });

  it("ومين عملها وإمتى محفوظين", () => {
    const collect = service.slice(service.indexOf("async function collectMovements"));
    expect(collect).toContain("createdByName: event.createdByName");
    expect(collect).toContain("createdAt: event.createdAt");
  });
});

// ───────────────── ١٢ · ١٣ · الفصل بين المصانع ─────────────────

describe("🔑 ١٢·١٣ · المصانع مابتختلطش", () => {
  const collect = service.slice(service.indexOf("async function collectMovements"));

  it("🔑 ١٢ · كل حركة بتتفلتر على مفتاح المصنع", () => {
    expect(collect).toContain("if (payload.supplierKey !== supplierKey) continue");
    expect(collect).toContain("if (key !== supplierKey) continue");
  });

  it("🔑 ١٣ · مفيش أي مطابقة تقريبية للأسماء القديمة", () => {
    for (const fuzzy of ["levenshtein", "similarity", "fuzzy", "startsWith", "includes(name"]) {
      expect(collect, fuzzy).not.toContain(fuzzy);
    }
    // الربط الصريح الأول، وبعدين تطابق **كامل** للاسم — ودي هوية مش تخمين.
    expect(collect).toContain("nameMap.get(name) ?? canonicalNames.get(name)");
  });

  it("🔑 والاسم غير المربوط مابيدخلش أي كشف", () => {
    // `nameMap.get` بترجّع undefined، و`canonicalNames.get` كمان، فـ`key` بيبقى
    // undefined ومش هيساوي أي مفتاح مصنع.
    expect(collect).toContain("const key = nameMap.get(name) ?? canonicalNames.get(name);");
    expect(collect).toContain("if (key !== supplierKey) continue;");
  });

  it("🔑 والربط قرار المالك — بيترفض لو المصنع مش موجود", () => {
    const map = fn("mapHistoricalSupplierName");
    expect(map).toContain("المصنع مش موجود");
    expect(map).not.toContain("createSupplier");
  });

  it("🔑 والشاشة بتقول صراحة إنها مش هتخمّن", () => {
    expect(page).toContain("مش هيخمّن");
    expect(page).toContain("الاسم اللي متربطش\n          مابيدخلش في أي كشف");
  });
});

// ───────────────── ١٦ · اللوحة ─────────────────

describe("🔑 ١٦ · اللوحة من نفس المحرّك", () => {
  it("🔑 بتنادي نفس دالة الملخّص — مفيش رصيد تاني", () => {
    const dashboard = fn("getSupplierDashboardTotals");
    expect(dashboard).toContain("getSupplierSummaries");
    expect(dashboard).toContain("summariseSuppliers");
  });

  it("🔑 والكروت التلاتة موجودة", () => {
    for (const label of [
      "إجمالي مستحق للمصانع",
      "إجمالي لينا عند المصانع",
      "صافي حساب الموردين",
    ]) {
      expect(control, label).toContain(label);
    }
    // جوه نداء اللوحة الواحد — مش نداء تاني. لو اتقروا من نداءين كانوا هيرجعوا من
    // لحظتين مختلفتين، والاختبار اللي بيقفل «نداء واحد للوحة» بيوقّع على ده.
    expect(control).toContain("d?.suppliers?.owedToFactories");
    const db = read("server/db.ts");
    expect(db).toContain("getSupplierDashboardTotals(ids)");
  });

  it("🔑 و`supplierDue` القديم ما اتغيّرش — مش مصدر الحقيقة للحساب الجاري", () => {
    // الاتنين بيقيسوا حاجتين مختلفتين: القديم على مستوى الفاتورة، والجديد حساب
    // جاري مفتوح. الخلط بينهم كان هيخلي رقم منهم يكدب.
    expect(control).toContain("مستحق للورشة");
    expect(service).not.toContain("paymentStatus");
  });
});

// ───────────────── اللغة والصلاحيات ─────────────────

describe("🔑 لغة التاجر", () => {
  it("🔑 مفيش مصطلحات محاسبة في اللي التاجر بيقراه", () => {
    // على النص العربي بس. المصطلحات الإنجليزية بتظهر في أسماء الدوال (`returnCredit`)
    // وهي مش بتوصل الشاشة — الفحص عليها كان بيوقّع الاختبار على حاجة سليمة.
    // وبدون التعليقات: الشرح اللي بيقول «مانستخدمش كلمة كذا» بيحتوي الكلمة نفسها.
    const visible = codeOnly(page);
    for (const jargon of ["مدين", "دائن", "قيد يومية", "أستاذ مساعد", "حـ/"]) {
      expect(visible, jargon).not.toContain(jargon);
    }
  });

  it("🔑 والرصيد بجملة مش برقم لوحده", () => {
    expect(page).toContain("describeBalance");
    const shared = read("shared/supplierLedger.ts");
    expect(shared).toContain("عليك للمصنع");
    expect(shared).toContain("ليك عند المصنع");
    expect(shared).toContain("الحساب متعادل");
  });

  it("الأعمدة اللي طلبها موجودة", () => {
    for (const column of [
      "التاريخ والوقت", "نوع الحركة", "المرجع", "البيان",
      "القيمة", "الرصيد قبل", "الرصيد بعد",
    ]) {
      expect(page, column).toContain(column);
    }
  });

  it("والفلاتر السريعة الخمسة", () => {
    for (const quick of ["اليوم", "هذا الأسبوع", "هذا الشهر", "الشهر الماضي", "الكل"]) {
      expect(page, quick).toContain(quick);
    }
    expect(page).toContain("بحث بالمرجع");
  });

  it("🔑 والقراءة على accounting.view والكتابة على accounting.manage", () => {
    const block = routers.slice(
      routers.indexOf("suppliers: router({"),
      routers.indexOf("payroll: router({")
    );
    expect(block).toContain('statement: permissionProcedure("accounting.view")');
    expect(block).toContain('payment: permissionProcedure("accounting.manage")');
  });
});

// ───────────────── الاستلام من نفس الصفحة ─────────────────

describe("🔑 استلام البضاعة من كشف المصنع", () => {
  const receipt = fs.readFileSync("client/src/pages/GoodsReceipt.tsx", "utf-8");

  it("🔑 نفس المكوّن — مفيش فورم تاني للمخزون", () => {
    // فورم مبسّط هنا كان هيسجّل الحساب من غير مخزون: يبقى عليك دَيْن لبضاعة النظام
    // مايعرفهاش. وكان هيفقد السادة/المحفور والأصناف المتعددة كمان.
    expect(page).toContain('import GoodsReceipt from "./GoodsReceipt"');
    expect(page).toContain("<GoodsReceipt");
    expect(page).not.toContain("purchaseReceiptCreate");
  });

  it("🔑 والمصنع مقفول — الاسم مابيتكتبش تاني", () => {
    // أي حرف مختلف كان هيعمل مصنع تالت في الكشف.
    expect(page).toContain("lockedSupplierName={data?.supplier?.name}");
    expect(codeOnly(receipt)).toContain("disabled={embedded}");
  });

  it("🔑 والصفحة الأصلية لسه شغّالة بنفس المكوّن", () => {
    const app = fs.readFileSync("client/src/App.tsx", "utf-8");
    expect(app).toContain("<GoodsReceipt />");
    expect(codeOnly(receipt)).toContain("const embedded = embeddedBusinessId != null");
  });

  it("🔑 وبيقول إن الحفظ لوحده مايحرّكش الحساب", () => {
    // الاعتماد هو اللي بيعمل الحدث اللي الكشف بيقرا منه.
    expect(page).toContain("الحفظ لوحده مايحرّكش الحساب");
    expect(page).toContain("<strong>الاعتماد</strong>");
  });
});
