import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/mysql2";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة 4 — الأداء والاعتمادية: رسائل الأخطاء الداخلية مابتسرّبش نص الاستعلام/الـparams للعميل ولا للّوج، أدوات
 * Manus خارج بناء الإنتاج، xlsx بيتحمّل وقت التصدير بس، وسقف لقوائم العميل.
 */
describe("⚡ المرحلة 4 — وحدات", () => {
  const format = (error: TRPCError) =>
    (appRouter as any)._def._config.errorFormatter({ shape: { message: error.message, code: -32603, data: { code: error.code } }, error, type: "query", path: "x", input: undefined, ctx: undefined });

  it("الخطأ الداخلي من الـORM (نص استعلام + params) بيوصل للعميل كود بس؛ رسالة الأعمال العادية بتفضل؛ وباقي الأكواد زي ما هي", () => {
    const orm = Object.assign(new Error("Failed query: select `customerPhone` from `orders` where ... params: 01055544433,عميل-سري"), { cause: { code: "ER_LOCK_DEADLOCK" } });
    const leaked = format(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: orm.message, cause: orm }));
    expect(leaked.message).toBe("خطأ داخلي (ER_LOCK_DEADLOCK)");
    expect(JSON.stringify(leaked)).not.toContain("01055544433");
    const business = format(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "الدورة غير موجودة", cause: new Error("الدورة غير موجودة") }));
    expect(business.message).toBe("الدورة غير موجودة");
    expect(format(new TRPCError({ code: "BAD_REQUEST", message: "رسالة واضحة" })).message).toBe("رسالة واضحة");
  });

  it("حراس على الكود: onError بنص آمن، أدوات Manus في dev بس، xlsx بيتحمّل وقت التصدير، وسقف القوائم", () => {
    expect(fs.readFileSync("server/_core/index.ts", "utf-8")).toContain("message: safeErrorText(error.cause ?? error)");
    const vite = fs.readFileSync("vite.config.ts", "utf-8");
    expect(vite).toContain("serveOnly(vitePluginManusRuntime() as AnyPlugin)");
    expect(vite).toContain("serveOnly(jsxLocPlugin() as AnyPlugin)");
    for (const f of ["client/src/pages/Dashboard.tsx", "client/src/lib/closingExports.ts"]) {
      const src = fs.readFileSync(f, "utf-8");
      expect(src, f).not.toMatch(/^import .* from "xlsx";/m);
      expect(src, f).toContain('await import("xlsx")');
    }
    expect((fs.readFileSync("server/routers.ts", "utf-8").match(/limit: z\.number\(\)\.max\(MAX_LIST_LIMIT\)/g) ?? []).length).toBe(11);
  });
});

const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
describe.runIf(CAN)("⚡ المرحلة 4 — على MySQL مؤقتة", { timeout: 60_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let owner = 0;
  const sign = (id: number) => jwt.sign({ employeeId: id }, process.env.JWT_SECRET as string);
  const web = async () => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(owner) } }, res: { cookie() {}, clearCookie() {} } } as any));
  beforeAll(async () => {
    tmp = await createTempSchema("perf_p4");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("p4-a");
    owner = Number(((await createEmployee({ name: "o4", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `o4_${tmp.name}`.slice(0, 50), passwordHash: "h" } as any)) as any)?.[0]?.insertId);
  }, 180_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("PERF-4 · قوائم العميل بحد أقصى 1000 (فوقه BAD_REQUEST قبل أي استعلام)، والقيمة المستخدمة في الواجهة شغالة", async () => {
    const c = await web();
    await expect(c.orders.list({ limit: 1001 } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.returns.list({ limit: 100000 } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ok: any = await c.orders.list({ limit: 1000 } as any);
    expect(Array.isArray(ok.orders)).toBe(true);
  });
});
