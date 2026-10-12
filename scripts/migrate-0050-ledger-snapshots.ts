/**
 * Migration 0050 (صورة الإقفال الثابتة) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط 0040 والفهرسين المركّبين.
 *   node dist/scripts/migrate-0050-ledger-snapshots.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0050-ledger-snapshots.mjs --apply --confirm "APPLY 0050 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0050-ledger-snapshots.mjs --rollback --confirm "ROLLBACK 0050 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجداول فارغة. في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { LEDGER_SNAPSHOTS_MIGRATION } from "../server/ledgerPhaseMigrations";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(LEDGER_SNAPSHOTS_MIGRATION, "drizzle/0050_ledger_period_snapshots.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
