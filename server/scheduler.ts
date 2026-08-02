import { lt } from "drizzle-orm";
import { rawProviderWebhooks } from "../drizzle/schema";
import { getDb } from "./db";

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
  const run = () =>
    cleanupExpiredRawWebhooks().catch(error =>
      console.error("[Maintenance] Raw webhook cleanup failed", error)
    );
  const timer = setInterval(run, intervalMinutes * 60_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
