import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { __setDbForTests, createEmployee, createProductWithVariants } from "./db";
import { makeInventoryKey, sendToWorkshop } from "./inventoryV2.service";
import { numberSource } from "./uniqueNumber";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * تصادم الأرقام المولّدة على قاعدة مؤقتة محلية: رقم أوردر فيسبوك (قيد فريد عام لكل الشركات) ورقم إذن الورشة (فريد داخل
 * النشاط عبر مفتاح business_events). التصادم يُفرض عمدًا بإرجاع رقم مستخدم من numberSource:
 *  • المحاولة التالية تنجح برقم جديد وبمعاملة نظيفة (لا بنود/حركات مكررة، ولا أثر من المحاولة الفاشلة)؛
 *  • استنفاد 3 محاولات = CONFLICT بلا أي بيانات جزئية؛ أي خطأ آخر يخرج كما هو من أول محاولة؛
 *  • تصادم بين شركتين؛ والورشة: التصادم لم يعد يُرجع الإذن الآخر كأنه نجاح (كان يُسقط الإرسال بصمت).
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🔢 تصادم أرقام الأوردرات وأذون الورشة", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const P: Record<string, { productId: number; variants: number[] }> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const n = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0].n);
  const caller = (emp: number) => appRouter.createCaller({ user: null, employee: null, tenantId: null,
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: emp }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} } } as any);
  const addOrder = (who: "A" | "B", i: number) => caller(e[who]).facebookEntry.addOrder({
    customerName: `عميل ${who}${i}`, customerPhone: `0101${String(1000000 + i).slice(-7)}`, governorate: "القاهرة", customerAddress: `عنوان ${i}`,
    selectedProducts: P[who].variants.slice(0, (i % 3) + 1).map((v, k) => ({ productId: P[who].productId, productName: "x", quantity: k + 1, variantId: v, unitPrice: 100 })),
    totalAmount: P[who].variants.slice(0, (i % 3) + 1).reduce((s, _v, k) => s + (k + 1) * 100, 0) } as any);
  const counts = async () => ({ orders: await n("SELECT COUNT(*) n FROM orders"), items: await n("SELECT COUNT(*) n FROM order_items") });
  const orderOf = async (num: string) => (await q("SELECT id, businessId, customerName FROM orders WHERE orderNumber = ?", [num]))[0];
  const itemsOf = async (id: number) => (await q("SELECT productId, variantId, quantity FROM order_items WHERE orderId = ? ORDER BY id", [id])).map((r: any) => [r.variantId, r.quantity]);
  let tick = 0;
  const fresh = (prefix: "FB" | "WS") => `${prefix}-${String(1800000000000 + ++tick)}-${String(tick % 1000).padStart(3, "0")}`;

  beforeAll(async () => {
    tmp = await createTempSchema("num_coll");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("nc-a"); B = await createCoreTestFixture("nc-b");
    for (const [k, f] of [["A", A], ["B", B]] as const) {
      const tag = `${k}${Date.now()}`;
      const p = await createProductWithVariants(f.businessId, { name: `أسورة ${tag}` }, [
        { name: "سادة", sku: `NC-1-${tag}`, currentStock: 1000, price: "150" }, { name: "منقوش", sku: `NC-2-${tag}`, currentStock: 1000, price: "200" }, { name: "عين", sku: `NC-3-${tag}`, currentStock: 1000, price: "160" }]);
      P[k] = { productId: p.productId, variants: p.variantIds };
      e[k] = insId(await createEmployee({ name: `de-${k}`, role: "data_entry", isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `de_${k}_${tmp.name}`.slice(0, 50) } as any));
    }
  }, 300_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("أوردر: تصادم مع رقم شركة أخرى ⇒ المحاولة التالية تنجح برقم جديد، بنود صحيحة مرة واحدة، والأوردر الآخر كما هو", async () => {
    const theirs = (await addOrder("B", 1)).orderNumber;
    const theirRow = await orderOf(theirs); const theirItems = await itemsOf(theirRow.id);
    const before = await counts();
    const next = fresh("FB");
    const spy = vi.spyOn(numberSource, "fbOrder").mockReturnValueOnce(theirs).mockReturnValueOnce(next);
    const r = await addOrder("A", 2);
    expect([r.orderNumber, spy.mock.calls.length]).toEqual([next, 2]);
    const mine = await orderOf(next);
    expect(mine.businessId).toBe(A.businessId);
    expect(await itemsOf(mine.id)).toEqual([[P.A.variants[0], 1], [P.A.variants[1], 2], [P.A.variants[2], 3]]);
    expect(await counts()).toEqual({ orders: before.orders + 1, items: before.items + 3 });
    expect([await orderOf(theirs), await itemsOf(theirRow.id)]).toEqual([theirRow, theirItems]);
  });

  it("أوردر: تصادم داخل نفس الشركة ⇒ رقم جديد، ولا أيتام", async () => {
    const mine = (await addOrder("A", 3)).orderNumber;
    const next = fresh("FB");
    vi.spyOn(numberSource, "fbOrder").mockReturnValueOnce(mine).mockReturnValueOnce(next);
    expect((await addOrder("A", 4)).orderNumber).toBe(next);
    expect(await n("SELECT COUNT(*) n FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.orderId = o.id)")).toBe(0);
  });

  it("أوردر: استنفاد 3 محاولات ⇒ CONFLICT بلا أي بيانات جزئية", async () => {
    const taken = (await addOrder("B", 5)).orderNumber;
    const before = await counts();
    const spy = vi.spyOn(numberSource, "fbOrder").mockReturnValue(taken);
    const err = await addOrder("A", 6).catch(x => x);
    expect([err?.code, spy.mock.calls.length]).toEqual(["CONFLICT", 3]);
    expect(await counts()).toEqual(before);
  });

  it("أوردر: خطأ غير التصادم (رقم أطول من العمود) يخرج كما هو من أول محاولة بلا إعادة ولا بيانات", async () => {
    const before = await counts();
    const spy = vi.spyOn(numberSource, "fbOrder").mockReturnValue(`FB-${"9".repeat(30)}`);
    const err = await addOrder("A", 7).catch(x => x);
    let code = ""; for (let x: any = err, d = 0; x && d < 8; x = x.cause, d++) code ||= x.code === "INTERNAL_SERVER_ERROR" ? "" : (x.code ?? "");
    expect([code, spy.mock.calls.length]).toEqual(["ER_DATA_TOO_LONG", 1]);
    expect(await counts()).toEqual(before);
  });

  it("أوردر: 10 جولات × 20 أوردر متزامن بالمولّد الحقيقي ⇒ صفر فشل وأرقام فريدة", async () => {
    const before = await counts();
    for (let round = 0; round < 10; round++) {
      const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => addOrder(i % 2 ? "A" : "B", 100 + round * 20 + i)));
      const failed = res.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason?.message).slice(0, 120));
      expect(failed).toEqual([]);
    }
    expect((await counts()).orders).toBe(before.orders + 200);
  }, 120_000);

  describe("أذون الورشة", () => {
    const W: Record<string, { office: number; workshop: number; product: number; product2: number }> = {};
    const actor = (k: "A" | "B") => ({ id: e[k], name: `de-${k}` });
    const bal = async (wh: number, product: number) => Number((await q("SELECT onHandQuantity n FROM inventory_balances WHERE warehouseId = ? AND inventoryKey = ?", [wh, makeInventoryKey(product)]))[0]?.n ?? -1);
    const events = (biz: number) => n("SELECT COUNT(*) n FROM business_events WHERE businessId = ? AND eventType = 'inventory.stock_transfer'", [biz]);
    const send = (k: "A" | "B", product: number, quantity: number, reason = "تلميع") =>
      sendToWorkshop({ businessId: (k === "A" ? A : B).businessId, reason, occurredAt: new Date("2026-10-10T10:00:00Z"), lines: [{ productId: product, quantity }], actor: actor(k) });

    beforeAll(async () => {
      for (const [k, f] of [["A", A], ["B", B]] as const) {
        const office = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'المكتب')", [f.businessId]));
        const workshop = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'الورشة')", [f.businessId]));
        await q("UPDATE businesses SET defaultWarehouseId = ?, workshopWarehouseId = ? WHERE id = ?", [office, workshop, f.businessId]);
        const product = insId(await q("INSERT INTO products (name, businessId) VALUES ('أسورة ورشة', ?)", [f.businessId]));
        const product2 = insId(await q("INSERT INTO products (name, businessId) VALUES ('أسورة ورشة 2', ?)", [f.businessId]));
        for (const p of [product, product2])
          await q("INSERT INTO inventory_balances (businessId, warehouseId, productId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, ?, 100, '4000.0000', '40.0000')", [f.businessId, office, p, makeInventoryKey(p)]);
        W[k] = { office, workshop, product, product2 };
      }
    });

    it("تصادم بنفس البيانات (كان يُرجع الإذن الآخر كنجاح ويُسقط الإرسال بصمت) ⇒ رقم جديد والمخزون يتحرك مرتين", async () => {
      const R1 = fresh("WS"), R2 = fresh("WS");
      vi.spyOn(numberSource, "workshopReference").mockReturnValueOnce(R1).mockReturnValueOnce(R1).mockReturnValueOnce(R2);
      expect((await send("A", W.A.product, 5)).reference).toBe(R1);
      const second = await send("A", W.A.product, 5);
      expect([second.reference, (second as any).duplicate ?? false]).toEqual([R2, false]);
      expect([await bal(W.A.office, W.A.product), await bal(W.A.workshop, W.A.product), await events(A.businessId)]).toEqual([90, 10, 2]);
    });

    it("تصادم ببيانات مختلفة (تعارض مفتاح) ⇒ رقم جديد لا رفض", async () => {
      const [{ ref }] = await q("SELECT sourceReference ref FROM business_events WHERE businessId = ? ORDER BY id LIMIT 1", [A.businessId]);
      const R3 = fresh("WS");
      vi.spyOn(numberSource, "workshopReference").mockReturnValueOnce(ref).mockReturnValueOnce(R3);
      expect((await send("A", W.A.product, 3, "إصلاح قفل")).reference).toBe(R3);
      expect([await bal(W.A.office, W.A.product), await events(A.businessId)]).toEqual([87, 3]);
    });

    it("استنفاد 3 محاولات ⇒ CONFLICT بلا أي أثر (ولا صف رصيد فارغ في الورشة من المحاولات الفاشلة)", async () => {
      const [{ ref }] = await q("SELECT sourceReference ref FROM business_events WHERE businessId = ? ORDER BY id LIMIT 1", [A.businessId]);
      const spy = vi.spyOn(numberSource, "workshopReference").mockReturnValue(ref);
      const err = await send("A", W.A.product2, 4).catch(x => x);
      expect([err?.code, spy.mock.calls.length]).toEqual(["CONFLICT", 3]);
      expect([await bal(W.A.office, W.A.product2), await bal(W.A.workshop, W.A.product2), await events(A.businessId)]).toEqual([100, -1, 3]);
    });

    it("نفس الرقم في نشاط شركة أخرى ليس تصادمًا (المفتاح داخل النشاط) ⇒ محاولة واحدة", async () => {
      const [{ ref }] = await q("SELECT sourceReference ref FROM business_events WHERE businessId = ? ORDER BY id LIMIT 1", [A.businessId]);
      const spy = vi.spyOn(numberSource, "workshopReference").mockReturnValue(ref);
      expect((await send("B", W.B.product, 2)).reference).toBe(ref);
      expect([spy.mock.calls.length, await bal(W.B.office, W.B.product), await bal(W.B.workshop, W.B.product)]).toEqual([1, 98, 2]);
    });
  });
});
