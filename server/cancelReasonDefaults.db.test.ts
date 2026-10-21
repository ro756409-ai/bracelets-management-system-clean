import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { createEmployee } from "./db";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { DEFAULT_CANCEL_REASONS } from "../client/src/hooks/useCancelReasonOptions";

/**
 * BUG-28 على السيرفر: نشاط بلا أسباب إلغاء مضبوطة — الأسباب الافتراضية اللي الواجهة بقت تعرضها
 * يقبلها السيرفر وتتحفظ كما هي (لوحة الإدارة والبوابة)، والسبب الفارغ مرفوض، وعزل الشركات كما هو.
 * لا تغيير سيرفر في هذا الإصلاح — الاختبار يثبت إن القائمة الافتراضية صالحة فعلًا ضد القاعدة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const as = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🚫 BUG-28 — الإلغاء بالأسباب الافتراضية على قاعدة حقيقية", () => {
  const RUN = `cr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let raw: mysql.Pool; let A: CoreTestFixture; let B: CoreTestFixture;
  const e: Record<string, number> = {};
  const q = async (s: string, p: unknown[] = []) => ((await raw.query(s, p)) as any)[0];
  let seq = 0;
  const newOrder = async (f: CoreTestFixture, assignee: number | null) =>
    insId(await raw.query(
      "INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, status, source, assignedEmployeeId) VALUES (?, ?, 'عميل', '01000000000', 'عنوان كامل للاختبار', 'القاهرة', 'أسورة', '250.00', 'new', 'manual', ?)",
      [f.businessId, `${RUN}${++seq}`.slice(0, 20), assignee]));
  const order = async (id: number) => (await q("SELECT status, cancelReason FROM orders WHERE id = ?", [id]))[0];

  beforeAll(async () => {
    raw = mysql.createPool(process.env.DATABASE_URL as string);
    A = await createCoreTestFixture("cr-a"); B = await createCoreTestFixture("cr-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => {
      e[k] = insId(await createEmployee({ name: `${k}-cr`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${RUN}`.slice(0, 50) } as any));
    };
    await mk("ownerA", "super_admin", A); await mk("agentA", "agent", A); await mk("agentA2", "agent", A); await mk("ownerB", "super_admin", B);
    // النشاطان بلا أي أسباب إلغاء مضبوطة — نفس حالة البلاغ.
    expect((await q("SELECT COUNT(*) AS n FROM business_configuration_values WHERE businessId IN (?, ?) AND namespace = 'cancellation_reason'", [A.businessId, B.businessId]))[0].n).toBe(0);
  }, 120_000);
  afterAll(async () => { await raw?.end(); }, 60_000);

  it("كل الأسباب الافتراضية تقع داخل حد السيرفر (1–80 حرفًا)", () => {
    expect(DEFAULT_CANCEL_REASONS.length).toBe(8);
    for (const r of DEFAULT_CANCEL_REASONS) { expect(r.length).toBeGreaterThan(0); expect(r.length).toBeLessThanOrEqual(80); }
  });

  it("لوحة الإدارة: المالك يلغي بكل سبب افتراضي ويتحفظ السبب كما هو", async () => {
    const o = await as(e.ownerA);
    for (const reason of DEFAULT_CANCEL_REASONS) {
      const id = await newOrder(A, null);
      expect(await code(() => o.orders.cancel({ orderId: id, cancelReason: reason })), reason).toBe("ok");
      expect(await order(id)).toEqual({ status: "cancelled", cancelReason: reason });
    }
  });

  it("البوابة: الوكيل يلغي أوردره بسبب افتراضي؛ ولا يلغي أوردر زميله", async () => {
    const mine = await newOrder(A, e.agentA), other = await newOrder(A, e.agentA2);
    const ag = await as(e.agentA);
    expect(await code(() => ag.employeePortal.cancel({ orderId: mine, cancelReason: DEFAULT_CANCEL_REASONS[7] }))).toBe("ok");
    expect(await order(mine)).toEqual({ status: "cancelled", cancelReason: DEFAULT_CANCEL_REASONS[7] });
    expect(await code(() => ag.employeePortal.cancel({ orderId: other, cancelReason: DEFAULT_CANCEL_REASONS[0] }))).not.toBe("ok");
    expect((await order(other)).status).toBe("new");
  });

  it("السبب الفارغ مرفوض كما كان، والأوردر لا يتغير", async () => {
    const id = await newOrder(A, e.agentA);
    expect(await code(async () => (await as(e.ownerA)).orders.cancel({ orderId: id, cancelReason: "" }))).toBe("BAD_REQUEST");
    expect(await code(async () => (await as(e.agentA)).employeePortal.cancel({ orderId: id, cancelReason: "" }))).toBe("BAD_REQUEST");
    expect(await order(id)).toEqual({ status: "new", cancelReason: null });
  });

  it("عزل الشركات: مالك الشركة B لا يلغي أوردر الشركة A", async () => {
    const id = await newOrder(A, null);
    expect(await code(async () => (await as(e.ownerB)).orders.cancel({ orderId: id, cancelReason: DEFAULT_CANCEL_REASONS[0] }))).not.toBe("ok");
    expect(await order(id)).toEqual({ status: "new", cancelReason: null });
  });
});
