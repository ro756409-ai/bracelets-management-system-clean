/**
 * Migration 0041 (order_activity_events) — بلا نسخ SQL يدوي وبلا drizzle-kit.
 *   corepack pnpm tsx scripts/migrate-0041-order-events.ts                       # check (قراءة فقط)
 *   DEPLOY_ENV=test corepack pnpm tsx scripts/migrate-0041-order-events.ts --apply --confirm "APPLY 0041 TO <db>"
 *   DEPLOY_ENV=test corepack pnpm tsx scripts/migrate-0041-order-events.ts --rollback --confirm "ROLLBACK 0041 TO <db>"
 * applied → replay؛ partial (أو فهرس مركّب واحد/بتعريف مختلف) → رفض بلا أي DDL؛ rollback فقط والجدول فارغ.
 */
import "dotenv/config";
import { ORDER_EVENTS_MIGRATION } from "../server/orderEventsMigration";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
