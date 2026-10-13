import { IDEMPOTENCY_SPEC, IDEMPOTENCY_TABLES } from "../shared/operationIdempotencySpec";
import type { HandMigrationDef } from "./handMigration.service";

/** 0052 لمحرّك الـMigrations اليدوية — يشترط الفهرس المركّب businesses(tenantId, id) (من 0040/0041)، بلا FK لاحق. */
export const OPERATION_IDEMPOTENCY_MIGRATION: HandMigrationDef = {
  id: "0052", title: "0052 operation idempotency keys", tables: [...IDEMPOTENCY_TABLES], specs: IDEMPOTENCY_SPEC, lateForeignKeys: [], compositeIndexes: "require_present",
};
export const OPERATION_IDEMPOTENCY_FILE = "drizzle/0052_operation_idempotency_keys.sql";
