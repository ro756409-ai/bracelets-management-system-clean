/**
 * Migration 0051 (سجل حظر/رفع الكتابات المالية القديمة) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط 0040 والفهرسين المركّبين.
 *   node dist/scripts/migrate-0051-ledger-legacy-archive.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0051-ledger-legacy-archive.mjs --apply --confirm "APPLY 0051 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0051-ledger-legacy-archive.mjs --rollback --confirm "ROLLBACK 0051 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجدول فارغ (مرفوض مع أي حدث). في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { LEDGER_LEGACY_ARCHIVE_MIGRATION } from "../server/ledgerPhaseMigrations";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(LEDGER_LEGACY_ARCHIVE_MIGRATION, "drizzle/0051_ledger_legacy_archive.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
