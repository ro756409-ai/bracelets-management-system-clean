import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { createEmployee } from "./db";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { canWriteCost, costForSubmit } from "../client/src/lib/costWrite";

/**
 * BUG-01 (Release 1) — نموذج تعديل المخزون للمدير المسحوب منه inventory_costing.manage:
 *  • auth.myPermissions يعكس السحب (نفس قاعدة permissionProcedure) فالواجهة ماتبعتش تكلفة؛
 *  • التعديل بالشكل اللي النموذج بيبعته (بلا تكلفة) ينجح والتكلفة المحفوظة ماتتغيرش؛
 *  • أي محاولة مباشرة لتغيير التكلفة تفضل مرفوضة؛ والمالك والمحاسب بلا تغيير.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const as = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🧾 BUG-01 — نموذج تعديل المخزون بلا صلاحية إدارة التكلفة", () => {
  const RUN = `cf${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let raw: mysql.Pool; let A: CoreTestFixture;
  const e: Record<string, number> = {};
  let variant = 0;
  const q = async (sql: string, p: any[] = []) => ((await raw.query(sql, p)) as any)[0];
  const override = (permission: string, allowed: boolean) =>
    q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'manager', ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [A.tenantId, permission, allowed ? 1 : 0, e.owner]);
  const clear = () => q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'manager'", [A.tenantId]);
  const row = async () => (await q("SELECT name, price, costPrice, minStockLevel, isActive FROM product_variants WHERE id = ?", [variant]))[0];
  const perms = async (id: number) => (await (await as(id)).auth.myPermissions()) as string[];
  /** نفس حساب الصفحة: canWriteCost من myPermissions ثم costForSubmit على قيمة الخانة المحمّلة. */
  const formEdit = async (id: number, edit: { name: string; price: number; minStockLevel: number }, loadedCost: number) => {
    const list = await perms(id);
    const can = canWriteCost({ isSuccess: true, has: p => list.includes(p) });
    return (await as(id)).variants.update({ id: variant, name: edit.name, price: edit.price, costPrice: costForSubmit(can, loadedCost), minStockLevel: edit.minStockLevel, isActive: true });
  };

  beforeAll(async () => {
    raw = mysql.createPool(process.env.DATABASE_URL as string);
    A = await createCoreTestFixture("costform-a");
    const mk = async (k: string, role: string) => { e[k] = insId(await createEmployee({ name: `${k}-cf`, role, isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `${k}_${RUN}`.slice(0, 50) } as any)); };
    await mk("owner", "super_admin"); await mk("acc", "accountant"); await mk("mgr", "manager");
    variant = insId(await raw.query("INSERT INTO product_variants (productId, name, price, costPrice, currentStock, minStockLevel) VALUES (?, 'نقش', 250, 90, 10, 5)", [A.productId]));
  }, 120_000);
  afterAll(async () => { if (A) await clear().catch(() => {}); await raw?.end(); }, 60_000);

  it("myPermissions: المالك والمحاسب كما هم، والمدير يتبع تجاوزات الشركة في inventory_costing.* فقط", async () => {
    expect(await perms(e.owner)).toEqual(expect.arrayContaining(["inventory_costing.view", "inventory_costing.manage", "inventory_costing.approve"]));
    const acc = await perms(e.acc);
    expect(acc).toEqual(expect.arrayContaining(["inventory_costing.view", "inventory_costing.manage"]));
    const mgrDefault = await perms(e.mgr);
    expect(mgrDefault).toEqual(expect.arrayContaining(["inventory_costing.view", "inventory_costing.manage"]));
    await override("inventory_costing.manage", false);
    const mgrRevoked = await perms(e.mgr);
    expect(mgrRevoked).toContain("inventory_costing.view");
    expect(mgrRevoked).not.toContain("inventory_costing.manage");
    // باقي قائمة المدير زي ما هي (نفس الطول ناقص الصلاحية المسحوبة)
    expect(mgrRevoked.length).toBe(mgrDefault.length - 1);
    expect(await perms(e.owner)).toContain("inventory_costing.manage");
    await clear();
  });

  it("المدير المسحوب منه الإدارة: تعديل الاسم والسعر والحد الأدنى من النموذج ينجح، والتكلفة كما هي", async () => {
    await override("inventory_costing.manage", false);
    expect(await code(() => formEdit(e.mgr, { name: "نقش معدّل", price: 260, minStockLevel: 4 }, 90))).toBe("ok");
    const r = await row();
    expect([r.name, Number(r.price), Number(r.costPrice), r.minStockLevel]).toEqual(["نقش معدّل", 260, 90, 4]);
    await clear();
  });

  it("السيرفر يفضل يرفض أي محاولة مباشرة لتغيير التكلفة بلا صلاحية، ولا يتغير شيء", async () => {
    await override("inventory_costing.manage", false);
    const before = await row();
    const m = await as(e.mgr);
    expect(await code(() => m.variants.update({ id: variant, price: 999, costPrice: 1 }))).toBe("FORBIDDEN");
    expect(await code(() => m.variants.update({ id: variant, costPrice: 90 }))).toBe("FORBIDDEN"); // حتى نفس القيمة
    expect(await row()).toEqual(before);
    await clear();
  });

  it("المالك: نفس السلوك — النموذج يرسل التكلفة وتتحفظ", async () => {
    expect(await code(() => formEdit(e.owner, { name: "نقش", price: 250, minStockLevel: 5 }, 95))).toBe("ok");
    expect(Number((await row()).costPrice)).toBe(95);
  });

  it("المدير بالافتراضي: نفس السلوك القديم — يعدّل التكلفة من النموذج", async () => {
    expect(await code(() => formEdit(e.mgr, { name: "نقش", price: 250, minStockLevel: 5 }, 91))).toBe("ok");
    expect(Number((await row()).costPrice)).toBe(91);
  });
});
