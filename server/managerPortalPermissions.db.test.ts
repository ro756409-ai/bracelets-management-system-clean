import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * لوحة المدير: الدور الإداري شرط (لا توسيع للمشرف) + صلاحية لكل تبويب/فعل بتجاوزات الشركة؛ المخزون بـ
 * inventory.view/adjust بدل الدور الحرفي؛ التكلفة لا تظهر إلا بـinventory_costing.view؛ ومهام الويب
 * القراءة employees.view والكتابة employees.manage. كل سحب لشركة A لا يمس B.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🧭 لوحة المدير — صلاحية لكل تبويب وفعل", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const override = (tenantId: number, role: string, permission: string, allowed: boolean) =>
    tmp.raw.query("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [tenantId, role, permission, allowed ? 1 : 0, emp.ownerA]);
  const clear = (tenantId: number, role: string, permission: string) => tmp.raw.query("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = ? AND permission = ?", [tenantId, role, permission]);

  beforeAll(async () => {
    tmp = await createTempSchema("mgr_p");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("mp-a"); B = await createCoreTestFixture("mp-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { emp[k] = insId(await createEmployee({ name: `${k}-mp`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("mgr", "manager", A); await mk("mgrB", "manager", B); await mk("mod", "moderator", A); await mk("wh", "warehouse", A); await mk("whB", "warehouse", B); await mk("agent", "agent", A); await mk("ownerA", "super_admin", A);
    await tmp.raw.query("INSERT INTO product_variants (productId, name, price, costPrice, currentStock) VALUES (?, 'نقش', 250, 90, 10)", [A.productId]);
  }, 240_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الدور شرط: المشرف ممنوع من لوحة المدير حتى لو عنده الصلاحية", async () => {
    const m = await portal(emp.mod);
    expect(await code(() => m.employeePortal.allOrders({} as any))).toBe("FORBIDDEN");
    expect(await code(() => m.employeePortal.employeesList())).toBe("FORBIDDEN");
  });

  it("المدير بالافتراضي يعدّي؛ سحب employees.manage في A يمنع الكتابة فقط وفي A فقط", async () => {
    const m = await portal(emp.mgr);
    expect(await code(() => m.employeePortal.employeesList())).toBe("ok");
    expect(await code(() => m.employeePortal.dashboardStats({}))).toBe("ok");
    await override(A.tenantId, "manager", "employees.manage", false);
    expect(await code(() => m.employeePortal.employeesList())).toBe("ok");
    expect(await code(() => m.employeePortal.createEmployee({ name: "x", role: "agent" } as any))).toBe("FORBIDDEN");
    expect(await code(() => m.employeePortal.sendBroadcast({ message: "x" }))).toBe("FORBIDDEN");
    expect(await code(() => m.tasks.create({ title: "مهمة" }))).toBe("FORBIDDEN");
    expect(await code(() => m.tasks.list({}))).toBe("ok");
    expect(await code(async () => (await portal(emp.mgrB)).employeePortal.sendBroadcast({ message: "مرحبًا" }))).toBe("ok");
    await clear(A.tenantId, "manager", "employees.manage");
    expect(await code(() => m.tasks.create({ title: "مهمة" }))).toBe("ok");
  });

  it("سحب orders.view/employees.view يغلق التبويب على السيرفر", async () => {
    const m = await portal(emp.mgr);
    await override(A.tenantId, "manager", "orders.view", false);
    expect(await code(() => m.employeePortal.allOrders({} as any))).toBe("FORBIDDEN");
    await clear(A.tenantId, "manager", "orders.view");
    await override(A.tenantId, "manager", "employees.view", false);
    expect(await code(() => m.tasks.list({}))).toBe("FORBIDDEN");
    expect(await code(() => m.employeePortal.activeEmployeesList())).toBe("FORBIDDEN");
    await clear(A.tenantId, "manager", "employees.view");
  });

  it("المخزون: المخزن view/adjust بالافتراضي، الوكيل ممنوع، وسحب adjust في A لا يمس B", async () => {
    const w = await portal(emp.wh);
    expect(await code(() => w.employeePortal.productsList())).toBe("ok");
    expect(await code(() => w.employeePortal.inventoryMovements({ limit: 5 }))).toBe("ok");
    expect(await code(() => w.employeePortal.addInventoryMovement({ productId: A.productId, type: "in", quantity: 1 }))).toBe("ok");
    expect(await code(async () => (await portal(emp.agent)).employeePortal.productsList())).toBe("FORBIDDEN");
    await override(A.tenantId, "warehouse", "inventory.adjust", false);
    expect(await code(() => w.employeePortal.addInventoryMovement({ productId: A.productId, type: "in", quantity: 1 }))).toBe("FORBIDDEN");
    expect(await code(() => w.employeePortal.productsList())).toBe("ok");
    expect(await code(async () => (await portal(emp.whB)).employeePortal.addInventoryMovement({ productId: B.productId, type: "in", quantity: 1 }))).toBe("ok");
    expect(await code(() => w.employeePortal.addInventoryMovement({ productId: B.productId, type: "in", quantity: 1 }))).toBe("FORBIDDEN");
    await clear(A.tenantId, "warehouse", "inventory.adjust");
  });

  it("التكلفة: لا تظهر للمخزن ولا للوكيل؛ تظهر بالمنح أو للمدير", async () => {
    const variants = async (id: number) => (await (await portal(id)).employeePortal.stockVariants({})) as any[];
    const wv = await variants(emp.wh);
    expect(wv.length).toBeGreaterThan(0);
    expect(wv.every(v => !("costPrice" in v))).toBe(true);
    expect((await variants(emp.agent)).every(v => !("costPrice" in v))).toBe(true);
    expect((await variants(emp.mgr)).some(v => Number(v.costPrice) === 90)).toBe(true);
    await override(A.tenantId, "warehouse", "inventory_costing.view", true);
    expect((await variants(emp.wh)).some(v => Number(v.costPrice) === 90)).toBe(true);
    await clear(A.tenantId, "warehouse", "inventory_costing.view");
  });
});
