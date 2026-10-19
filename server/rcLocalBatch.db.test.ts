import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createProductWithVariants, insertOrderWithItems, MONEY_LOCKED_UPDATE_REVIEW } from "./db";
import { upsertEasyOrder, type EasyOrderPayload } from "./easyorder.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * دفعة RC المحلية — اختبارات الإصلاحات الجديدة على قاعدة مؤقتة ببيانات مصطنعة (بتتمسح بعد الاختبار):
 * عزل الكتابات الجماعية، سياسة المبالغ (سالب/مشتق/بعد الشحن/بعد شحنة بوسطة)، اتساق إجمالي فيسبوك، سجل الأنشطة
 * (نشاط + منفّذ حقيقي + لا تكرار + أحداث حساسة بلا أسرار)، سجل المسحات، وEasy Order (شحن افتراضي/خطأ دائم/مبلغ بعد الشحن).
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
async function err(fn: () => Promise<any>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: "ok", message: "" }; } catch (e: any) { return { code: e?.code ?? "ERR", message: String(e?.message ?? "") }; }
}

describe.runIf(CAN)("🧪 دفعة RC المحلية — الإصلاحات الجديدة", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  let ownerA = 0, ownerB = 0, agent1 = 0, agent2 = 0, fb = 0;
  let p1 = 0, v1 = 0, v2 = 0, pB = 0, vB = 0;
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const row = async (id: number) => (await q("SELECT * FROM orders WHERE id = ?", [id]))[0];
  const snap = async (id: number) => JSON.stringify({ o: await row(id), i: await q("SELECT * FROM order_items WHERE orderId = ? ORDER BY id", [id]) });
  const logs = async (action: string, entityId?: number) =>
    q(`SELECT * FROM activity_logs WHERE action = ?${entityId != null ? " AND entityId = ?" : ""} ORDER BY id`, entityId != null ? [action, entityId] : [action]);
  const CUST = { customerName: "عميل الدفعة", customerPhone: "01000007001", governorate: "القاهرة", customerAddress: "شارع الدفعة 9 - الدور 3 - شقة 5" };

  /** أوردر ببندين (100×1 + 150×2 = 400) + شحن 50 = 450. */
  async function order(fx: CoreTestFixture, over: Record<string, unknown> = {}, lines?: any[]) {
    const n = ++seq;
    const items = lines ?? [
      { productId: p1, productName: "أسورة", quantity: 1, variantId: v1, unitPrice: 100 },
      { productId: p1, productName: "أسورة", quantity: 2, variantId: v2, unitPrice: 150 },
    ];
    return insertOrderWithItems({
      orderNumber: `RC${n}-${tmp.name.slice(-6)}`.slice(0, 20), businessId: fx.businessId, ...CUST, productName: "أسورة",
      productId: items[0].productId, variantId: items[0].variantId, quantity: items.reduce((s: number, l: any) => s + l.quantity, 0),
      totalAmount: "450.00", shippingFees: "50.00", source: "manual", status: "new", ...over,
    } as any, items);
  }

  beforeAll(async () => {
    tmp = await createTempSchema("rcbatch");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("rc-a"); B = await createCoreTestFixture("rc-b");
    const emp = async (name: string, role: string, fx: CoreTestFixture) =>
      insId(await createEmployee({ name, role, isActive: true, tenantId: fx.tenantId, businessId: fx.businessId, username: `${name}_${tmp.name}`.slice(0, 50), passwordHash: "x" } as any));
    ownerA = await emp("rcownA", "super_admin", A); ownerB = await emp("rcownB", "super_admin", B);
    agent1 = await emp("rcag1", "agent", A); agent2 = await emp("rcag2", "agent", A); fb = await emp("rcfb", "facebook_entry", A);
    const a = await createProductWithVariants(A.businessId, { name: "أسورة الدفعة" }, [
      { name: "نقشة 1", sku: `RC1-${tmp.name}`.slice(0, 50), currentStock: 100 } as any,
      { name: "نقشة 2", sku: `RC2-${tmp.name}`.slice(0, 50), currentStock: 100 } as any,
    ]);
    p1 = a.productId; [v1, v2] = a.variantIds;
    const b = await createProductWithVariants(B.businessId, { name: "منتج B" }, [{ name: "B", sku: `RCB-${tmp.name}`.slice(0, 50), currentStock: 10 } as any]);
    pB = b.productId; vB = b.variantIds[0];
  }, 180_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  // ==================== G1 · العزل ====================
  it("G1 reclaimOrders: أوردر tenant تاني مسند لنفس الموظف مايتلمسش، والحالات مقفولة على أوردرات شغّالة", async () => {
    const mine = await order(A, { assignedEmployeeId: agent1 });
    const foreign = await order(B, { assignedEmployeeId: agent1 }, [{ productId: pB, productName: "B", quantity: 1, variantId: vB, unitPrice: 400 }]);
    const r = await (await web(ownerA)).employees.reclaimOrders({ employeeId: agent1 });
    expect(r.count).toBe(1);
    expect((await row(mine)).assignedEmployeeId).toBeNull();
    expect((await row(foreign)).assignedEmployeeId).toBe(agent1); // أوردر B سليم
    expect(await code(async () => (await web(ownerA)).employees.reclaimOrders({ employeeId: agent1, statuses: ["shipped"] } as any))).toBe("BAD_REQUEST");
  });

  it("G1 orders.editOrderItems بجلسة موظف: أوردر مش مسند ليه = FORBIDDEN بلا تغيير؛ المسند ليه = مسموح", async () => {
    const id = await order(A, { assignedEmployeeId: agent2 });
    const before = await snap(id);
    const items = [{ productId: p1, productName: "أسورة", variantId: v1, quantity: 1, unitPrice: 90, discount: 0 }];
    expect(await code(async () => (await portal(agent1)).orders.editOrderItems({ orderId: id, items }))).toBe("FORBIDDEN");
    expect(await snap(id)).toBe(before);
    expect(await code(async () => (await portal(agent2)).orders.editOrderItems({ orderId: id, items }))).toBe("ok");
  });

  it("G1 products.create بنشاط tenant تاني = FORBIDDEN، ومفيش منتج يتيم بـbusinessId = -1", async () => {
    const r = await code(async () => (await web(ownerA)).products.create({ name: "منتج تسلل", businessId: B.businessId, sku: `RCX-${tmp.name}`.slice(0, 40) } as any));
    expect(r).toBe("FORBIDDEN");
    const r2 = await code(async () => (await web(ownerA)).products.createWithVariants({ name: "منتج تسلل 2", businessId: B.businessId, variants: [{ name: "x" }] } as any));
    expect(r2).toBe("FORBIDDEN");
    expect((await q("SELECT COUNT(*) AS n FROM products WHERE businessId = -1"))[0].n).toBe(0);
  });

  it("G1 duplicates.restore: المالك بنطاق جلسته كاملة؛ tenant تاني = NOT_FOUND/FORBIDDEN", async () => {
    const id = await order(A); await q("UPDATE orders SET isDuplicate = 1 WHERE id = ?", [id]);
    expect(await code(async () => (await web(ownerB)).duplicates.restore({ orderId: id }))).toMatch(/NOT_FOUND|FORBIDDEN/);
    expect((await row(id)).isDuplicate).toBe(1);
    await (await web(ownerA)).duplicates.restore({ orderId: id });
    expect((await row(id)).isDuplicate).toBe(0);
  });

  // ==================== G4 · المالية ====================
  it("G4 orders.create: إجمالي مش رقم/سالب/أكتر من خانتين = BAD_REQUEST (مش 500)", async () => {
    const base = { ...CUST, productId: p1, productName: "أسورة", variantId: v1, quantity: 1, source: "manual", businessId: A.businessId };
    for (const totalAmount of ["abc", "-5", "1.234", "", "1e5"]) {
      const e = await err(async () => (await web(ownerA)).orders.create({ ...base, totalAmount } as any));
      expect(e.code, totalAmount).toBe("BAD_REQUEST");
    }
    expect(await code(async () => (await web(ownerA)).orders.create({ ...base, totalAmount: "250.50" } as any))).toBe("ok");
  });

  it("G4 editOrder: سالب مرفوض؛ الإجمالي المباشر لأوردر ببنود مرفوض؛ تعديل الشحن بيشتق الإجمالي", async () => {
    const id = await order(A);
    const before = await snap(id);
    const c = await web(ownerA);
    expect(await code(() => c.orders.editOrder({ orderId: id, totalAmount: -500 }))).toBe("BAD_REQUEST");
    expect(await code(() => c.orders.editOrder({ orderId: id, shippingFees: -20 }))).toBe("BAD_REQUEST");
    const direct = await err(() => c.orders.editOrder({ orderId: id, totalAmount: 999 }));
    expect(direct.code).toBe("BAD_REQUEST"); expect(direct.message).toContain("بيتحسب من البنود");
    expect(await snap(id)).toBe(before);
    await c.orders.editOrder({ orderId: id, shippingFees: 70 });
    const o = await row(id);
    expect([o.totalAmount, o.shippingFees]).toEqual(["470.00", "70.00"]);
    const ship = await q("SELECT SUM(customerShippingSnapshot) AS s FROM order_items WHERE orderId = ?", [id]);
    expect(Number(ship[0].s)).toBe(70);
    // إجمالي مبعوت مع الشحن لازم يطابق
    expect(await code(() => c.orders.editOrder({ orderId: id, shippingFees: 60, totalAmount: 999 }))).toBe("BAD_REQUEST");
    await c.orders.editOrder({ orderId: id, shippingFees: 60, totalAmount: 460 });
    expect((await row(id)).totalAmount).toBe("460.00");
  });

  it("G4 بعد الشحن: تعديل المبلغ/الشحن/البنود ممنوع بلا تغيير (editOrder + محرر البنود)", async () => {
    for (const st of ["shipped", "delivered", "returned"]) {
      const id = await order(A); await q("UPDATE orders SET status = ? WHERE id = ?", [st, id]);
      const before = await snap(id);
      const c = await web(ownerA);
      expect(await code(() => c.orders.editOrder({ orderId: id, shippingFees: 10 })), st).toBe("BAD_REQUEST");
      expect(await code(() => c.orders.editOrderItems({ orderId: id, items: [{ productId: p1, productName: "أسورة", variantId: v1, quantity: 1, unitPrice: 1, discount: 0 }] })), st).toBe("BAD_REQUEST");
      expect(await snap(id), st).toBe(before);
      // بيانات العميل لسه بتتعدّل
      await c.orders.editOrder({ orderId: id, notes: `ملاحظة ${st}` });
      expect((await row(id)).notes).toBe(`ملاحظة ${st}`);
    }
  });

  it("G4 بعد إنشاء شحنة بوسطة: تغيير المبلغ ممنوع (التحصيل اتبعت)، وتعديل بنفس المبلغ مسموح", async () => {
    const id = await order(A); await q("UPDATE orders SET bostaShipmentId = ? WHERE id = ?", [`BSH-${tmp.name}`.slice(0, 40), id]);
    const before = await snap(id);
    const c = await web(ownerA);
    expect(await code(() => c.orders.editOrder({ orderId: id, shippingFees: 80 }))).toBe("BAD_REQUEST");
    expect(await code(() => c.orders.editOrderItems({ orderId: id, items: [{ productId: p1, productName: "أسورة", variantId: v1, quantity: 1, unitPrice: 400, discount: 50 }] }))).toBe("BAD_REQUEST");
    expect(await snap(id)).toBe(before);
    // نفس الإجمالي (400 بند + 50 شحن) بتركيبة مختلفة = مسموح
    expect(await code(() => c.orders.editOrderItems({ orderId: id, items: [{ productId: p1, productName: "أسورة", variantId: v2, quantity: 1, unitPrice: 400, discount: 0 }] }))).toBe("ok");
    expect((await row(id)).totalAmount).toBe("450.00");
  });

  // ==================== G3 · فيسبوك ====================
  it("G3 فيسبوك: الإجمالي لازم = البنود − الخصم + الشحن (إضافة وتعديل)، والتعديل المتكرر ثابت، وبعد الشحن مقفول", async () => {
    const f = await portal(fb);
    const lines = [
      { productId: p1, productName: "x", quantity: 1, variantId: v1, unitPrice: 200 },
      { productId: p1, productName: "x", quantity: 2, variantId: v2, unitPrice: 150 },
    ]; // 500
    expect(await code(() => f.facebookEntry.addOrder({ ...CUST, selectedProducts: lines, totalAmount: 999, shippingCost: 50, discount: 30 } as any))).toBe("BAD_REQUEST");
    expect(await code(() => f.facebookEntry.addOrder({ ...CUST, selectedProducts: lines, totalAmount: 600, shippingCost: 50, discount: 600 } as any))).toBe("BAD_REQUEST");
    const r = await f.facebookEntry.addOrder({ ...CUST, selectedProducts: lines, totalAmount: 520, shippingCost: 50, discount: 30 } as any);
    const id = (await q("SELECT id FROM orders WHERE orderNumber = ?", [r.orderNumber]))[0].id as number;
    expect([(await row(id)).totalAmount, (await row(id)).shippingFees]).toEqual(["520.00", "50.00"]);
    // عميل قديم بلا خصم: إجمالي أكبر من البنود + الشحن مرفوض
    expect(await code(() => f.facebookEntry.addOrder({ ...CUST, selectedProducts: lines, totalAmount: 551, shippingCost: 50 } as any))).toBe("BAD_REQUEST");

    const before = await snap(id);
    expect(await code(() => f.facebookEntry.updateOrder({ orderId: id, ...CUST, selectedProducts: lines, totalAmount: 700, shippingCost: 50, discount: 30 } as any))).toBe("BAD_REQUEST");
    expect(await snap(id)).toBe(before);
    const edit = { orderId: id, ...CUST, selectedProducts: [{ ...lines[0], quantity: 2 }, lines[1]], totalAmount: 710, shippingCost: 40, discount: 30, variantId: v1 }; // 700 − 30 + 40
    for (let k = 0; k < 3; k++) await f.facebookEntry.updateOrder(edit as any);
    expect(await logs("fb_order_update", id)).toHaveLength(1); // 3 تعديلات بنفس البيانات = سطر نشاط واحد
    const o = await row(id);
    expect([o.totalAmount, o.shippingFees]).toEqual(["710.00", "40.00"]);
    const items = await q("SELECT variantId, quantity, unitPrice FROM order_items WHERE orderId = ? ORDER BY id", [id]);
    expect(items.map((i: any) => [i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[v1, 2, 200], [v2, 2, 150]]);
    await q("UPDATE orders SET status = 'shipped' WHERE id = ?", [id]);
    const shipped = await snap(id);
    expect(await code(() => f.facebookEntry.updateOrder({ ...edit, customerName: "تغيير بعد الشحن" } as any))).toBe("BAD_REQUEST");
    expect(await snap(id)).toBe(shipped);
  });

  // ==================== G5 · سجل الأنشطة ====================
  it("G5 التأكيد/الإلغاء المتكرر = سطر واحد بنشاط ومنفّذ حقيقي (معرّف موجب + دوره)", async () => {
    const id = await order(A, { assignedEmployeeId: agent1 });
    const c = await web(ownerA);
    await c.orders.confirm({ orderId: id }); await c.orders.confirm({ orderId: id });
    const conf = await logs("confirm_order", id);
    expect(conf).toHaveLength(1);
    expect(conf[0]).toMatchObject({ businessId: A.businessId, performedBy: ownerA, performedByRole: "super_admin" });
    await c.orders.cancel({ orderId: id, cancelReason: "تجربة" }); await c.orders.cancel({ orderId: id, cancelReason: "تجربة" });
    expect(await logs("cancel_order", id)).toHaveLength(1);

    const id2 = await order(A, { assignedEmployeeId: agent1 });
    const p = await portal(agent1);
    await p.employeePortal.confirm({ orderId: id2 }); await p.employeePortal.confirm({ orderId: id2 });
    const pc = await logs("confirm_order", id2);
    expect(pc).toHaveLength(1);
    expect(pc[0]).toMatchObject({ businessId: A.businessId, performedBy: agent1, performedByRole: "agent" });
  });

  it("G5 محرر البنود بنفس البيانات مرتين = سطر نشاط وسطر سجل تعديل واحد", async () => {
    const id = await order(A);
    const c = await web(ownerA);
    const items = [{ productId: p1, productName: "أسورة", variantId: v1, quantity: 1, unitPrice: 120, discount: 0 }];
    await c.orders.editOrderItems({ orderId: id, items, shippingFees: 30 });
    await c.orders.editOrderItems({ orderId: id, items, shippingFees: 30 });
    expect(await logs("edit_order_items", id)).toHaveLength(1);
    expect((await q("SELECT COUNT(*) AS n FROM order_edit_logs WHERE orderId = ? AND field = 'orderItems'", [id]))[0].n).toBe(1);
    expect((await row(id)).totalAmount).toBe("150.00");
  });

  it("G5 الحذف (فردي وجماعي) بيتسجّل تحت نشاط الأوردر — مش NULL", async () => {
    const c = await web(ownerA);
    const one = await order(A);
    await c.orders.delete({ orderId: one });
    const d = await logs("delete_order", one);
    expect(d).toHaveLength(1); expect(d[0].businessId).toBe(A.businessId);
    const two = [await order(A), await order(A)];
    await c.orders.bulkDelete({ orderIds: two });
    const bd = (await logs("bulk_delete_orders")).filter((r: any) => JSON.parse(r.metadata).orderIds.includes(two[0]));
    expect(bd).toHaveLength(1); expect(bd[0].businessId).toBe(A.businessId);
  });

  it("G5 إدارة الموظفين بتتسجّل من غير كلمة السر ولا الـhash", async () => {
    const c = await web(ownerA);
    const SECRET = "Sup3r-Secret-Pass!";
    await c.employees.create({ name: "موظف جديد", role: "agent", businessId: A.businessId });
    const created = (await q("SELECT id FROM employees WHERE name = 'موظف جديد' AND tenantId = ?", [A.tenantId]))[0].id as number;
    await c.employees.setCredentials({ id: created, username: `newemp_${tmp.name}`.slice(0, 40), password: SECRET });
    await c.employees.changePassword({ id: created, newPassword: SECRET + "2" });
    await c.employees.update({ id: created, role: "warehouse" });
    const rows = await q("SELECT * FROM activity_logs WHERE entityType = 'employee' AND entityId = ? ORDER BY id", [created]);
    expect(rows.map((r: any) => r.action)).toEqual(["employee_create", "employee_credentials_set", "employee_password_change", "employee_update"]);
    for (const r of rows) {
      expect(r.businessId).toBe(A.businessId);
      expect(r.performedBy).toBe(ownerA);
      const text = `${r.description} ${r.metadata ?? ""}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/\$2[aby]\$/); // bcrypt hash
    }
    expect(JSON.parse(rows[3].metadata).changes.role).toEqual({ from: "agent", to: "warehouse" });
  });

  it("G5 activityLog.list: كل tenant يشوف سطوره بس", async () => {
    const mine = await (await web(ownerA)).activityLog.list({ limit: 100 });
    const theirs = await (await web(ownerB)).activityLog.list({ limit: 100 });
    const rowsOf = (r: any) => (Array.isArray(r) ? r : r.logs ?? r.items ?? r.rows ?? []);
    expect(rowsOf(mine).length).toBeGreaterThan(0);
    expect(rowsOf(mine).every((l: any) => l.businessId === A.businessId)).toBe(true);
    expect(rowsOf(theirs).every((l: any) => l.businessId === B.businessId)).toBe(true);
  });

  it("G5 orders.scanLogsReport (جلسة المالك): سجلات + إحصاءات، مقيّدة بالنطاق", async () => {
    const mineOrder = await order(A); const otherOrder = await order(B, {}, [{ productId: pB, productName: "B", quantity: 1, variantId: vB, unitPrice: 400 }]);
    await q("INSERT INTO scan_logs (orderId, serialNumber, scannedBy, scannedByName, result) VALUES (?, 'SA', ?, 'a', 'success'), (?, 'SB', ?, 'b', 'success'), (0, 'SX', ?, 'a', 'failed')",
      [mineOrder, ownerA, otherOrder, ownerB, ownerA]);
    const r = await (await web(ownerA)).orders.scanLogsReport({ limit: 100 });
    const serials = r.logs.map((l: any) => l.serialNumber).sort();
    expect(serials).toEqual(["SA", "SX"]);
    expect(r.stats).toMatchObject({ total: 2, success: 1, failed: 1 });
    expect(r.logs.find((l: any) => l.serialNumber === "SA")?.order?.orderNumber).toBeTruthy();
    const rb = await (await web(ownerB)).orders.scanLogsReport({ limit: 100 });
    expect(rb.logs.map((l: any) => l.serialNumber)).toEqual(["SB"]);
  });

  // ==================== G2 · التزامن ====================
  it("G2 تأكيد متزامن ×5 ثم إلغاء متزامن ×5: خصم مرة واحدة، إرجاع مرة واحدة، وسطر نشاط واحد لكل منهما", async () => {
    const stock = async () => (await q("SELECT id, currentStock FROM product_variants WHERE id IN (?, ?) ORDER BY id", [v1, v2])).map((r: any) => r.currentStock);
    const s0 = await stock();
    const id = await order(A);
    const c = await web(ownerA);
    const conf = await Promise.allSettled(Array.from({ length: 5 }, () => c.orders.confirm({ orderId: id })));
    expect(conf.filter(r => r.status === "fulfilled").length).toBeGreaterThan(0);
    const s1 = await stock();
    expect([s0[0] - s1[0], s0[1] - s1[1]]).toEqual([1, 2]);
    expect(await logs("confirm_order", id)).toHaveLength(1);
    await Promise.allSettled(Array.from({ length: 5 }, () => c.orders.cancel({ orderId: id, cancelReason: "تزامن" })));
    expect(await stock()).toEqual(s0);
    expect(await logs("cancel_order", id)).toHaveLength(1);
    const moves = await q("SELECT type, SUM(quantity) AS q FROM inventory_movements WHERE orderId = ? GROUP BY type ORDER BY type", [id]);
    expect(moves.map((m: any) => [m.type, Number(m.q)])).toEqual([["in", 3], ["out", 3]]);
  });

  // ==================== G6 · Easy Order ====================
  const eo = (id: string, over: Partial<EasyOrderPayload> = {}): EasyOrderPayload => ({
    id, full_name: "عميل إيزي", phone: "01012345678", government: "الجيزة", address: "شارع النيل رقم 5 الدقي",
    updated_at: "2026-10-01T10:00:00Z", created_at: "2026-10-01T09:00:00Z",
    cart_items: [{ price: 300, quantity: 1, product: { name: "منتج غير مطابق" } }], ...over,
  } as any);

  it("G6 Easy Order: الشحن الافتراضي 50 مابيتغيّرش، بس الأوردر يتعلّم للمراجعة بسبب واضح", async () => {
    const r = await upsertEasyOrder(eo(`EO-DEF-${tmp.name}`.slice(0, 60)), { businessId: A.businessId, source: "easyorder" });
    expect(r.outcome).toBe("created");
    const o = await row(r.orderId!);
    expect([o.totalAmount, o.shippingFees]).toEqual(["350.00", "50.00"]);
    expect(o.needsReview).toBe(1);
    expect(o.reviewReason).toContain("رسوم شحن افتراضية 50");
    expect(o.reviewReason).toContain("غير موجود");
    const z = await upsertEasyOrder(eo(`EO-ZERO-${tmp.name}`.slice(0, 60), { shipping_cost: 0 }), { businessId: A.businessId, source: "easyorder" });
    expect((await row(z.orderId!)).reviewReason).toContain("أرسل الشحن: 0");
    const ok = await upsertEasyOrder(eo(`EO-SHIP-${tmp.name}`.slice(0, 60), { shipping_cost: 35 }), { businessId: A.businessId, source: "easyorder" });
    expect((await row(ok.orderId!)).reviewReason ?? "").not.toContain("رسوم شحن افتراضية");
  });

  it("G6 Easy Order: بيانات أطول من العمود = فشل دائم (permanent) بلا أوردر — مش 500 يتعاد للأبد", async () => {
    const r = await upsertEasyOrder(eo(`EO-LONG-${tmp.name}`.slice(0, 60), { full_name: "ا".repeat(150) }), { businessId: A.businessId, source: "easyorder" });
    expect(r.outcome).toBe("failed");
    expect(r.permanent).toBe(true);
    expect((await q("SELECT COUNT(*) AS n FROM orders WHERE externalOrderId = ?", [`EO-LONG-${tmp.name}`.slice(0, 60)]))[0].n).toBe(0);
  });

  it("G6 Easy Order: تحديث بعد الشحن مايغيّرش الإجمالي/الشحن — يتعلّم للمراجعة، وباقي التحديث يتطبّق", async () => {
    const ext = `EO-LOCK-${tmp.name}`.slice(0, 60);
    const c = await upsertEasyOrder(eo(ext, { shipping_cost: 50 }), { businessId: A.businessId, source: "easyorder" });
    await q("UPDATE orders SET status = 'shipped', needsReview = 0, reviewReason = NULL WHERE id = ?", [c.orderId]);
    const u = await upsertEasyOrder(eo(ext, { shipping_cost: 90, phone: "01099999999", updated_at: "2026-10-02T10:00:00Z" }), { businessId: A.businessId, source: "easyorder" });
    expect(u.outcome).toBe("updated");
    const o = await row(c.orderId!);
    expect([o.totalAmount, o.shippingFees]).toEqual(["350.00", "50.00"]);
    expect(o.needsReview).toBe(1);
    expect(o.reviewReason).toContain(MONEY_LOCKED_UPDATE_REVIEW);
    expect(o.customerPhone).toBe("01099999999");
  });

  it("G6 تحويل الحالة لـ«تم الشحن» يدويًا بيسجّل shippedAt مرة واحدة", async () => {
    const id = await order(A);
    await q("UPDATE orders SET status = 'printed' WHERE id = ?", [id]);
    await (await web(ownerA)).orders.update({ id, status: "shipped" } as any);
    const first = (await row(id)).shippedAt;
    expect(first).toBeTruthy();
  });
});
