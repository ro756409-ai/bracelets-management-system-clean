/**
 * Migration 0044 (الفرق والقيادة المؤرخة) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط الفهرسين المركّبين (0040 أو 0041).
 *   node dist/scripts/migrate-0044-teams.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0044-teams.mjs --apply --confirm "APPLY 0044 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0044-teams.mjs --rollback --confirm "ROLLBACK 0044 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجدولان فارغان.
 */
import "dotenv/config";
import { TEAMS_MIGRATION } from "../server/teamsMigration";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(TEAMS_MIGRATION, "drizzle/0044_teams.sql")
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
