import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { COOKIE_NAME } from "@shared/const";
import {
  getDb, createEmployee, createProductWithVariants, insertOrderWithItems, setOrderEntryMode, markOrdersAsPrinted, updateOrderWithItems,
} from "./db";
import {
  orders, orderItems, inventoryMovements, products, productVariants, employees, activityLogs, orderEditLogs, returns, webhookLogs, salesChannels,
} from "../drizzle/schema";
import { registerWebhookRoutes } from "./easyorderWebhook";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Rollback-Safe — end-to-end على MySQL اختبار: كل مسار خطر (Admin API، بوابة الموظف، الحذف
 * الجماعي، المرتجعات، حل المراجعة، ويبهوك Easy Order، تحديث البنود من التكاملات) بيترفض
 * PRECONDITION_FAILED، والرفض **مابيغيّرش أي حاجة**: صف الأوردر (حتى updatedAt)، البنود، الحركات،
 * أرصدة التركيبات والمنتجات، سجل الأنشطة، سجل التعديلات، المرتجعات. والمسارات الآمنة شغالة زي ما هي.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🛡️ Rollback-Safe — رفض المسارات الخطرة بلا أي أثر، والآمنة شغالة", { timeout: 120_000 }, () => {
  let F: CoreTestFixture;
  const tag = `${Date.now()}`.slice(-8);
  const ids = { orderIds: [] as number[], productIds: [] as number[], empIds: [] as number[], channelId: 0 };
  let owner = 0, agent = 0, prodV = 0, v1 = 0, v2 = 0, prodS = 0;
  let seq = 0;
  const secret = `rs-secret-${tag}-${Math.random().toString(36).slice(2, 10)}`;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const res = { clearCookie: () => {}, cookie: () => {} };
  const asAdmin = async (id = owner) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: jwt.sign({ employeeId: id }, process.env.JWT_SECRET as string) } }, res } as any));
  const asPortal = async (id = agent) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: id }, process.env.JWT_SECRET as string) } }, res } as any));
  const db = async () => (await getDb())!;
  const CUST = { customerName: "عميل رجوع آمن", customerPhone: "01000000777", customerAddress: "شارع الاختبار 12 - الدور 3 - شقة 5", governorate: "القاهرة" };

  type L = { productId: number; variantId: number | null; qty: number; price?: number };
  async function mkOrder(lines: L[], extra: Record<string, any> = {}): Promise<number> {
    const head = lines[0];
    const id = await insertOrderWithItems(
      {
        ...CUST, orderNumber: `RS-${tag}-${++seq}`, businessId: F.businessId, source: "manual", status: "new",
        productId: head.productId, variantId: head.variantId ?? undefined, productName: "أسورة رجوع",
        quantity: lines.reduce((s, l) => s + l.qty, 0), totalAmount: String(lines.reduce((s, l) => s + l.qty * (l.price ?? 100), 0)),
        assignedEmployeeId: agent, ...extra,
      } as any,
      lines.map(l => ({ productId: l.productId, variantId: l.variantId ?? undefined, productName: "أسورة رجوع", quantity: l.qty, unitPrice: l.price ?? 100 }))
    );
    ids.orderIds.push(id);
    return id;
  }
  const confirm = async (id: number) => (await asAdmin()).orders.confirm({ orderId: id });
  const withCatalogMode = async (fn: () => Promise<void>) => {
    await setOrderEntryMode(F.businessId, "catalog_variants", 1);
    try { await fn(); } finally { await setOrderEntryMode(F.businessId, "bracelets_legacy", 1); }
  };

  /** كل اللي ممكن الرفض يلمسه — لازم يفضل زي ما هو حرفيًا. */
  async function snap(orderIds: number[]) {
    const d = await db();
    const ord = await d.select().from(orders).where(inArray(orders.id, orderIds)).orderBy(orders.id);
    const items = await d.select().from(orderItems).where(inArray(orderItems.orderId, orderIds)).orderBy(orderItems.id);
    const moves = await d.select().from(inventoryMovements).where(inArray(inventoryMovements.orderId, orderIds)).orderBy(inventoryMovements.id);
    const vs = await d.select({ id: productVariants.id, s: productVariants.currentStock }).from(productVariants).where(inArray(productVariants.productId, ids.productIds)).orderBy(productVariants.id);
    const ps = await d.select({ id: products.id, s: products.currentStock }).from(products).where(inArray(products.id, ids.productIds)).orderBy(products.id);
    const acts = await d.select({ id: activityLogs.id }).from(activityLogs).where(and(eq(activityLogs.entityType, "order"), inArray(activityLogs.entityId, orderIds)));
    const edits = await d.select({ id: orderEditLogs.id }).from(orderEditLogs).where(inArray(orderEditLogs.orderId, orderIds));
    const rets = await d.select({ id: returns.id }).from(returns).where(inArray(returns.orderId, orderIds));
    const allMovesForProducts = await d.select({ id: inventoryMovements.id }).from(inventoryMovements).where(inArray(inventoryMovements.productId, ids.productIds));
    return JSON.stringify({ ord, items, moves, vs, ps, acts: acts.length, edits: edits.length, rets: rets.length, allMoves: allMovesForProducts.length });
  }
  /** الرفض بلا أي أثر. الافتراضي = حارس الرجوع الآمن؛ «CONFLICT» = رفض 620a5ae الأصلي (حركة out سابقة) متساب زي ما هو. */
  async function expectRefusedNoEffect(orderIds: number[], fn: () => Promise<unknown>, expected: "PRECONDITION_FAILED" | "CONFLICT" = "PRECONDITION_FAILED") {
    const before = await snap(orderIds);
    let code = "ok", message = "";
    try { await fn(); } catch (e: any) { code = e?.code ?? "ERR"; message = String(e?.message ?? ""); }
    expect(code, message).toBe(expected);
    if (expected === "PRECONDITION_FAILED") expect(message).toContain("نسخة رجوع مؤقتة");
    expect(await snap(orderIds)).toBe(before);
    return message;
  }
  const stock = async (vid: number) => (await (await db()).select({ s: productVariants.currentStock }).from(productVariants).where(eq(productVariants.id, vid)))[0].s;
  const pstock = async (pid: number) => (await (await db()).select({ s: products.currentStock }).from(products).where(eq(products.id, pid)))[0].s;
  const statusOf = async (id: number) => (await (await db()).select({ s: orders.status }).from(orders).where(eq(orders.id, id)))[0]?.s;
  const movesOf = async (id: number) => (await db()).select().from(inventoryMovements).where(eq(inventoryMovements.orderId, id)).orderBy(inventoryMovements.id);

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    F = await createCoreTestFixture("rsafe");
    await setOrderEntryMode(F.businessId, "bracelets_legacy", 1);
    const pv = await createProductWithVariants(F.businessId, { name: "أسورة رجوع آمن" }, [
      { name: "RS-A1", sku: `RSA1-${tag}`, currentStock: 50, price: "100" },
      { name: "RS-A2", sku: `RSA2-${tag}`, currentStock: 30, price: "100" },
    ] as any);
    prodV = pv.productId; [v1, v2] = pv.variantIds;
    prodS = insId(await d.insert(products).values({ businessId: F.businessId, name: "منتج بسيط رجوع", currentStock: 20 } as any));
    ids.productIds.push(prodV, prodS);
    owner = insId(await createEmployee({ name: "RS owner", role: "super_admin", isActive: true, tenantId: F.tenantId, businessId: F.businessId, username: `rs_o_${tag}` } as any));
    agent = insId(await createEmployee({ name: "RS agent", role: "agent", isActive: true, tenantId: F.tenantId, businessId: F.businessId, username: `rs_a_${tag}` } as any));
    ids.empIds.push(owner, agent);
    ids.channelId = insId(await d.insert(salesChannels).values({ businessId: F.businessId, name: "RS EO", platform: "easyorder", webhookSecret: secret, isActive: true } as any));
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) {
      await d.delete(activityLogs).where(and(eq(activityLogs.entityType, "order"), inArray(activityLogs.entityId, ids.orderIds)));
      await d.delete(orderEditLogs).where(inArray(orderEditLogs.orderId, ids.orderIds));
      await d.delete(returns).where(inArray(returns.orderId, ids.orderIds));
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.orderId, ids.orderIds));
      await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds));
      await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    }
    if (ids.productIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.productId, ids.productIds));
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    if (ids.channelId) await d.delete(salesChannels).where(eq(salesChannels.id, ids.channelId));
    if (F) await d.delete(webhookLogs).where(eq(webhookLogs.businessId, F.businessId));
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    await F?.cleanup();
  });

  // ───────────── المسارات الآمنة شغالة ─────────────
  it("✅ تأكيد أوردر جديد بيخصم مرة واحدة من التركيبة، والتكرار idempotent", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 2 }]);
    const s0 = await stock(v1);
    await confirm(id); await confirm(id);
    expect(await stock(v1)).toBe(s0 - 2);
    expect((await movesOf(id)).map(m => [m.variantId, m.type, m.quantity])).toEqual([[v1, "out", 2]]);
  });

  it("✅ إلغاء أوردر جديد (مفيش خصم) مسموح؛ تأجيل مؤكد مسموح ورجوعه للتأكيد بنفس الخصم بلا خصم تاني", async () => {
    const a = await mkOrder([{ productId: prodV, variantId: v2, qty: 1 }]);
    await (await asAdmin()).orders.cancel({ orderId: a, cancelReason: "عميل لغى قبل التأكيد" });
    expect(await statusOf(a)).toBe("cancelled");
    expect(await movesOf(a)).toHaveLength(0);

    const b = await mkOrder([{ productId: prodV, variantId: v2, qty: 1 }]);
    await confirm(b);
    const s = await stock(v2);
    await (await asAdmin()).orders.postpone({ orderId: b, postponedTo: new Date(Date.now() + 86400000) });
    expect(await statusOf(b)).toBe("postponed");
    await (await asAdmin()).orders.update({ id: b, status: "confirmed" }); // الخصم موجود ومطابق
    expect(await statusOf(b)).toBe("confirmed");
    expect(await stock(v2)).toBe(s);
    expect(await movesOf(b)).toHaveLength(1);
  });

  it("✅ تعديل سعر/خصم بنفس الأصناف والكميات على مؤكد مسموح (بلا حركة)، وتعديل اسم العميل مسموح", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(id);
    const s = await stock(v1); const n = (await movesOf(id)).length;
    const r = await (await asAdmin()).orders.editOrderItems({ orderId: id, items: [{ productId: prodV, productName: "أسورة رجوع", variantId: v1, quantity: 1, unitPrice: 150, discount: 10 }] } as any);
    expect(r).toMatchObject({ itemCount: 1 });
    await (await asAdmin()).orders.editOrder({ orderId: id, customerName: "اسم معدّل" } as any);
    expect(await stock(v1)).toBe(s);
    expect(await movesOf(id)).toHaveLength(n);
  });

  it("✅ الطباعة والشحن على مؤكد شغالين؛ مرتجع بدون استرجاع مسموح؛ مرتجع باسترجاع دقيق (منتج بسيط) مسموح", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(id);
    await markOrdersAsPrinted([id], [F.businessId]);
    expect(await statusOf(id)).toBe("printed");
    await (await asAdmin()).orders.update({ id, status: "shipped" } as any);
    expect(await statusOf(id)).toBe("shipped");
    await (await asAdmin()).returns.markAsReturned({ orderId: id, returnReason: "رفض الاستلام", restoreStock: false });
    expect(await statusOf(id)).toBe("returned");

    // منتج بسيط بلا تركيبات: قالب bracelets_legacy بيشترط تركيبة لكل سطر، فالجزء ده على القالب العام.
    await withCatalogMode(async () => {
      const s = await mkOrder([{ productId: prodS, variantId: null, qty: 2 }]);
      await confirm(s);
      const p0 = await pstock(prodS);
      await markOrdersAsPrinted([s], [F.businessId]);
      await (await asAdmin()).orders.update({ id: s, status: "shipped" } as any);
      await (await asAdmin()).returns.markAsReturned({ orderId: s, returnReason: "رفض الاستلام", restoreStock: true });
      expect(await pstock(prodS)).toBe(p0 + 2);
    });
  });

  it("✅ حذف أوردر جديد (بلا خصم) مسموح للمالك", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await (await asAdmin()).orders.delete({ orderId: id });
    expect(await statusOf(id)).toBeUndefined();
  });

  // ───────────── R-1: الإلغاء بعد الخصم ─────────────
  it("⛔ إلغاء مؤكد: Admin API، بوابة الموظف (cancel وupdateStatus)، وorders.update — كله مرفوض بلا أثر", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 2 }]);
    await confirm(id);
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.cancel({ orderId: id, cancelReason: "x" }));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.cancel({ orderId: id, cancelReason: "x" }));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.updateStatus({ orderId: id, status: "cancelled", cancelReason: "x" } as any));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.update({ id, status: "cancelled" } as any));
  });

  it("⛔ الحالة وحدها مش دليل: أوردر مؤجل بعد التأكيد (خصمه محجوز) — إلغاؤه مرفوض", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v2, qty: 1 }]);
    await confirm(id);
    await (await asAdmin()).orders.postpone({ orderId: id, postponedTo: new Date(Date.now() + 86400000) });
    expect(await statusOf(id)).toBe("postponed");
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.cancel({ orderId: id, cancelReason: "x" }));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.updateStatus({ orderId: id, status: "cancelled", cancelReason: "x" } as any));
  });

  it("⛔ حركة يدوية مربوطة بالأوردر = صافي غير موثوق: تأكيده وإلغاؤه مرفوضين", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await (await db()).insert(inventoryMovements).values({ businessId: F.businessId, productId: prodV, variantId: v1, type: "out", quantity: 1, reason: "تسوية يدوية", orderId: id, performedBy: owner } as any);
    await expectRefusedNoEffect([id], () => confirm(id), "CONFLICT"); // 620a5ae أصلًا: حركة out سابقة = تعارض
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.cancel({ orderId: id, cancelReason: "x" }));
  });

  // ───────────── R-2: إعادة فتح/تأكيد ملغي ─────────────
  it("⛔ أوردر ملغي: تأكيد (Admin وبوابة)، فتح لجديد، تأجيل، أو orders.update — كله مرفوض بلا أثر", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await (await asAdmin()).orders.cancel({ orderId: id, cancelReason: "قبل التأكيد" });
    await expectRefusedNoEffect([id], () => confirm(id));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.confirm({ orderId: id } as any));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.updateStatus({ orderId: id, status: "confirmed" } as any));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.updateStatus({ orderId: id, status: "new" } as any));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.updateStatus({ orderId: id, status: "postponed", postponedTo: new Date(Date.now() + 86400000) } as any));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.postpone({ orderId: id, postponedTo: new Date(Date.now() + 86400000) }));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.update({ id, status: "confirmed" } as any));
  });

  it("⛔ ملغي من v2 (خصم + إرجاع «إلغاء أوردر» = صافي صفر): إعادة تأكيده برضه مرفوضة", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v2, qty: 1 }]);
    const d = await db();
    await d.update(orders).set({ status: "cancelled" }).where(eq(orders.id, id));
    await d.insert(inventoryMovements).values([
      { businessId: F.businessId, productId: prodV, variantId: v2, type: "out", quantity: 1, reason: `تأكيد أوردر RS`, orderId: id, performedBy: owner },
      { businessId: F.businessId, productId: prodV, variantId: v2, type: "in", quantity: 1, reason: `إلغاء أوردر RS`, orderId: id, performedBy: owner },
    ] as any);
    await expectRefusedNoEffect([id], () => confirm(id), "CONFLICT"); // حركة out سابقة → رفض 620a5ae الأصلي
  });

  it("⛔ تغيير الحالة لحالة خصم من غير خصم (orders.update new→confirmed/shipped) مرفوض — التأكيد من زر التأكيد بس", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.update({ id, status: "confirmed" } as any));
    // new → shipped أصلًا انتقال مش مسموح في جدول 620a5ae (رفض قديم كـError عام = 500) — بلا أثر برضه.
    const before = await snap([id]);
    await expect((await asAdmin()).orders.update({ id, status: "shipped" } as any)).rejects.toBeTruthy();
    expect(await snap([id])).toBe(before);
  });

  // ───────────── R-4: تعديل البنود اللي بيحرّك المخزون ─────────────
  it("⛔ تعديل بنود مؤكد: كمية، تركيبة تانية، إضافة سطر — Admin وبوابة الموظف — مرفوض بلا أثر", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 2 }]);
    await confirm(id);
    const line = (variantId: number, quantity: number) => ({ productId: prodV, productName: "أسورة رجوع", variantId, quantity, unitPrice: 100, discount: 0 });
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrderItems({ orderId: id, items: [line(v1, 3)] } as any));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrderItems({ orderId: id, items: [line(v2, 2)] } as any));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrderItems({ orderId: id, items: [line(v1, 2), line(v2, 1)] } as any));
    await expectRefusedNoEffect([id], async () => (await asPortal()).employeePortal.editOrderItems({ orderId: id, items: [line(v1, 1)] } as any));
  });

  it("⛔ نفس الأصناف بترتيب مختلف (الهيدر يتغيّر لمنتج تاني) — الحاجز التاني بيمنع تسوية المنتج الأب", async () => {
    await withCatalogMode(async () => {
      const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }, { productId: prodS, variantId: null, qty: 1 }]);
      await confirm(id);
      const msg = await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrderItems({
        orderId: id,
        items: [
          { productId: prodS, productName: "منتج بسيط رجوع", variantId: null, quantity: 1, unitPrice: 100, discount: 0 },
          { productId: prodV, productName: "أسورة رجوع", variantId: v1, quantity: 1, unitPrice: 100, discount: 0 },
        ],
      } as any));
      expect(msg).toContain("ترتيب");
    });
  });

  it("⛔ editOrder (هيدر): تغيير كمية/منتج/تركيبة لمؤكد مرفوض بلا أثر", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(id);
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrder({ orderId: id, quantity: 3 } as any));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrder({ orderId: id, variantId: v2 } as any));
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.editOrder({ orderId: id, productId: prodS, variantId: null } as any));
  });

  it("⛔ تحديث البنود من التكاملات (updateOrderWithItems — Easy Order upsert / تعديل فيسبوك) لمؤكد مرفوض", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(id);
    await expectRefusedNoEffect([id], () => updateOrderWithItems(id, { customerName: "تحديث خارجي" } as any, [{ productId: prodV, variantId: v1, productName: "x", quantity: 2, unitPrice: 100 }]));
  });

  // ───────────── الحذف، المرتجع باسترجاع، حل المراجعة ─────────────
  it("⛔ حذف مؤكد (فردي وجماعي): مرفوض، والجماعي كله أو لا شيء (الأوردر الجديد في نفس الدفعة مايتحذفش)", async () => {
    const c = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(c);
    const n = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await expectRefusedNoEffect([c], async () => (await asAdmin()).orders.delete({ orderId: c }));
    await expectRefusedNoEffect([c, n], async () => (await asAdmin()).orders.bulkDelete({ orderIds: [n, c] }));
    expect(await statusOf(n)).toBe("new");
  });

  it("⛔ مرتجع باسترجاع مخزون لأوردر تركيبات (620a5ae بيرجّع على المنتج الأب) مرفوض بلا أثر", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(id);
    await (await asAdmin()).orders.update({ id, status: "preparing" } as any);
    await expectRefusedNoEffect([id], async () => (await asAdmin()).returns.markAsReturned({ orderId: id, returnReason: "رفض", restoreStock: true }));
    expect(await statusOf(id)).toBe("preparing");
  });

  it("⛔ تعيين منتج (حل المراجعة) لأوردر مؤكد مرفوض", async () => {
    const id = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }]);
    await confirm(id);
    await expectRefusedNoEffect([id], async () => (await asAdmin()).orders.resolveReview({ orderId: id, productId: prodS, variantId: null } as any));
  });

  // ───────────── ويبهوك Easy Order ─────────────
  it("⛔ ويبهوك Easy Order: «cancelled» لمؤكد و«confirmed» لجديد — 200 status_blocked_rollback_safe، الأوردر زي ما هو، والرفض متسجّل", async () => {
    let handler: any;
    registerWebhookRoutes({ post: (_p: string, h: any) => { handler = h; }, get: () => {} } as any);
    const call = async (order_id: string, new_status: string) => {
      const out: { code: number; body: any } = { code: 200, body: null };
      const r: any = { status: (c: number) => { out.code = c; return r; }, json: (b: any) => { out.body = b; return r; } };
      await handler({ query: {}, headers: { "x-webhook-secret": secret }, body: { event_type: "order-status-update", order_id, new_status, old_status: "x" } }, r);
      return out;
    };
    const c = await mkOrder([{ productId: prodV, variantId: v1, qty: 1 }], { externalOrderId: `EXT-C-${tag}` });
    await confirm(c);
    const n = await mkOrder([{ productId: prodV, variantId: v2, qty: 1 }], { externalOrderId: `EXT-N-${tag}` });
    const before = await snap([c, n]);
    const r1 = await call(`EXT-C-${tag}`, "cancelled");
    const r2 = await call(`EXT-N-${tag}`, "confirmed");
    expect([r1.code, r1.body?.action]).toEqual([200, "status_blocked_rollback_safe"]);
    expect([r2.code, r2.body?.action]).toEqual([200, "status_blocked_rollback_safe"]);
    expect(await snap([c, n])).toBe(before);
    const logs = await (await db()).select().from(webhookLogs).where(eq(webhookLogs.businessId, F.businessId));
    expect(logs.filter(l => String(l.message).includes("لم يتم تغيير حالة")).length).toBe(2);
    // حالة مسموحة بتعدّي عادي: مطبوع → مشحون (مؤكد → مشحون أصلًا انتقال مش مسموح في جدول 620a5ae).
    await markOrdersAsPrinted([c], [F.businessId]);
    const r3 = await call(`EXT-C-${tag}`, "shipped");
    expect(r3.body?.action).toBe("status_updated");
    expect(await statusOf(c)).toBe("shipped");
  });

  // ───────────── W3: تحديث أوردر من ويبهوك Easy Order (مسار الـupsert كامل) ─────────────
  it("🔁 W3 ويبهوك upsert: تعديل كمية مؤكد = 200 blocked_rollback_safe بلا أي تغيير (ولا مع الإعادة)؛ المسموح بينجح؛ الفشل الحقيقي يفضل 500", async () => {
    let handler: any;
    registerWebhookRoutes({ post: (_p: string, h: any) => { handler = h; }, get: () => {} } as any);
    const post = async (body: any) => {
      const out: { code: number; body: any } = { code: 200, body: null };
      const r: any = { status: (c: number) => { out.code = c; return r; }, json: (b: any) => { out.body = b; return r; } };
      await handler({ query: {}, headers: { "x-webhook-secret": secret }, body }, r);
      return out;
    };
    const eo = (id: string, at: string, qty: number, extra: Record<string, any> = {}) => ({
      id, created_at: "2026-10-18T20:00:00Z", updated_at: at, full_name: "عميل ويبهوك W3", phone: "01000000888", government: "القاهرة",
      address: "شارع الويبهوك 9 - الدور 2 - شقة 4", payment_method: "cod", cost: 100 * qty, shipping_cost: 0, total_cost: 100 * qty,
      cart_items: [{ price: 100, quantity: qty, product: { name: "أسورة رجوع آمن" }, variant: { sku: `RSA1-${tag}` } }], ...extra,
    });
    const d = await db();
    const idOf = async (ext: string) => (await d.select({ id: orders.id }).from(orders).where(and(eq(orders.externalOrderId, ext), eq(orders.businessId, F.businessId))))[0]?.id;
    const logs = async () => d.select().from(webhookLogs).where(eq(webhookLogs.businessId, F.businessId)).orderBy(webhookLogs.id);

    // أوردر خارجي جديد → تأكيد عادي (خصم 1)
    const c1 = await post(eo(`EXT-W3-${tag}`, "2026-10-18T20:00:00Z", 1));
    expect(c1.body?.action).toBe("created");
    const id = await idOf(`EXT-W3-${tag}`); ids.orderIds.push(id);
    await confirm(id);

    // 1) تعديل الكمية لمؤكد → 200 blocked، بلا أي تغيير، وسجل رفض واحد للمراجعة (بلا payload خام)
    const before = await snap([id]); const l0 = (await logs()).length;
    const r1 = await post(eo(`EXT-W3-${tag}`, "2026-10-18T20:10:00Z", 2));
    expect([r1.code, r1.body?.action]).toEqual([200, "blocked_rollback_safe"]);
    expect(await snap([id])).toBe(before);
    const l1 = await logs();
    expect(l1.length).toBe(l0 + 1);
    const rej = l1[l1.length - 1];
    expect(rej.status).toBe("error");
    expect(rej.externalOrderId).toBe(`EXT-W3-${tag}`);
    expect(String(rej.message)).toContain("تحديث مرفوض (نسخة الرجوع الآمن)");
    expect(String(rej.message)).toContain(`EXT-W3-${tag}`);
    expect(rej.rawPayload).toBeNull();
    expect(String(rej.message)).not.toContain(secret);

    // 2) إعادة نفس الويبهوك → نفس الرد، وبرضه بلا أي تغيير في البيانات
    const r2 = await post(eo(`EXT-W3-${tag}`, "2026-10-18T20:10:00Z", 2));
    expect([r2.code, r2.body?.action]).toEqual([200, "blocked_rollback_safe"]);
    expect(await snap([id])).toBe(before);

    // 3) تحديث مسموح لنفس المؤكد (نفس الأصناف والكميات، عنوان جديد) → updated فعلًا، والمخزون والحركات زي ما هم
    const stockBefore = await stock(v1); const movesBefore = (await movesOf(id)).length;
    const r3 = await post(eo(`EXT-W3-${tag}`, "2026-10-18T20:20:00Z", 1, { address: "عنوان جديد مسموح 15 - الدور 5 - شقة 9" }));
    expect([r3.code, r3.body?.action]).toEqual([200, "updated"]);
    const [o3] = await d.select().from(orders).where(eq(orders.id, id));
    expect(o3.customerAddress).toBe("عنوان جديد مسموح 15 - الدور 5 - شقة 9");
    expect(await stock(v1)).toBe(stockBefore);
    expect(await movesOf(id)).toHaveLength(movesBefore);

    // 4) تحديث مسموح لأوردر جديد (مش ماسك مخزون): تغيير الكمية بينجح
    const n1 = await post(eo(`EXT-W3N-${tag}`, "2026-10-18T20:00:00Z", 1));
    expect(n1.body?.action).toBe("created");
    const nid = await idOf(`EXT-W3N-${tag}`); ids.orderIds.push(nid);
    const n2 = await post(eo(`EXT-W3N-${tag}`, "2026-10-18T20:10:00Z", 3));
    expect([n2.code, n2.body?.action]).toEqual([200, "updated"]);
    const [ni] = await d.select().from(orderItems).where(eq(orderItems.orderId, nid));
    expect(ni.quantity).toBe(3);

    // 5) فشل حفظ حقيقي (اسم أطول من عمود customerName) على مؤكد بنفس الأصناف → يفضل 500، مش «مرفوض عمدًا»، وبلا تغيير
    const before5 = await snap([id]);
    const r5 = await post(eo(`EXT-W3-${tag}`, "2026-10-18T20:30:00Z", 1, { full_name: "ن".repeat(150) }));
    expect(r5.code).toBe(500);
    expect(r5.body?.action).not.toBe("blocked_rollback_safe");
    expect(await snap([id])).toBe(before5);
    const l5 = await logs();
    expect(String(l5[l5.length - 1].message)).toContain("فشل حفظ الأوردر");
  });

  // ───────────── سباق: تأكيد متزامن مع تعديل كمية ─────────────
  it("🔁 تأكيد متزامن مع تعديل كمية (editOrder): في كل الأحوال الخصم = البنود (مفيش فرق)", async () => {
    for (let i = 0; i < 4; i++) {
      const id = await mkOrder([{ productId: prodV, variantId: v2, qty: 1 }]);
      const a = await asAdmin(); const b = await asAdmin();
      await Promise.allSettled([a.orders.confirm({ orderId: id }), b.orders.editOrder({ orderId: id, quantity: 2 } as any)]);
      const d = await db();
      const [it0] = await d.select().from(orderItems).where(eq(orderItems.orderId, id));
      const net = (await movesOf(id)).reduce((s, m) => s + (m.type === "out" ? m.quantity : -m.quantity), 0);
      if ((await statusOf(id)) === "confirmed") expect(net, `iteration ${i}`).toBe(it0.quantity);
      else expect(net).toBe(0);
    }
  });
});
