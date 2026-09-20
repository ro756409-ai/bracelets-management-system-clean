import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, createProductWithVariants } from "./db";
import { employees, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة A — نطاق بوابة الموظف = نشاط الموظف، **مهما كانت جلسة الويب في نفس المتصفح**.
 *
 * الثغرة: `employeePortalProcedure` بتحقن `ctx.employee` وبتسيب `ctx.user` بتاع جلسة
 * المالك. `sessionBusinessIds` بتشوف `user.role === "admin"` فبترجّع **كل أنشطة
 * الـtenant** — يعني قيد `employee.businessId` بيتجاهَل وكتالوج شاشة الإدخال يعرض
 * منتجات أنشطة تانية للموظف.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const appTsx = fs.readFileSync("client/src/App.tsx", "utf-8");
const login = fs.readFileSync("client/src/pages/EmployeeLogin.tsx", "utf-8");
const entry = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf-8");

describe("🔒 empScope مابيمرّرش جلسة الويب", () => {
  it("🔒 user: null — جلسة المالك ماتوسّعش نطاق موظف البوابة", () => {
    const fn = routers.slice(
      routers.indexOf("function empScope(ctx: any): ScopeCtx"),
      routers.indexOf("function empScope(ctx: any): ScopeCtx") + 260
    );
    expect(fn).toContain("user: null");
    expect(fn).not.toContain("user: ctx.user");
    expect(fn).toContain("employee: emp");
  });
  it("🔑 نقطة الاختناق واحدة — كل قرّاء البوابة بيمرّوا منها", () => {
    // لو رجع حد يمرّر ctx.user في أي استدعاء مباشر، الحارس ده بيسقط.
    expect(routers).not.toContain("user: ctx.user ?? null, employee");
    expect(routers.match(/empScope\(ctx\)/g)!.length).toBeGreaterThan(20);
  });
});

describe("🔒 حالة العميل بتتمسح مع تغيّر الهوية", () => {
  it("🔒 حارس الهوية مركّب في جذر التطبيق", () => {
    expect(appTsx).toContain("<EmployeeScopeGuard />");
  });
  it("🔒 الدخول بيمسح cache ومسودات الحساب السابق", () => {
    expect(login).toContain("resetEmployeeClientState(queryClient");
  });
  it("🔒 مفتاح المسودة مربوط بالحساب — المفتاح العام اتشال", () => {
    expect(entry).toContain("draftKey(readEmployeeScope())");
    expect(entry).not.toContain('const DRAFT_KEY = "manualEntryDraft"');
  });
  it("🔒 المسودة المسترجعة متحقَّقة ضد الكتالوج", () => {
    expect(entry).toContain("keepItemsInCatalog(d.items, catalog)");
  });
});

// ── سلوكي فعلي: موظف نشاط A مايشوفش نشاط B مهما كانت جلسة الويب ──
const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN_E2E)("🔒 عزل بوابة الموظف — سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { empIds: [] as number[], productIds: [] as number[] };
  let empA = 0, empNoBiz = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  /** ctx بجلسة موظف + **جلسة مالك admin في نفس المتصفح** (سيناريو الثغرة). */
  const ctxFor = (employeeId: number, webUser: any = null) => ({
    user: webUser, employee: null, tenantId: null,
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  }) as any;
  const caller = (employeeId: number, webUser: any = null) =>
    appRouter.createCaller(ctxFor(employeeId, webUser));

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("scope-a");
    B = await createCoreTestFixture("scope-b");
    const pa = await createProductWithVariants(A.businessId, { name: `منتج A ${tag}` }, [
      { name: "نوع A", sku: `SC-A-${tag}`, currentStock: 5, price: "100" },
    ]);
    const pb = await createProductWithVariants(B.businessId, { name: `منتج B ${tag}` }, [
      { color: "أسود", size: "6", sku: `SC-B-${tag}`, currentStock: 5, price: "200" },
    ]);
    ids.productIds.push(pa.productId, pb.productId);
    empA = insId(await createEmployee({ name: "emp-A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `scA_${tag}` } as any));
    empNoBiz = insId(await createEmployee({ name: "emp-none", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: null, username: `scN_${tag}` } as any));
    ids.empIds.push(empA, empNoBiz);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔒 موظف A يشوف منتجاته بس", async () => {
    const cat = await caller(empA).facebookEntry.catalog();
    expect(cat.products.some(p => p.name === `منتج A ${tag}`)).toBe(true);
    expect(cat.products.some(p => p.name === `منتج B ${tag}`)).toBe(false);
    expect(cat.variants.some(v => v.sku === `SC-B-${tag}`)).toBe(false);
  });

  it("🔒 **الثغرة**: جلسة مالك admin في نفس المتصفح ماتوسّعش نطاقه", async () => {
    const withOwner = await caller(empA, { id: 1, role: "admin", name: "owner" })
      .facebookEntry.catalog();
    expect(withOwner.products.some(p => p.name === `منتج B ${tag}`)).toBe(false);
    expect(withOwner.variants.some(v => v.sku === `SC-B-${tag}`)).toBe(false);
    expect(withOwner.products.every(p => p.businessId === A.businessId)).toBe(true);
  });

  it("🔒 نفس الشيء على parsePaste (نفس الكتالوج)", async () => {
    const res = await caller(empA, { id: 1, role: "admin", name: "owner" })
      .facebookEntry.parsePaste({ text: `نوع المنتج: منتج B ${tag}\nعدد القطع: 1` });
    // منتج النشاط التاني مايتطابقش — لا بالاسم ولا بأي fallback
    expect(res.match).toBeNull();
  });

  it("🔒 موظف بلا نشاط → كتالوج فاضي (fail-closed) حتى بجلسة مالك", async () => {
    const cat = await caller(empNoBiz, { id: 1, role: "admin", name: "owner" })
      .facebookEntry.catalog();
    expect(cat.products).toEqual([]);
    expect(cat.variants).toEqual([]);
  });

  it("🔒 مفيش fallback لـbusinessId=1", async () => {
    const cat = await caller(empA).facebookEntry.catalog();
    if (A.businessId !== 1) expect(cat.products.some(p => p.businessId === 1)).toBe(false);
  });
});
