/**
 * المرحلة 7C — حارس نصّي للمخزون/استلام البضاعة/الجرد: الاستعلامات والـmutations الأساسية كما كانت قبل
 * تغيير العرض (commit 4877628)، لا مسار مخزون جديد، لا كتابة مزدوجة، الرصيد لا يتغيّر إلا من الـmutations
 * الحالية، والحوارات القديمة باقية. كُتب قبل تعديل العرض ثم أُكملت أقسام «بعد» مع التنفيذ.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (p: string) => strip(readFileSync(path.join(root, p), "utf8"));
const hooks = (src: string) => [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

const inventory = read("pages/Inventory.tsx");
const receipt = read("pages/GoodsReceipt.tsx");
const stocktakePage = read("pages/Stocktake.tsx");
const accStocktake = read("pages/accountant/AccStocktake.tsx");
const routers = readFileSync(path.resolve(__dirname, "../../../server/routers.ts"), "utf8");

/** صفحة المخزون قبل 7C: 4 استعلامات + 13 mutation بهذا الترتيب */
const INVENTORY_BEFORE = [
  "trpc.products.list.useQuery", "trpc.products.lowStock.useQuery", "trpc.products.movements.useQuery", "trpc.variants.all.useQuery",
  "trpc.products.addMovement.useMutation", "trpc.products.update.useMutation", "trpc.variants.addMovement.useMutation",
  "trpc.variants.create.useMutation", "trpc.variants.update.useMutation", "trpc.variants.addToProduct.useMutation",
  "trpc.variants.delete.useMutation", "trpc.variants.update.useMutation", "trpc.products.update.useMutation",
  "trpc.products.create.useMutation", "trpc.products.createWithVariants.useMutation", "trpc.products.update.useMutation",
  "trpc.products.update.useMutation",
];
/** مُضاف في 7C (قراءة فقط): آخر جرد من endpoint موجود — لبطاقة الملخص عند اختيار نشاط واحد وبصلاحية العرض */
const INVENTORY_ADDED = ["trpc.accountingV2.stocktakeList.useQuery"];

/** استلام البضاعة قبل 7C: 5 استعلامات + 5 mutations */
const RECEIPT_BEFORE = [
  "trpc.businesses.warehouses.useQuery", "trpc.businesses.createWarehouse.useMutation", "trpc.products.list.useQuery",
  "trpc.variants.all.useQuery", "trpc.accountingV2.inventoryControlData.useQuery",
  "trpc.accountingV2.purchaseReceiptCreate.useMutation", "trpc.accountingV2.purchaseReceiptSubmit.useMutation",
  "trpc.accountingV2.purchaseReceiptApprove.useMutation", "trpc.accountingV2.purchaseReceiptVoid.useMutation",
];

/** الجرد (AccStocktake — مكوّن المحاسب، لم يُمس): 4 استعلامات + 4 mutations */
const STOCKTAKE_ENDPOINTS = [
  "trpc.businesses.warehouses.useQuery", "trpc.accountingV2.stocktakeList.useQuery", "trpc.accountingV2.stocktakeCreate.useMutation",
  "trpc.accountingV2.stocktakeGet.useQuery", "trpc.products.list.useQuery", "trpc.variants.all.useQuery",
  "trpc.accountingV2.stocktakeLineUpdate.useMutation", "trpc.accountingV2.stocktakeSubmit.useMutation", "trpc.accountingV2.stocktakeApprove.useMutation",
];

