/**
 * Migration 0042 (الحضور والانصراف) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط الفهرسين المركّبين (0040 أو 0041).
 *   node dist/scripts/migrate-0042-attendance.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0042-attendance.mjs --apply --confirm "APPLY 0042 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0042-attendance.mjs --rollback --confirm "ROLLBACK 0042 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجداول الخمسة فارغة (يحذف FK اللاحق أولًا).
 */
import "dotenv/config";
import { ATTENDANCE_MIGRATION } from "../server/attendanceMigration";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
