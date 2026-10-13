import type { TableSpec } from "./schemaSpec";

/** مواصفة 0052 كبيانات (تحقق check/verify مقابل information_schema) — مفتاح منع تكرار عمليات الإنشاء. */
export const IDEMPOTENCY_TABLES = ["operation_idempotency_keys"] as const;

export const IDEMPOTENCY_SPEC: Record<(typeof IDEMPOTENCY_TABLES)[number], TableSpec> = {
  operation_idempotency_keys: {
    columns: [
      { name: "id", type: "int", nullable: false }, { name: "tenantId", type: "int", nullable: false }, { name: "businessId", type: "int", nullable: false },
      { name: "operation", type: "enum", nullable: false }, { name: "operationId", type: "varchar(80)", nullable: false }, { name: "requestHash", type: "char(64)", nullable: false },
      { name: "resultId", type: "int", nullable: false }, { name: "resultReference", type: "varchar(100)", nullable: false },
      { name: "actorType", type: "enum", nullable: false }, { name: "actorId", type: "int", nullable: false }, { name: "createdAt", type: "timestamp(3)", nullable: false },
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "oik_scope_unique", columns: ["tenantId", "businessId", "operation", "operationId"] }],
    indexes: [],
    foreignKeys: [
      { name: "fk_oik_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_oik_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
    ],
    checks: ["chk_oik_operation_id", "chk_oik_hash", "chk_oik_result"],
  },
};
