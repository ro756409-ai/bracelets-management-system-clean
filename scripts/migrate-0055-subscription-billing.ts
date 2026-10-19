/**
 * Migration 0055 (subscription billing) — بلا نسخ SQL يدوي وبلا drizzle-kit.
 *   node dist/scripts/migrate-0055-subscription-billing.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0055-subscription-billing.mjs --apply --confirm "APPLY 0055 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0055-subscription-billing.mjs --rollback --confirm "ROLLBACK 0055 TO <db>"
 * في هذه المرحلة: Docker محلي مؤقت فقط. لا Staging ولا Production بدون موافقة صريحة منفصلة.
 */
import "dotenv/config";
import { SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE } from "../server/subscriptionBillingMigration";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE)
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
