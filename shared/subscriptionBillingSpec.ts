import type { TableSpec } from "./schemaSpec";

/** مواصفة 0055 كبيانات (تحقق check/verify مقابل information_schema) — اشتراك متجرك: حسابات الفوترة، المدفوعات، الفترات. */
export const SUBSCRIPTION_BILLING_TABLES = ["tenant_billing_accounts", "subscription_payments", "subscription_periods"] as const;

export const SUBSCRIPTION_BILLING_SPEC: Record<(typeof SUBSCRIPTION_BILLING_TABLES)[number], TableSpec> = {
  tenant_billing_accounts: {
    columns: [
      { name: "tenantId", type: "int", nullable: false }, { name: "model", type: "enum", nullable: false },
      { name: "enrolledBy", type: "enum", nullable: false }, { name: "enrolledByPlatformAdminId", type: "int", nullable: true },
      { name: "createdAt", type: "timestamp(3)", nullable: false },
    ],
    uniques: [{ name: "PRIMARY", columns: ["tenantId"] }],
    indexes: [],
    foreignKeys: [{ name: "fk_tba_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] }],
    checks: ["chk_tba_enrolled_by"],
  },
  subscription_payments: {
    columns: [
      { name: "id", type: "int", nullable: false }, { name: "tenantId", type: "int", nullable: false },
      { name: "planCode", type: "enum", nullable: false }, { name: "months", type: "tinyint", nullable: false },
      { name: "amountMinor", type: "int", nullable: false }, { name: "currency", type: "char(3)", nullable: false },
      { name: "provider", type: "enum", nullable: false }, { name: "status", type: "enum", nullable: false },
      { name: "idempotencyKey", type: "varchar(80)", nullable: false }, { name: "providerRef", type: "varchar(120)", nullable: true },
      { name: "paymentReference", type: "varchar(200)", nullable: true }, { name: "evidenceUrl", type: "varchar(500)", nullable: true },
      { name: "note", type: "text", nullable: true }, { name: "recordedByPlatformAdminId", type: "int", nullable: true },
      { name: "failureReason", type: "varchar(300)", nullable: true }, { name: "refundReason", type: "varchar(300)", nullable: true },
      { name: "createdAt", type: "timestamp(3)", nullable: false }, { name: "succeededAt", type: "timestamp(3)", nullable: true },
      { name: "failedAt", type: "timestamp(3)", nullable: true }, { name: "refundedAt", type: "timestamp(3)", nullable: true },
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] },
      { name: "sp_idempotency_unique", columns: ["idempotencyKey"] },
      { name: "sp_provider_ref_unique", columns: ["provider", "providerRef"] },
    ],
    indexes: [{ name: "sp_tenant_created_idx", columns: ["tenantId", "createdAt"] }],
    foreignKeys: [{ name: "fk_sp_billing_account", columns: ["tenantId"], refTable: "tenant_billing_accounts", refColumns: ["tenantId"] }],
    checks: ["chk_sp_plan_months", "chk_sp_amount", "chk_sp_idempotency", "chk_sp_manual_evidence", "chk_sp_online_ref", "chk_sp_status_times"],
  },
  subscription_periods: {
    columns: [
      { name: "id", type: "int", nullable: false }, { name: "tenantId", type: "int", nullable: false },
      { name: "paymentId", type: "int", nullable: false }, { name: "startsAt", type: "timestamp(3)", nullable: false },
      { name: "endsAt", type: "timestamp(3)", nullable: false }, { name: "voidedAt", type: "timestamp(3)", nullable: true },
      { name: "voidReason", type: "varchar(300)", nullable: true }, { name: "createdAt", type: "timestamp(3)", nullable: false },
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "spd_payment_unique", columns: ["paymentId"] }],
    indexes: [{ name: "spd_tenant_ends_idx", columns: ["tenantId", "endsAt"] }],
    foreignKeys: [
      { name: "fk_spd_billing_account", columns: ["tenantId"], refTable: "tenant_billing_accounts", refColumns: ["tenantId"] },
      { name: "fk_spd_payment", columns: ["paymentId"], refTable: "subscription_payments", refColumns: ["id"] },
    ],
    checks: ["chk_spd_range", "chk_spd_void"],
  },
};
