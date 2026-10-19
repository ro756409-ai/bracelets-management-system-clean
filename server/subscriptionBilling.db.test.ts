import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, approveSignupRequest, createSignupRequest, getDb } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE } from "./subscriptionBillingMigration";
import {
  BillingError, applyProviderEvent, createPendingPayment, enrollTenant, getBillingOverview, recordManualPayment, refundPayment,
} from "./subscriptionBilling.service";
import { resolveTenantAccess } from "./tenantAccess";
import { assertTrpcTenantAccess } from "./_core/trpc";
import { addCalendarMonths, planAmountMinor, SUBSCRIPTION_GRACE_MS } from "@shared/billing";

/**
 * اشتراك متجرك (0055) على قاعدة مؤقتة معزولة ببيانات مصطنعة — بلا أي مزوّد دفع حقيقي (المزوّد mock، والتوقيع خارج النطاق هنا).
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const FLAGS = ["TENANT_ACCESS_ENFORCEMENT_ENABLED", "SUBSCRIPTION_BILLING_ENABLED"] as const;

describe.runIf(CAN)("💳 اشتراك متجرك — 0055 + الدفع + الوصول", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture; let L: CoreTestFixture;
  const saved: Record<string, string | undefined> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const count = async (t: string, tenantId: number) => Number((await q(`SELECT COUNT(*) n FROM ${t} WHERE tenantId = ?`, [tenantId]))[0].n);
  const sqlText = () => fs.readFileSync(SUBSCRIPTION_BILLING_FILE, "utf-8");
  let seq = 0;
  const key = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
  const manual = (tenantId: number, over: Partial<Parameters<typeof recordManualPayment>[0]> = {}) => recordManualPayment({
    tenantId, planCode: "month_1", idempotencyKey: key("m"), paymentReference: `TRX-${++seq}-${tmp.name.slice(-5)}`,
    evidenceUrl: "https://evidence.example/receipt.png", platformAdminId: 1, ...over,
  });
  const T0 = new Date("2026-01-31T10:00:00.000Z");

  beforeAll(async () => {
    for (const k of FLAGS) saved[k] = process.env[k];
    tmp = await createTempSchema("billing");
    // الفهرسان المركّبان (0041) شرط مسبق لـ0055 (require_present) — نفس حالة Staging.
    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0041", "apply", tmp.name) })).ok).toBe(true);
    await tmp.raw.query("SET time_zone = '+00:00'");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("bill-a"); B = await createCoreTestFixture("bill-b"); L = await createCoreTestFixture("bill-legacy");
  }, 240_000);
  afterAll(async () => {
    for (const k of FLAGS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("0055: check → apply → مطابقة المواصفة → replay → rollback (فارغة) → apply؛ وبدون عبارة التأكيد مرفوض", async () => {
    const run = (mode: "check" | "apply" | "rollback", confirm?: string) =>
      runHandMigration(SUBSCRIPTION_BILLING_MIGRATION, { databaseUrl: tmp.url, mode, sqlText: sqlText(), deployEnv: "test", confirm });
    expect((await run("check")).state).toBe("not_applied");
    expect((await run("apply", "APPLY 0055 TO wrong")).refused).toBeTruthy();
    const ap = await run("apply", confirmPhrase("0055", "apply", tmp.name));
    expect(ap.ok, ap.lines.join("\n")).toBe(true);
    expect(ap.applied).toBe(3);
    const chk = await run("check");
    expect(chk.state).toBe("applied"); expect(chk.issues).toEqual([]);
    expect((await run("apply", confirmPhrase("0055", "apply", tmp.name))).replay).toBe(true);
    expect((await run("rollback", confirmPhrase("0055", "rollback", tmp.name))).ok).toBe(true);
    expect((await run("check")).state).toBe("not_applied");
    expect((await run("apply", confirmPhrase("0055", "apply", tmp.name))).ok).toBe(true);
  });

  it("CHECK/UNIQUE على مستوى القاعدة: دفع يدوي بلا دليل، فترة مقلوبة، فترتان لنفس الدفع ⇒ مرفوض", async () => {
    await enrollTenant((await getDb())!, { tenantId: B.tenantId, by: "signup" });
    await expect(tmp.raw.query(
      "INSERT INTO subscription_payments (tenantId, planCode, months, amountMinor, provider, status, idempotencyKey, paymentReference, recordedByPlatformAdminId) VALUES (?, 'month_1', 1, 50000, 'manual', 'pending', ?, 'REF1', 1)",
      [B.tenantId, key("chk")])).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(tmp.raw.query(
      "INSERT INTO subscription_payments (tenantId, planCode, months, amountMinor, provider, status, idempotencyKey) VALUES (?, 'month_5', 1, 199900, 'mock', 'pending', ?)",
      [B.tenantId, key("chk")])).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    const p = await manual(B.tenantId);
    await expect(tmp.raw.query("INSERT INTO subscription_periods (tenantId, paymentId, startsAt, endsAt) VALUES (?, ?, NOW(3), NOW(3))", [B.tenantId, p.payment.id]))
      .rejects.toBeTruthy();
    await expect(tmp.raw.query("INSERT INTO subscription_periods (tenantId, paymentId, startsAt, endsAt) VALUES (?, ?, NOW(3), NOW(3) + INTERVAL 1 DAY)", [B.tenantId, p.payment.id]))
      .rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("الوصول: شركة قديمة (مش مسجّلة) بسلوكها القديم؛ المسجّلة بلا دفع = restricted؛ العلم معطل = السلوك القديم", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "true";
    process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
    expect((await enrollTenant((await getDb())!, { tenantId: A.tenantId, by: "platform_admin", platformAdminId: 1 })).created).toBe(true);
    expect((await enrollTenant((await getDb())!, { tenantId: A.tenantId, by: "platform_admin", platformAdminId: 1 })).created).toBe(false);
    await expect(enrollTenant((await getDb())!, { tenantId: L.tenantId, by: "platform_admin" })).rejects.toBeInstanceOf(BillingError);

    const legacy = await resolveTenantAccess(L.tenantId);
    expect([legacy.level, legacy.reason]).toEqual(["full", "active"]);
    const a = await resolveTenantAccess(A.tenantId);
    expect([a.level, a.reason, a.processWebhooks, a.runJobs, a.acceptNewOrders]).toEqual(["restricted", "subscription_pending_payment", true, false, false]);
    await expect(assertTrpcTenantAccess(A.tenantId, "mutation", "orders.create")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertTrpcTenantAccess(A.tenantId, "mutation", "sales.importCsv")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertTrpcTenantAccess(A.tenantId, "mutation", "orders.cancel")).resolves.toBeUndefined();
    await expect(assertTrpcTenantAccess(A.tenantId, "mutation", "returns.markAsReturned")).resolves.toBeUndefined();
    await expect(assertTrpcTenantAccess(A.tenantId, "query", "orders.list")).resolves.toBeUndefined();
    await expect(assertTrpcTenantAccess(A.tenantId, "query", "subscription.status")).resolves.toBeUndefined();

    process.env.SUBSCRIPTION_BILLING_ENABLED = "false";
    expect((await resolveTenantAccess(A.tenantId)).level).toBe("full");
    process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
  });

  it("دفع يدوي: فترة بالأشهر التقويمية من لحظة التفعيل، إعادة بنفس المفتاح بلا تكرار، تعارضات مرفوضة", async () => {
    const k = key("first");
    const ref = `INSTA-${tmp.name.slice(-6)}`;
    const r1 = await recordManualPayment({ tenantId: A.tenantId, planCode: "month_1", idempotencyKey: k, paymentReference: ref, note: "تحويل إنستاباي موثق بإيصال", platformAdminId: 1, now: T0 });
    expect(r1.replay).toBe(false);
    expect(r1.payment.amountMinor).toBe(planAmountMinor("month_1"));
    expect(r1.period.startsAt.toISOString()).toBe(T0.toISOString());
    expect(r1.period.endsAt.toISOString()).toBe(addCalendarMonths(T0, 1).toISOString()); // 31 يناير ⇒ 28 فبراير

    const again = await recordManualPayment({ tenantId: A.tenantId, planCode: "month_1", idempotencyKey: k, paymentReference: ref, note: "تحويل إنستاباي موثق بإيصال", platformAdminId: 1, now: T0 });
    expect(again.replay).toBe(true); expect(again.payment.id).toBe(r1.payment.id);
    expect(await count("subscription_payments", A.tenantId)).toBe(1);
    expect(await count("subscription_periods", A.tenantId)).toBe(1);

    await expect(recordManualPayment({ tenantId: A.tenantId, planCode: "month_12", idempotencyKey: k, paymentReference: ref, note: "تحويل إنستاباي موثق بإيصال", platformAdminId: 1 }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(recordManualPayment({ tenantId: A.tenantId, planCode: "month_1", idempotencyKey: key("dupref"), paymentReference: ` ${ref.toLowerCase()} `, note: "نفس المرجع بمفتاح جديد", platformAdminId: 1 }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(manual(A.tenantId, { evidenceUrl: null, note: "قصير" })).rejects.toMatchObject({ code: "invalid" });
    await expect(manual(A.tenantId, { evidenceUrl: "http://insecure.example/x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(manual(A.tenantId, { paymentReference: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(manual(A.tenantId, { planCode: "month_2" })).rejects.toMatchObject({ code: "invalid" });
    await expect(manual(L.tenantId)).rejects.toMatchObject({ code: "not_found" });
    expect(await count("subscription_payments", A.tenantId)).toBe(1);

    expect((await resolveTenantAccess(A.tenantId, new Date(T0.getTime() + 86_400_000))).reason).toBe("subscription_active");
  });

  it("تجديد مبكر يتضاف على النهاية؛ أثناء السماح من النهاية؛ بعد انتهاء السماح من لحظة التفعيل (بلا فترة مجانية)", async () => {
    const end1 = addCalendarMonths(T0, 1);
    const early = await manual(A.tenantId, { planCode: "month_5", now: new Date(end1.getTime() - 5 * 86_400_000) });
    expect(early.period.startsAt.toISOString()).toBe(end1.toISOString());
    const end2 = early.period.endsAt;
    expect(end2.toISOString()).toBe(addCalendarMonths(end1, 5).toISOString());

    const inGrace = new Date(end2.getTime() + 60 * 60 * 1000);
    const g = await resolveTenantAccess(A.tenantId, inGrace);
    expect([g.level, g.reason]).toEqual(["full", "subscription_grace"]);
    const afterGrace = new Date(end2.getTime() + SUBSCRIPTION_GRACE_MS + 1);
    const x = await resolveTenantAccess(A.tenantId, afterGrace);
    expect([x.level, x.reason]).toEqual(["restricted", "subscription_expired"]);

    const lateAt = new Date(end2.getTime() + 10 * 86_400_000);
    const late = await manual(A.tenantId, { planCode: "month_1", now: lateAt });
    expect(late.period.startsAt.toISOString()).toBe(lateAt.toISOString());
    expect((await resolveTenantAccess(A.tenantId, new Date(lateAt.getTime() + 1000))).level).toBe("full");
  });

  it("تفعيلان متزامنان لنفس الشركة ⇒ فترتان متتاليتان بلا تداخل (قفل صف الحساب)", async () => {
    const C = await createCoreTestFixture("bill-c");
    await enrollTenant((await getDb())!, { tenantId: C.tenantId, by: "signup" });
    const now = new Date("2026-03-15T12:00:00.000Z");
    const [x, y] = await Promise.all([manual(C.tenantId, { now }), manual(C.tenantId, { now })]);
    const ps = [x.period, y.period].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    expect(ps[0].startsAt.toISOString()).toBe(now.toISOString());
    expect(ps[1].startsAt.toISOString()).toBe(ps[0].endsAt.toISOString());
  });

  it("استرداد: لآخر فترة بس، بيلغي الفترة (voidedAt) والحالة تتحسب من جديد؛ مفيش حذف", async () => {
    const o = await getBillingOverview(A.tenantId);
    const succeeded = o.payments.filter(p => p.status === "succeeded").sort((a, b) => a.id - b.id);
    await expect(refundPayment({ paymentId: succeeded[0].id, reason: "خطأ في التسجيل" })).rejects.toMatchObject({ code: "conflict" });
    await expect(refundPayment({ paymentId: succeeded[succeeded.length - 1].id, reason: "قص" })).rejects.toMatchObject({ code: "invalid" });
    const last = succeeded[succeeded.length - 1];
    const r = await refundPayment({ paymentId: last.id, reason: "استرداد بطلب التاجر" });
    expect(r.period.voidedAt).toBeTruthy();
    await expect(refundPayment({ paymentId: last.id, reason: "مرة تانية" })).rejects.toMatchObject({ code: "conflict" });
    const after = await getBillingOverview(A.tenantId);
    expect(after.periods.length).toBe(o.periods.length);
    expect(after.periods.find(p => p.paymentId === last.id)?.voidedAt).toBeTruthy();
  });

  it("مزوّد (mock): المبلغ من السيرفر، مبلغ مختلف مرفوض، الحدث المكرر بلا أثر، فشل/استرداد", async () => {
    const D = await createCoreTestFixture("bill-d");
    await enrollTenant((await getDb())!, { tenantId: D.tenantId, by: "signup" });
    const k = key("co");
    const { payment } = await createPendingPayment({ tenantId: D.tenantId, planCode: "month_12", provider: "mock", idempotencyKey: k });
    expect(payment.amountMinor).toBe(399_900);
    expect((await createPendingPayment({ tenantId: D.tenantId, planCode: "month_12", provider: "mock", idempotencyKey: k })).replay).toBe(true);
    await expect(createPendingPayment({ tenantId: B.tenantId, planCode: "month_12", provider: "mock", idempotencyKey: k })).rejects.toMatchObject({ code: "conflict" });

    const ev = { provider: "mock" as const, paymentId: payment.id, providerRef: `mock-${k}`, amountMinor: 399_900, currency: "EGP" };
    await expect(applyProviderEvent({ ...ev, outcome: "succeeded", amountMinor: 100 })).rejects.toMatchObject({ code: "conflict" });
    expect(await count("subscription_periods", D.tenantId)).toBe(0);
    expect(await applyProviderEvent({ ...ev, outcome: "succeeded" })).toEqual({ status: "succeeded", changed: true });
    expect(await applyProviderEvent({ ...ev, outcome: "succeeded" })).toEqual({ status: "succeeded", changed: false });
    expect(await applyProviderEvent({ ...ev, outcome: "failed" })).toEqual({ status: "succeeded", changed: false });
    expect(await count("subscription_periods", D.tenantId)).toBe(1);
    await expect(applyProviderEvent({ ...ev, providerRef: "other-ref", outcome: "succeeded" })).rejects.toMatchObject({ code: "conflict" });
    expect(await applyProviderEvent({ ...ev, outcome: "refunded" })).toEqual({ status: "refunded", changed: true });

    const f = await createPendingPayment({ tenantId: D.tenantId, planCode: "month_1", provider: "mock", idempotencyKey: key("co") });
    expect(await applyProviderEvent({ provider: "mock", paymentId: f.payment.id, providerRef: `mock-f-${seq}`, amountMinor: 50_000, currency: "EGP", outcome: "failed", reason: "declined" }))
      .toEqual({ status: "failed", changed: true });
    await expect(applyProviderEvent({ provider: "mock", paymentId: f.payment.id, providerRef: `mock-f-${seq}`, amountMinor: 50_000, currency: "EGP", outcome: "succeeded" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(applyProviderEvent({ provider: "paymob", paymentId: f.payment.id, providerRef: "x", amountMinor: 50_000, currency: "EGP", outcome: "succeeded" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("عزل التجار: نظرة شركة B ماتشملش مدفوعات A", async () => {
    const a = await getBillingOverview(A.tenantId);
    const b = await getBillingOverview(B.tenantId);
    const aIds = new Set(a.payments.map(p => p.id));
    expect(b.payments.some(p => aIds.has(p.id))).toBe(false);
    expect((await getBillingOverview(L.tenantId)).enrolled).toBe(false);
  });

  it("قبول تسجيل جديد: العلم شغال ⇒ بلا تجربة (active + مسجّلة + pending_payment)؛ العلم معطل ⇒ تجربة 14 يوم كما هي", async () => {
    const mk = (n: string) => createSignupRequest({ ownerName: `مالك ${n}`, businessName: `متجر ${n}`, phone: "01000000000", email: `${n}-${tmp.name}@example.test`, username: `${n}_${tmp.name}`.slice(0, 50), passwordHash: "$2b$10$abcdefghijklmnopqrstuuJ8l0n0f8h1q7xk3W1h8m6gJ5Zb0x9Ka" });
    process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
    const r1 = await approveSignupRequest(await mk("nt"), 1);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const [t1] = await q("SELECT status, trialEndsAt FROM tenants WHERE id = ?", [r1.tenantId]);
    expect([t1.status, t1.trialEndsAt]).toEqual(["active", null]);
    expect(await count("tenant_billing_accounts", r1.tenantId)).toBe(1);
    expect((await resolveTenantAccess(r1.tenantId)).reason).toBe("subscription_pending_payment");

    process.env.SUBSCRIPTION_BILLING_ENABLED = "false";
    const r2 = await approveSignupRequest(await mk("tr"), 1);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const [t2] = await q("SELECT status, trialEndsAt FROM tenants WHERE id = ?", [r2.tenantId]);
    expect(t2.status).toBe("trialing"); expect(t2.trialEndsAt).toBeTruthy();
    expect(await count("tenant_billing_accounts", r2.tenantId)).toBe(0);
    process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
  });
});
