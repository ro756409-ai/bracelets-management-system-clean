import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * BUG-41 — حفظ موظف بلا بريد ينجح (الويب وبوابة المدير)، والخانة الفارغة في التعديل لا تمسح
 * بريدًا محفوظًا، والتعديل لموظف بريده فارغ ينجح، والبريد غير الصالح مرفوض.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const as = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("✉️ BUG-41 — البريد الاختياري للموظف", () => {
  let tmp: TempSchema; let A: CoreTestFixture;
  let owner = 0, mgr = 0;
  const row = async (name: string) => { const [[r]] = (await tmp.raw.query("SELECT id, email, phone FROM employees WHERE name = ? AND tenantId = ?", [name, A.tenantId])) as any; return r; };

  beforeAll(async () => {
    tmp = await createTempSchema("emp_mail");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("mail-a");
    owner = insId(await createEmployee({ name: "مالك-بريد", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `own_${tmp.name}`.slice(0, 50) } as any));
    mgr = insId(await createEmployee({ name: "مدير-بريد", role: "manager", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `mgr_${tmp.name}`.slice(0, 50) } as any));
  }, 240_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الإنشاء بخانة بريد فارغة ينجح ويُحفظ بلا بريد", async () => {
    const o = await as(owner);
    expect(await code(() => o.employees.create({ name: "سارة بلا بريد", phone: "01001234511", email: "", role: "agent" }))).toBe("ok");
    expect((await row("سارة بلا بريد")).email).toBeNull();
  });

  it("تعديل موظف بريده فارغ (لتغيير الاسم) ينجح", async () => {
    const o = await as(owner);
    const id = (await row("سارة بلا بريد")).id;
    expect(await code(() => o.employees.update({ id, name: "سارة م", email: "" }))).toBe("ok");
    expect((await row("سارة م")).email).toBeNull();
  });

  it("الخانة الفارغة في التعديل لا تمسح بريدًا محفوظًا؛ والبريد الجديد الصالح يُحفظ", async () => {
    const o = await as(owner);
    expect(await code(() => o.employees.create({ name: "محمد ببريد", email: "mohamed@store.example", role: "agent" }))).toBe("ok");
    const id = (await row("محمد ببريد")).id;
    expect(await code(() => o.employees.update({ id, phone: "01001234512", email: "" }))).toBe("ok");
    expect((await row("محمد ببريد")).email).toBe("mohamed@store.example");
    expect(await code(() => o.employees.update({ id, email: " new@store.example " }))).toBe("ok");
    expect((await row("محمد ببريد")).email).toBe("new@store.example");
  });

  it("البريد غير الصالح مرفوض كما كان", async () => {
    expect(await code(async () => (await as(owner)).employees.create({ name: "خطأ بريد", email: "not-an-email", role: "agent" }))).toBe("BAD_REQUEST");
  });

  it("بوابة المدير: نفس السلوك في createEmployee/updateEmployee", async () => {
    const m = await as(mgr);
    expect(await code(() => m.employeePortal.createEmployee({ name: "مخزن بلا بريد", email: "", role: "warehouse" }))).toBe("ok");
    const id = (await row("مخزن بلا بريد")).id;
    expect(await code(() => m.employeePortal.updateEmployee({ id, name: "مخزن ب", email: "" }))).toBe("ok");
    expect((await row("مخزن ب")).email).toBeNull();
  });
});
