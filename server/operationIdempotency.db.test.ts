import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createProductWithVariants } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { makeInventoryKey } from "./inventoryV2.service";
import { OPERATION_IDEMPOTENCY_FILE, OPERATION_IDEMPOTENCY_MIGRATION } from "./operationIdempotencyMigration";
import { numberSource } from "./uniqueNumber";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * 0052 — منع تكرار إنشاء الأوردر وإرسال الورشة على السيرفر، على قواعد مؤقتة محلية فقط:
 *  • الـMigration: check → apply → verify → replay، القيود فعّالة، rollback مرفوض مع أي صف ثم ناجح بعد التفريغ.
 *  • نفس المفتاح + نفس البيانات = نفس النتيجة (ولو ضاع الرد)؛ بيانات مختلفة = CONFLICT؛ التزامن = عملية واحدة؛
 *    عزل الشركات والأنشطة؛ فاعل آخر لا يرى النتيجة؛ الفشل بلا بيانات جزئية ولا يستهلك المفتاح؛ عمليتان مستقلتان بنفس
 *    المحتوى = عمليتان؛ الطلب بلا مفتاح غير محمي ولا يُسجَّل له شيء؛ قبل 0052 الطلب بمعرّف مرفوض (fail-closed)؛
 *    والإيقاف التشغيلي OPERATION_CREATION_PAUSED يرفض العمليتين للجميع بلا أي كتابة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const errOf = async (p: Promise<any>) => p.then(() => null, (e: any) => e);

