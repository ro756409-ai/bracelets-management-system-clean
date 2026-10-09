import { lt } from "drizzle-orm";
import { rawProviderWebhooks } from "../drizzle/schema";
import { getDb } from "./db";
import { drainDeferredWebhooks } from "./tenantAccessDrain";

export async function cleanupExpiredRawWebhooks(now = new Date()) {
  const db = await getDb();
  if (!db) return { deleted: 0, skipped: true };
  const result: any = await db
    .delete(rawProviderWebhooks)
    .where(lt(rawProviderWebhooks.retainUntil, now));
  return {
    deleted: Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0),
    skipped: false,
  };
}

export function startMaintenanceScheduler() {
  if (
    process.env.DISABLE_MAINTENANCE_SCHEDULER === "true" ||
    process.env.NODE_ENV === "test"
  )
    return () => {};
  const intervalMinutes = Number(
    process.env.MAINTENANCE_INTERVAL_MINUTES ?? "60"
  );
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1)
    throw new Error("MAINTENANCE_INTERVAL_MINUTES must be at least 1");
  const run = () => {
    void cleanupExpiredRawWebhooks().catch(error =>
      console.error("[Maintenance] Raw webhook cleanup failed", error)
    );
    // الويبهوك المؤجل لشركات عادت full — مرة واحدة لكل حدث (خلف TENANT_ACCESS_ENFORCEMENT_ENABLED، معطل = لا شيء).
    void drainDeferredWebhooks().catch(error =>
      console.error("[Maintenance] Deferred webhook drain failed", error)
    );
  };
  const timer = setInterval(run, intervalMinutes * 60_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
