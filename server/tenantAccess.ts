import { and, desc, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { tenants, subscriptions, businesses } from "../drizzle/schema";
import { getDb } from "./db";
import { computeTenantAccess, httpRequestAllowed, TENANT_ACCESS_MESSAGES, type TenantAccess } from "@shared/tenantAccess";

/**
 * `resolveTenantAccess` — المصدر **الوحيد** لقرار وصول الشركة في كل الطبقات: tRPC (query/mutation، الويب
 * والبوابة)، مسارات Express (رفع/استيراد/تصدير)، المهام الخلفية، وصندوق الويبهوك. خلف
 * `TENANT_ACCESS_ENFORCEMENT_ENABLED` (معطل افتراضيًا): العلم معطل ⇒ full دائمًا بلا أي قراءة من القاعدة
 * (السلوك الحالي بلا تغيير). لا تغيير لحالة أي شركة هنا — قراءة فقط. Platform Admin خارج هذا المسار تمامًا
 * (مسارات /api/platform بكوكي منفصل لا تمر بالحارس).
 */
export const tenantAccessEnforcementEnabled = () => process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED === "true";
const FULL: TenantAccess = { level: "full", reason: "active", processWebhooks: true, runJobs: true, until: null };

export async function resolveTenantAccess(tenantId: number, now = new Date()): Promise<TenantAccess> {
  if (!tenantAccessEnforcementEnabled()) return FULL;
  const db = await getDb();
  if (!db) return computeTenantAccess(null, null, now);
  const [t] = await db.select({ status: tenants.status, trialEndsAt: tenants.trialEndsAt }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  let pastDueSince: Date | null = null;
  if (t?.status === "past_due") {
    // بداية التأخير = نهاية آخر فترة اشتراك متأخرة (لا عمود pastDueSince في tenants؛ بلا صف ⇒ fail-closed).
    const [s] = await db.select({ end: subscriptions.currentPeriodEnd }).from(subscriptions)
      .where(and(eq(subscriptions.tenantId, tenantId), eq(subscriptions.status, "past_due"))).orderBy(desc(subscriptions.currentPeriodEnd)).limit(1);
    pastDueSince = s?.end ?? null;
  }
  return computeTenantAccess(t ?? null, pastDueSince, now);
}

export async function resolveTenantAccessForBusiness(businessId: number, now = new Date()): Promise<TenantAccess & { tenantId: number | null }> {
  if (!tenantAccessEnforcementEnabled()) return { ...FULL, tenantId: null };
  const db = await getDb();
  const [b] = db ? await db.select({ tenantId: businesses.tenantId }).from(businesses).where(eq(businesses.id, businessId)).limit(1) : [];
  if (!b?.tenantId) return { ...computeTenantAccess(null, null, now), tenantId: null };
  return { ...(await resolveTenantAccess(b.tenantId, now)), tenantId: b.tenantId };
}

/** حارس المهام الخلفية لكل شركة: لا تشغيل لمهمة تكتب لشركة غير full. */
export async function canRunTenantJob(tenantId: number, now = new Date()): Promise<boolean> {
  return (await resolveTenantAccess(tenantId, now)).runJobs;
}

export function tenantAccessError(access: TenantAccess) {
  return { code: access.level === "blocked" ? "TENANT_BLOCKED" : "TENANT_READ_ONLY", message: TENANT_ACCESS_MESSAGES[access.reason], level: access.level, reason: access.reason };
}

/** مسارات Express خارج الحارس: الدخول/الخروج/التسجيل/المنصة/الصحة/الويبهوك (له صندوقه)/tRPC (له حارسه). */
const EXPRESS_EXEMPT = [/^\/api\/auth\//, /^\/api\/employee\//, /^\/api\/signup\//, /^\/api\/platform\//, /^\/api\/health$/, /^\/api\/webhooks\//, /^\/api\/trpc\//];

/**
 * حارس Express العام (قبل تسجيل المسارات): الجلسة تُحل بنفس `createContext` (مصدر واحد للهوية والـtenant).
 * GET/HEAD قراءة وتصدير؛ أي method آخر كتابة (رفع/استيراد) ⇒ 403 في read_only وblocked.
 */
export function tenantAccessExpressGuard(resolveSessionTenant: (req: Request, res: Response) => Promise<number | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!tenantAccessEnforcementEnabled() || !req.path.startsWith("/api/") || EXPRESS_EXEMPT.some(r => r.test(req.path))) return next();
    let tenantId: number | null = null;
    try { tenantId = await resolveSessionTenant(req, res); } catch { return next(); /* المسار نفسه يرفض غير المصادق */ }
    if (tenantId == null) return next();
    const access = await resolveTenantAccess(tenantId);
    if (httpRequestAllowed(access, req.method)) return next();
    return res.status(403).json({ error: tenantAccessError(access) });
  };
}