describe.runIf(CAN)("🔁 0052 — منع تكرار الإنشاء على السيرفر", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  let A2 = 0;
  const e: Record<string, number> = {};
  const P: Record<string, { productId: number; variants: number[] }> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const n = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0].n);
  const caller = (emp: number) => appRouter.createCaller({ user: null, employee: null, tenantId: null,
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: emp }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} } } as any);
  const orderInput = (who: string, tag: string, extra: Record<string, unknown> = {}) => ({
    customerName: `عميل ${tag}`, customerPhone: "01012345678", governorate: "القاهرة", customerAddress: `عنوان ${tag}`,
    selectedProducts: P[who].variants.slice(0, 2).map((v, k) => ({ productId: P[who].productId, productName: "x", quantity: k + 1, variantId: v, unitPrice: 100 })),
    totalAmount: 300, ...extra,
  });
  const add = (emp: string, who: string, tag: string, operationId?: string, extra: Record<string, unknown> = {}) =>
    caller(e[emp]).facebookEntry.addOrder({ ...orderInput(who, tag, extra), ...(operationId ? { operationId } : {}) } as any);
  const ordersNamed = (tag: string) => n("SELECT COUNT(*) n FROM orders WHERE customerName = ?", [`عميل ${tag}`]);
  const keys = (opId: string) => n("SELECT COUNT(*) n FROM operation_idempotency_keys WHERE operationId = ?", [opId]);
  const allCounts = async () => ({ orders: await n("SELECT COUNT(*) n FROM orders"), items: await n("SELECT COUNT(*) n FROM order_items"), keys: await n("SELECT COUNT(*) n FROM operation_idempotency_keys") });
  let seq = 0;
  const op = () => `op_${Date.now().toString(36)}_${++seq}_test`;

  beforeAll(async () => {
    tmp = await createTempSchema("idem");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("id-a"); B = await createCoreTestFixture("id-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug, baseCurrency) VALUES (?, 'نشاط ثانٍ', ?, 'EGP')", [A.tenantId, `id-a2-${tmp.name}`.slice(0, 50)]));
    const emp = async (k: string, role: string, tenantId: number, businessId: number) => { e[k] = insId(await createEmployee({ name: k, role, isActive: true, tenantId, businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await emp("deA", "data_entry", A.tenantId, A.businessId); await emp("deA_other", "data_entry", A.tenantId, A.businessId);
    await emp("deA2", "data_entry", A.tenantId, A2); await emp("deB", "data_entry", B.tenantId, B.businessId);
    await emp("ownerA", "super_admin", A.tenantId, A.businessId); await emp("ownerB", "super_admin", B.tenantId, B.businessId);
    for (const [k, biz] of [["A", A.businessId], ["A2", A2], ["B", B.businessId]] as const) {
      const tag = `${k}${Date.now()}`;
      const p = await createProductWithVariants(biz, { name: `أسورة ${tag}` }, [
        { name: "سادة", sku: `ID-1-${tag}`, currentStock: 1000, price: "150" }, { name: "منقوش", sku: `ID-2-${tag}`, currentStock: 1000, price: "200" }]);
      P[k] = { productId: p.productId, variants: p.variantIds };
    }
  }, 300_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("Migration 0052: check → apply → مطابقة كاملة → replay؛ القيود فعّالة؛ rollback مرفوض مع أي صف ثم ناجح بعد التفريغ، ثم إعادة التطبيق", async () => {
    const sqlText = fs.readFileSync(OPERATION_IDEMPOTENCY_FILE, "utf-8");
    const run = (mode: "check" | "apply" | "rollback") => runHandMigration(OPERATION_IDEMPOTENCY_MIGRATION, { databaseUrl: tmp.url, mode, sqlText,
      ...(mode === "check" ? {} : { deployEnv: "test", confirm: confirmPhrase("0052", mode, tmp.name) }) });
    expect((await run("check")).state).toBe("not_applied");
    expect((await runHandMigration(OPERATION_IDEMPOTENCY_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText, deployEnv: "test", confirm: "APPLY 0052 TO other" })).refused).toMatch(/عبارة التأكيد/);
    const a = await run("apply");
    expect([a.ok, a.state, a.issues]).toEqual([true, "applied", []]);
    expect((await run("apply")).replay).toBe(true);
    expect((await run("check")).ok).toBe(true);
    const H = "a".repeat(64);
    const ins = (tenant: number, biz: number, opId: string, hash = H) => q("INSERT INTO operation_idempotency_keys (tenantId, businessId, operation, operationId, requestHash, resultId, resultReference, actorType, actorId) VALUES (?, ?, 'order.create', ?, ?, 1, 'FB-1', 'employee', 1)", [tenant, biz, opId, hash]);
    await expect(ins(A.tenantId, A.businessId, "bad id!")).rejects.toThrow(/chk_oik_operation_id/);
    await expect(ins(A.tenantId, A.businessId, "abcdefgh1", "XYZ")).rejects.toThrow(/chk_oik_hash/);
    await expect(ins(A.tenantId, B.businessId, "abcdefgh2")).rejects.toThrow(/foreign key/i);   // نشاط من شركة أخرى
    await ins(A.tenantId, A.businessId, "abcdefgh3");
    await expect(ins(A.tenantId, A.businessId, "abcdefgh3")).rejects.toThrow(/Duplicate/);
    await ins(A.tenantId, A2, "abcdefgh3"); await ins(B.tenantId, B.businessId, "abcdefgh3");     // نفس المعرّف بنطاق آخر
    expect((await run("rollback")).refused).toBe("not_empty");
    await q("DELETE FROM operation_idempotency_keys"); // تفريغ يدوي (اختبار فقط — التطبيق لا يملك مسار حذف)
    expect((await run("rollback")).ok).toBe(true);
    expect((await run("check")).state).toBe("not_applied");
    expect((await run("apply")).ok).toBe(true);
  });

  it("أوردر: نفس المفتاح ونفس البيانات (رد ضائع ثم إعادة) = نفس الأوردر بلا تكرار بنود؛ بيانات مختلفة = CONFLICT", async () => {
    const k = op();
    const r1 = await add("deA", "A", "same-1", k);
    expect([r1.replay, r1.idempotency]).toEqual([false, "protected"]);
    const items = await n("SELECT COUNT(*) n FROM order_items i JOIN orders o ON o.id = i.orderId WHERE o.orderNumber = ?", [r1.orderNumber]);
    const r2 = await add("deA", "A", "same-1", k); // الرد الأول «ضاع» — الواجهة تعيد بنفس المعرّف
    expect([r2.orderNumber, r2.replay, r2.idempotency]).toEqual([r1.orderNumber, true, "protected"]);
    expect([await ordersNamed("same-1"), await keys(k), await n("SELECT COUNT(*) n FROM order_items i JOIN orders o ON o.id = i.orderId WHERE o.orderNumber = ?", [r1.orderNumber])]).toEqual([1, 1, items]);
    const before = await allCounts();
    const err = await errOf(add("deA", "A", "same-1", k, { notes: "تعديل بعد الحفظ" }));
    expect([err?.code, String(err?.message)]).toEqual(["CONFLICT", expect.stringContaining(r1.orderNumber)]);
    expect(await allCounts()).toEqual(before);
  });

  it("أوردر: 6 طلبات متزامنة بنفس المفتاح = أوردر واحد ومفتاح واحد، والكل يرى نفس الرقم", async () => {
    const k = op();
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => add("deA", "A", "conc-1", k)));
    expect(res.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason?.message).slice(0, 100))).toEqual([]);
    const nums = new Set(res.map(r => (r as PromiseFulfilledResult<any>).value.orderNumber));
    expect([nums.size, await ordersNamed("conc-1"), await keys(k)]).toEqual([1, 1, 1]);
    expect(res.filter(r => !(r as PromiseFulfilledResult<any>).value.replay)).toHaveLength(1);
    expect(await n("SELECT COUNT(*) n FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_items i WHERE i.orderId = o.id)")).toBe(0);
  });

  it("أوردر: عمليتان مستقلتان بنفس المحتوى (مفتاحان) = أوردران؛ وبلا مفتاح = غير محمي ولا يُسجَّل شيء", async () => {
    await add("deA", "A", "twin", op()); await add("deA", "A", "twin", op());
    expect(await ordersNamed("twin")).toBe(2);
    const keysBefore = await n("SELECT COUNT(*) n FROM operation_idempotency_keys");
    const l1 = await add("deA", "A", "legacy"); const l2 = await add("deA", "A", "legacy");
    expect([l1.idempotency, l2.idempotency, l1.orderNumber === l2.orderNumber]).toEqual(["none", "none", false]);
    expect([await ordersNamed("legacy"), await n("SELECT COUNT(*) n FROM operation_idempotency_keys")]).toEqual([2, keysBefore]);
    expect((await errOf(add("deA", "A", "bad", "short")))?.code).toBe("BAD_REQUEST"); // صيغة معرّف غير صالحة
  });

  it("أوردر: العزل — نفس المعرّف في شركة أخرى أو نشاط آخر = عملية مستقلة؛ موظف آخر في نفس النشاط = CONFLICT بلا كشف رقم الأوردر", async () => {
    const k = op();
    const mine = await add("deA", "A", "iso-a", k);
    const otherTenant = await add("deB", "B", "iso-b", k);
    const otherBiz = await add("deA2", "A2", "iso-a2", k);
    expect([otherTenant.replay, otherBiz.replay]).toEqual([false, false]);
    expect(new Set([mine.orderNumber, otherTenant.orderNumber, otherBiz.orderNumber]).size).toBe(3);
    expect(await keys(k)).toBe(3);
    const before = await allCounts();
    const err = await errOf(add("deA_other", "A", "iso-a", k));
    expect(err?.code).toBe("CONFLICT");
    expect(String(err?.message)).not.toContain(mine.orderNumber);
    expect(await allCounts()).toEqual(before);
  });

  it("أوردر: فشل داخل المعاملة (استنفاد أرقام) = لا أوردر ولا مفتاح؛ والمفتاح غير مستهلك — إعادة المحاولة تنجح مرة واحدة", async () => {
    const taken = (await add("deB", "B", "taken")).orderNumber;
    const k = op(); const before = await allCounts();
    vi.spyOn(numberSource, "fbOrder").mockReturnValue(taken);
    expect((await errOf(add("deA", "A", "fail-1", k)))?.code).toBe("CONFLICT");
    expect([await allCounts(), await keys(k)]).toEqual([before, 0]);
    vi.restoreAllMocks();
    const ok = await add("deA", "A", "fail-1", k);
    expect([ok.replay, await ordersNamed("fail-1"), await keys(k)]).toEqual([false, 1, 1]);
    expect((await add("deA", "A", "fail-1", k)).orderNumber).toBe(ok.orderNumber);
  });

  it("أوردر: بعد حذف الأوردر، إعادة نفس المعرّف تُرفض ولا تُنشئ أوردرًا جديدًا", async () => {
    const k = op();
    const r = await add("deA", "A", "deleted-1", k);
    const [{ id }] = await q("SELECT id FROM orders WHERE orderNumber = ?", [r.orderNumber]);
    await caller(e.deA).facebookEntry.deleteOrder({ orderId: Number(id) });
    expect(await ordersNamed("deleted-1")).toBe(0);
    expect((await errOf(add("deA", "A", "deleted-1", k)))?.code).toBe("CONFLICT");
    expect(await ordersNamed("deleted-1")).toBe(0);
  });

  describe("إرسال الورشة", () => {
    const W: Record<string, { office: number; workshop: number; product: number }> = {};
    const bal = async (wh: number, product: number) => Number((await q("SELECT onHandQuantity n FROM inventory_balances WHERE warehouseId = ? AND inventoryKey = ?", [wh, makeInventoryKey(product)]))[0]?.n ?? 0);
    const sendInput = (k: "A" | "B", quantity: number, reason = "تلميع") => ({ businessId: (k === "A" ? A : B).businessId, reason, occurredAt: new Date("2026-10-10T10:00:00Z"), lines: [{ productId: W[k].product, quantity }] });
    // جلسة كاملة (createContext) — مسارات المحاسبة تقرأ الموظف من السياق
    const ctxCaller = async (emp: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: emp }, process.env.JWT_SECRET as string) } }, res: { cookie: () => {}, clearCookie: () => {} } } as any));
    const send = async (k: "A" | "B", quantity: number, operationId?: string, reason?: string) =>
      (await ctxCaller(k === "A" ? e.ownerA : e.ownerB)).accountingV2.workshopSend({ ...sendInput(k, quantity, reason), ...(operationId ? { operationId } : {}) } as any);

    beforeAll(async () => {
      for (const [k, f] of [["A", A], ["B", B]] as const) {
        const office = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'المكتب')", [f.businessId]));
        const workshop = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'الورشة')", [f.businessId]));
        await q("UPDATE businesses SET defaultWarehouseId = ?, workshopWarehouseId = ? WHERE id = ?", [office, workshop, f.businessId]);
        const product = insId(await q("INSERT INTO products (name, businessId) VALUES ('أسورة ورشة', ?)", [f.businessId]));
        await q("INSERT INTO inventory_balances (businessId, warehouseId, productId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, ?, 100, '4000.0000', '40.0000')", [f.businessId, office, product, makeInventoryKey(product)]);
        W[k] = { office, workshop, product };
      }
    });

    it("نفس المفتاح ونفس البيانات = نفس الإذن والمخزون يتحرك مرة؛ بيانات مختلفة = CONFLICT بلا حركة", async () => {
      const k = op();
      const r1 = await send("A", 5, k);
      const r2 = await send("A", 5, k);
      expect([r2.reference, r2.replay, r2.idempotency]).toEqual([r1.reference, true, "protected"]);
      expect([await bal(W.A.office, W.A.product), await bal(W.A.workshop, W.A.product), await keys(k)]).toEqual([95, 5, 1]);
      expect((await errOf(send("A", 6, k)))?.code).toBe("CONFLICT");
      expect(await bal(W.A.office, W.A.product)).toBe(95);
    });

    it("4 إرسالات متزامنة بنفس المفتاح = حركة واحدة؛ نفس المعرّف في شركة أخرى = عملية مستقلة؛ بلا مفتاح = غير محمي", async () => {
      const k = op();
      const res = await Promise.allSettled(Array.from({ length: 4 }, () => send("A", 2, k)));
      expect(res.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason?.message).slice(0, 100))).toEqual([]);
      expect(new Set(res.map(r => (r as PromiseFulfilledResult<any>).value.reference)).size).toBe(1);
      expect([await bal(W.A.office, W.A.product), await keys(k)]).toEqual([93, 1]);
      const other = await send("B", 3, k);
      expect([other.replay, await bal(W.B.office, W.B.product), await keys(k)]).toEqual([false, 97, 2]);
      const l1 = await send("A", 1), l2 = await send("A", 1);
      expect([l1.idempotency, l2.idempotency, l1.reference === l2.reference, await bal(W.A.office, W.A.product)]).toEqual(["none", "none", false, 91]);
    });
  });

  it("الإيقاف التشغيلي (OPERATION_CREATION_PAUSED=true): الأوردر والورشة مرفوضان للجميع — بمعرّف أو بدونه — بلا أي كتابة", async () => {
    const prev = process.env.OPERATION_CREATION_PAUSED;
    process.env.OPERATION_CREATION_PAUSED = "true";
    try {
      const before = await allCounts();
      const events = await n("SELECT COUNT(*) n FROM business_events WHERE eventType = 'inventory.stock_transfer'");
      expect((await errOf(add("deA", "A", "paused-1", op())))?.code).toBe("PRECONDITION_FAILED");
      expect((await errOf(add("deA", "A", "paused-2")))?.code).toBe("PRECONDITION_FAILED");
      const ctx = await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: e.ownerA }, process.env.JWT_SECRET as string) } }, res: { cookie: () => {}, clearCookie: () => {} } } as any);
      const ws = appRouter.createCaller(ctx).accountingV2.workshopSend({ businessId: A.businessId, reason: "تلميع", occurredAt: new Date(), lines: [{ productId: P.A.productId, quantity: 1 }], operationId: op() } as any);
      expect((await errOf(ws))?.code).toBe("PRECONDITION_FAILED");
      expect([await allCounts(), await n("SELECT COUNT(*) n FROM business_events WHERE eventType = 'inventory.stock_transfer'")]).toEqual([before, events]);
    } finally { if (prev === undefined) delete process.env.OPERATION_CREATION_PAUSED; else process.env.OPERATION_CREATION_PAUSED = prev; }
    expect((await add("deA", "A", "paused-3", op())).idempotency).toBe("protected");
  });

  it("قبل 0052 (الجدول غير موجود): الطلب بمعرّف مرفوض بلا أي كتابة (لا مرور صامت بلا حماية)؛ الطلب القديم بلا معرّف يعمل «none»", async () => {
    const bare = await createTempSchema("idem_bare");
    try {
      for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await bare.raw.query(stmt);
      __setDbForTests(drizzle(bare.url));
      const f = await createCoreTestFixture("id-bare");
      const emp = insId(await createEmployee({ name: "bare", role: "data_entry", isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `bare_${bare.name}`.slice(0, 50) } as any));
      const p = await createProductWithVariants(f.businessId, { name: `أسورة bare ${Date.now()}` }, [{ name: "سادة", sku: `ID-B-${Date.now()}`, currentStock: 10, price: "150" }]);
      const input = { customerName: "عميل bare", customerPhone: "01012345678", governorate: "القاهرة", customerAddress: "عنوان", totalAmount: 100,
        selectedProducts: [{ productId: p.productId, productName: "x", quantity: 1, variantId: p.variantIds[0], unitPrice: 100 }] };
      const count = async () => Number(((await bare.raw.query("SELECT COUNT(*) n FROM orders WHERE customerName = 'عميل bare'")) as any)[0][0].n);
      expect((await errOf(caller(emp).facebookEntry.addOrder({ ...input, operationId: op() } as any)))?.code).toBe("PRECONDITION_FAILED");
      expect(await count()).toBe(0);
      const legacy = await caller(emp).facebookEntry.addOrder(input as any);
      expect([legacy.idempotency, await count()]).toEqual(["none", 1]);
    } finally { __setDbForTests(drizzle(tmp.url)); await bare.drop(); }
  }, 300_000);
});
