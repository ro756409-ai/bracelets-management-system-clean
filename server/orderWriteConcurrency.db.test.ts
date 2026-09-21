import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import {
  getDb,
  createEmployee,
  createProductWithVariants,
  getOrderItemsForOrders,
  insertOrderWithItems,
  updateOrderWithItems,
  runOrderTransaction,
  withDeadlockRetry,
  isDeadlockError,
} from "./db";
import { employees, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * كتابة الأوردر ذرّية وآمنة للتزامن — على MySQL حقيقية.
 *
 * الحادثة: أوردرين جداد متزامنين بيعملوا deadlock على `order_items` (gap lock من
 * `SELECT … FOR UPDATE` على صفوف مش موجودة)، ولأن الهيدر كان في transaction قبل
 * البنود، الطرف الخاسر كان بيسيب **أوردر يتيم بلا بنود**.
 *
 * الملف ده لازم يشتغل **بالتوازي** مع باقي ملفات DB — ده الهدف منه.
 */

const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

// ── retry: وحدة من غير قاعدة ──
describe("🔑 withDeadlockRetry — على حدود الـtransaction", () => {
  const deadlock = () =>
    Object.assign(new Error("wrapped"), {
      cause: Object.assign(new Error("Deadlock found"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }),
    });

  it("🔑 بيتعرّف على الـdeadlock حتى لو ملفوف", () => {
    expect(isDeadlockError(deadlock())).toBe(true);
    expect(isDeadlockError(new Error("غير"))).toBe(false);
  });
  it("🔑 بيعيد بعد deadlock وبينجح", async () => {
    let calls = 0;
    const r = await withDeadlockRetry(async () => {
      calls++;
      if (calls < 3) throw deadlock();
      return "ok";
    });
    expect(r).toBe("ok");
    expect(calls).toBe(3);
  });
  it("🔒 حد أقصى 3 محاولات — بعدها الخطأ بيطلع", async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => { calls++; throw deadlock(); })
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });
  it("🔒 خطأ غير الـdeadlock → مفيش إعادة", async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => { calls++; throw new Error("validation"); })
    ).rejects.toThrow("validation");
    expect(calls).toBe(1);
  });
});

