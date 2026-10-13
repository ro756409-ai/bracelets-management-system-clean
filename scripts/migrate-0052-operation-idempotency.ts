/**
 * Migration 0052 (مفتاح منع تكرار إنشاء الأوردر وإرسال الورشة) — بلا نسخ SQL يدوي وبلا drizzle-kit. يشترط الفهرسين المركّبين (0040/0041).
 *   node dist/scripts/migrate-0052-operation-idempotency.mjs                       # check (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0052-operation-idempotency.mjs --apply --confirm "APPLY 0052 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0052-operation-idempotency.mjs --rollback --confirm "ROLLBACK 0052 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback فقط والجدول فارغ (مرفوض مع أي صف). في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { OPERATION_IDEMPOTENCY_FILE, OPERATION_IDEMPOTENCY_MIGRATION } from "../server/operationIdempotencyMigration";
import { runHandMigrationCli } from "./_handMigrationCli";

runHandMigrationCli(OPERATION_IDEMPOTENCY_MIGRATION, OPERATION_IDEMPOTENCY_FILE)
  .catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
