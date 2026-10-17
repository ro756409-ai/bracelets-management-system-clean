import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import {
  __setDbForTests, createEmployee, createProduct, createProductWithVariants, createOrderWithItems,
  confirmOrder, cancelOrder, postponeOrder, updateOrder, editOrderFull, replaceOrderItemsFromEditor,
  StockShortfallError, OrderConfirmBlockedError, OrderStockInconsistencyError,
} from "./db";
import { upsertEasyOrder, type EasyOrderPayload } from "./easyorder.service";
import { applyExternalStatus } from "./easyorderWebhook";
import { applyBostaEvent } from "./bostaWebhook";
import fs from "fs";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { normalizeBostaEvent } from "./bostaEvents";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * DATA-4 على MySQL حقيقي (قاعدة مؤقتة): قاعدة واحدة لمخزون الأوردر — صافي خصم الأوردر لكل تركيبة/منتج = بنوده الحالية،
 * والإلغاء يرجّع الصافي كله. لا خصم مكرر ولا استرجاع مكرر مهما تكرر الطلب أو تتابعت الحالات أو تزامنت، والتعديل بعد
 * التأكيد يحرّك التركيبة الصحيحة، وأي فشل في النص = لا تغيير.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) =>
  appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: id }, process.env.JWT_SECRET as string) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function failure(fn: () => Promise<any>): Promise<any> { try { await fn(); return null; } catch (e) { return e; } }
const editor = (id: number) => ({ id, name: "tester", role: "super_admin" });

