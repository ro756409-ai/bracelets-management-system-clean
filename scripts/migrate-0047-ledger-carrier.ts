/**
 * Migration 0047 (شركات الشحن (ربط الشحنة، طابور المراجعة، الإعدادات)) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط 0040 والفهرسين المركّبين.
 *   node dist/scripts/migrate-0047-ledger-carrier.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0047-ledger-carrier.mjs --apply --confirm "APPLY 0047 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0047-ledger-carrier.mjs --rollback --confirm "ROLLBACK 0047 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجداول فارغة. في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { LEDGER_CARRIER_MIGRATION } from "../server/ledgerPhaseMigrations";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(LEDGER_CARRIER_MIGRATION, "drizzle/0047_ledger_carrier.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
