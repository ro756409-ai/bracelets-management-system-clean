import { eq, sql } from "drizzle-orm";
import { carrierWebhookInbox, webhookLogs, businesses } from "../drizzle/schema";
import { getDb } from "./db";
import { canRunTenantJob, tenantAccessEnforcementEnabled } from "./tenantAccess";
import { listDeferredInboxEvents } from "./carrierWebhookInbox.service";
import { processDeferredBostaEvent } from "./bostaWebhook";
import { drainDeferredEasyOrders, DEFERRED_EVENT } from "./easyorderWebhook";
import { isMissingTableError } from "./carrierAccounts.service";

/**
 * مهمة خلفية: معالجة الويبهوك المؤجل **مرة واحدة** لكل شركة عادت full. خلف TENANT_ACCESS_ENFORCEMENT_ENABLED
 * (معطل = لا شيء). الشركة غير full تُتخطّى (canRunTenantJob — نفس resolveTenantAccess). لا تغيير لحالة أي شركة.
 */
export async function drainDeferredWebhooks(now = new Date()): Promise<{ skipped: boolean; tenants: Record<number, { bosta: number; easyOrders: number } | "not_full"> }> {
  if (!tenantAccessEnforcementEnabled()) return { skipped: true, tenants: {} };
  const db = await getDb();
  if (!db) return { skipped: true, tenants: {} };
  const ids = new Set<number>();
  try {
    for (const r of await db.selectDistinct({ t: carrierWebhookInbox.tenantId }).from(carrierWebhookInbox).where(eq(carrierWebhookInbox.processingStatus, "deferred")))
      if (r.t != null) ids.add(Number(r.t));
  } catch (err) { if (!isMissingTableError(err)) throw err; }
  for (const r of await db.selectDistinct({ t: businesses.tenantId }).from(webhookLogs).innerJoin(businesses, eq(businesses.id, webhookLogs.businessId)).where(sql`${webhookLogs.eventType} = ${DEFERRED_EVENT}`))
    if (r.t != null) ids.add(Number(r.t));
  const tenants: Record<number, { bosta: number; easyOrders: number } | "not_full"> = {};
  for (const tenantId of ids) {
    if (!(await canRunTenantJob(tenantId, now))) { tenants[tenantId] = "not_full"; continue; }
    let bosta = 0;
    for (const row of await listDeferredInboxEvents(tenantId)) if ((await processDeferredBostaEvent(row)) === "processed") bosta++;
    const eo = await drainDeferredEasyOrders(tenantId);
    tenants[tenantId] = { bosta, easyOrders: eo.processed };
  }
  return { skipped: false, tenants };
}
