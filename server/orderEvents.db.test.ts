import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, getDb, createEmployee, confirmOrder, cancelOrder, assignOrderToEmployee, updateOrder } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { applyBostaEvent } from "./bostaWebhook";
import { normalizeBostaEvent } from "./bostaEvents";
import { applyExternalStatus } from "./easyorderWebhook";
import { COOKIE_NAME } from "@shared/const";

/**
 * سجل أحداث الأوردرات (0041) عبر المسارات الحقيقية على قاعدة Docker مؤقتة (نسخة المخطط + 0041):
 * العلم معطل/مفعّل، الجدول غائب/موجود، Replay/Conflict، Double-click متزامن، كل مسارات القرار، الإسناد،
 * الويبهوك (Retry لا يكرر)، عزل الـtenant، الحذف بعد الحدث، ولا تغيير بلا حدث.
 */
const SQL = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.message ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const op = () => `op${Math.random().toString(36).slice(2, 14)}`;

describe("🔒 0041 — حراس نصّية", () => {
  const all = ["server/db.ts", "server/routers.ts", "server/orderEvents.service.ts", "server/bostaWebhook.ts", "server/easyorderWebhook.ts"].map(f => fs.readFileSync(f, "utf-8")).join("\n");
  it("لا UPDATE ولا DELETE على جدول الأحداث في أي مسار كود", () => {
    expect(all).not.toMatch(/update\(orderActivityEvents\)/);
    expect(all).not.toMatch(/delete\(orderActivityEvents\)/);
    expect(all).not.toMatch(/(UPDATE|DELETE FROM)\s+`?order_activity_events/i);
  });
  it("العميل لا يرسل eventType/tenantId/businessId — الحدث من المسار والأوردر", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    expect(routers).not.toMatch(/eventType:\s*z\./);
    expect(routers).toContain("const operationIdInput = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional();");
  });
});

describe.runIf(CAN)("📒 0041 — الخدمة والمسارات على قاعدة مؤقتة", () => {
  let withTable: TempSchema, without: TempSchema;
  let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const savedFlag = process.env.ORDER_EVENTS_ENABLED;
  const db = () => withTable.raw;
  const events = async (orderId: number) => ((await db().query("SELECT * FROM order_activity_events WHERE orderId = ? ORDER BY id", [orderId])) as any)[0] as any[];
  const status = async (orderId: number) => (((await db().query("SELECT status, assignedEmployeeId FROM orders WHERE id = ?", [orderId])) as any)[0][0]);
  const flag = (on: boolean) => { process.env.ORDER_EVENTS_ENABLED = on ? "true" : "false"; };

  async function mkOrder(f: CoreTestFixture, assignee: number | null, extra: Record<string, unknown> = {}) {
    const d = (await getDb())!;
    const { orders, orderItems } = await import("../drizzle/schema");
    const id = insId(await d.insert(orders).values({
      businessId: f.businessId, orderNumber: `E-${Math.random().toString(36).slice(2, 10)}`, customerName: "عميل", customerPhone: "01000000000",
      customerAddress: "شارع تجريبي 12", governorate: "القاهرة", productName: "منتج", quantity: 1, totalAmount: "100.00", source: "manual",
      status: "new", productId: f.productId, assignedEmployeeId: assignee, ...extra,
    } as any));
    await d.insert(orderItems).values({ orderId: id, productId: f.productId, productName: "منتج", quantity: 1, unitPrice: "100.00" } as any);
    return id;
  }

  beforeAll(async () => {
    withTable = await createTempSchema("oev_on");
    without = await createTempSchema("oev_off");
    const r = await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: withTable.url, mode: "apply", sqlText: SQL, deployEnv: "test", confirm: confirmPhrase("0041", "apply", withTable.name) });
    expect(r.ok).toBe(true);
    __setDbForTests(drizzle(withTable.url));
    A = await createCoreTestFixture("ev-a"); B = await createCoreTestFixture("ev-b");
    await db().query("UPDATE products SET currentStock = 100 WHERE id IN (?, ?)", [A.productId, B.productId]);
    const mk = async (key: string, role: string, f: CoreTestFixture) => { emp[key] = insId(await createEmployee({ name: `${key}-ev`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${key}_${withTable.name}`.slice(0, 50) } as any)); };
    await mk("agentA", "agent", A); await mk("agentA2", "agent", A); await mk("ownerA", "super_admin", A); await mk("mgrA", "manager", A); await mk("agentB", "agent", B);
  }, 240_000);

  afterAll(async () => {
    if (savedFlag == null) delete process.env.ORDER_EVENTS_ENABLED; else process.env.ORDER_EVENTS_ENABLED = savedFlag;
    __setDbForTests(null);
    await withTable?.drop(); await without?.drop();
  }, 180_000);

  it("العلم معطل: لا أحداث، والمسار القديم يعمل كما هو", async () => {
    flag(false);
    const o = await mkOrder(A, emp.agentA);
    await (await portal(emp.agentA)).employeePortal.confirm({ orderId: o, operationId: op() });
    expect((await status(o)).status).toBe("confirmed");
    expect(await events(o)).toEqual([]);
  });

  it("العلم معطل والجدول غائب: النظام يعمل طبيعيًا (لا وصول للجدول)", async () => {
    flag(false);
    __setDbForTests(drizzle(without.url));
    try {
      const F = await createCoreTestFixture("ev-off");
      await without.raw.query("UPDATE products SET currentStock = 10 WHERE id = ?", [F.productId]);
      const agent = insId(await createEmployee({ name: "off-agent", role: "agent", isActive: true, tenantId: F.tenantId, businessId: F.businessId, username: `off_${without.name}`.slice(0, 50) } as any));
      const o = await mkOrder(F, agent);
      await (await portal(agent)).employeePortal.confirm({ orderId: o });
      await (await portal(agent)).employeePortal.markNoAnswer({ orderId: await mkOrder(F, agent), callAttempts: 2 });
      const [[row]] = (await without.raw.query("SELECT status FROM orders WHERE id = ?", [o])) as any;
      expect(row.status).toBe("confirmed");
      // العلم مفعّل والجدول غائب → PRECONDITION_FAILED بلا أي تغيير
      flag(true);
      const o2 = await mkOrder(F, agent);
      expect(await code(async () => (await portal(agent)).employeePortal.confirm({ orderId: o2, operationId: op() }))).toBe("PRECONDITION_FAILED");
      expect(await code(async () => (await portal(agent)).employeePortal.postpone({ orderId: o2, postponedTo: new Date(Date.now() + 86400000), operationId: op() }))).toBe("PRECONDITION_FAILED");
      const [[row2]] = (await without.raw.query("SELECT status FROM orders WHERE id = ?", [o2])) as any;
      expect(row2.status).toBe("new");
    } finally {
      __setDbForTests(drizzle(withTable.url));
      flag(false);
    }
  }, 60_000);

  it("تأكيد من البوابة: حدث واحد منسوب لمنفّذه، tenant/business من الأوردر، والوقت من السيرفر", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    await (await portal(emp.agentA)).employeePortal.confirm({ orderId: o, operationId: op() });
    const [e] = await events(o);
    expect(e).toMatchObject({ tenantId: A.tenantId, businessId: A.businessId, eventType: "confirm", fromStatus: "new", toStatus: "confirmed", actorType: "employee", actorEmployeeId: emp.agentA, attributedEmployeeId: emp.agentA, source: "employee_portal" });
    expect(String(e.payloadHash)).toMatch(/^[0-9a-f]{64}$/);
    // الوقت من السيرفر بالـepoch (مستقل عن time_zone الجلسة وعن توقيت جهاز الاختبار)
    const [[t]] = (await db().query("SELECT UNIX_TIMESTAMP(occurredAt) * 1000 AS ms FROM order_activity_events WHERE id = ?", [e.id])) as any;
    expect(Math.abs(Number(t.ms) - Date.now())).toBeLessThan(5 * 60_000);
  });

  it("Double-click متزامن بنفس operationId: حدث واحد وخصم مخزون مرة واحدة", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    const [[before]] = (await db().query("SELECT currentStock FROM products WHERE id = ?", [A.productId])) as any;
    const id = op();
    const c = await portal(emp.agentA);
    const results = await Promise.allSettled([c.employeePortal.confirm({ orderId: o, operationId: id }), c.employeePortal.confirm({ orderId: o, operationId: id })]);
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    expect((await events(o)).length).toBe(1);
    const [[after]] = (await db().query("SELECT currentStock FROM products WHERE id = ?", [A.productId])) as any;
    expect(Number(before.currentStock) - Number(after.currentStock)).toBe(1);
    // Replay لاحق بنفس المعرّف: نجاح بلا حدث جديد
    await c.employeePortal.confirm({ orderId: o, operationId: id });
    expect((await events(o)).length).toBe(1);
  });

  it("نفس المفتاح + hash مختلف = CONFLICT بلا تغيير", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    const id = op();
    const c = await portal(emp.agentA);
    await c.employeePortal.cancel({ orderId: o, cancelReason: "سعر", operationId: id });
    expect(await code(() => c.employeePortal.cancel({ orderId: o, cancelReason: "شحن", operationId: id }))).toBe("CONFLICT");
    expect((await events(o)).length).toBe(1);
    expect((await events(o))[0].reason).toBe("سعر");
  });

  it("كل مسارات القرار: لم يرد (محاولات) → تأجيل → تأكيد، وإلغاء من الإدارة باسم موظف حقيقي (لا رقم سالب)", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    const c = await portal(emp.agentA);
    await c.employeePortal.markNoAnswer({ orderId: o, callAttempts: 3, operationId: op() });
    await c.employeePortal.postpone({ orderId: o, postponedTo: new Date(Date.now() + 86400000), operationId: op() });
    await c.employeePortal.updateStatus({ orderId: o, status: "confirmed", operationId: op() });
    const ev = await events(o);
    expect(ev.map(e => [e.eventType, e.fromStatus, e.toStatus, e.callAttempt])).toEqual([
      ["no_answer", "new", "no_answer", 3], ["postpone", "no_answer", "postponed", null], ["confirm", "postponed", "confirmed", null],
    ]);
    const o2 = await mkOrder(A, emp.agentA);
    await (await web(emp.ownerA)).orders.cancel({ orderId: o2, cancelReason: "مكرر", operationId: op() });
    const [e2] = await events(o2);
    expect(e2).toMatchObject({ eventType: "cancel", actorEmployeeId: emp.ownerA, attributedEmployeeId: emp.ownerA, source: "admin_ui", reason: "مكرر" });
    const o3 = await mkOrder(A, emp.agentA);
    await (await web(emp.ownerA)).orders.markNoAnswer({ orderId: o3, callAttempts: 1, operationId: op() });
    await (await web(emp.ownerA)).orders.update({ id: o3, status: "postponed", operationId: op() });
    expect((await events(o3)).map(e => e.eventType)).toEqual(["no_answer", "postpone"]);
  });

  it("الإسناد: assign ثم reassign ثم سحب الإسناد — كل حدث بالمُسنَد السابق والحالي", async () => {
    flag(true);
    const o = await mkOrder(A, null);
    const m = await portal(emp.mgrA);
    await m.employeePortal.assignOrder({ orderId: o, employeeId: emp.agentA, operationId: op() });
    await m.employeePortal.bulkAssignOrders({ orderIds: [o], employeeId: emp.agentA2, operationId: op() });
    await m.employeePortal.assignOrder({ orderId: o, employeeId: emp.agentA2, operationId: op() }); // نفس المُسنَد = لا حدث
    await (await web(emp.ownerA)).employees.reclaimOrders({ employeeId: emp.agentA2, operationId: op() });
    const ev = await events(o);
    expect(ev.map(e => [e.eventType, e.assigneeEmployeeIdAtEvent, e.previousAssigneeEmployeeId, e.source])).toEqual([
      ["assign", emp.agentA, null, "employee_portal"], ["reassign", emp.agentA2, emp.agentA, "bulk"], ["unassign", null, emp.agentA2, "bulk"],
    ]);
    expect((await status(o)).assignedEmployeeId).toBeNull();
  });

  it("الويبهوك: Bosta وEasy Orders بفاعل ويبهوك بلا نسبة لموظف، والإعادة لا تكرر الحدث", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA, { status: "confirmed", bostaShipmentId: `SHP-${Math.random().toString(36).slice(2, 8)}` });
    const [[row]] = (await db().query("SELECT bostaShipmentId FROM orders WHERE id = ?", [o])) as any;
    const n = normalizeBostaEvent({ _id: row.bostaShipmentId, state: 24, type: "SEND", timeStamp: Date.now() });
    expect(n.ok).toBe(true);
    const ev = (n as any).event;
    await applyBostaEvent(A.businessId, ev);
    await applyBostaEvent(A.businessId, ev); // Retry
    const bosta = (await events(o)).filter(e => e.eventType === "ship_update");
    expect(bosta.length).toBe(1);
    expect(bosta[0]).toMatchObject({ actorType: "webhook", actorEmployeeId: null, attributedEmployeeId: null, source: "webhook_bosta", fromStatus: "confirmed", toStatus: "shipped" });
    const o2 = await mkOrder(A, emp.agentA);
    expect(await applyExternalStatus(o2, "confirmed")).toEqual({ ok: true });
    expect(await applyExternalStatus(o2, "confirmed")).toEqual({ ok: true }); // Retry بنفس الحالة
    const eo = await events(o2);
    expect(eo.length).toBe(1);
    expect(eo[0]).toMatchObject({ eventType: "confirm", actorType: "webhook", attributedEmployeeId: null, source: "webhook_easyorders" });
  });

  it("عزل الـtenant: فاعل من شركة B على أوردر A يُرفض بلا أي تغيير (لا تغيير بلا حدث)", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    const ctx = { actor: { type: "employee" as const, employeeId: emp.agentB, role: "agent", name: "x" }, source: "employee_portal" as const, operationId: op() };
    expect(await code(() => confirmOrder(o, emp.agentB, "x", ctx))).toBe("FORBIDDEN");
    expect(await code(() => cancelOrder(o, "سعر", undefined, emp.agentB, ctx))).toBe("FORBIDDEN");
    expect(await code(() => assignOrderToEmployee(o, emp.agentA2, emp.agentB, ctx))).toBe("FORBIDDEN");
    expect(await code(() => updateOrder(o, { status: "no_answer" }, ctx))).toBe("FORBIDDEN");
    expect(await status(o)).toMatchObject({ status: "new", assignedEmployeeId: emp.agentA });
    expect(await events(o)).toEqual([]);
    const [[stock]] = (await db().query("SELECT COUNT(*) n FROM inventory_movements WHERE orderId = ?", [o])) as any;
    expect(Number(stock.n)).toBe(0);
  });

  it("مسار بلا سياق حدث والعلم مفعّل = PRECONDITION_FAILED بلا تغيير", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    expect(await code(() => updateOrder(o, { status: "no_answer" }))).toBe("PRECONDITION_FAILED");
    expect((await status(o)).status).toBe("new");
  });

  it("حذف الأوردر المكرر بعد الحدث: الحدث يبقى مقروءًا بالرقم المحفوظ", async () => {
    flag(true);
    const o = await mkOrder(A, emp.agentA);
    const [[{ orderNumber }]] = (await db().query("SELECT orderNumber FROM orders WHERE id = ?", [o])) as any;
    await (await portal(emp.agentA)).employeePortal.markNoAnswer({ orderId: o, operationId: op() });
    await db().query("DELETE FROM order_items WHERE orderId = ?", [o]);
    await db().query("DELETE FROM orders WHERE id = ?", [o]);
    const [e] = await events(o);
    expect(e.orderNumberSnapshot).toBe(orderNumber);
  });
});

