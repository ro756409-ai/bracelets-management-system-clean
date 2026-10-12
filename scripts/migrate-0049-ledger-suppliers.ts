/**
 * Migration 0049 (الموردون والورشة) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط 0040 والفهرسين المركّبين.
 *   node dist/scripts/migrate-0049-ledger-suppliers.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0049-ledger-suppliers.mjs --apply --confirm "APPLY 0049 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0049-ledger-suppliers.mjs --rollback --confirm "ROLLBACK 0049 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجداول فارغة. في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { LEDGER_SUPPLIERS_MIGRATION } from "../server/ledgerPhaseMigrations";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(LEDGER_SUPPLIERS_MIGRATION, "drizzle/0049_ledger_suppliers.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
