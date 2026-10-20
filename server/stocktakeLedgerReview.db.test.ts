import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";

/**
 * BUG-55 — فشل ترحيل فروق الجرد للدفتر بعد الاعتماد: الاعتماد وحركة المخزون يفضلوا (مفيش rollback ولا retry)، والنتيجة
 * `ledger.status = "review"` بسبب آمن (من غير نص الاستعلام/بيانات)، ومحاولة ترحيل واحدة بس، وسطر في سجل النشاط للمراجعة.
 * الترحيل الناجح مايكتبش سطر مراجعة.
 */
const ledgerMock = vi.hoisted(() => ({ postStocktakeVariance: vi.fn() }));
vi.mock("./ledgerInventory.service", async orig => ({
  ...(await orig<typeof import("./ledgerInventory.service")>()),
  postStocktakeVariance: ledgerMock.postStocktakeVariance,
}));

import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { makeInventoryKey } from "./inventoryV2.service";
import { createStocktake, getStocktake, submitStocktake, updateStocktakeLine } from "./stocktake.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const as = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const MAKER = { id: 7101, name: "عادّ الجرد" };

class DriverLikeError extends Error {
  code = "ER_LOCK_DEADLOCK";
  sql = "insert into ledger_entries ...";
}

describe.runIf(CAN)("📒 BUG-55 — فشل قيد فروق الجرد لا يظهر كنجاح كامل", () => {
  let tmp: TempSchema; let fx: CoreTestFixture; let owner = 0;
  const q = async (sql: string, p: any[] = []) => tmp.raw.query(sql, p);
  const rows = async (sql: string, p: any[] = []) => ((await q(sql, p)) as any)[0] as any[];

  beforeAll(async () => {
    tmp = await createTempSchema("st_ledger");
    __setDbForTests(drizzle(tmp.url));
    fx = await createCoreTestFixture("st-ledger");
    owner = insId(await createEmployee({ name: "owner-st", role: "super_admin", isActive: true, tenantId: fx.tenantId, businessId: fx.businessId, username: `own_${tmp.name}`.slice(0, 50) } as any));
  }, 240_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);
  beforeEach(() => { ledgerMock.postStocktakeVariance.mockReset(); });

  async function pendingStocktake(onHand: number, counted: number) {
    const key = makeInventoryKey(fx.productId, null);
    await q("DELETE FROM inventory_balances WHERE businessId = ? AND warehouseId = ? AND inventoryKey = ?", [fx.businessId, fx.warehouseId, key]);
    await q("INSERT INTO inventory_balances (businessId, warehouseId, productId, variantId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, NULL, ?, ?, ?, '10.0000')",
      [fx.businessId, fx.warehouseId, fx.productId, key, onHand, (onHand * 10).toFixed(4)]);
    const { stocktakeId } = await createStocktake({ businessId: fx.businessId, warehouseId: fx.warehouseId, actor: MAKER } as any);
    const snap = await getStocktake({ businessId: fx.businessId, stocktakeId });
    const line = snap!.lines.find((l: any) => l.productId === fx.productId)!;
    await updateStocktakeLine({ businessId: fx.businessId, stocktakeId, lineId: line.id, countedQuantity: counted, actor: MAKER } as any);
    await submitStocktake({ businessId: fx.businessId, stocktakeId });
    return { stocktakeId, key };
  }

  it("القيد فشل: الاعتماد والمخزون اتحرّكوا، review بسبب آمن، محاولة واحدة، وسطر مراجعة في سجل النشاط", async () => {
    ledgerMock.postStocktakeVariance.mockRejectedValue(new DriverLikeError("Failed query: insert into `ledger_entries` params: 01012345678"));
    const { stocktakeId, key } = await pendingStocktake(100, 95);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r: any = await (await as(owner)).accountingV2.stocktakeApprove({ businessId: fx.businessId, stocktakeId });
    const warned = warn.mock.calls.map(c => JSON.stringify(c));
    warn.mockRestore();

    expect(r.ledger.status).toBe("review");
    expect(r.ledger.reason).not.toMatch(/Failed query|ledger_entries|01012345678/);
    expect(ledgerMock.postStocktakeVariance).toHaveBeenCalledTimes(1); // بلا retry
    expect(warned.some(c => c.includes("[stocktake-ledger]"))).toBe(true);
    expect(warned.join(" ")).not.toMatch(/Failed query|01012345678/);

    const [st] = await rows("SELECT status FROM stocktakes WHERE id = ?", [stocktakeId]);
    expect(st.status).toBe("approved");
    const [bal] = await rows("SELECT onHandQuantity FROM inventory_balances WHERE businessId = ? AND warehouseId = ? AND inventoryKey = ?", [fx.businessId, fx.warehouseId, key]);
    expect(Number(bal.onHandQuantity)).toBe(95);

    const logs = await rows("SELECT * FROM activity_logs WHERE action = 'stocktake_ledger_review' AND entityId = ?", [stocktakeId]);
    expect(logs).toHaveLength(1);
    expect(logs[0].entityType).toBe("stocktake");
    expect(Number(logs[0].businessId)).toBe(fx.businessId);
    expect(Number(logs[0].performedBy)).toBe(owner);
    expect(String(logs[0].description)).toContain(`#${stocktakeId}`);
    expect(JSON.stringify(logs[0])).not.toMatch(/Failed query|01012345678/);
  });

  it("القيد نجح: النتيجة posted ومفيش سطر مراجعة", async () => {
    ledgerMock.postStocktakeVariance.mockResolvedValue({ status: "posted", transactionId: 1, amount: "50.00", direction: "loss" });
    const { stocktakeId } = await pendingStocktake(40, 35);
    const r: any = await (await as(owner)).accountingV2.stocktakeApprove({ businessId: fx.businessId, stocktakeId });
    expect(r.ledger.status).toBe("posted");
    expect(await rows("SELECT id FROM activity_logs WHERE action = 'stocktake_ledger_review' AND entityId = ?", [stocktakeId])).toHaveLength(0);
  });
});