describe.runIf(CAN)("🔎 معاينة Backfill — قراءة فقط", () => {
  it("تعدّ المصادر بالدرجات، معزولة لكل شركة، ولا تكتب شيئًا", async () => {
    const tmp = await createTempSchema("oev_bf");
    try {
      const { openReadOnlyExecutor } = await import("./balanceReconciliation.service");
      const { previewOrderEventsBackfill } = await import("./orderEventsBackfillPreview.service");
      const q = (s: string, p: unknown[] = []) => tmp.raw.query(s, p).then(r => (r[0] as any).insertId as number);
      const t1 = await q("INSERT INTO tenants (name, slug, status) VALUES ('T1', ?, 'active')", [`t1-${tmp.name}`.slice(0, 60)]);
      const t2 = await q("INSERT INTO tenants (name, slug, status) VALUES ('T2', ?, 'active')", [`t2-${tmp.name}`.slice(0, 60)]);
      const b1 = await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'B1', ?)", [t1, `b1-${tmp.name}`.slice(0, 50)]);
      const b2 = await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'B2', ?)", [t2, `b2-${tmp.name}`.slice(0, 50)]);
      const e1 = await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('e1', 'agent', 1, ?, ?, ?)", [t1, b1, `e1-${tmp.name}`.slice(0, 50)]);
      const mkO = (biz: number, extra: string, vals: unknown[]) => q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, governorate, customerAddress, productName, quantity, totalAmount, source${extra ? ", " + extra : ""}) VALUES (?, ?, 'c', '01000000000', 'القاهرة', 'عنوان طويل', 'p', 1, 1, 'manual'${vals.map(() => ", ?").join("")})`, [biz, `BF-${Math.random().toString(36).slice(2, 10)}`, ...vals]);
      const o1 = await mkO(b1, "status, confirmedByEmployeeId, confirmedAt", ["confirmed", e1, new Date()]);
      await mkO(b1, "status", ["no_answer"]);
      await mkO(b1, "assignedEmployeeId", [e1]);
      await mkO(b2, "status", ["no_answer"]);
      await q("INSERT INTO order_edit_logs (orderId, field, oldValue, newValue, editedBy, editedByName, editedByRole) VALUES (?, 'status', 'new', 'confirmed', ?, 'e1', 'agent')", [o1, e1]);
      await q("INSERT INTO activity_logs (businessId, action, entityType, entityId, description, performedBy, performedByName, performedByRole) VALUES (?, 'cancel_order', 'order', ?, 'x', ?, 'e1', 'admin')", [b1, o1, -e1]);
      const ro = await openReadOnlyExecutor(tmp.url);
      try {
        const p1 = await previewOrderEventsBackfill(ro, t1);
        expect(p1).toEqual({ tenantId: t1, confirmed: { confirmFromOrders: 1, statusFromEditLogs: 1 }, partial: { activityLogs: 1 }, unknown: { noAnswerOrders: 1, postponedOrders: 0, assignedOrders: 1, printedOrders: 0 } });
        expect((await previewOrderEventsBackfill(ro, t2)).unknown.noAnswerOrders).toBe(1);
        await expect(ro.query("DELETE FROM orders")).rejects.toThrow(/non-SELECT/);
      } finally { await ro.close(); }
    } finally { await tmp.drop(); }
  }, 120_000);
});
