import { describe, it, expect, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import {
  getDb, createSignupRequest, approveSignupRequest, rejectSignupRequest,
  getSignupRequestById, getBusinessIdsForTenant, getOrders,
} from "./db";
import { signupRequests, tenants, businesses, employees, memberships } from "../drizzle/schema";

/**
 * Phase 3.4 — قبول/رفض طلبات التسجيل فعليًا على matjarak_test: ذرّية القبول، منع التكرار،
 * تجربة 14 يوم، مساحة فارغة معزولة، والرفض. (بيتخطّى بدون TEST_DATABASE_URL.)
 */
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 Platform Admin approve/reject — DB فعلي", () => {
  const tag = Date.now();
  const createdTenantIds: number[] = [];
  const reqIds: number[] = [];

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    for (const tId of createdTenantIds) {
      const emps = await db.select({ id: employees.id }).from(employees).where(eq(employees.tenantId, tId));
      const empIds = emps.map(e => e.id);
      if (empIds.length) await db.delete(memberships).where(inArray(memberships.employeeId, empIds));
      await db.delete(employees).where(eq(employees.tenantId, tId));
      await db.delete(businesses).where(eq(businesses.tenantId, tId));
      await db.delete(tenants).where(eq(tenants.id, tId));
    }
    if (reqIds.length) await db.delete(signupRequests).where(inArray(signupRequests.id, reqIds));
  });

  async function makeRequest(suffix: string) {
    const hash = await bcrypt.hash("owner-pass-1234", 10);
    const id = await createSignupRequest({
      ownerName: `مالك ${suffix}`, businessName: `نشاط ${suffix}`, phone: `0100${suffix}`,
      email: `owner-${tag}-${suffix}@test.local`, username: `owner_${tag}_${suffix}`, passwordHash: hash,
    });
    reqIds.push(id);
    return id;
  }

  it("🔑 القبول ذرّي: tenant+business+owner+membership + تجربة 14 يوم + الطلب approved", async () => {
    const db = await getDb();
    const id = await makeRequest("a");
    const r = await approveSignupRequest(id, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    createdTenantIds.push(r.tenantId);

    const [t] = await db!.select().from(tenants).where(eq(tenants.id, r.tenantId)).limit(1);
    expect(t.status).toBe("trialing");
    expect(t.trialStartsAt).toBeTruthy();
    expect(t.trialEndsAt).toBeTruthy();
    const days = (new Date(t.trialEndsAt!).getTime() - new Date(t.trialStartsAt!).getTime()) / 86400000;
    expect(Math.round(days)).toBe(14);

    const [emp] = await db!.select().from(employees).where(eq(employees.id, r.employeeId)).limit(1);
    expect(emp.tenantId).toBe(r.tenantId);
    expect(emp.businessId).toBe(r.businessId);
    expect(emp.role).toBe("super_admin");
    expect(emp.isActive).toBe(true);
    const [mem] = await db!.select().from(memberships).where(eq(memberships.employeeId, r.employeeId)).limit(1);
    expect(mem.role).toBe("owner");

    const req = await getSignupRequestById(id);
    expect(req?.status).toBe("approved");
    expect(req?.createdTenantId).toBe(r.tenantId);
    // passwordHash اتمسحت من الطلب.
    const [raw] = await db!.select().from(signupRequests).where(eq(signupRequests.id, id)).limit(1);
    expect(raw.passwordHash).toBe("");
  });

  it("🔑 منع القبول المتكرر → not_pending", async () => {
    const id = await makeRequest("b");
    const r1 = await approveSignupRequest(id, 1);
    expect(r1.ok).toBe(true);
    if (r1.ok) createdTenantIds.push(r1.tenantId);
    const r2 = await approveSignupRequest(id, 1);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("not_pending");
  });

  it("🔑 مساحة العمل فارغة ومعزولة (صفر أوردرات في النشاط الجديد)", async () => {
    const id = await makeRequest("c");
    const r = await approveSignupRequest(id, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    createdTenantIds.push(r.tenantId);
    const allowed = (await getBusinessIdsForTenant(r.tenantId)) ?? [];
    expect(allowed).toEqual([r.businessId]); // نشاط واحد فقط تحت التينانت
    const { orders } = await getOrders({ businessIds: [r.businessId], limit: 100 });
    expect(orders.length).toBe(0); // مفيش نسخ بيانات
  });

  it("🔑 الرفض: الطلب rejected + مفيش tenant/employee", async () => {
    const db = await getDb();
    const id = await makeRequest("d");
    const r = await rejectSignupRequest(id, 1, "سبب اختباري");
    expect(r.ok).toBe(true);
    const req = await getSignupRequestById(id);
    expect(req?.status).toBe("rejected");
    expect(req?.rejectionReason).toBe("سبب اختباري");
    expect(req?.createdTenantId).toBeNull();
    const [raw] = await db!.select().from(signupRequests).where(eq(signupRequests.id, id)).limit(1);
    expect(raw.passwordHash).toBe("");
  });
});