describe.runIf(CAN)("🔑 DATA-4 — دورة حياة مخزون الأوردر", { timeout: 30_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  let ownerA = 0;
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const vStock = async (id: number) => Number((await q("SELECT currentStock FROM product_variants WHERE id = ?", [id]))[0].currentStock);
  const pStock = async (id: number) => Number((await q("SELECT currentStock FROM products WHERE id = ?", [id]))[0].currentStock);
  const status = async (id: number) => (await q("SELECT status FROM orders WHERE id = ?", [id]))[0].status as string;
  const moveCount = async (orderId: number) => Number((await q("SELECT COUNT(*) AS n FROM inventory_movements WHERE orderId = ?", [orderId]))[0].n);
  const anyNegative = async () => Number((await q(
    "SELECT (SELECT COUNT(*) FROM product_variants WHERE currentStock < 0) + (SELECT COUNT(*) FROM products WHERE currentStock < 0) AS n"))[0].n);

  /** منتج بتركيبتين (كل واحدة stock) — يرجّع الأب والتركيبتين. */
  async function variantProduct(f: CoreTestFixture, stock: number) {
    const k = ++seq;
    const r = await createProductWithVariants(f.businessId, { name: `أسورة ${k}` }, [
      { sku: `S${k}-A-${tmp.name}`.slice(0, 50), color: "ذهبي", currentStock: stock } as any,
      { sku: `S${k}-B-${tmp.name}`.slice(0, 50), color: "فضي", currentStock: stock } as any,
    ]);
    await q("UPDATE products SET currentStock = 100 WHERE id = ?", [r.productId]); // رصيد للأب لكشف أي لمس خاطئ له
    return { p: r.productId, a: r.variantIds[0], b: r.variantIds[1] };
  }
  async function simpleProduct(f: CoreTestFixture, stock: number) {
    return createProduct({ businessId: f.businessId, name: `منتج بسيط ${++seq}`, sku: `SP${seq}-${tmp.name}`.slice(0, 50), price: "100.00", currentStock: stock } as any);
  }
  async function order(f: CoreTestFixture, items: { productId: number; variantId?: number; quantity: number }[], extra: Record<string, any> = {}) {
    const orderNumber = `D4${tmp.name.slice(-6)}${++seq}`.slice(0, 20);
    const id = await createOrderWithItems({
      businessId: f.businessId, orderNumber, customerName: "عميل", customerPhone: "01012345678",
      customerAddress: "شارع النيل رقم 5 الدقي", governorate: "القاهرة", productName: "x",
      productId: items[0]?.productId, variantId: items[0]?.variantId, quantity: items.reduce((s, i) => s + i.quantity, 0),
      totalAmount: "100.00", status: "new", source: "manual", ...extra,
    } as any, items.map(i => ({ productName: "x", unitPrice: 100, ...i })));
    return id!;
  }
  const line = (productId: number, variantId: number | null, quantity: number) =>
    ({ productId, productName: "x", variantId, quantity, unitPrice: 100, discount: 0 });

  beforeAll(async () => {
    tmp = await createTempSchema("data4_stock");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("d4-a");
    B = await createCoreTestFixture("d4-b");
    ownerA = insId(await createEmployee({ name: "owner-d4", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId,
      username: `owner_${tmp.name}`.slice(0, 50), passwordHash: "hash" } as any));
  }, 120_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("تأكيد يخصم التركيبة مرة واحدة؛ التأكيد المكرر لا يخصم ثانيًا؛ الإلغاء يرجّع مرة واحدة والإلغاء المكرر لا يرجّع", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }, { productId: P.p, variantId: P.b, quantity: 1 }]);
    await confirmOrder(id, ownerA);
    await confirmOrder(id, ownerA);
    expect([await vStock(P.a), await vStock(P.b), await pStock(P.p), await status(id)]).toEqual([8, 9, 100, "confirmed"]);
    expect((await cancelOrder(id, "العميل ألغى", undefined, ownerA)).restoredQuantity).toBe(3);
    expect((await cancelOrder(id, "العميل ألغى", undefined, ownerA)).restoredQuantity).toBe(0);
    expect([await vStock(P.a), await vStock(P.b), await pStock(P.p), await status(id)]).toEqual([10, 10, 100, "cancelled"]);
  });

  it("ملغي ← جديد ← تأكيد (إعادة تفعيل) يخصم مرة واحدة فقط؛ ثم إلغاء يرجّع للبداية", async () => {
    const P = await variantProduct(A, 5);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    await cancelOrder(id, "x", undefined, ownerA);
    await updateOrder(id, { status: "new" });
    await confirmOrder(id, ownerA);
    expect([await vStock(P.a), await status(id)]).toEqual([3, "confirmed"]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect(await vStock(P.a)).toBe(5);
  });

  it("مؤكد ← مؤجل ← مؤكد ← لم يرد ← جديد ← مؤكد: الخصم يبقى مرة واحدة (السلوك الحالي: التأجيل لا يفك الخصم)", async () => {
    const P = await variantProduct(A, 5);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    await postponeOrder(id, new Date(Date.now() + 86_400_000), undefined, ownerA);
    expect(await vStock(P.a)).toBe(3);
    await confirmOrder(id, ownerA);
    await updateOrder(id, { status: "no_answer" });
    await updateOrder(id, { status: "new" });
    await confirmOrder(id, ownerA);
    expect([await vStock(P.a), await status(id)]).toEqual([3, "confirmed"]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect(await vStock(P.a)).toBe(5);
  });

  it("«ملغي» من مسار التحديث العام (درج الأوردر عبر الراوتر، وWebhook) يرجّع المخزون — مرة واحدة حتى لو تكرر أو تزامن", async () => {
    const P = await variantProduct(A, 6);
    const o1 = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(o1, ownerA);
    await (await portal(ownerA)).orders.update({ id: o1, status: "cancelled", notes: "ملاحظة" });
    expect([await vStock(P.a), await status(o1)]).toEqual([6, "cancelled"]);

    const o2 = await order(A, [{ productId: P.p, variantId: P.b, quantity: 3 }]);
    await confirmOrder(o2, ownerA);
    const rs = await Promise.all([applyExternalStatus(o2, "cancelled"), applyExternalStatus(o2, "cancelled"), applyExternalStatus(o2, "cancelled")]);
    expect(rs.every(r => r.ok)).toBe(true);
    await applyExternalStatus(o2, "cancelled");
    expect([await vStock(P.b), await status(o2)]).toEqual([6, "cancelled"]);
  });

  it("نفس Webhook «مؤكد» مرتين وبالتزامن = خصم واحد", async () => {
    const P = await variantProduct(A, 4);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }]);
    const rs = await Promise.all([applyExternalStatus(id, "confirmed"), applyExternalStatus(id, "confirmed"), applyExternalStatus(id, "confirmed")]);
    expect(rs.every(r => r.ok)).toBe(true);
    await applyExternalStatus(id, "confirmed");
    expect([await vStock(P.a), await status(id)]).toEqual([3, "confirmed"]);
  });

  it("إلغاء أوردر مسلَّم أو مرتجع مرفوض (BAD_REQUEST من الراوتر، رفض من الـWebhook) بلا أي حركة مخزون", async () => {
    const P = await variantProduct(A, 5);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    for (const s of ["delivered", "returned"]) {
      await q("UPDATE orders SET status = ? WHERE id = ?", [s, id]);
      const before = await moveCount(id);
      const e = await failure(async () => (await portal(ownerA)).orders.cancel({ orderId: id, cancelReason: "x" }));
      expect(e?.code, s).toBe("BAD_REQUEST");
      expect((await failure(async () => (await portal(ownerA)).orders.update({ id, status: "cancelled" })))?.code, s).toBe("BAD_REQUEST");
      expect((await applyExternalStatus(id, "cancelled")).ok, s).toBe(false);
      expect([await vStock(P.a), await status(id), await moveCount(id)], s).toEqual([3, s, before]);
    }
  });

  it("محرر البنود بعد التأكيد: تقليل الكمية + تغيير التركيبة + إضافة سطر — الحركة على التركيبة الصحيحة والأب لا يُلمس؛ والإلغاء يرجّع للبداية", async () => {
    const P = await variantProduct(A, 10);
    const S = await simpleProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 3 }]);
    await confirmOrder(id, ownerA);
    expect(await vStock(P.a)).toBe(7);
    await replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA));
    expect([await vStock(P.a), await pStock(P.p)]).toEqual([9, 100]);
    await replaceOrderItemsFromEditor(id, [line(P.p, P.b, 2), line(S, null, 4)], undefined, editor(ownerA));
    expect([await vStock(P.a), await vStock(P.b), await pStock(S), await pStock(P.p)]).toEqual([10, 8, 6, 100]);
    await replaceOrderItemsFromEditor(id, [line(P.p, P.b, 2), line(S, null, 4)], undefined, editor(ownerA)); // نفس البنود = لا حركة
    expect([await vStock(P.b), await pStock(S)]).toEqual([8, 6]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect([await vStock(P.a), await vStock(P.b), await pStock(S), await pStock(P.p)]).toEqual([10, 10, 10, 100]);
    expect(await anyNegative()).toBe(0);
  });

  it("محرر البنود: زيادة فوق المتاح = StockShortfallError بلا أي تغيير (لا بنود ولا مخزون)", async () => {
    const P = await variantProduct(A, 3);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    const moves = await moveCount(id);
    const e = await failure(() => replaceOrderItemsFromEditor(id, [line(P.p, P.a, 2), line(P.p, P.b, 9)], undefined, editor(ownerA)));
    expect(e).toBeInstanceOf(StockShortfallError);
    expect([await vStock(P.a), await vStock(P.b), await moveCount(id)]).toEqual([1, 3, moves]);
    expect(await q("SELECT variantId, quantity FROM order_items WHERE orderId = ?", [id])).toEqual([{ variantId: P.a, quantity: 2 }]);
  });

  it("أوردر مؤكد على المنتج الأب (قبل 2026-09-28): التعديل يرجّع للأب ويخصم من التركيبة؛ الإلغاء بعدها يرجّع التركيبة — لا تضخم", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    // محاكاة خصم قديم على الأب (بيانات تاريخية): حركة out على الأب + حالة مؤكد
    await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, NULL, 'out', 2, ?, ?, ?)",
      [A.businessId, P.p, `تأكيد أوردر legacy`, id, ownerA]);
    await q("UPDATE products SET currentStock = currentStock - 2 WHERE id = ?", [P.p]);
    await q("UPDATE orders SET status = 'confirmed' WHERE id = ?", [id]);
    await replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA));
    expect([await pStock(P.p), await vStock(P.a)]).toEqual([100, 9]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect([await pStock(P.p), await vStock(P.a)]).toEqual([100, 10]);
  });

  it("أوردر مؤكد بلا حركة مخزون مسجّلة: تعديل الأصناف/الكميات مرفوض بلا تغيير، والحقول غير المخزنية مسموحة", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await q("UPDATE orders SET status = 'confirmed' WHERE id = ?", [id]);
    const e = await failure(() => replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA)));
    expect(String(e?.message)).toContain("بلا حركة مخزون مسجّلة");
    expect((await failure(() => editOrderFull(id, { quantity: 1 }, editor(ownerA))))?.message).toContain("بلا حركة مخزون مسجّلة");
    expect([await vStock(P.a), await moveCount(id)]).toEqual([10, 0]);
    expect(await q("SELECT quantity FROM order_items WHERE orderId = ?", [id])).toEqual([{ quantity: 2 }]);
    await editOrderFull(id, { customerName: "اسم جديد" }, editor(ownerA));
    expect((await q("SELECT customerName FROM orders WHERE id = ?", [id]))[0].customerName).toBe("اسم جديد");
  });

  it("editOrderFull (أوردر بصنف واحد): تغيير التركيبة والكمية بعد التأكيد يتحرك على التركيبة، ذرّيًا، والإلغاء يرجّع للبداية", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    await editOrderFull(id, { variantId: P.b, quantity: 3 }, editor(ownerA));
    expect([await vStock(P.a), await vStock(P.b), await pStock(P.p)]).toEqual([10, 7, 100]);
    expect(await q("SELECT variantId, quantity FROM order_items WHERE orderId = ?", [id])).toEqual([{ variantId: P.b, quantity: 3 }]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect([await vStock(P.a), await vStock(P.b)]).toEqual([10, 10]);
  });

  it("فشل في نص المعاملة (Trigger يرفض سجل التعديل بعد حركة المخزون) = Rollback كامل: المخزون والبنود والهيدر والحركات كما هي", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    const snap = async () => [await vStock(P.a), await vStock(P.b), await moveCount(id),
      await q("SELECT variantId, quantity FROM order_items WHERE orderId = ?", [id]),
      (await q("SELECT variantId, quantity FROM orders WHERE id = ?", [id]))[0]];
    const before = await snap();
    await q("CREATE TRIGGER d4_fail_edit_log BEFORE INSERT ON order_edit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure'");
    try {
      const e = await failure(() => editOrderFull(id, { variantId: P.b, quantity: 1 }, editor(ownerA)));
      expect(String(e?.cause?.message ?? e?.message)).toContain("forced failure");
    } finally {
      await q("DROP TRIGGER IF EXISTS d4_fail_edit_log");
    }
    expect(await snap()).toEqual(before);

    // نفس الشيء للتأكيد: فشل بعد خصم المخزون وقبل تحديث الحالة
    const id2 = await order(A, [{ productId: P.p, variantId: P.b, quantity: 4 }]);
    await q("CREATE TRIGGER d4_fail_confirm BEFORE UPDATE ON orders FOR EACH ROW BEGIN IF NEW.status = 'confirmed' AND OLD.status <> 'confirmed' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced confirm failure'; END IF; END");
    try {
      expect(await failure(() => confirmOrder(id2, ownerA))).not.toBeNull();
    } finally {
      await q("DROP TRIGGER IF EXISTS d4_fail_confirm");
    }
    expect([await vStock(P.b), await moveCount(id2), await status(id2)]).toEqual([10, 0, "new"]);
  });

  it("أوردرين متزامنين على آخر وحدة: واحد يتأكد والآخر StockShortfallError، والمخزون صفر لا سالب", async () => {
    const P = await variantProduct(A, 1);
    const o1 = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }]);
    const o2 = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }]);
    const rs = await Promise.allSettled([confirmOrder(o1, ownerA), confirmOrder(o2, ownerA)]);
    expect(rs.filter(r => r.status === "fulfilled").length).toBe(1);
    const rejected = rs.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StockShortfallError);
    expect([await vStock(P.a), [await status(o1), await status(o2)].sort()]).toEqual([0, ["confirmed", "new"]]);
    expect(await anyNegative()).toBe(0);
  });

  it("إلغاء وتعديل متزامنان لنفس الأوردر: لا استرجاع مكرر ولا سالب، والنتيجة النهائية متسقة مع البنود", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 4 }]);
    await confirmOrder(id, ownerA);
    await Promise.allSettled([
      cancelOrder(id, "x", undefined, ownerA),
      replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA)),
      cancelOrder(id, "x", undefined, ownerA),
    ]);
    expect(await status(id)).toBe("cancelled");
    expect(await vStock(P.a)).toBe(10);
  });

  it("سباق حتمي: تعديل ينتظر قفل الأوردر خلف إلغاء — بعد الإلغاء يقرأ الحركات الحالية لا لقطة قديمة (لا استرجاع زائد)", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 4 }]);
    await confirmOrder(id, ownerA);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    await q("START TRANSACTION");
    await q("SELECT id FROM orders WHERE id = ? FOR UPDATE", [id]); // نمسك القفل عشان نرتّب الطابور: إلغاء ثم تعديل
    const cancel = cancelOrder(id, "x", undefined, ownerA);
    await sleep(400);
    const edit = replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA));
    await sleep(400);
    await q("COMMIT");
    await Promise.allSettled([cancel, edit]);
    expect([await status(id), await vStock(P.a)]).toEqual(["cancelled", 10]);
  });

  it("عزل الشركات: صنف من شركة أخرى في محرر البنود أو التأكيد مرفوض، ومخزون الشركة الأخرى لا يتحرك", async () => {
    const PA = await variantProduct(A, 10);
    const PB = await variantProduct(B, 10);
    const id = await order(A, [{ productId: PA.p, variantId: PA.a, quantity: 1 }]);
    await confirmOrder(id, ownerA);
    const e = await failure(() => replaceOrderItemsFromEditor(id, [line(PB.p, PB.a, 2)], undefined, editor(ownerA)));
    expect(e).toBeInstanceOf(OrderConfirmBlockedError);
    expect([await vStock(PA.a), await vStock(PB.a), await pStock(PB.p)]).toEqual([9, 10, 100]);
    expect((await failure(() => editOrderFull(id, { productId: PB.p, variantId: PB.b }, editor(ownerA))))).toBeInstanceOf(OrderConfirmBlockedError);
    expect([await vStock(PB.b), await vStock(PA.a)]).toEqual([10, 9]);
    // أوردر جديد ببند من الشركة الأخرى لا يتأكد
    const id2 = await order(A, [{ productId: PB.p, variantId: PB.a, quantity: 1 }]);
    expect(await failure(() => confirmOrder(id2, ownerA))).toBeInstanceOf(OrderConfirmBlockedError);
    expect([await vStock(PB.a), await status(id2)]).toEqual([10, "new"]);
  });

  it("حركة يدوية مربوطة بالأوردر: قبل التأكيد = تعارض (CONFLICT) بلا تغيير كما كان؛ بعد التأكيد الإلغاء لا يرجّعها", async () => {
    const P = await variantProduct(A, 10);
    const manual = async (orderId: number) => {
      await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, 'out', 1, 'تالف أثناء التغليف', ?, ?)",
        [A.businessId, P.p, P.b, orderId, ownerA]);
      await q("UPDATE product_variants SET currentStock = currentStock - 1 WHERE id = ?", [P.b]);
    };
    const blocked = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await manual(blocked);
    expect(await failure(() => confirmOrder(blocked, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect([await vStock(P.a), await vStock(P.b), await status(blocked)]).toEqual([10, 9, "new"]);

    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    await manual(id);
    expect([await vStock(P.a), await vStock(P.b)]).toEqual([8, 8]);
    await replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA)); // المطابقة تتجاهل اليدوية
    expect([await vStock(P.a), await vStock(P.b)]).toEqual([9, 8]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect([await vStock(P.a), await vStock(P.b)]).toEqual([10, 8]);
  });

  it("Easy Order: نفس الأوردر الخارجي مرتين ثم ثلاث مرات بالتزامن = أوردر واحد فقط", async () => {
    const payload = (id: string): EasyOrderPayload => ({
      id, full_name: "عميل إيزي", phone: "01012345678", government: "الجيزة", address: "شارع النيل رقم 5 الدقي", total_cost: 350, shipping_cost: 50,
      updated_at: "2026-10-01T10:00:00Z", created_at: "2026-10-01T09:00:00Z",
      cart_items: [{ price: 300, quantity: 1, product: { name: "منتج غير مطابق" } }],
    });
    const up = (p: EasyOrderPayload) => upsertEasyOrder(p, { businessId: A.businessId, source: "easyorder" });
    const seqId = `EO-SEQ-${tmp.name}`.slice(0, 60);
    expect((await up(payload(seqId))).outcome).toBe("created");
    expect((await up(payload(seqId))).outcome).toBe("duplicate_unchanged");
    const raceId = `EO-RACE-${tmp.name}`.slice(0, 60);
    const rs = await Promise.all([up(payload(raceId)), up(payload(raceId)), up(payload(raceId))]);
    expect(rs.filter(r => r.outcome === "created").length).toBe(1);
    expect(new Set(rs.map(r => r.orderId)).size).toBe(1);
    for (const ext of [seqId, raceId])
      expect((await q("SELECT COUNT(*) AS n FROM orders WHERE businessId = ? AND externalOrderId = ?", [A.businessId, ext]))[0].n).toBe(1);
  });

  // ==================== مراجعة DATA-4 (v2) ====================

  /** لقطة كاملة لأي كتابة محتملة على الأوردر: الصف، البنود، المخزون، الحركات، السجلات. */
  async function fullSnapshot(orderId: number, variantIds: number[]) {
    return JSON.stringify({
      order: await q("SELECT * FROM orders WHERE id = ?", [orderId]),
      items: await q("SELECT productId, variantId, quantity, unitPrice, productName FROM order_items WHERE orderId = ? ORDER BY id", [orderId]),
      stock: await Promise.all(variantIds.map(vStock)),
      moves: await moveCount(orderId),
      activity: (await q("SELECT COUNT(*) AS n FROM activity_logs WHERE entityId = ?", [orderId]))[0].n,
      edits: (await q("SELECT COUNT(*) AS n FROM order_edit_logs WHERE orderId = ?", [orderId]))[0].n,
      returns: (await q("SELECT COUNT(*) AS n FROM returns WHERE orderId = ?", [orderId]))[0].n,
    });
  }

  it("D3 · facebookEntry.updateOrder على أوردر خارج من المخزون: تغيير الكمية/التركيبة/الصنف مرفوض بلا أي كتابة؛ نفس الأصناف + بيانات العميل مسموحة", async () => {
    const P = await variantProduct(A, 10);
    const S = await simpleProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { source: "facebook", lastUpdatedBy: ownerA });
    await confirmOrder(id, ownerA);
    const fb = async (sel: { productId: number; productName: string; quantity: number }[], variantId: number | undefined, name = "عميل") =>
      (await portal(ownerA)).facebookEntry.updateOrder({ orderId: id, customerName: name, customerPhone: "01012345678", governorate: "القاهرة",
        customerAddress: "شارع النيل رقم 5 الدقي", selectedProducts: sel, totalAmount: 200, variantId });
    const before = await fullSnapshot(id, [P.a, P.b]);
    for (const [label, call] of [
      ["كمية", () => fb([{ productId: P.p, productName: "x", quantity: 3 }], P.a)],
      ["تركيبة", () => fb([{ productId: P.p, productName: "x", quantity: 2 }], P.b)],
      ["صنف إضافي", () => fb([{ productId: P.p, productName: "x", quantity: 2 }, { productId: S, productName: "y", quantity: 1 }], P.a)],
    ] as const) {
      const e = await failure(call);
      expect(e?.code, label).toBe("BAD_REQUEST");
      expect(e?.message, label).toContain("الأوردر خرج من المخزون");
      expect(await fullSnapshot(id, [P.a, P.b]), label).toBe(before);
    }
    expect(await pStock(S)).toBe(10);
    await fb([{ productId: P.p, productName: "x", quantity: 2 }], P.a, "اسم مصحّح");
    expect((await q("SELECT customerName FROM orders WHERE id = ?", [id]))[0].customerName).toBe("اسم مصحّح");
    expect([await vStock(P.a), await q("SELECT variantId, quantity FROM order_items WHERE orderId = ?", [id])]).toEqual([8, [{ variantId: P.a, quantity: 2 }]]);
    // أوردر لسه جديد (مش خارج من المخزون): تغيير الأصناف مسموح زي ما كان، بلا حركة مخزون
    const fresh = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }], { source: "facebook", lastUpdatedBy: ownerA });
    await (await portal(ownerA)).facebookEntry.updateOrder({ orderId: fresh, customerName: "ع", customerPhone: "01012345678", governorate: "القاهرة",
      customerAddress: "شارع النيل رقم 5 الدقي", selectedProducts: [{ productId: P.p, productName: "x", quantity: 4 }], totalAmount: 400, variantId: P.b });
    expect([await q("SELECT variantId, quantity FROM order_items WHERE orderId = ?", [fresh]), await moveCount(fresh), await vStock(P.b)])
      .toEqual([[{ variantId: P.b, quantity: 4 }], 0, 10]);
  });

  it("D3 · تحديث Easy Order أحدث يغيّر أصناف أوردر مؤكد: البنود والمخزون كما هما، بيانات العميل تتحدّث، والأوردر يتعلّم للمراجعة", async () => {
    const P = await variantProduct(A, 10);
    const ext = `EO-LOCK-${tmp.name}`.slice(0, 60);
    const payload = (name: string, qty: number, at: string): EasyOrderPayload => ({
      id: ext, full_name: name, phone: "01012345678", government: "الجيزة", address: "شارع النيل رقم 5 الدقي", total_cost: 350, shipping_cost: 50,
      updated_at: at, created_at: "2026-10-01T09:00:00Z", cart_items: [{ price: 300, quantity: qty, product: { name: "منتج غير مطابق" } }],
    });
    const up = (p: EasyOrderPayload) => upsertEasyOrder(p, { businessId: A.businessId, source: "easyorder" });
    const c = await up(payload("عميل إيزي", 1, "2026-10-01T10:00:00Z"));
    const id = c.orderId!;
    // الموظف طابق البند على تركيبة وأكّد
    await q("UPDATE order_items SET productId = ?, variantId = ? WHERE orderId = ?", [P.p, P.a, id]);
    await q("UPDATE orders SET productId = ?, variantId = ?, needsReview = 0, reviewReason = NULL WHERE id = ?", [P.p, P.a, id]);
    await confirmOrder(id, ownerA);
    const u = await up(payload("اسم من الموقع", 3, "2026-10-01T11:00:00Z"));
    expect([u.outcome, u.needsReview, String(u.reviewReason)]).toEqual(["updated", true, expect.stringContaining("لم يُطبَّق")]);
    const o = (await q("SELECT customerName, productId, variantId, quantity, needsReview, reviewReason, status FROM orders WHERE id = ?", [id]))[0];
    expect([o.customerName, o.productId, o.variantId, o.quantity, Boolean(o.needsReview), o.status]).toEqual(["اسم من الموقع", P.p, P.a, 1, true, "confirmed"]);
    expect(o.reviewReason).toContain("لم يُطبَّق");
    expect(await q("SELECT productId, variantId, quantity FROM order_items WHERE orderId = ?", [id])).toEqual([{ productId: P.p, variantId: P.a, quantity: 1 }]);
    expect([await vStock(P.a), await moveCount(id)]).toEqual([9, 1]);
    await cancelOrder(id, "x", undefined, ownerA);
    expect(await vStock(P.a)).toBe(10);
  });

  it("الإلغاء لأوردر مسلَّم/مرتجع من كل نقاط الدخول: خطأ واضح، ولا تغيير في الصف أو البنود أو المخزون أو الحركات أو السجلات", async () => {
    const P = await variantProduct(A, 5);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    for (const s of ["delivered", "returned"]) {
      await q("UPDATE orders SET status = ? WHERE id = ?", [s, id]);
      const before = await fullSnapshot(id, [P.a]);
      const c = await portal(ownerA);
      const entries: [string, () => Promise<any>][] = [
        ["orders.cancel", () => c.orders.cancel({ orderId: id, cancelReason: "x" })],
        ["orders.update", () => c.orders.update({ id, status: "cancelled" })],
        ["employeePortal.cancel", () => c.employeePortal.cancel({ orderId: id, cancelReason: "x" })],
        ["employeePortal.updateStatus", () => c.employeePortal.updateStatus({ orderId: id, status: "cancelled", cancelReason: "x" })],
      ];
      for (const [name, call] of entries) {
        const e = await failure(call);
        expect(e?.code, `${s}/${name}`).toBe("BAD_REQUEST");
        expect(e?.message, `${s}/${name}`).toContain("لا يمكن إلغاء أوردر حالته");
        expect(await fullSnapshot(id, [P.a]), `${s}/${name}`).toBe(before);
      }
      const w = await applyExternalStatus(id, "cancelled");
      expect([w.ok, (w as any).reason]).toEqual([false, expect.stringContaining("لا يمكن إلغاء أوردر حالته")]);
      expect(await fullSnapshot(id, [P.a]), `${s}/webhook`).toBe(before);
      await expect(cancelOrder(id, "x", undefined, ownerA)).rejects.toThrow("لا يمكن إلغاء أوردر حالته");
      expect(await fullSnapshot(id, [P.a]), `${s}/db`).toBe(before);
    }
  });

  it("تاريخي · مرتجع قديم رجّع المخزون («مرتجع - أوردر»): جزء من الصافي — إعادة التفعيل تخصم من جديد والإلغاء يرجّع مرة واحدة", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    const on = (await q("SELECT orderNumber FROM orders WHERE id = ?", [id]))[0].orderNumber;
    await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, 'in', 2, ?, ?, ?)",
      [A.businessId, P.p, P.a, `مرتجع - أوردر ${on}`, id, ownerA]);
    await q("UPDATE product_variants SET currentStock = currentStock + 2 WHERE id = ?", [P.a]);
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [id]);
    await q("INSERT INTO returns (orderId, orderNumber, customerName, customerPhone, governorate, productName, quantity, totalAmount, returnReason, stockRestored, processedBy, businessId) VALUES (?, ?, 'c', '01012345678', 'القاهرة', 'x', 2, '100.00', 'قديم', 1, ?, ?)",
      [id, on, ownerA, A.businessId]);
    expect(await vStock(P.a)).toBe(10);
    await updateOrder(id, { status: "new" });
    await confirmOrder(id, ownerA);
    expect(await vStock(P.a)).toBe(8);
    await cancelOrder(id, "x", undefined, ownerA);
    expect(await vStock(P.a)).toBe(10);
  });

  it("تاريخي · مرتجع بلا إعادة للمخزون: مرتجع ← جديد = CONFLICT من كل المسارات بلا أي تغيير؛ وبيانات قديمة في «جديد» بمرتجع مسجّل = تأكيد/تعديل/إلغاء CONFLICT", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    await q("UPDATE orders SET status = 'shipped' WHERE id = ?", [id]);
    await (await portal(ownerA)).returns.markAsReturned({ orderId: id, returnReason: "رفض الاستلام" });
    const before = await fullSnapshot(id, [P.a, P.b]);
    expect(await failure(() => updateOrder(id, { status: "new" }))).toBeInstanceOf(OrderStockInconsistencyError);
    expect((await failure(async () => (await portal(ownerA)).orders.update({ id, status: "new" })))?.code).toBe("CONFLICT");
    expect((await failure(async () => (await portal(ownerA)).employeePortal.updateStatus({ orderId: id, status: "new" })))?.code).toBe("CONFLICT");
    expect((await applyExternalStatus(id, "new")).ok).toBe(false);
    expect(await fullSnapshot(id, [P.a, P.b])).toBe(before);
    // نفس الحالة لكن بيانات قديمة اتنقلت لـ«جديد» قبل الحارس (بلا دليل رجوع للمخزون)
    await q("UPDATE orders SET status = 'new' WHERE id = ?", [id]);
    const legacy = await fullSnapshot(id, [P.a, P.b]);
    expect((await failure(async () => (await portal(ownerA)).employeePortal.confirm({ orderId: id })))?.code).toBe("CONFLICT");
    expect(await failure(() => replaceOrderItemsFromEditor(id, [line(P.p, P.b, 1)], undefined, editor(ownerA)))).toBeInstanceOf(OrderStockInconsistencyError);
    expect((await failure(async () => (await portal(ownerA)).orders.editOrder({ orderId: id, quantity: 1 } as any)))?.code).toBe("CONFLICT");
    expect((await failure(async () => (await portal(ownerA)).orders.cancel({ orderId: id, cancelReason: "x" })))?.code).toBe("CONFLICT");
    expect(await fullSnapshot(id, [P.a, P.b])).toBe(legacy);
    expect(await vStock(P.a)).toBe(8);
  });

  it("تاريخي · صافي سالب (إرجاع أكتر من الخصم): التأكيد والتعديل والإلغاء تعارض بلا تغيير", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, 'in', 1, 'إلغاء أوردر قديم', ?, ?)",
      [A.businessId, P.p, P.a, id, ownerA]);
    const before = await fullSnapshot(id, [P.a]);
    expect(await failure(() => confirmOrder(id, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await failure(() => replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA)))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await failure(() => cancelOrder(id, "x", undefined, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await fullSnapshot(id, [P.a])).toBe(before);
  });

  it("تاريخي · حركات تأكيد مكررة (صافي أكبر من البنود): لا تسوية صامتة — التعديل والإلغاء وإعادة التأكيد CONFLICT بلا تغيير", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    for (let i = 0; i < 2; i++)
      await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, 'out', 2, 'تأكيد أوردر مكرر', ?, ?)",
        [A.businessId, P.p, P.a, id, ownerA]);
    await q("UPDATE product_variants SET currentStock = currentStock - 4 WHERE id = ?", [P.a]);
    await q("UPDATE orders SET status = 'confirmed' WHERE id = ?", [id]);
    await confirmOrder(id, ownerA); // مؤكد = idempotent، لا قراءة ولا كتابة مخزون
    const before = await fullSnapshot(id, [P.a]);
    expect(await failure(() => replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA)))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await failure(() => editOrderFull(id, { quantity: 1 }, editor(ownerA)))).toBeInstanceOf(OrderStockInconsistencyError);
    expect((await failure(async () => (await portal(ownerA)).orders.cancel({ orderId: id, cancelReason: "x" })))?.code).toBe("CONFLICT");
    expect((await applyExternalStatus(id, "cancelled")).ok).toBe(false);
    expect(await fullSnapshot(id, [P.a])).toBe(before);
    // بنود اتغيّرت من مسار قديم ماطابقش المخزون (الصافي على تركيبة والبند على تانية) = نفس التعارض
    const id2 = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }]);
    await confirmOrder(id2, ownerA);
    await q("UPDATE order_items SET variantId = ? WHERE orderId = ?", [P.b, id2]);
    const before2 = await fullSnapshot(id2, [P.a, P.b]);
    expect(await failure(() => cancelOrder(id2, "x", undefined, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await failure(() => replaceOrderItemsFromEditor(id2, [line(P.p, P.b, 2)], undefined, editor(ownerA)))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await fullSnapshot(id2, [P.a, P.b])).toBe(before2);
  });

  it("D4 · مرتجع مباشر من «مؤكد» أو «قيد التجهيز» بلا شحنة مرفوض بلا أي كتابة؛ بشحنة بوسطة مسموح (والمرتجع لا يرجّع للمخزون — السياسة)", async () => {
    const P = await variantProduct(A, 10);
    for (const st of ["confirmed", "preparing"]) {
      const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
      await confirmOrder(id, ownerA);
      await q("UPDATE orders SET status = ? WHERE id = ?", [st, id]);
      const before = await fullSnapshot(id, [P.a]);
      const e = await failure(async () => (await portal(ownerA)).returns.markAsReturned({ orderId: id, returnReason: "x" }));
      expect([e?.code, e?.message], st).toEqual(["BAD_REQUEST", expect.stringContaining("لم يُشحن")]);
      expect(await fullSnapshot(id, [P.a]), st).toBe(before);
      const stock = await vStock(P.a);
      await q("UPDATE orders SET bostaShipmentId = ? WHERE id = ?", [`SH-${id}`, id]);
      await (await portal(ownerA)).returns.markAsReturned({ orderId: id, returnReason: "رفض الاستلام" });
      expect([await status(id), await vStock(P.a)], st).toEqual(["returned", stock]);
    }
  });

  it("حارس التأجيل: من shipped/delivered/returned/cancelled مرفوض من كل المسارات بلا كتابة؛ من new/no_answer/confirmed مسموح والمخزون كما هو (D1)", async () => {
    const P = await variantProduct(A, 10);
    const when = new Date(Date.now() + 86_400_000);
    for (const st of ["shipped", "delivered", "returned", "cancelled"]) {
      const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }], { assignedEmployeeId: ownerA });
      await q("UPDATE orders SET status = ? WHERE id = ?", [st, id]);
      const before = await fullSnapshot(id, [P.a]);
      const c = await portal(ownerA);
      for (const [name, call] of [
        ["orders.postpone", () => c.orders.postpone({ orderId: id, postponedTo: when })],
        ["employeePortal.postpone", () => c.employeePortal.postpone({ orderId: id, postponedTo: when })],
        ["employeePortal.updateStatus", () => c.employeePortal.updateStatus({ orderId: id, status: "postponed", postponedTo: when })],
      ] as const) {
        const e = await failure(call);
        expect([e?.code, e?.message], `${st}/${name}`).toEqual(["BAD_REQUEST", expect.stringContaining("لا يمكن تأجيل أوردر")]);
        expect(await fullSnapshot(id, [P.a]), `${st}/${name}`).toBe(before);
      }
      expect(await failure(() => postponeOrder(id, when, undefined, ownerA)), st).not.toBeNull();
    }
    for (const st of ["new", "no_answer", "confirmed"]) {
      const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 1 }], { assignedEmployeeId: ownerA });
      if (st === "confirmed") await confirmOrder(id, ownerA); else await q("UPDATE orders SET status = ? WHERE id = ?", [st, id]);
      const stock = await vStock(P.a);
      await (await portal(ownerA)).orders.postpone({ orderId: id, postponedTo: when });
      expect([await status(id), await vStock(P.a)], st).toEqual(["postponed", stock]);
    }
  });

  it("حارس التأكيد: المسلَّم والمرتجع لا يُؤكَّدان (البوابة، الـWebhook، الدالة) بلا كتابة؛ وملغي ← جديد ← تأكيد يفضل شغال", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    for (const st of ["delivered", "returned"]) {
      await q("UPDATE orders SET status = ? WHERE id = ?", [st, id]);
      const before = await fullSnapshot(id, [P.a]);
      const c = await portal(ownerA);
      expect((await failure(() => c.employeePortal.confirm({ orderId: id })))?.code, st).toBe("BAD_REQUEST");
      expect((await failure(() => c.employeePortal.updateStatus({ orderId: id, status: "confirmed" })))?.code, st).toBe("BAD_REQUEST");
      expect((await applyExternalStatus(id, "confirmed")).ok, st).toBe(false);
      expect(await failure(() => confirmOrder(id, ownerA)), st).toBeInstanceOf(OrderConfirmBlockedError);
      expect(await fullSnapshot(id, [P.a]), st).toBe(before);
    }
    const re = await order(A, [{ productId: P.p, variantId: P.b, quantity: 3 }]);
    await confirmOrder(re, ownerA);
    await cancelOrder(re, "x", undefined, ownerA);
    await updateOrder(re, { status: "new" });
    await confirmOrder(re, ownerA);
    expect([await status(re), await vStock(P.b)]).toEqual(["confirmed", 7]);
  });

  it("createExternalOrderOnce · نفس الرقم الخارجي في نشاطين = أوردرين منفصلين؛ وتسليم أقدم وأحدث متزامنين = أوردر واحد بآخر بيانات", async () => {
    const payload = (id: string, name: string, at: string): EasyOrderPayload => ({
      id, full_name: name, phone: "01012345678", government: "الجيزة", address: "شارع النيل رقم 5 الدقي", total_cost: 350, shipping_cost: 50,
      updated_at: at, created_at: "2026-10-01T09:00:00Z", cart_items: [{ price: 300, quantity: 1, product: { name: "منتج غير مطابق" } }],
    });
    const shared = `EO-SHARED-${tmp.name}`.slice(0, 60);
    const [ra, rb] = await Promise.all([
      upsertEasyOrder(payload(shared, "عميل A", "2026-10-01T10:00:00Z"), { businessId: A.businessId, source: "easyorder" }),
      upsertEasyOrder(payload(shared, "عميل B", "2026-10-01T10:00:00Z"), { businessId: B.businessId, source: "easyorder" }),
    ]);
    expect([ra.outcome, rb.outcome]).toEqual(["created", "created"]);
    expect(ra.orderId).not.toBe(rb.orderId);
    const rows = await q("SELECT id, businessId, customerName FROM orders WHERE externalOrderId = ? ORDER BY businessId", [shared]);
    expect(rows.map((r: any) => [r.businessId, r.customerName])).toEqual([[A.businessId, "عميل A"], [B.businessId, "عميل B"]].sort((x, y) => x[0] - y[0]));

    for (let round = 0; round < 3; round++) {
      const ext = `EO-NEWER-${round}-${tmp.name}`.slice(0, 60);
      const rs = await Promise.all([
        upsertEasyOrder(payload(ext, "قديم", "2026-10-01T10:00:00Z"), { businessId: A.businessId, source: "easyorder" }),
        upsertEasyOrder(payload(ext, "أحدث", "2026-10-01T12:00:00Z"), { businessId: A.businessId, source: "easyorder" }),
      ]);
      expect(rs.filter(r => r.outcome === "created").length, `round ${round}`).toBe(1);
      expect(rs.every(r => ["created", "updated", "duplicate_unchanged"].includes(r.outcome)), JSON.stringify(rs)).toBe(true);
      expect(new Set(rs.map(r => r.orderId)).size).toBe(1);
      const found = await q("SELECT id, customerName FROM orders WHERE businessId = ? AND externalOrderId = ?", [A.businessId, ext]);
      expect([found.length, found[0].id, found[0].customerName], `round ${round}`).toEqual([1, rs[0].orderId, "أحدث"]);
    }
  });

  it("تزامن facebookEntry.updateOrder مع محرر البنود لنفس الأوردر المؤكد: لا تحديث ضايع ولا فرق مخزون (عشوائي + ترتيب حتمي بالاتجاهين)", async () => {
    const P = await variantProduct(A, 50);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const fbCall = (id: number, name: string, qty: number) => async () => (await portal(ownerA)).facebookEntry.updateOrder({ orderId: id, customerName: name,
      customerPhone: "01012345678", governorate: "القاهرة", customerAddress: "شارع النيل رقم 5 الدقي",
      selectedProducts: [{ productId: P.p, productName: "x", quantity: qty }], totalAmount: 200, variantId: P.a });
    /** الثابت: المخزون + صافي الأوردر = البداية، والبنود = الصافي، والاسم = آخر كتابة ناجحة. */
    const check = async (id: number, fbOk: boolean, label: string) => {
      const items = await q("SELECT variantId, quantity FROM order_items WHERE orderId = ?", [id]);
      const net = Number((await q("SELECT COALESCE(SUM(CASE WHEN type = 'out' THEN quantity ELSE -quantity END), 0) AS n FROM inventory_movements WHERE orderId = ?", [id]))[0].n);
      const name = (await q("SELECT customerName FROM orders WHERE id = ?", [id]))[0].customerName;
      expect(items, label).toEqual([{ variantId: P.a, quantity: 1 }]); // تعديل المحرر مابيضيعش أبدًا
      expect(net, label).toBe(1);
      expect(name, label).toBe(fbOk ? "اسم من فيسبوك" : "عميل");
      return net;
    };
    let base = await vStock(P.a);
    for (let round = 0; round < 4; round++) {
      const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { source: "facebook", lastUpdatedBy: ownerA });
      await confirmOrder(id, ownerA);
      const [fb] = await Promise.allSettled([fbCall(id, "اسم من فيسبوك", 2)(), replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA))]);
      // فيسبوك إمّا سبق (نفس الأصناف → نجح) أو جه بعد المحرر (الأصناف اختلفت → رفض صريح BAD_REQUEST، مش كتابة صامتة)
      if (fb.status === "rejected") expect((fb.reason as any)?.code, `round ${round}`).toBe("BAD_REQUEST");
      base -= await check(id, fb.status === "fulfilled", `round ${round}`);
      expect(await vStock(P.a), `round ${round}`).toBe(base);
    }
    for (const fbFirst of [true, false]) {
      const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { source: "facebook", lastUpdatedBy: ownerA });
      await confirmOrder(id, ownerA);
      await q("START TRANSACTION");
      await q("SELECT id FROM orders WHERE id = ? FOR UPDATE", [id]);
      const first = fbFirst ? fbCall(id, "اسم من فيسبوك", 2)() : replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA));
      await sleep(400);
      const second = fbFirst ? replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA)) : fbCall(id, "اسم من فيسبوك", 2)();
      await sleep(400);
      await q("COMMIT");
      const [r1, r2] = await Promise.allSettled([first, second]);
      const fb = fbFirst ? r1 : r2;
      expect(fb.status, `fbFirst=${fbFirst}`).toBe(fbFirst ? "fulfilled" : "rejected");
      if (!fbFirst) expect(((fb as PromiseRejectedResult).reason as any)?.code).toBe("BAD_REQUEST");
      base -= await check(id, fbFirst, `fbFirst=${fbFirst}`);
      expect(await vStock(P.a), `fbFirst=${fbFirst}`).toBe(base);
    }
  });

  it("Easy Order — إعادة المحاولة محصورة في تصادم رقم الأوردر: خطأ قاعدة بيانات عام = محاولة واحدة و«failed»؛ التصادم يُعاد حتى 3 مرات", async () => {
    const payload = (id: string): EasyOrderPayload => ({
      id, full_name: "عميل", phone: "01012345678", government: "الجيزة", address: "شارع النيل رقم 5 الدقي", total_cost: 350, shipping_cost: 50,
      updated_at: "2026-10-01T10:00:00Z", created_at: "2026-10-01T09:00:00Z", cart_items: [{ price: 300, quantity: 1, product: { name: "منتج غير مطابق" } }],
    });
    const up = (ext: string) => upsertEasyOrder(payload(ext), { businessId: A.businessId, source: "easyorder" });
    // عدّاد محاولات في جدول MyISAM (مش بيترجع مع rollback) + Trigger يرمي الخطأ المطلوب على أوردرات الاختبار ده بس
    await q("CREATE TABLE d4_attempts (ext VARCHAR(80)) ENGINE=MyISAM");
    const trigger = (body: string) => q(`CREATE TRIGGER d4_eo_fail BEFORE INSERT ON orders FOR EACH ROW BEGIN
      IF NEW.externalOrderId LIKE 'EO-RTY-%' THEN INSERT INTO d4_attempts VALUES (NEW.externalOrderId); ${body} END IF; END`);
    const attempts = async (ext: string) => Number((await q("SELECT COUNT(*) AS n FROM d4_attempts WHERE ext = ?", [ext]))[0].n);
    const count = async (ext: string) => Number((await q("SELECT COUNT(*) AS n FROM orders WHERE externalOrderId = ?", [ext]))[0].n);
    const DUP = "SIGNAL SQLSTATE '23000' SET MYSQL_ERRNO = 1062, MESSAGE_TEXT = 'Duplicate entry for key orders.orders_orderNumber_unique';";
    try {
      await trigger("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'generic db failure';");
      const g = `EO-RTY-GEN-${tmp.name}`.slice(0, 60);
      const rg = await up(g);
      expect(rg.outcome).toBe("failed");
      expect([await attempts(g), await count(g)]).toEqual([1, 0]);
      await q("DROP TRIGGER d4_eo_fail");

      await trigger(`IF (SELECT COUNT(*) FROM d4_attempts WHERE ext = NEW.externalOrderId) <= 2 THEN ${DUP} END IF;`);
      const c = `EO-RTY-COL-${tmp.name}`.slice(0, 60);
      const rc = await up(c);
      expect([rc.outcome, await attempts(c), await count(c)]).toEqual(["created", 3, 1]);
      await q("DROP TRIGGER d4_eo_fail");

      await trigger(DUP);
      const x = `EO-RTY-MAX-${tmp.name}`.slice(0, 60);
      const rx = await up(x);
      expect([rx.outcome, await attempts(x), await count(x)]).toEqual(["failed", 3, 0]);
    } finally {
      await q("DROP TRIGGER IF EXISTS d4_eo_fail");
      await q("DROP TABLE IF EXISTS d4_attempts");
    }
  });

  // ==================== DATA-4 v4: ما بعد الشحن ====================

  it("بعد الشحن · إلغاء أوردر shipped مرفوض من كل نقاط الدخول (الراوتر، البوابة، الـWebhook، الدالة، وحدث «ملغي» من بوسطة) بلا أي كتابة", async () => {
    const P = await variantProduct(A, 10);
    const sid = `SH-CAN-${tmp.name}`.slice(0, 60);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    await q("UPDATE orders SET status = 'shipped', bostaShipmentId = ? WHERE id = ?", [sid, id]);
    const before = await fullSnapshot(id, [P.a]);
    const c = await portal(ownerA);
    for (const [name, call] of [
      ["orders.cancel", () => c.orders.cancel({ orderId: id, cancelReason: "x" })],
      ["orders.update", () => c.orders.update({ id, status: "cancelled" })],
      ["employeePortal.cancel", () => c.employeePortal.cancel({ orderId: id, cancelReason: "x" })],
      ["employeePortal.updateStatus", () => c.employeePortal.updateStatus({ orderId: id, status: "cancelled", cancelReason: "x" })],
    ] as const) {
      const e = await failure(call);
      expect([e?.code, e?.message], name).toEqual(["BAD_REQUEST", expect.stringContaining("لا يمكن إلغاء أوردر اتشحن")]);
      expect(await fullSnapshot(id, [P.a]), name).toBe(before);
    }
    const w = await applyExternalStatus(id, "cancelled");
    expect([w.ok, (w as any).reason]).toEqual([false, expect.stringContaining("لا يمكن إلغاء أوردر اتشحن")]);
    await expect(cancelOrder(id, "x", undefined, ownerA)).rejects.toThrow("لا يمكن إلغاء أوردر اتشحن");
    expect(await fullSnapshot(id, [P.a])).toBe(before);
    // بوسطة «ملغية» (49): مراجعة فقط — لا تغيير حالة ولا مخزون
    const ev = normalizeBostaEvent({ _id: sid, trackingNumber: 1, state: 49, type: "SEND", timeStamp: Date.now() });
    expect(ev.ok).toBe(true);
    await applyBostaEvent(A.businessId, (ev as any).event);
    expect([await status(id), await vStock(P.a), await moveCount(id)]).toEqual(["shipped", 8, 1]);
  });

  it("بعد الشحن · تأكيد أوردر shipped (انتقال للخلف) مرفوض من كل نقاط الدخول بلا أي كتابة", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    await q("UPDATE orders SET status = 'shipped' WHERE id = ?", [id]);
    const before = await fullSnapshot(id, [P.a]);
    const c = await portal(ownerA);
    for (const [name, call] of [
      ["orders.confirm", () => c.orders.confirm({ orderId: id })],
      ["orders.update", () => c.orders.update({ id, status: "confirmed" })],
      ["employeePortal.confirm", () => c.employeePortal.confirm({ orderId: id })],
      ["employeePortal.updateStatus", () => c.employeePortal.updateStatus({ orderId: id, status: "confirmed" })],
    ] as const) {
      const e = await failure(call);
      expect(e?.code, name).toBe("BAD_REQUEST");
      expect(await fullSnapshot(id, [P.a]), name).toBe(before);
    }
    expect((await applyExternalStatus(id, "confirmed")).ok).toBe(false);
    expect(await failure(() => confirmOrder(id, ownerA))).toBeInstanceOf(OrderConfirmBlockedError);
    expect(await fullSnapshot(id, [P.a])).toBe(before);
    expect([await status(id), await vStock(P.a)]).toEqual(["shipped", 8]);
  });

  it("للخلف · تأكيد أوردر printed مرفوض من كل نقاط الدخول بلا أي كتابة؛ و«قيد التجهيز ← مؤكد» (تصحيح في الجدول) باقٍ", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    await q("UPDATE orders SET status = 'printed' WHERE id = ?", [id]);
    const before = await fullSnapshot(id, [P.a]);
    const c = await portal(ownerA);
    for (const [name, call] of [
      ["orders.confirm", () => c.orders.confirm({ orderId: id })],
      ["orders.update", () => c.orders.update({ id, status: "confirmed" })],
      ["employeePortal.confirm", () => c.employeePortal.confirm({ orderId: id })],
      ["employeePortal.updateStatus", () => c.employeePortal.updateStatus({ orderId: id, status: "confirmed" })],
    ] as const) {
      expect((await failure(call))?.code, name).toBe("BAD_REQUEST");
      expect(await fullSnapshot(id, [P.a]), name).toBe(before);
    }
    expect((await applyExternalStatus(id, "confirmed")).ok).toBe(false);
    expect(await failure(() => confirmOrder(id, ownerA))).toBeInstanceOf(OrderConfirmBlockedError);
    expect(await fullSnapshot(id, [P.a])).toBe(before);
    expect([await status(id), await vStock(P.a)]).toEqual(["printed", 8]);
    // preparing ← confirmed مسموح في الجدول: إعادة التأكيد بلا خصم جديد
    await q("UPDATE orders SET status = 'preparing' WHERE id = ?", [id]);
    await confirmOrder(id, ownerA);
    expect([await status(id), await vStock(P.a), await moveCount(id)]).toEqual(["confirmed", 8, 1]);
  });

  it("سياسة المرتجع · «مرتجع» من بوسطة لا يرجّع المخزون (الشحنة ليست دليل وصول للمخزن)، وإعادة تفعيله بعدها CONFLICT", async () => {
    const P = await variantProduct(A, 10);
    const sid = `SH-RET-${tmp.name}`.slice(0, 60);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    await q("UPDATE orders SET status = 'shipped', bostaShipmentId = ? WHERE id = ?", [sid, id]);
    const ev = normalizeBostaEvent({ _id: sid, trackingNumber: 2, state: 46, type: "SEND", timeStamp: Date.now() });
    await applyBostaEvent(A.businessId, (ev as any).event);
    expect([await status(id), await vStock(P.a), await moveCount(id)]).toEqual(["returned", 8, 1]);
    expect((await q("SELECT COUNT(*) AS n FROM returns WHERE orderId = ?", [id]))[0].n).toBe(0);
    const before = await fullSnapshot(id, [P.a]);
    expect((await failure(async () => (await portal(ownerA)).employeePortal.updateStatus({ orderId: id, status: "new" })))?.code).toBe("CONFLICT");
    expect((await failure(async () => (await portal(ownerA)).orders.cancel({ orderId: id, cancelReason: "x" })))?.code).toBe("BAD_REQUEST");
    expect(await fullSnapshot(id, [P.a])).toBe(before);
  });

  it("الثقة في الصافي · أسباب تاريخية معروفة وسليمة لا توقف الأوردر: خصم تركيبة + فروق المحرر القديم على الأب، وخصم أب + تعديل أب قديم", async () => {
    const P = await variantProduct(A, 10);
    const mv = (orderId: number, variantId: number | null, type: "in" | "out", qty: number, reason: string) =>
      q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [A.businessId, P.p, variantId, type, qty, reason, orderId, ownerA]);
    // (أ) تأكيد على التركيبة ×2 ثم المحرر القديم زوّد لـ3 بحركة على الأب (كل حركة غيّرت رصيدها مرة واحدة)
    const a = await order(A, [{ productId: P.p, variantId: P.a, quantity: 3 }]);
    await mv(a, P.a, "out", 2, "تأكيد أوردر قديم"); await q("UPDATE product_variants SET currentStock = currentStock - 2 WHERE id = ?", [P.a]);
    await mv(a, null, "out", 1, "تعديل بنود أوردر قديم"); await q("UPDATE products SET currentStock = currentStock - 1 WHERE id = ?", [P.p]);
    await q("UPDATE orders SET status = 'confirmed' WHERE id = ?", [a]);
    await replaceOrderItemsFromEditor(a, [line(P.p, P.a, 2)], undefined, editor(ownerA)); // = عكس المسجّل + خصم البنود
    expect([await vStock(P.a), await pStock(P.p)]).toEqual([8, 100]);
    await cancelOrder(a, "x", undefined, ownerA);
    expect([await vStock(P.a), await pStock(P.p)]).toEqual([10, 100]);
    // (ب) عصر الأب: تأكيد ×2 + «تعديل أوردر - إرجاع قديم/خصم جديد» لـ3، كله على الأب
    const b = await order(A, [{ productId: P.p, variantId: P.b, quantity: 3 }]);
    await mv(b, null, "out", 2, "تأكيد أوردر قديم");
    await mv(b, null, "in", 2, "تعديل أوردر X - إرجاع قديم");
    await mv(b, null, "out", 3, "تعديل أوردر X - خصم جديد");
    await q("UPDATE products SET currentStock = currentStock - 3 WHERE id = ?", [P.p]);
    await q("UPDATE orders SET status = 'confirmed' WHERE id = ?", [b]);
    await cancelOrder(b, "x", undefined, ownerA);
    expect([await pStock(P.p), await vStock(P.b)]).toEqual([100, 10]);
  });

  it("الثقة في الصافي · فروق مشكوك فيها لا تُسوّى صامتًا: مرتجع رجّع جزء بس، وخصم تركيبة أكبر من بندها حتى لو الإجمالي مطابق", async () => {
    const P = await variantProduct(A, 10);
    // (أ) مرتجع قديم رجّع 1 من 2 بحركة مسجّلة
    const a = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(a, ownerA);
    const on = (await q("SELECT orderNumber FROM orders WHERE id = ?", [a]))[0].orderNumber;
    await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, 'in', 1, ?, ?, ?)",
      [A.businessId, P.p, P.a, `مرتجع - أوردر ${on}`, a, ownerA]);
    await q("UPDATE product_variants SET currentStock = currentStock + 1 WHERE id = ?", [P.a]);
    await q("INSERT INTO returns (orderId, orderNumber, customerName, customerPhone, governorate, productName, quantity, totalAmount, returnReason, stockRestored, processedBy, businessId) VALUES (?, ?, 'c', '01012345678', 'القاهرة', 'x', 2, '100.00', 'جزئي', 1, ?, ?)",
      [a, on, ownerA, A.businessId]);
    await q("UPDATE orders SET status = 'new' WHERE id = ?", [a]);
    const beforeA = await fullSnapshot(a, [P.a]);
    expect(await failure(() => confirmOrder(a, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await failure(() => cancelOrder(a, "x", undefined, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await fullSnapshot(a, [P.a])).toBe(beforeA);
    // (ب) الصافي A ×2 + B ×1 والبنود A ×1 + B ×2 (نفس الإجمالي، توزيع مختلف — بند اتعدّل بلا مطابقة)
    const b = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }, { productId: P.p, variantId: P.b, quantity: 1 }]);
    await confirmOrder(b, ownerA);
    await q("UPDATE order_items SET quantity = 3 - quantity WHERE orderId = ?", [b]);
    const beforeB = await fullSnapshot(b, [P.a, P.b]);
    expect(await failure(() => cancelOrder(b, "x", undefined, ownerA))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await failure(() => replaceOrderItemsFromEditor(b, [line(P.p, P.a, 1)], undefined, editor(ownerA)))).toBeInstanceOf(OrderStockInconsistencyError);
    expect(await fullSnapshot(b, [P.a, P.b])).toBe(beforeB);
  });

  // ==================== DATA-4 v6: ذرية الإلغاء + idempotency + المختلط ====================

  it("ذرية · «ملغي» مع حقول تانية من updateOrder/orders.update في معاملة واحدة: فشل الحقول = Rollback للإلغاء وإرجاع المخزون؛ النجاح = كتابة واحدة", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }]);
    await confirmOrder(id, ownerA);
    const before = await fullSnapshot(id, [P.a]);
    const tooLong = "س".repeat(150); // customerName varchar(100) — يفشل في نفس الـUPDATE بعد حركات الإرجاع
    expect(await failure(() => updateOrder(id, { status: "cancelled", customerName: tooLong } as any))).not.toBeNull();
    expect(await failure(async () => (await portal(ownerA)).orders.update({ id, status: "cancelled", customerName: tooLong }))).not.toBeNull();
    expect(await fullSnapshot(id, [P.a])).toBe(before);
    expect([await status(id), await vStock(P.a), await moveCount(id)]).toEqual(["confirmed", 8, 1]);
    await (await portal(ownerA)).orders.update({ id, status: "cancelled", customerName: "اسم بعد الإلغاء", customerPhone: "+201012345678" });
    const o = (await q("SELECT status, customerName, customerPhone, cancelledAt FROM orders WHERE id = ?", [id]))[0];
    expect([o.status, o.customerName, o.customerPhone, o.cancelledAt != null]).toEqual(["cancelled", "اسم بعد الإلغاء", "01012345678", true]);
    expect([await vStock(P.a), await moveCount(id)]).toEqual([10, 2]);
  });

  it("idempotency (الأحداث معطّلة) · إلغاء أوردر ملغي من كل المسارات = صفر، بلا حركة ولا إعادة كتابة لطابع/سبب الإلغاء؛ وحقول الهيدر التانية بس تتكتب", async () => {
    const P = await variantProduct(A, 10);
    const id = await order(A, [{ productId: P.p, variantId: P.a, quantity: 2 }], { assignedEmployeeId: ownerA });
    await confirmOrder(id, ownerA);
    expect((await cancelOrder(id, "سبب أول", undefined, ownerA)).restoredQuantity).toBe(2);
    await q("UPDATE orders SET cancelledAt = '2020-06-15 12:00:00' WHERE id = ?", [id]); // طابع ثابت قديم يكشف أي إعادة كتابة
    const before = await fullSnapshot(id, [P.a]);
    expect((await cancelOrder(id, "سبب تاني", "ملاحظة", ownerA)).restoredQuantity).toBe(0);
    const c = await portal(ownerA);
    await c.orders.cancel({ orderId: id, cancelReason: "سبب تالت" });
    await c.employeePortal.cancel({ orderId: id, cancelReason: "سبب رابع" });
    expect((await c.employeePortal.updateStatus({ orderId: id, status: "cancelled", cancelReason: "x" })).unchanged).toBe(true);
    expect((await applyExternalStatus(id, "cancelled")).ok).toBe(true);
    await updateOrder(id, { status: "cancelled" });
    // كل حاجة زي ما هي (الصف، البنود، المخزون، الحركات، سجل التعديل، المرتجعات) — ما عدا سطر activity_logs اللي الراوتر
    // بيكتبه لكل نداء إلغاء (سلوك قديم في الراوتر، مش حدث أوردر ولا حركة)
    const noActivity = (x: string) => x.replace(/"activity":\d+,/, "");
    expect(noActivity(await fullSnapshot(id, [P.a]))).toBe(noActivity(before));
    const o = (await q("SELECT cancelReason, cancelledAt FROM orders WHERE id = ?", [id]))[0];
    expect([o.cancelReason, new Date(o.cancelledAt).getUTCFullYear(), await vStock(P.a), await moveCount(id)]).toEqual(["سبب أول", 2020, 10, 2]);
    await updateOrder(id, { status: "cancelled", customerName: "تصحيح اسم" } as any);
    expect([(await q("SELECT customerName, cancelReason FROM orders WHERE id = ?", [id]))[0].customerName, await moveCount(id)]).toEqual(["تصحيح اسم", 2]);
  });

  it("مختلط أب/تركيبات · عدم يقين حقيقي = CONFLICT في التعديل والإلغاء وإعادة التأكيد بلا أي تغيير", async () => {
    const P = await variantProduct(A, 20);
    const vC = (await createProductWithVariants(A.businessId, { name: `تالت ${++seq}` }, [{ sku: `C${seq}-${tmp.name}`.slice(0, 50), color: "أحمر", currentStock: 20 } as any])).variantIds[0];
    const mv = (orderId: number, productId: number, variantId: number | null, type: "in" | "out", qty: number) =>
      q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, ?, ?, 'تأكيد أوردر قديم', ?, ?)",
        [A.businessId, productId, variantId, type, qty, orderId, ownerA]);
    const cases: [string, { productId: number; variantId: number; quantity: number }[], (id: number) => Promise<void>][] = [
      ["تركيبة محسوبة أكتر من بندها + باقي على الأب", [{ productId: P.p, variantId: P.a, quantity: 1 }, { productId: P.p, variantId: P.b, quantity: 2 }],
        async id => { await mv(id, P.p, P.a, "out", 2); await mv(id, P.p, null, "out", 1); }],
      ["تركيبة مش في البنود + الأب", [{ productId: P.p, variantId: P.a, quantity: 2 }],
        async id => { await mv(id, P.p, P.b, "out", 1); await mv(id, P.p, null, "out", 1); }],
      ["الأب سالب + تركيبة", [{ productId: P.p, variantId: P.a, quantity: 1 }],
        async id => { await mv(id, P.p, P.a, "out", 2); await mv(id, P.p, null, "in", 1); }],
      ["إجمالي (تركيبة + أب) أكبر من البنود", [{ productId: P.p, variantId: P.a, quantity: 2 }],
        async id => { await mv(id, P.p, P.a, "out", 1); await mv(id, P.p, null, "out", 2); }],
      ["خصم أب لمنتج والبند منتج تاني", [{ productId: P.p, variantId: P.a, quantity: 1 }],
        async id => { const other = (await q("SELECT productId FROM product_variants WHERE id = ?", [vC]))[0].productId; await mv(id, other, null, "out", 1); }],
    ];
    for (const [label, lines, seed] of cases) {
      for (const st of ["confirmed", "new"]) {
        const id = await order(A, lines);
        await seed(id);
        await q("UPDATE orders SET status = ? WHERE id = ?", [st, id]);
        const before = await fullSnapshot(id, [P.a, P.b, vC]);
        const parent = await pStock(P.p);
        if (st === "new") expect(await failure(() => confirmOrder(id, ownerA)), `${label}/${st}/confirm`).toBeInstanceOf(OrderStockInconsistencyError);
        expect(await failure(() => replaceOrderItemsFromEditor(id, [line(P.p, P.a, 1)], undefined, editor(ownerA))), `${label}/${st}/edit`).toBeInstanceOf(OrderStockInconsistencyError);
        expect(await failure(() => cancelOrder(id, "x", undefined, ownerA)), `${label}/${st}/cancel`).toBeInstanceOf(OrderStockInconsistencyError);
        expect(await fullSnapshot(id, [P.a, P.b, vC]), `${label}/${st}`).toBe(before);
        expect(await pStock(P.p), `${label}/${st}/parent`).toBe(parent);
      }
    }
  });

  it("بعد كل السيناريوهات: لا مخزون سالب في أي تركيبة أو منتج", async () => {
    expect(await anyNegative()).toBe(0);
  });
});

