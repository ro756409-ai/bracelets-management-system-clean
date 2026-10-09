import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * البوابة على حارس واحد (`requireEmployeeTenantPermission`): الافتراضي كما هو، والمنح والسحب لكل شركة
 * يطبَّقان فورًا ولشركتها فقط، وهوية البوابة من كوكي الموظف وحده (لا جلسة مالك). + «مهامي».
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const caller = async (cookies: Record<string, string>) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies }, res } as any));
const portal = (id: number, ownerOf?: number) => caller({ employee_token: sign(id), ...(ownerOf ? { [COOKIE_NAME]: sign(ownerOf) } : {}) });
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const ITEMS = { orderId: 999_999_999, items: [{ productId: null, productName: "x", variantId: null, quantity: 1, unitPrice: 1, discount: 0 }] };

describe.runIf(CAN)("🔐 البوابة — منح/سحب لكل شركة، هوية الكوكي فقط، ومهامي", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const task: Record<string, number> = {};
  const override = (tenantId: number, role: string, permission: string, allowed: boolean) =>
    tmp.raw.query("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [tenantId, role, permission, allowed ? 1 : 0, emp.ownerA]);
  const clear = (tenantId: number, role: string, permission: string) => tmp.raw.query("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = ? AND permission = ?", [tenantId, role, permission]);

  beforeAll(async () => {
    tmp = await createTempSchema("portal_p");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("pp-a"); B = await createCoreTestFixture("pp-b");
    const mk = async (k: string, role: string, f: CoreTestFixture, businessId: number | null = f.businessId) => { emp[k] = insId(await createEmployee({ name: `${k}-pp`, role, isActive: true, tenantId: f.tenantId, businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("agent", "agent", A); await mk("agent2", "agent", A); await mk("wh", "warehouse", A); await mk("ownerA", "super_admin", A);
    await mk("agentB", "agent", B); await mk("whB", "warehouse", B); await mk("noBiz", "agent", A, null);
    const t = async (k: string, businessId: number | null, assignedTo: number | null) => {
      const [r] = (await tmp.raw.query("INSERT INTO tasks (businessId, title, assignedTo, createdBy, createdByName) VALUES (?, ?, ?, ?, 'المدير')", [businessId, k, assignedTo, emp.ownerA])) as any;
      task[k] = Number(r.insertId);
    };
    await t("mine", A.businessId, emp.agent); await t("general", A.businessId, null); await t("colleague", A.businessId, emp.agent2); await t("tenantB", B.businessId, null);
  }, 240_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الافتراضي كما هو: الوكيل يعدّي حارس التأكيد، والمخزن ممنوع من تعديل البنود", async () => {
    expect(await code(async () => (await portal(emp.agent)).employeePortal.confirm({ orderId: 999_999_999 }))).not.toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.wh)).employeePortal.editOrderItems(ITEMS))).toBe("FORBIDDEN");
  });

  it("السحب لشركة A يمنع فورًا في A فقط، والرجوع يعيد الافتراضي", async () => {
    await override(A.tenantId, "agent", "orders.confirm", false);
    expect(await code(async () => (await portal(emp.agent)).employeePortal.confirm({ orderId: 999_999_999 }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.agentB)).employeePortal.confirm({ orderId: 999_999_999 }))).not.toBe("FORBIDDEN");
    await clear(A.tenantId, "agent", "orders.confirm");
    expect(await code(async () => (await portal(emp.agent)).employeePortal.confirm({ orderId: 999_999_999 }))).not.toBe("FORBIDDEN");
  });

  it("المنح لشركة A يفتح في A فقط", async () => {
    await override(A.tenantId, "warehouse", "orders.edit_items", true);
    expect(await code(async () => (await portal(emp.wh)).employeePortal.editOrderItems(ITEMS))).not.toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.whB)).employeePortal.editOrderItems(ITEMS))).toBe("FORBIDDEN");
    await clear(A.tenantId, "warehouse", "orders.edit_items");
  });

  it("لا جلسة مالك في البوابة: كوكي المالك وحده UNAUTHORIZED، ومع كوكي موظف الهوية هي الموظف", async () => {
    expect(await code(async () => (await caller({ [COOKIE_NAME]: sign(emp.ownerA) })).employeePortal.editOrderItems(ITEMS))).toBe("UNAUTHORIZED");
    expect(await code(async () => (await portal(emp.wh, emp.ownerA)).employeePortal.editOrderItems(ITEMS))).toBe("FORBIDDEN");
    expect(await code(async () => (await caller({ [COOKIE_NAME]: sign(emp.ownerA) })).employeePortal.tasks.listMine())).toBe("UNAUTHORIZED");
  });

  it("مهامي: مهامي + العامة لنشاطي فقط — لا مهام زميل ولا شركة أخرى", async () => {
    const rows = await (await portal(emp.agent)).employeePortal.tasks.listMine();
    expect(rows.map((r: any) => r.id).sort()).toEqual([task.mine, task.general].sort());
    const b = await (await portal(emp.agentB)).employeePortal.tasks.listMine();
    expect(b.map((r: any) => r.id)).toEqual([task.tenantB]);
    expect(await (await portal(emp.noBiz)).employeePortal.tasks.listMine()).toEqual([]);
  });

  it("تحديث الحالة: مهمتي والعامة فقط؛ الزميل والشركة الأخرى NOT_FOUND بلا تغيير", async () => {
    const a = await portal(emp.agent);
    expect((await a.employeePortal.tasks.updateMyStatus({ taskId: task.mine, status: "done" })).success).toBe(true);
    expect((await a.employeePortal.tasks.updateMyStatus({ taskId: task.general, status: "in_progress" })).success).toBe(true);
    expect(await code(() => a.employeePortal.tasks.updateMyStatus({ taskId: task.colleague, status: "done" }))).toBe("NOT_FOUND");
    expect(await code(() => a.employeePortal.tasks.updateMyStatus({ taskId: task.tenantB, status: "done" }))).toBe("NOT_FOUND");
    const [rows] = (await tmp.raw.query("SELECT id, taskStatus AS s FROM tasks WHERE id IN (?, ?, ?, ?) ORDER BY id", [task.mine, task.general, task.colleague, task.tenantB])) as any;
    expect(Object.fromEntries(rows.map((r: any) => [r.id, r.s]))).toEqual({ [task.mine]: "done", [task.general]: "in_progress", [task.colleague]: "new", [task.tenantB]: "new" });
  });

  it("مهامي strict + منح/سحب tasks.view_own", async () => {
    const a = await portal(emp.agent);
    expect(await code(() => a.employeePortal.tasks.listMine({ employeeId: emp.agent2 } as any))).toBe("BAD_REQUEST");
    expect(await code(() => a.employeePortal.tasks.updateMyStatus({ taskId: task.mine, status: "done", employeeId: emp.agent2 } as any))).toBe("BAD_REQUEST");
    await override(A.tenantId, "agent", "tasks.view_own", false);
    expect(await code(() => a.employeePortal.tasks.listMine())).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.agentB)).employeePortal.tasks.listMine())).toBe("ok");
    await clear(A.tenantId, "agent", "tasks.view_own");
  });
});
