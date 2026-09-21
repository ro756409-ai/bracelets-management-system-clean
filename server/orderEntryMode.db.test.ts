import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import {
  getDb,
  createEmployee,
  createProductWithVariants,
  getOrderEntryMode,
  setOrderEntryMode,
} from "./db";
import { businessConfigurationValues, employees, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import {
  parseOrderEntryMode,
  DEFAULT_ORDER_ENTRY_MODE,
  ORDER_ENTRY_NAMESPACE,
  ORDER_ENTRY_CONFIG_KEY,
} from "../shared/orderEntryMode";

/**
 * قالب شاشة الإدخال لكل نشاط — من السيرفر بهوية الجلسة.
 * الافتراضي `catalog_variants`؛ المالك بس يغيّره وفي نطاقه؛ الموظف يقراه ومايقدرش
 * يبعته ولا يزوّره؛ وتغييره لنشاط مايلمسش نشاطًا تانيًا.
 */

describe("🔑 parseOrderEntryMode — fail-safe", () => {
  it("🔑 القيم الصالحة", () => {
    expect(parseOrderEntryMode("bracelets_legacy")).toBe("bracelets_legacy");
    expect(parseOrderEntryMode(JSON.stringify("bracelets_legacy"))).toBe("bracelets_legacy");
    expect(parseOrderEntryMode("catalog_variants")).toBe("catalog_variants");
  });
  it("🔒 أي حاجة غريبة → الافتراضي بلا رمي", () => {
    for (const v of [null, undefined, "", "{bad", "legacy", 42, JSON.stringify("x"), "{\"a\":1}"])
      expect(parseOrderEntryMode(v)).toBe(DEFAULT_ORDER_ENTRY_MODE);
  });
});

describe("🔒 حراس المصدر", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  const entry = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf-8");
  const legacy = fs.readFileSync("client/src/components/orders/LegacyEngravingPicker.tsx", "utf-8");
  const businessesPage = fs.readFileSync("client/src/pages/Businesses.tsx", "utf-8");

  it("🔒 entryConfig بلا input — القالب من نشاط الجلسة", () => {
    const i = routers.indexOf("entryConfig: employeePortalProcedure.query(");
    expect(i).toBeGreaterThan(-1);
    // لحد نهاية الإجراء نفسه بس — مش الإجراء اللي بعده.
    const block = routers.slice(i, routers.indexOf("}),", i));
    expect(block).toContain("employeeCatalogBusinessIds(empScope(ctx))");
    expect(block).not.toContain(".input(");
  });
  it("🔒 setOrderEntryMode إجراء أدمن بنطاق", () => {
    const i = routers.indexOf("setOrderEntryMode: adminProcedure");
    expect(i).toBeGreaterThan(-1);
    expect(routers.slice(i, i + 700)).toContain("scopeBusinessId(ctx, input.businessId)");
  });
  it("🔒 مفيش businessId ثابت في الواجهة", () => {
    for (const src of [entry, legacy, businessesPage]) {
      expect(src).not.toMatch(/businessId\s*===?\s*\d/);
      expect(src).not.toMatch(/tenantId\s*===?\s*\d/);
    }
    // ولا اسم منتج لاختيار القالب/المنتج
    expect(legacy).not.toContain("أسورة");
    expect(legacy).not.toContain("بدلة");
  });
  it("🔒 الواجهة بتاخد القالب من الـquery مش من localStorage/URL", () => {
    expect(entry).toContain("trpc.facebookEntry.entryConfig.useQuery()");
    expect(entry).not.toMatch(/localStorage\.getItem\([^)]*mode/i);
    expect(entry).not.toMatch(/searchParams|URLSearchParams/);
    // مفتاح المسودة بيشمل القالب (والنشاط الفعّال — تبديل النشاط مايرجّعش مسودة نشاط تاني)
    expect(entry).toContain("activeDraftKey(draftKey(readEmployeeScope()), activeBusinessId, entryMode)");
  });
  it("🔑 نفس الحفظ الذرّي في القالبين", () => {
    expect(entry).toContain("trpc.facebookEntry.addOrder.useMutation");
    expect(entry.match(/addOrderMutation\.mutate\(/g)?.length ?? 0).toBe(1);
  });
});

const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🔒 قالب الإدخال — سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { empIds: [] as number[], productIds: [] as number[] };
  let empA = 0, empB = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  const empCaller = (employeeId: number, webUser: any = null) =>
    appRouter.createCaller({
      user: webUser, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
  const ownerCaller = (tenantId: number) =>
    appRouter.createCaller({
      user: { id: 1, role: "admin", name: "owner" }, employee: null, tenantId,
      req: { protocol: "https", headers: {}, cookies: {} },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
  const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("mode-a");
    B = await createCoreTestFixture("mode-b");
    const pa = await createProductWithVariants(A.businessId, { name: `منتج نقش ${tag}` }, [
      { name: "سادة", sku: `EM-A1-${tag}`, currentStock: 5, price: "150" },
      { name: "منقوش", sku: `EM-A2-${tag}`, currentStock: 5, price: "200" },
    ]);
    ids.productIds.push(pa.productId);
    empA = insId(await createEmployee({ name: "eA", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `emA_${tag}` } as any));
    empB = insId(await createEmployee({ name: "eB", role: "data_entry", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `emB_${tag}` } as any));
    ids.empIds.push(empA, empB);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    await d.delete(businessConfigurationValues).where(
      and(inArray(businessConfigurationValues.businessId, [A.businessId, B.businessId]), eq(businessConfigurationValues.namespace, ORDER_ENTRY_NAMESPACE))
    );
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 بلا إعداد → الافتراضي catalog_variants للموظف", async () => {
    expect((await empCaller(empA).facebookEntry.entryConfig()).mode).toBe("catalog_variants");
    expect(await getOrderEntryMode(A.businessId)).toBe("catalog_variants");
  });

  it("🔑 المالك يفعّل bracelets_legacy لنشاطه → الموظف يشوفه فورًا", async () => {
    const r = await ownerCaller(A.tenantId).businesses.setOrderEntryMode({ businessId: A.businessId, mode: "bracelets_legacy" });
    expect(r.mode).toBe("bracelets_legacy");
    expect((await empCaller(empA).facebookEntry.entryConfig()).mode).toBe("bracelets_legacy");
    expect((await ownerCaller(A.tenantId).businesses.orderEntryMode({ businessId: A.businessId })).mode).toBe("bracelets_legacy");
    // الصف اتخزّن بالـnamespace/configKey المتفق عليهم — ومرة واحدة (upsert)
    const d = await getDb();
    const rows = await d!.select().from(businessConfigurationValues).where(and(
      eq(businessConfigurationValues.businessId, A.businessId),
      eq(businessConfigurationValues.namespace, ORDER_ENTRY_NAMESPACE),
      eq(businessConfigurationValues.configKey, ORDER_ENTRY_CONFIG_KEY),
    ));
    expect(rows).toHaveLength(1);
  });

  it("🔒 عزل: نشاط B لسه على الافتراضي — وموظف B مايتأثرش", async () => {
    expect((await empCaller(empB).facebookEntry.entryConfig()).mode).toBe("catalog_variants");
    expect(await getOrderEntryMode(B.businessId)).toBe("catalog_variants");
  });

  it("🔒 الموظف مايقدرش يغيّر القالب (FORBIDDEN)", async () => {
    expect(await code(() => empCaller(empA).businesses.setOrderEntryMode({ businessId: A.businessId, mode: "catalog_variants" }))).not.toBe("ok");
    expect((await empCaller(empA).facebookEntry.entryConfig()).mode).toBe("bracelets_legacy");
  });

  it("🔒 تزوير: input للـentryConfig وجلسة مالك في نفس المتصفح ماتغيّرش القالب/النطاق", async () => {
    // موظف B بيبعت نشاط A وجلسة أدمن — القالب لسه بتاع نشاط B (الافتراضي)
    const forged = await empCaller(empB, { id: 1, role: "admin", name: "owner" })
      .facebookEntry.entryConfig({ businessId: A.businessId, mode: "bracelets_legacy" } as any);
    expect(forged.mode).toBe("catalog_variants");
  });

  it("🔒 أدمن tenant تاني مايقدرش يغيّر قالب نشاط A", async () => {
    expect(await code(() => ownerCaller(B.tenantId).businesses.setOrderEntryMode({ businessId: A.businessId, mode: "catalog_variants" }))).toBe("FORBIDDEN");
    expect(await getOrderEntryMode(A.businessId)).toBe("bracelets_legacy");
  });

  it("🔑 الرجوع للكتالوج الكامل (upsert على نفس الصف)", async () => {
    await setOrderEntryMode(A.businessId, "catalog_variants", 1);
    expect((await empCaller(empA).facebookEntry.entryConfig()).mode).toBe("catalog_variants");
  });

  it("🔒 قيمة تالفة في القاعدة → الافتراضي بلا انهيار", async () => {
    const d = await getDb();
    await d!.update(businessConfigurationValues).set({ valueJson: "{broken" }).where(and(
      eq(businessConfigurationValues.businessId, A.businessId),
      eq(businessConfigurationValues.namespace, ORDER_ENTRY_NAMESPACE),
    ));
    expect((await empCaller(empA).facebookEntry.entryConfig()).mode).toBe("catalog_variants");
  });
});