describe.runIf(CAN)("🔒 كتابة الأوردر تحت التزامن — MySQL حقيقية", () => {
  let A: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[], orderIds: [] as number[] };
  let emp = 0, productId = 0;
  let vA = 0, vB = 0, vC = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const caller = () =>
    appRouter.createCaller({
      user: null, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: emp }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);

  /** الأوردرات اللي مالهاش ولا بند — المفروض صفر دايمًا. */
  async function orphans(orderIds: number[]): Promise<number[]> {
    if (orderIds.length === 0) return [];
    const d = await getDb();
    const withItems = await d!
      .selectDistinct({ id: orderItems.orderId })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds));
    const has = new Set(withItems.map(r => r.id));
    return orderIds.filter(id => !has.has(id));
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("conc");
    const p = await createProductWithVariants(A.businessId, { name: `أسورة تزامن ${tag}` }, [
      { name: "سادة", sku: `CC-A-${tag}`, currentStock: 1000, price: "150" },
      { name: "منقوش", sku: `CC-B-${tag}`, currentStock: 1000, price: "200" },
      { name: "عين حورس", sku: `CC-C-${tag}`, currentStock: 1000, price: "160" },
    ]);
    productId = p.productId;
    [vA, vB, vC] = p.variantIds;
    ids.productIds.push(productId);
    emp = insId(await createEmployee({ name: "conc", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `conc_${tag}` } as any));
    ids.empIds.push(emp);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    const mine = await d.select({ id: orders.id }).from(orders).where(eq(orders.businessId, A.businessId));
    const all = Array.from(new Set([...ids.orderIds, ...mine.map(r => r.id)]));
    if (all.length) {
      await d.delete(orderItems).where(inArray(orderItems.orderId, all));
      await d.delete(orders).where(inArray(orders.id, all));
    }
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    await A?.cleanup();
  });

  it("🔑 20 أوردر مختلف في نفس اللحظة عبر addOrder → الكل ينجح بلا أيتام ولا تكرار", async () => {
    const N = 20;
    const variants = [vA, vB, vC];
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        caller().facebookEntry.addOrder({
          customerName: `عميل ${i}`,
          customerPhone: `0100000${String(1000 + i).padStart(4, "0")}`,
          governorate: "القاهرة",
          customerAddress: `عنوان ${i}`,
          // كل أوردر بعدد بنود مختلف (1-3) عشان نختبر البنود مش الهيدر بس
          selectedProducts: variants.slice(0, (i % 3) + 1).map((v, k) => ({
            productId, productName: "x", quantity: k + 1, variantId: v, unitPrice: 100,
          })),
          totalAmount: variants.slice(0, (i % 3) + 1).reduce((s, _v, k) => s + (k + 1) * 100, 0),
        } as any)
      )
    );
    const failed = results.filter(r => r.status === "rejected");
    expect(failed.map(f => String((f as PromiseRejectedResult).reason?.message))).toEqual([]);

    const numbers = results.map(r => (r as PromiseFulfilledResult<any>).value.orderNumber);
    const d = await getDb();
    const rows = await d!.select().from(orders).where(inArray(orders.orderNumber, numbers));
    ids.orderIds.push(...rows.map(r => r.id));

    // 🔑 كل أوردر اتعمل مرة واحدة
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map(r => r.orderNumber)).size).toBe(N);

    // 🔒 صفر أيتام
    expect(await orphans(rows.map(r => r.id))).toEqual([]);

    // 🔑 كل أوردر ببنوده الصح بالظبط — لا ناقص ولا مكرر
    const itemsMap = await getOrderItemsForOrders(rows.map(r => r.id));
    for (const row of rows) {
      const i = Number(row.customerName.replace("عميل ", ""));
      const expected = variants.slice(0, (i % 3) + 1);
      const items = itemsMap.get(row.id) ?? [];
      expect(items.map(x => x.variantId).sort()).toEqual([...expected].sort());
      expect(items.map(x => x.quantity).sort()).toEqual(expected.map((_v, k) => k + 1).sort());
      expect(row.quantity).toBe(items.reduce((s, x) => s + x.quantity, 0));
    }
  });

  it("🔒 تحديثان متزامنان لنفس الأوردر → يتسلسلوا والبنود من تحديث واحد كامل", async () => {
    const id = await insertOrderWithItems(
      {
        orderNumber: `CU-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "c",
        customerPhone: "01000000000", governorate: "القاهرة", customerAddress: "a",
        productName: "p", quantity: 1, totalAmount: "150.00", source: "facebook", status: "new",
      } as any,
      [{ productId, productName: "p", quantity: 1, variantId: vA, unitPrice: 150 }]
    );
    ids.orderIds.push(id);

    const payloadX = [
      { productId, productName: "p", quantity: 2, variantId: vB, unitPrice: 100 },
      { productId, productName: "p", quantity: 1, variantId: vC, unitPrice: 100 },
    ];
    const payloadY = [
      { productId, productName: "p", quantity: 5, variantId: vA, unitPrice: 60 },
    ];
    const res = await Promise.allSettled([
      updateOrderWithItems(id, { totalAmount: "300.00", quantity: 3 }, payloadX),
      updateOrderWithItems(id, { totalAmount: "300.00", quantity: 5 }, payloadY),
    ]);
    expect(res.every(r => r.status === "fulfilled")).toBe(true);

    const items = (await getOrderItemsForOrders([id])).get(id) ?? [];
    const sig = items.map(i => `${i.variantId}x${i.quantity}`).sort().join(",");
    const sigX = payloadX.map(i => `${i.variantId}x${i.quantity}`).sort().join(",");
    const sigY = payloadY.map(i => `${i.variantId}x${i.quantity}`).sort().join(",");
    // 🔒 البنود من **واحد** من التحديثين بالظبط — مش خليط، ومش مكررة
    expect([sigX, sigY]).toContain(sig);
    // والهيدر متسق مع البنود اللي فضلت
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(eq(orders.id, id));
    expect(row.quantity).toBe(items.reduce((s, i) => s + i.quantity, 0));
  });

  it("🔒 خطأ أثناء كتابة البنود → الهيدر مايفضلش (rollback كامل)", async () => {
    const orderNumber = `RB-${tag}`.slice(0, 20);
    await expect(
      insertOrderWithItems(
        {
          orderNumber, businessId: A.businessId, customerName: "c",
          customerPhone: "01000000000", governorate: "القاهرة", customerAddress: "a",
          productName: "p", quantity: 1, totalAmount: "150.00", source: "facebook", status: "new",
        } as any,
        // كمية صفر → replaceOrderItemsInTransaction بيرمي **بعد** ما الهيدر اتكتب
        [{ productId, productName: "p", quantity: 0, variantId: vA, unitPrice: 150 }]
      )
    ).rejects.toThrow("كمية بند الأوردر غير صالحة");
    const d = await getDb();
    const left = await d!.select().from(orders).where(eq(orders.orderNumber, orderNumber));
    expect(left).toEqual([]);
  });

  it("🔒 بنود فاضية → مفيش هيدر يتيم", async () => {
    const orderNumber = `EM-${tag}`.slice(0, 20);
    await expect(
      insertOrderWithItems(
        {
          orderNumber, businessId: A.businessId, customerName: "c",
          customerPhone: "01000000000", governorate: "القاهرة", customerAddress: "a",
          productName: "p", quantity: 1, totalAmount: "1.00", source: "facebook", status: "new",
        } as any,
        []
      )
    ).rejects.toThrow();
    const d = await getDb();
    expect(await d!.select().from(orders).where(eq(orders.orderNumber, orderNumber))).toEqual([]);
  });

  it("🔑 **deadlock حقيقي مُجبَر** → retry ينجح، وكل كتابة موجودة مرة واحدة بالظبط", async () => {
    // أوردرين موجودين؛ كل transaction بتقفل واحد وبعدين بتحاول تقفل التاني بعكس الترتيب
    // → دايرة حقيقية، وMySQL لازم تقتل واحدة. الحاجز بيشتغل في **المحاولة الأولى بس**،
    // فالإعادة بتعدّي عادي — ده بالظبط سيناريو الـretry.
    const mk = async (n: string) =>
      insertOrderWithItems(
        {
          orderNumber: `DL${n}-${tag}`.slice(0, 20), businessId: A.businessId, customerName: n,
          customerPhone: "01000000000", governorate: "القاهرة", customerAddress: "a",
          productName: "p", quantity: 1, totalAmount: "150.00", source: "facebook", status: "new",
        } as any,
        [{ productId, productName: "p", quantity: 1, variantId: vA, unitPrice: 150 }]
      );
    const o1 = await mk("1");
    const o2 = await mk("2");
    ids.orderIds.push(o1, o2);

    let arrived = 0;
    let release!: () => void;
    const bothHoldFirstLock = new Promise<void>(r => (release = r));
    const arrive = () => { if (++arrived === 2) release(); return bothHoldFirstLock; };

    const attempts = { t1: 0, t2: 0 };
    const lockRow = (tx: any, id: number) =>
      tx.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).for("update");
    const appendNote = (tx: any, id: number, note: string) =>
      tx.update(orders).set({ notes: sql`CONCAT(COALESCE(${orders.notes}, ''), ${note})` }).where(eq(orders.id, id));

    const t1 = runOrderTransaction(async tx => {
      attempts.t1++;
      await lockRow(tx, o1);
      if (attempts.t1 === 1) await arrive();
      await lockRow(tx, o2);
      await appendNote(tx, o1, "[T1]");
    });
    const t2 = runOrderTransaction(async tx => {
      attempts.t2++;
      await lockRow(tx, o2);
      if (attempts.t2 === 1) await arrive();
      await lockRow(tx, o1);
      await appendNote(tx, o2, "[T2]");
    });
    const r = await Promise.allSettled([t1, t2]);

    // 🔑 الاتنين نجحوا في الآخر
    expect(r.map(x => x.status)).toEqual(["fulfilled", "fulfilled"]);
    // 🔑 deadlock حصل فعلًا: واحدة على الأقل اتعادت
    expect(attempts.t1 + attempts.t2).toBeGreaterThanOrEqual(3);
    // 🔒 idempotency: كل كتابة مرة واحدة بالظبط رغم الإعادة (المحاولة المقتولة اترجعت)
    const d = await getDb();
    const rows = await d!.select({ id: orders.id, notes: orders.notes }).from(orders).where(inArray(orders.id, [o1, o2]));
    const note = new Map(rows.map(x => [x.id, x.notes ?? ""]));
    expect(note.get(o1)).toBe("[T1]");
    expect(note.get(o2)).toBe("[T2]");
    // 🔒 والبنود ماتأثرتش ولا اتكررت
    const items = await getOrderItemsForOrders([o1, o2]);
    expect(items.get(o1)).toHaveLength(1);
    expect(items.get(o2)).toHaveLength(1);
  });
});
