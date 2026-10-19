import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createProductWithVariants, setOrderEntryMode } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * تعديل أوردر فيسبوك متعدد البنود: كل بند يحتفظ بنوع الحفر (التركيبة) بتاعه بعد التعديل.
 * قبل الإصلاح الواجهة كانت بتبعت تركيبة البند الأول بس، والسيرفر كان بيدّيها لكل بنود نفس المنتج ويشيلها من
 * بنود المنتجات التانية. قاعدة مؤقتة ببيانات مصطنعة، بتتمسح بعد الاختبار.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }

describe.runIf(CAN)("📝 تعديل أوردر فيسبوك: نوع الحفر محفوظ لكل بند", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  let fb = 0; let p1 = 0, v1 = 0, v2 = 0, p2 = 0, v3 = 0, vB = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const lines = async (orderId: number) => (await q("SELECT productId, variantId, quantity, color, size FROM order_items WHERE orderId = ? ORDER BY id", [orderId]))
    .map((r: any) => [r.productId, r.variantId, r.quantity]);
  const snap = async (orderId: number) => JSON.stringify({ o: await q("SELECT * FROM orders WHERE id = ?", [orderId]), i: await q("SELECT * FROM order_items WHERE orderId = ? ORDER BY id", [orderId]) });
  const CUST = { customerName: "عميل نقشة", customerPhone: "01000009001", governorate: "القاهرة", customerAddress: "شارع النقشة 4 - الدور 2 - شقة 7" };
  async function addOrder(products: any[]) {
    // الإجمالي متسق مع البنود (السيرفر بيرفض إجمالي أكبر من البنود + الشحن من غير خصم).
    const totalAmount = products.reduce((s: number, p: any) => s + (p.unitPrice ?? 0) * (p.quantity ?? 1), 0);
    const r = await (await portal(fb)).facebookEntry.addOrder({ ...CUST, selectedProducts: products, totalAmount } as any);
    return (await q("SELECT id FROM orders WHERE orderNumber = ?", [r.orderNumber]))[0].id as number;
  }

  beforeAll(async () => {
    tmp = await createTempSchema("fbvar");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("fbv-a"); B = await createCoreTestFixture("fbv-b");
    await setOrderEntryMode(A.businessId, "bracelets_legacy", 1);
    const a = await createProductWithVariants(A.businessId, { name: "أسورة نقش" }, [
      { name: "آية الكرسي", sku: `FV1-${tmp.name}`.slice(0, 50), currentStock: 10 } as any,
      { name: "عين حورس", sku: `FV2-${tmp.name}`.slice(0, 50), currentStock: 10 } as any,
    ]);
    p1 = a.productId; [v1, v2] = a.variantIds;
    const b = await createProductWithVariants(A.businessId, { name: "أسورة تانية" }, [{ name: "سادة", sku: `FV3-${tmp.name}`.slice(0, 50), currentStock: 10 } as any]);
    p2 = b.productId; v3 = b.variantIds[0];
    const other = await createProductWithVariants(B.businessId, { name: "منتج تاجر B" }, [{ name: "B", sku: `FVB-${tmp.name}`.slice(0, 50), currentStock: 10 } as any]);
    vB = other.variantIds[0];
    fb = insId(await createEmployee({ name: "fb-var", role: "facebook_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `fbv_${tmp.name}`.slice(0, 50), passwordHash: "x" } as any));
  }, 180_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("متعدد البنود (نفس المنتج بنقشتين + منتج تاني): التعديل بيحفظ نقشة كل بند — حتى مع تغيير الكمية", async () => {
    const id = await addOrder([
      { productId: p1, productName: "x", quantity: 1, variantId: v1, unitPrice: 100 },
      { productId: p1, productName: "x", quantity: 1, variantId: v2, unitPrice: 100 },
      { productId: p2, productName: "x", quantity: 1, variantId: v3, unitPrice: 100 },
    ]);
    expect(await lines(id)).toEqual([[p1, v1, 1], [p1, v2, 1], [p2, v3, 1]]);
    // نفس شكل طلب الواجهة بعد الإصلاح: variantId لكل بند + تركيبة البند الأول على مستوى الأوردر
    await (await portal(fb)).facebookEntry.updateOrder({
      orderId: id, ...CUST, customerName: "عميل نقشة معدّل", totalAmount: 400, variantId: v1,
      selectedProducts: [
        { productId: p1, productName: "x", quantity: 1, variantId: v1 },
        { productId: p1, productName: "x", quantity: 2, variantId: v2 },
        { productId: p2, productName: "x", quantity: 1, variantId: v3 },
      ],
    } as any);
    expect(await lines(id)).toEqual([[p1, v1, 1], [p1, v2, 2], [p2, v3, 1]]);
    expect((await q("SELECT customerName FROM orders WHERE id = ?", [id]))[0].customerName).toBe("عميل نقشة معدّل");
  });

  it("أسعار البنود: التعديل بسعر كل بند بيحفظه زي ما هو (مش توزيع الإجمالي بالكمية)", async () => {
    const id = await addOrder([
      { productId: p1, productName: "x", quantity: 1, variantId: v1, unitPrice: 300 },
      { productId: p1, productName: "x", quantity: 1, variantId: v2, unitPrice: 350 },
      { productId: p2, productName: "x", quantity: 1, variantId: v3, unitPrice: 200 },
    ]);
    await (await portal(fb)).facebookEntry.updateOrder({
      orderId: id, ...CUST, totalAmount: 1200, variantId: v1,
      selectedProducts: [
        { productId: p1, productName: "x", quantity: 1, variantId: v1, unitPrice: 300 },
        { productId: p1, productName: "x", quantity: 2, variantId: v2, unitPrice: 350 },
        { productId: p2, productName: "x", quantity: 1, variantId: v3, unitPrice: 200 },
      ],
    } as any);
    const rows = await q("SELECT variantId, quantity, unitPrice FROM order_items WHERE orderId = ? ORDER BY id", [id]);
    expect(rows.map((r: any) => [r.variantId, r.quantity, Number(r.unitPrice)])).toEqual([[v1, 1, 300], [v2, 2, 350], [v3, 1, 200]]);
    expect(Number((await q("SELECT totalAmount FROM orders WHERE id = ?", [id]))[0].totalAmount)).toBe(1200);
  });

  it("عميل قديم (بلا تركيبة لكل بند): بند واحد بتركيبة على مستوى الأوردر بيتحفظ زي قبل كده", async () => {
    const id = await addOrder([{ productId: p1, productName: "x", quantity: 1, variantId: v2, unitPrice: 100 }]);
    await (await portal(fb)).facebookEntry.updateOrder({ orderId: id, ...CUST, totalAmount: 200, variantId: v2,
      selectedProducts: [{ productId: p1, productName: "x", quantity: 2 }] } as any);
    expect(await lines(id)).toEqual([[p1, v2, 2]]);
  });

  it("تركيبة تاجر تاني، أو تركيبة منتج تاني على البند: مرفوض بلا أي تغيير", async () => {
    const id = await addOrder([
      { productId: p1, productName: "x", quantity: 1, variantId: v1, unitPrice: 100 },
      { productId: p2, productName: "x", quantity: 1, variantId: v3, unitPrice: 100 },
    ]);
    const before = await snap(id);
    const foreign = await code(async () => (await portal(fb)).facebookEntry.updateOrder({ orderId: id, ...CUST, totalAmount: 200,
      selectedProducts: [{ productId: p1, productName: "x", quantity: 1, variantId: vB }, { productId: p2, productName: "x", quantity: 1, variantId: v3 }] } as any));
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(foreign);
    const mismatch = await code(async () => (await portal(fb)).facebookEntry.updateOrder({ orderId: id, ...CUST, totalAmount: 200,
      selectedProducts: [{ productId: p1, productName: "x", quantity: 1, variantId: v3 }, { productId: p2, productName: "x", quantity: 1, variantId: v3 }] } as any));
    expect(mismatch).toBe("BAD_REQUEST");
    expect(await snap(id)).toBe(before);
  });
});
