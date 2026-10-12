/**
 * Migration 0048 (المرتبات والسلف) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط 0040 والفهرسين المركّبين.
 *   node dist/scripts/migrate-0048-ledger-payroll.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0048-ledger-payroll.mjs --apply --confirm "APPLY 0048 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0048-ledger-payroll.mjs --rollback --confirm "ROLLBACK 0048 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجداول فارغة. في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { LEDGER_PAYROLL_MIGRATION } from "../server/ledgerPhaseMigrations";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(LEDGER_PAYROLL_MIGRATION, "drizzle/0048_ledger_payroll.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