describe("📦 Inventory — Queries/Mutations قبل ⊆ بعد", () => {
  const used = hooks(inventory);
  it("كل hooks ما قبل 7C باقية بنفس الترتيب النسبي (17 hook)", () => {
    const idx: number[] = []; let from = 0;
    for (const h of INVENTORY_BEFORE) { const i = used.indexOf(h, from); expect(i, h).toBeGreaterThanOrEqual(0); idx.push(i); from = i + 1; }
  });
  it("لا hook غير المعلن: قبل + stocktakeList (قراءة) فقط", () => {
    expect([...used].sort()).toEqual([...INVENTORY_BEFORE, ...INVENTORY_ADDED].sort());
  });
  it("الرصيد لا يتغيّر إلا من الـmutations الحالية — لا مسار جديد ولا كتابة مزدوجة", () => {
    expect(inventory).not.toMatch(/trpc\.(inventory|stock)\.[a-zA-Z]+\.useMutation/);
    expect(inventory).toContain("addMovementMutation.mutate({");
    expect(inventory).toContain("variantMovementMutation.mutate({");
    expect(readFileSync(path.join(root, "pages/Inventory.tsx"), "utf8")).toContain("Stock is intentionally NOT sent — edit dialog never overwrites currentStock directly.");
    // الحالة من المصدر المشترك نفسه (لا معادلة جديدة)
    expect(inventory).toContain("getStockStatus(");
    expect(inventory).toContain('from "@shared/inventoryCalculations"');
  });
  it("الحوارات التسعة باقية (حركة منتج/نوع، السجل، نماذج المنتج/النوع، السعر، المصفوفة، الأرشفة ×2)", () => {
    expect((inventory.match(/<Dialog\b[\s\S]*?open=\{/g) ?? []).length).toBe(9);
    for (const s of ["showMovementDialog", "showVariantMovementDialog", "showHistory", "showProductFormDialog", "showVariantFormDialog", "showPriceDialog", "showAddMatrixDialog", "archiveProductTarget", "deleteVariantTarget"]) expect(inventory, s).toContain(s);
  });
});

describe("🧾 GoodsReceipt — Queries/Mutations قبل = بعد", () => {
  it("نفس 10 hooks بالترتيب نفسه؛ لا hook آخر", () => {
    expect(hooks(receipt)).toEqual(RECEIPT_BEFORE);
  });
  it("التحقق والتحويل كما هما: صفر/سالب/غير صحيح مرفوض، السطور الصفرية لا تُرسل، الحفظ من purchaseReceiptCreate فقط", () => {
    for (const s of [
      'if (plain === 0 && engraved === 0) next[`l${i}-qty`] = "اكتب كمية سادة أو محفور";',
      'if (plain < 0 || engraved < 0) next[`l${i}-qty`] = "الكمية ماتكونش بالسالب";',
      "if (!Number.isInteger(plain) || !Number.isInteger(engraved))",
      'if (engraved > 0 && !l.variantId) next[`l${i}-variant`] = "اختار نوع الحفر";',
      "if (plain > 0)", "if (engraved > 0)",
      "createMutation.mutate({", 'receiptType: "purchase",', "items: toItems(),",
    ]) expect(receipt, s).toContain(s);
    expect((receipt.match(/createMutation\.mutate\(/g) ?? []).length).toBe(1);
    // الاعتماد/الإلغاء خلف inventory_costing.approve كما كان
    expect(receipt).toContain('usePermission("inventory_costing.approve")');
    expect(receipt).toContain("canApprove");
  });
  it("السيرفر: الكمية موجبة صحيحة في purchaseReceiptCreate (لا تغيير backend)", () => {
    const i = routers.indexOf('purchaseReceiptCreate: permissionProcedure("inventory_costing.manage")');
    expect(i).toBeGreaterThan(0);
    expect(routers.slice(i, i + 1200)).toContain("quantity: z.number().int().positive()");
  });
});

describe("📋 Stocktake — نفس الـendpoints، لا نظام جرد موازٍ", () => {
  it("AccStocktake (المحاسب) لم يُمس: 9 hooks كما هي", () => {
    expect(hooks(accStocktake)).toEqual(STOCKTAKE_ENDPOINTS);
  });
  it("صفحة الجرد تعتمد على useBrandOptions (نطاق الجلسة) وبلا businessId ثابت", () => {
    expect(stocktakePage).toContain("useBrandOptions");
    expect(stocktakePage).not.toMatch(/businessId=\{[0-9]+\}/);
  });
  it("السيرفر: العدّ لا يحرّك الرصيد (stocktakeLineUpdate = countedQuantity فقط)؛ الاعتماد خلف inventory_costing.approve", () => {
    const i = routers.indexOf('stocktakeLineUpdate: permissionProcedure("inventory_costing.manage")');
    expect(routers.slice(i, i + 400)).toContain("countedQuantity: z.number().int().min(0)");
    expect(routers.slice(i, i + 400)).not.toContain("currentStock");
    expect(routers).toContain('stocktakeApprove: permissionProcedure("inventory_costing.approve")');
  });
});
