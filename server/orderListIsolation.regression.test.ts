import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, getOrders } from "./db";
import { orders } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import type { TrpcContext } from "./_core/context";

/**
 * Regression لحادثة الإنتاج: اختفت أوردرات كل الأنشطة (Afandy + الأسورة) بعد النشر لأن
 * schema أضاف عمودًا (createdByEmployeeId) مش موجود في قاعدة الإنتاج، فكل SELECT للأوردرات
 * فشل. الاختبارات دي بتثبت أن قوائم الأوردرات:
 *   • مش فاضية لما فيه أوردرات صحيحة (SELECT بينجح — مفيش عمود وهمي).
 *   • معزولة: كل مالك يشوف أوردرات نشاطه فقط، بلا تسريب بين النشاطين.
 *   • خانة اللصق/الاستيراد منفصلة عن استعلام عرض الأوردرات.
 */

// ── حارس نصّي (بيشتغل دايمًا) — بيمسك الحادثة محليًا بلا DB ──
describe("🔒 استعلام الأوردرات مش بيعتمد على عمود غير مطبّق", () => {
  it("🔒 schema/orders مافيهوش عمود بيكسر SELECT قبل الـmigration", () => {
    const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(schema).not.toContain('int("createdByEmployeeId")');
  });
  it("🔒 خانة اللصق والاستيراد منفصلة عن قائمة عرض الأوردرات", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    const importExcel = fs.readFileSync("server/importExcel.ts", "utf-8");
    // parsePaste/الاستيراد read/insert بس — مايلمسوش استعلام orders.list ولا getOrders للعرض.
    const parseBlock = routers.slice(routers.indexOf("parsePaste: employeePortalProcedure"), routers.indexOf("parsePaste: employeePortalProcedure") + 700);
    expect(parseBlock).not.toContain("getOrders(");
    expect(importExcel).not.toContain("getOrders(");
  });
});

// ── سلوكي فعلي بتينانتين ومستخدمين (matjarak_test) ──
const ownerCtx = (tenantId: number, userId: number): TrpcContext =>
  ({
    user: { id: userId, role: "admin", name: "Owner" } as any,
    employee: null,
    tenantId,
    req: { protocol: "https", headers: {} } as any,
    res: { clearCookie: () => {} } as any,
  }) as any;

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔒 عزل قائمة الأوردرات بين نشاطين", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids: number[] = [];
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  async function makeOrder(businessId: number, label: string) {
    const d = await getDb(); if (!d) return;
    const id = insId(await d.insert(orders).values({
      businessId, orderNumber: `${label}-${tag}-${Math.random().toString(36).slice(2, 7)}`,
      customerName: label, customerPhone: "01000000000", customerAddress: "addr",
      governorate: "القاهرة", productName: "prod", quantity: 1, totalAmount: "100.00", status: "new",
    } as any));
    ids.push(id);
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("olA"); // Afandy
    B = await createCoreTestFixture("olB"); // الأسورة
    await makeOrder(A.businessId, "afandy");
    await makeOrder(A.businessId, "afandy");
    await makeOrder(B.businessId, "bracelet");
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.length) await d.delete(orders).where(inArray(orders.id, ids));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔒 قائمة مالك Afandy: أوردرات Afandy فقط ومش فاضية", async () => {
    const res: any = await appRouter.createCaller(ownerCtx(A.tenantId, 1001)).orders.list({} as any);
    const rows = res.orders ?? res;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((o: any) => o.businessId === A.businessId)).toBe(true);
    expect(rows.some((o: any) => o.businessId === B.businessId)).toBe(false);
  });

  it("🔒 قائمة مالك الأسورة: أوردرات الأسورة فقط ومش فاضية", async () => {
    const res: any = await appRouter.createCaller(ownerCtx(B.tenantId, 1002)).orders.list({} as any);
    const rows = res.orders ?? res;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((o: any) => o.businessId === B.businessId)).toBe(true);
    expect(rows.some((o: any) => o.businessId === A.businessId)).toBe(false);
  });

  it("🔒 getOrders بينجح (SELECT كامل بلا عمود وهمي) ويحترم businessIds", async () => {
    const aOrders: any = await getOrders({ businessIds: [A.businessId] } as any);
    expect(aOrders.orders.length).toBeGreaterThan(0);
    expect(aOrders.orders.every((o: any) => o.businessId === A.businessId)).toBe(true);
    // نطاق الرفض (زي ما الراوتر بيعمله عبر scopeBusinessIds لما مفيش نشاط) → صفر
    const denied: any = await getOrders({ businessIds: [-1] } as any);
    expect(denied.orders.length).toBe(0);
  });
});