/**
 * نفس قواعد الإلغاء مع سجل الأحداث **مفعّل** (0041 مطبّقة على قاعدة مؤقتة فقط): الإلغاء المتكرر صفر بلا حركة ولا حدث،
 * والـReplay بنفس العملية لا يغيّر شيئًا، و«ملغي» + حقول تانية ذرّي (فشلها = لا إلغاء ولا حدث ولا إرجاع مخزون).
 */
describe.runIf(CAN)("🔑 DATA-4 — الإلغاء مع سجل الأحداث مفعّل", { timeout: 30_000 }, () => {
  let tmp: TempSchema; let F: CoreTestFixture; let owner = 0; let seq = 0;
  const savedFlag = process.env.ORDER_EVENTS_ENABLED;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const op = () => `op${Math.random().toString(36).slice(2, 14)}`;
  const snap = async (orderId: number, variantId: number) => JSON.stringify({
    order: await q("SELECT * FROM orders WHERE id = ?", [orderId]),
    items: await q("SELECT productId, variantId, quantity FROM order_items WHERE orderId = ?", [orderId]),
    stock: (await q("SELECT currentStock FROM product_variants WHERE id = ?", [variantId]))[0].currentStock,
    moves: await q("SELECT type, quantity, reason FROM inventory_movements WHERE orderId = ? ORDER BY id", [orderId]),
    events: await q("SELECT eventType, idempotencyKey, payloadHash FROM order_activity_events WHERE orderId = ? ORDER BY id", [orderId]),
  });
  async function confirmedOrder() {
    const k = ++seq;
    const r = await createProductWithVariants(F.businessId, { name: `ev ${k}` }, [{ sku: `EV${k}-${tmp.name}`.slice(0, 50), color: "ذهبي", currentStock: 10 } as any]);
    const id = (await createOrderWithItems({ businessId: F.businessId, orderNumber: `EV${tmp.name.slice(-6)}${k}`.slice(0, 20), customerName: "عميل",
      customerPhone: "01012345678", customerAddress: "شارع النيل رقم 5 الدقي", governorate: "القاهرة", productName: "x", productId: r.productId,
      variantId: r.variantIds[0], quantity: 2, totalAmount: "100.00", status: "new", source: "manual", assignedEmployeeId: owner } as any,
      [{ productId: r.productId, variantId: r.variantIds[0], productName: "x", quantity: 2, unitPrice: 50 }]))!;
    await (await portal(owner)).employeePortal.confirm({ orderId: id, operationId: op() });
    return { id, v: r.variantIds[0] };
  }

  beforeAll(async () => {
    tmp = await createTempSchema("data4_ev");
    const r = await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8"),
      deployEnv: "test", confirm: confirmPhrase("0041", "apply", tmp.name) });
    expect(r.ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    F = await createCoreTestFixture("d4-ev");
    owner = insId(await createEmployee({ name: "owner-ev", role: "super_admin", isActive: true, tenantId: F.tenantId, businessId: F.businessId,
      username: `ev_${tmp.name}`.slice(0, 50), passwordHash: "hash" } as any));
    process.env.ORDER_EVENTS_ENABLED = "true";
  }, 180_000);
  afterAll(async () => {
    if (savedFlag == null) delete process.env.ORDER_EVENTS_ENABLED; else process.env.ORDER_EVENTS_ENABLED = savedFlag;
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("إلغاء متكرر من كل المسارات + Replay = صفر، بلا حركة ولا حدث ولا إعادة كتابة", async () => {
    const { id, v } = await confirmedOrder();
    const first = op();
    const c = await portal(owner);
    await c.employeePortal.cancel({ orderId: id, cancelReason: "سبب أول", operationId: first });
    const after = await snap(id, v);
    expect(JSON.parse(after).events.map((e: any) => e.eventType)).toEqual(["confirm", "cancel"]);
    expect([JSON.parse(after).stock, JSON.parse(after).moves.length]).toEqual([10, 2]);
    await c.employeePortal.cancel({ orderId: id, cancelReason: "سبب أول", operationId: first }); // Replay
    await c.employeePortal.cancel({ orderId: id, cancelReason: "سبب تاني", operationId: op() });
    await c.orders.cancel({ orderId: id, cancelReason: "سبب تالت", operationId: op() });
    await c.orders.update({ id, status: "cancelled", operationId: op() });
    expect((await applyExternalStatus(id, "cancelled")).ok).toBe(true);
    expect((await cancelOrder(id, "مباشر", undefined, owner, { actor: { type: "employee" as const, employeeId: owner, role: "super_admin", name: "owner-ev" }, source: "employee_portal" as const, operationId: op() })).restoredQuantity).toBe(0);
    expect(await snap(id, v)).toBe(after);
  });

  it("«ملغي» + حقول تانية ذرّي مع الأحداث: فشل الحقول = لا إلغاء ولا حدث ولا إرجاع مخزون", async () => {
    const { id, v } = await confirmedOrder();
    const before = await snap(id, v);
    const e = await failure(async () => (await portal(owner)).orders.update({ id, status: "cancelled", customerName: "س".repeat(150), operationId: op() }));
    expect(e).not.toBeNull();
    expect(await snap(id, v)).toBe(before);
    await (await portal(owner)).orders.update({ id, status: "cancelled", customerName: "اسم جديد", operationId: op() });
    const s = JSON.parse(await snap(id, v));
    expect([s.order[0].status, s.order[0].customerName, s.stock, s.events.map((x: any) => x.eventType)]).toEqual(["cancelled", "اسم جديد", 10, ["confirm", "cancel"]]);
  });
});
