/**
 * Migration 0043 (مركز الرسائل) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط الفهرسين المركّبين (0040 أو 0041).
 *   node dist/scripts/migrate-0043-messaging.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0043-messaging.mjs --apply --confirm "APPLY 0043 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0043-messaging.mjs --rollback --confirm "ROLLBACK 0043 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجداول التسعة فارغة.
 */
import "dotenv/config";
import { MESSAGING_MIGRATION } from "../server/messagingMigration";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(MESSAGING_MIGRATION, "drizzle/0043_messaging.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
