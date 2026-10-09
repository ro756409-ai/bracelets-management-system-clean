import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getDb, getOrderStatusCounts, createOrder } from "./db";
import { orders } from "../drizzle/schema";
import { inArray } from "drizzle-orm";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Header stat cards on the Orders page (getOrderStatusCounts). Needs a real database —
 * every test no-ops without one rather than failing, matching the pattern in
 * server/lowStock.test.ts. Must be run against a real environment to mean anything.
 */
describe("getOrderStatusCounts", () => {
  const createdIds: number[] = [];
  // نشاط معزول من الـfixture بدل افتراض Business #1 — على قاعدة جديدة مفيش صف #1 فعدّ «اليوم»
  // (اللي بيقرا منطقة النشاط الزمنية من جدول businesses) كان بيرجع 0.
  let fixture: CoreTestFixture | null = null;
  const bid = () => fixture!.businessId;

  beforeAll(async () => {
    const db = await getDb();
    if (!db) return;
    fixture = await createCoreTestFixture("status-counts");
    const stamp = Date.now() % 100000000;

    const confirmed = await createOrder({
      businessId: bid(),
      orderNumber: `TSC-A${stamp}`,
      customerName: "عميل اختبار الإحصاءات 1",
      customerPhone: "01000000091",
      governorate: "القاهرة",
      customerAddress: "عنوان اختبار",
      productId: fixture!.productId,
      productName: "صنف اختبار",
      quantity: 1,
      totalAmount: "100",
      source: "manual",
      status: "confirmed",
    } as any);
    if (confirmed) createdIds.push(confirmed);

    const needsReview = await createOrder({
      businessId: bid(),
      orderNumber: `TSC-B${stamp}`,
      customerName: "عميل اختبار الإحصاءات 2",
      customerPhone: "01000000092",
      governorate: "الجيزة",
      customerAddress: "عنوان اختبار",
      productId: null,
      productName: "صنف غير مطابق",
      quantity: 1,
      totalAmount: "50",
      source: "facebook",
      status: "new",
      needsReview: true,
    } as any);
    if (needsReview) createdIds.push(needsReview);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    if (createdIds.length) await db.delete(orders).where(inArray(orders.id, createdIds));
    await fixture?.cleanup();
  });

  it("counts orders by status and totals them", async () => {
    const db = await getDb();
    if (!db) return;
    const counts = await getOrderStatusCounts([bid()]);
    expect(counts.byStatus.confirmed).toBeGreaterThanOrEqual(1);
    expect(counts.byStatus.new).toBeGreaterThanOrEqual(1);
    expect(counts.total).toBeGreaterThanOrEqual(2);
  });

  it("counts orders flagged needsReview", async () => {
    const db = await getDb();
    if (!db) return;
    const counts = await getOrderStatusCounts([bid()]);
    expect(counts.needsReview).toBeGreaterThanOrEqual(1);
  });

  it("counts today's orders — both seeded rows were created just now", async () => {
    const db = await getDb();
    if (!db) return;
    const counts = await getOrderStatusCounts([bid()]);
    expect(counts.today).toBeGreaterThanOrEqual(2);
  });

  it("scopes counts to the given business ids", async () => {
    const db = await getDb();
    if (!db) return;
    const scoped = await getOrderStatusCounts([999999]);
    expect(scoped.total).toBe(0);
  });
});
