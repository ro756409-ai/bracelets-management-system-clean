import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import * as XLSX from "xlsx";
import { eq, inArray } from "drizzle-orm";
import { registerImportRoutes } from "./importExcel";
import { getDb, createEmployee, createProductWithVariants, getOrderItemsForOrders } from "./db";
import { businesses, employees, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "../shared/const";

/**
 * استيراد Easy Order end-to-end على MySQL عبر مسارات Express الحقيقية (supertest):
 * مالك نشاط الملابس يستورد الملف الحقيقي، إعادة الرفع = صفر جديد، data_entry ومالك نشاط
 * آخر مرفوضان، والمطابقة داخل كتالوج النشاط فقط.
 */
const REAL_PATH = "/Users/apple/Downloads/1790763367920093571-orders-2026-09-30.xlsx";
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const HAS_REAL = fs.existsSync(REAL_PATH);

const HEADERS = ["ID", "FullName", "Phone", "City", "Address", "Total Cost", "Product Name", "Variant", "Quantity", "SKU", "Item Price", "Order ID", "External Order ID"];
function buildXlsx(rows: Record<string, string>[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows.map(r => HEADERS.map(h => r[h] ?? ""))]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const row = (o: Partial<Record<string, string>> = {}): Record<string, string> => ({
  ID: "1", FullName: "عميل", Phone: "01012345678", City: "", Address: "الجيزة الهرم شارع 5", "Total Cost": "600",
  "Product Name": "بدلة اطفالي", Variant: "المقاس: من 6 ل 8 سنين اللون: آسود", Quantity: "1", SKU: "", "Item Price": "550", "Order ID": "syn-1", ...o,
});

describe.runIf(CAN)("🔑 استيراد Easy Order — DB", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[] };
  let ownerA = 0, entryA = 0, ownerB = 0, prodA = 0, prodB = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const app = express();
  app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use(cookieParser());
  registerImportRoutes(app);
  const ownerCookie = (employeeId: number) => `${COOKIE_NAME}=${jwt.sign({ employeeId }, process.env.JWT_SECRET as string)}`;
  const empCookie = (employeeId: number) => `employee_token=${jwt.sign({ employeeId }, process.env.JWT_SECRET as string)}`;
  const post = (path: string, cookie: string, buf: Buffer, businessId?: number) => {
    let r = request(app).post(path).set("Cookie", cookie).attach("file", buf, { filename: "orders.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    if (businessId != null) r = r.field("businessId", String(businessId));
    return r;
  };
  const ordersOf = async (bid: number) => (await getDb())!.select().from(orders).where(eq(orders.businessId, bid));

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("eo-a"); B = await createCoreTestFixture("eo-b");
    const variants = [];
    for (const [color, code] of [["أسود", "BLK"], ["بيج", "BEG"]] as const) for (const size of ["6", "8", "10", "12"]) variants.push({ color, size, sku: `AFK-${code}-${size}`, currentStock: 50, price: "550" });
    const a = await createProductWithVariants(A.businessId, { name: "بدلة اطفالي" }, variants.map(v => ({ ...v, sku: `${v.sku}-A-${tag}` })));
    // نشاط B: نفس المنتج لكن بلا مقاسات «بيج» — لإثبات المطابقة داخل الكتالوج فقط.
    const b = await createProductWithVariants(B.businessId, { name: "بدلة اطفالي" }, variants.filter(v => v.color === "أسود").map(v => ({ ...v, sku: `${v.sku}-B-${tag}` })));
    prodA = a.productId; prodB = b.productId; ids.productIds.push(prodA, prodB);
    ownerA = insId(await createEmployee({ name: "owner A", role: "admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `eo_oa_${tag}` } as any));
    entryA = insId(await createEmployee({ name: "entry A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `eo_ea_${tag}` } as any));
    ownerB = insId(await createEmployee({ name: "owner B", role: "admin", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `eo_ob_${tag}` } as any));
    ids.empIds.push(ownerA, entryA, ownerB);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    const os = [...(await ordersOf(A.businessId)), ...(await ordersOf(B.businessId))].map(o => o.id);
    if (os.length) { await d.delete(orderItems).where(inArray(orderItems.orderId, os)); await d.delete(orders).where(inArray(orders.id, os)); }
    if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔒 data_entry مرفوض (403)، ومالك نشاط B لا يستورد في نشاط A (403)، وبلا نشاط → 400", async () => {
    const buf = buildXlsx([row()]);
    expect((await post("/api/import/execute", empCookie(entryA), buf, A.businessId)).status).toBe(403);
    expect((await post("/api/import/execute", ownerCookie(ownerB), buf, A.businessId)).status).toBe(403);
    expect((await post("/api/import/execute", ownerCookie(ownerA), buf)).status).toBe(400);
    expect((await ordersOf(A.businessId)).length).toBe(0);
  });

  it("🔑 منتجان بـnewline → أوردر واحد ببندين، وΣ الكميات = كمية الأوردر؛ اختلاف العدد → مرفوض؛ عنوان غامض → مراجعة؛ هاتف غير صالح لا يُسقط الملف", async () => {
    const buf = buildXlsx([
      row({ ID: "1", "Order ID": "syn-1", "Product Name": "بدلة اطفالي\nبدلة اطفالي", Variant: "المقاس: من10 ل 12 سنه اللون: آسود\nالمقاس: من 6 ل 8 سنين اللون: بيج", Quantity: "1\n2", "Item Price": "550\n550" }),
      row({ ID: "2", "Order ID": "syn-2", "Product Name": "بدلة اطفالي\nبدلة اطفالي", Variant: "المقاس: من 6 ل 8 سنين اللون: آسود", Quantity: "1\n1\n1" }),
      row({ ID: "3", "Order ID": "syn-3", Address: "Maadi Street 77" }),
      row({ ID: "4", "Order ID": "syn-4", Phone: "10903863290" }),
      row({ ID: "5", "Order ID": "syn-5" }),
    ]);
    const pv = await post("/api/import/preview", ownerCookie(ownerA), buf, A.businessId);
    expect(pv.status).toBe(200);
    expect(pv.body.summary).toEqual({ new: 2, review: 2, existing: 0, rejected: 1 });
    expect(pv.body.preview.map((r: any) => r.status)).toEqual(["new", "rejected", "review", "review", "new"]);
    const ex = await post("/api/import/execute", ownerCookie(ownerA), buf, A.businessId);
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ imported: 4, imported_review: 2, already_existing: 0 });
    expect(ex.body.reports.find((r: any) => r.row === 3)).toMatchObject({ status: "rejected", orderId: "2" });
    expect(ex.body.reports.find((r: any) => r.row === 5)).toMatchObject({ status: "imported_review" });
    expect(ex.body.errors.some((e: string) => e.startsWith("الصف 5 — الأوردر 4 — رقم الهاتف غير صالف".replace("صالف", "صالح")))).toBe(true);
    const os = await ordersOf(A.businessId);
    expect(os.length).toBe(4);
    const multi = os.find(o => o.externalOrderId === "syn-1")!;
    expect(multi.quantity).toBe(3);
    const items = (await getOrderItemsForOrders([multi.id])).get(multi.id) ?? [];
    expect(items.map(i => [i.productId, i.quantity, i.color, i.size])).toEqual([[prodA, 1, "أسود", "12"], [prodA, 2, "بيج", "8"]]);
    expect(items.every(i => i.variantId != null)).toBe(true);
    const review = os.find(o => o.externalOrderId === "syn-3")!;
    expect(review.needsReview).toBe(true); expect(review.reviewReason).toContain("المحافظة غير محددة"); expect(review.governorate).toBe("غير محدد");
    const badPhone = os.find(o => o.externalOrderId === "syn-4")!;
    expect(badPhone.customerPhone).toBe("10903863290"); expect(badPhone.needsReview).toBe(true);
    expect(os.find(o => o.externalOrderId === "syn-2")).toBeUndefined();
  });

  it("🔒 نفس الملف مرة ثانية → صفر جديد، الكل موجود مسبقًا (idempotency بمفتاح Order ID داخل النشاط)", async () => {
    const buf = buildXlsx([row({ ID: "1", "Order ID": "syn-1" }), row({ ID: "5", "Order ID": "syn-5" })]);
    const before = (await ordersOf(A.businessId)).length;
    const ex = await post("/api/import/execute", ownerCookie(ownerA), buf, A.businessId);
    expect(ex.body).toMatchObject({ imported: 0, already_existing: 2 });
    expect((await ordersOf(A.businessId)).length).toBe(before);
    // نفس Order ID في نشاط B = مش مكرر هناك (المفتاح داخل النشاط)
    const exB = await post("/api/import/execute", ownerCookie(ownerB), buildXlsx([row({ ID: "5", "Order ID": "syn-5" })]), B.businessId);
    expect(exB.body.imported).toBe(1);
  });

  it("🔒 variant/product خارج كتالوج النشاط → failed_matching (نشاط B بلا «بيج»)، بلا لمس نشاط A", async () => {
    const before = (await ordersOf(A.businessId)).length;
    const ex = await post("/api/import/execute", ownerCookie(ownerB), buildXlsx([row({ ID: "9", "Order ID": "syn-9", Variant: "المقاس: من 6 ل 8 سنين اللون: بيج" })]), B.businessId);
    expect(ex.body).toMatchObject({ imported: 0, failed_matching: 1 });
    expect(ex.body.reports[0].status).toBe("failed_matching");
    expect((await ordersOf(A.businessId)).length).toBe(before);
  });

  it("🔒 Go-Live بلا إعدادات افتراضية → 409 برسالة واضحة قبل أي كتابة (بدل «خطأ في الاستيراد»)", async () => {
    const d = (await getDb())!;
    await d.update(businesses).set({ accountingGoLiveAt: new Date("2020-01-01") }).where(eq(businesses.id, A.businessId));
    try {
      const before = (await ordersOf(A.businessId)).length;
      const ex = await post("/api/import/execute", ownerCookie(ownerA), buildXlsx([row({ ID: "7", "Order ID": "syn-7" })]), A.businessId);
      expect(ex.status).toBe(409);
      expect(ex.body.error).toContain("Go-Live");
      expect((await ordersOf(A.businessId)).length).toBe(before);
    } finally { await d.update(businesses).set({ accountingGoLiveAt: null }).where(eq(businesses.id, A.businessId)); }
  });

  describe.runIf(HAS_REAL)("🔑 الملف الحقيقي", () => {
    it("🔑 المعاينة: 92 صفًا مصنّفة (77 جديد، 15 مراجعة)؛ التنفيذ: 92 مستوردًا؛ المتعدد ببنود صحيحة؛ إعادة الرفع صفر", async () => {
      const buf = fs.readFileSync(REAL_PATH);
      const pv = await post("/api/import/preview", ownerCookie(ownerA), buf, A.businessId);
      expect(pv.status).toBe(200);
      expect(pv.body.total).toBe(92);
      expect(pv.body.summary).toEqual({ new: 77, review: 15, existing: 0, rejected: 0 });
      const before = (await ordersOf(A.businessId)).length;
      const ex = await post("/api/import/execute", ownerCookie(ownerA), buf, A.businessId);
      expect(ex.status).toBe(200);
      expect(ex.body).toMatchObject({ imported: 92, imported_review: 15, already_existing: 0, failed_matching: 0 });
      const os = await ordersOf(A.businessId);
      expect(os.length - before).toBe(92);
      const imported = os.filter(o => /^[0-9a-f-]{36}$/.test(o.externalOrderId ?? ""));
      const itemsMap = await getOrderItemsForOrders(imported.map(o => o.id));
      const multi = imported.filter(o => (itemsMap.get(o.id)?.length ?? 0) > 1);
      expect(multi.length).toBe(16);
      for (const o of imported) {
        const items = itemsMap.get(o.id) ?? [];
        expect(items.length).toBeGreaterThan(0);
        expect(items.reduce((s, i) => s + i.quantity, 0)).toBe(o.quantity);
        expect(items.every(i => i.productId === prodA && i.variantId != null)).toBe(true);
      }
      const badPhone = imported.find(o => o.customerPhone === "96401950100")!;
      expect(badPhone.needsReview).toBe(true);
      // إعادة الرفع
      const again = await post("/api/import/execute", ownerCookie(ownerA), buf, A.businessId);
      expect(again.body).toMatchObject({ imported: 0, already_existing: 92 });
      expect((await ordersOf(A.businessId)).length).toBe(os.length);
    });
  });
});
