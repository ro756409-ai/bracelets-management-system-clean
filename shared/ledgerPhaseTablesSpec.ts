import type { TableSpec } from "./schemaSpec";

/**
 * مواصفات 0047–0050 كبيانات (تحقق check/verify مقابل information_schema) — جداول Ledger V3 للمراحل 3/5/6/7.
 * كل جدول بمفتاح شركة (tenantId) وFK مركّبة للأنشطة/الموظفين/قيود الدفتر، وCHECK مسمّاة (موجودة في ملف الـSQL).
 */
const int = (name: string, nullable = false) => ({ name, type: "int", nullable });
const ts = (name: string, nullable = false) => ({ name, type: "timestamp(3)", nullable });
const vc = (name: string, n: number, nullable = false) => ({ name, type: `varchar(${n})`, nullable });
const ch = (name: string, n: number, nullable = false) => ({ name, type: `char(${n})`, nullable });
const dec = (name: string, nullable = false) => ({ name, type: "decimal(18,4)", nullable });
const en = (name: string, nullable = false) => ({ name, type: "enum", nullable });
const fk = (name: string, columns: string[], refTable: string, refColumns: string[]) => ({ name, columns, refTable, refColumns });
const emp = (name: string, col: string) => fk(name, ["tenantId", col], "employees", ["tenantId", "id"]);
const biz = (name: string) => fk(name, ["tenantId", "businessId"], "businesses", ["tenantId", "id"]);
const ten = (name: string) => fk(name, ["tenantId"], "tenants", ["id"]);
const tx = (name: string, col: string) => fk(name, ["tenantId", col], "ledger_transactions", ["tenantId", "id"]);

export const LEDGER_PHASE_GENERATED = {
  activePeriod: "CASE WHEN `status` <> 'cancelled' THEN `period` END",
  receiptInvoiceId: "CASE WHEN `docType` = 'invoice' THEN `purchaseReceiptId` END",
} as const;

export const CARRIER_TABLES = ["ledger_shipments", "ledger_carrier_review_items", "ledger_settings"] as const;
export const PAYROLL_TABLES = ["ledger_payroll_runs", "ledger_payroll_lines", "ledger_advances", "ledger_advance_installments"] as const;
export const SUPPLIER_TABLES = ["ledger_suppliers", "ledger_supplier_documents", "ledger_workshop_batches", "ledger_workshop_events"] as const;
export const SNAPSHOT_TABLES = ["ledger_period_snapshots"] as const;

export const CARRIER_SPEC: Record<(typeof CARRIER_TABLES)[number], TableSpec> = {
  ledger_shipments: {
    columns: [int("id"), int("tenantId"), int("businessId"), int("orderId"), vc("carrier", 20), vc("shipmentId", 100), ts("createdAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lsh_tenant_carrier_shipment_unique", columns: ["tenantId", "carrier", "shipmentId"] }, { name: "lsh_tenant_carrier_order_unique", columns: ["tenantId", "carrier", "orderId"] }],
    indexes: [],
    foreignKeys: [ten("fk_lsh_tenant"), biz("fk_lsh_tenant_business")],
    checks: ["chk_lsh_carrier", "chk_lsh_shipment", "chk_lsh_order"],
  },
  ledger_carrier_review_items: {
    columns: [int("id"), int("tenantId"), int("businessId", true), en("source"), vc("referenceKey", 191), int("orderId", true), vc("shipmentId", 100, true), vc("reason", 500),
      en("status"), int("resolvedByEmployeeId", true), ts("resolvedAt", true), vc("resolutionNote", 500, true), ts("createdAt"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lcr_tenant_reference_unique", columns: ["tenantId", "referenceKey"] }],
    indexes: [{ name: "lcr_tenant_status_created", columns: ["tenantId", "status", "createdAt"] }],
    foreignKeys: [ten("fk_lcr_tenant"), biz("fk_lcr_tenant_business"), emp("fk_lcr_tenant_resolver", "resolvedByEmployeeId")],
    checks: ["chk_lcr_reason", "chk_lcr_resolution"],
  },
  ledger_settings: {
    columns: [int("id"), int("tenantId"), int("scopeBusinessId"), vc("settingKey", 60), dec("valueDecimal", true), int("valueInt", true), int("updatedByEmployeeId"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lst_tenant_scope_key_unique", columns: ["tenantId", "scopeBusinessId", "settingKey"] }],
    indexes: [],
    foreignKeys: [ten("fk_lst_tenant"), emp("fk_lst_tenant_updater", "updatedByEmployeeId")],
    checks: ["chk_lst_key", "chk_lst_scope", "chk_lst_one_value"],
  },
};

export const PAYROLL_SPEC: Record<(typeof PAYROLL_TABLES)[number], TableSpec> = {
  ledger_payroll_runs: {
    columns: [int("id"), int("tenantId"), ch("period", 7), en("status"), { name: "activePeriod", type: "char(7)", nullable: true, generated: LEDGER_PHASE_GENERATED.activePeriod },
      dec("gross"), dec("totalDeductions"), dec("net"), int("accrualTransactionId", true), int("paymentTransactionId", true),
      int("createdByEmployeeId"), int("approvedByEmployeeId", true), ts("approvedAt", true), int("paidByEmployeeId", true), ts("paidAt", true),
      int("cancelledByEmployeeId", true), ts("cancelledAt", true), vc("cancelReason", 500, true), vc("idempotencyKey", 191), ts("createdAt"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lpr_tenant_id_unique", columns: ["tenantId", "id"] }, { name: "lpr_tenant_active_period_unique", columns: ["tenantId", "activePeriod"] }, { name: "lpr_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] }],
    indexes: [{ name: "lpr_tenant_period", columns: ["tenantId", "period"] }],
    foreignKeys: [ten("fk_lpr_tenant"), emp("fk_lpr_tenant_creator", "createdByEmployeeId"), emp("fk_lpr_tenant_approver", "approvedByEmployeeId"), emp("fk_lpr_tenant_payer", "paidByEmployeeId"),
      emp("fk_lpr_tenant_canceller", "cancelledByEmployeeId"), tx("fk_lpr_tenant_accrual", "accrualTransactionId"), tx("fk_lpr_tenant_payment", "paymentTransactionId")],
    checks: ["chk_lpr_period", "chk_lpr_amounts", "chk_lpr_approved", "chk_lpr_paid", "chk_lpr_cancelled", "chk_lpr_state", "chk_lpr_key"],
  },
  ledger_payroll_lines: {
    columns: [int("id"), int("tenantId"), int("runId"), int("employeeId"), int("businessId", true), { name: "inputsJson", type: "json", nullable: false }, { name: "resultJson", type: "json", nullable: false },
      dec("gross"), dec("totalDeductions"), dec("net"), ts("createdAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lpl_run_employee_unique", columns: ["runId", "employeeId"] }, { name: "lpl_tenant_id_unique", columns: ["tenantId", "id"] }],
    indexes: [],
    foreignKeys: [ten("fk_lpl_tenant"), fk("fk_lpl_tenant_run", ["tenantId", "runId"], "ledger_payroll_runs", ["tenantId", "id"]), emp("fk_lpl_tenant_employee", "employeeId"), biz("fk_lpl_tenant_business")],
    checks: ["chk_lpl_amounts"],
  },
  ledger_advances: {
    columns: [int("id"), int("tenantId"), int("employeeId"), int("businessId", true), dec("principal"), { name: "issuedOn", type: "date", nullable: false }, int("installmentsCount"), en("status"),
      int("issueTransactionId"), int("cancelTransactionId", true), vc("idempotencyKey", 191), int("createdByEmployeeId"), ts("createdAt"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lad_tenant_id_unique", columns: ["tenantId", "id"] }, { name: "lad_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] }],
    indexes: [{ name: "lad_tenant_employee_status", columns: ["tenantId", "employeeId", "status"] }],
    foreignKeys: [ten("fk_lad_tenant"), emp("fk_lad_tenant_employee", "employeeId"), biz("fk_lad_tenant_business"), emp("fk_lad_tenant_creator", "createdByEmployeeId"),
      tx("fk_lad_tenant_issue", "issueTransactionId"), tx("fk_lad_tenant_cancel", "cancelTransactionId")],
    checks: ["chk_lad_principal", "chk_lad_installments", "chk_lad_cancel", "chk_lad_key"],
  },
  ledger_advance_installments: {
    columns: [int("id"), int("tenantId"), int("advanceId"), int("seq"), ch("dueMonth", 7), dec("amount"), en("status"), int("payrollRunId", true), dec("deductedAmount"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lai_advance_seq_unique", columns: ["advanceId", "seq"] }, { name: "lai_tenant_id_unique", columns: ["tenantId", "id"] }],
    indexes: [{ name: "lai_tenant_due_status", columns: ["tenantId", "dueMonth", "status"] }],
    foreignKeys: [ten("fk_lai_tenant"), fk("fk_lai_tenant_advance", ["tenantId", "advanceId"], "ledger_advances", ["tenantId", "id"]), fk("fk_lai_tenant_run", ["tenantId", "payrollRunId"], "ledger_payroll_runs", ["tenantId", "id"])],
    checks: ["chk_lai_amount", "chk_lai_due", "chk_lai_state"],
  },
};

export const SUPPLIER_SPEC: Record<(typeof SUPPLIER_TABLES)[number], TableSpec> = {
  ledger_suppliers: {
    columns: [int("id"), int("tenantId"), vc("code", 40), vc("name", 160), vc("phone", 30, true), { name: "isWorkshop", type: "tinyint(1)", nullable: false }, { name: "isActive", type: "tinyint(1)", nullable: false },
      int("createdByEmployeeId"), ts("createdAt"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lsu_tenant_id_unique", columns: ["tenantId", "id"] }, { name: "lsu_tenant_code_unique", columns: ["tenantId", "code"] }, { name: "lsu_tenant_name_unique", columns: ["tenantId", "name"] }],
    indexes: [],
    foreignKeys: [ten("fk_lsu_tenant"), emp("fk_lsu_tenant_creator", "createdByEmployeeId")],
    checks: ["chk_lsu_code", "chk_lsu_name", "chk_lsu_flags"],
  },
  ledger_supplier_documents: {
    columns: [int("id"), int("tenantId"), int("supplierId"), int("businessId", true), en("docType"), vc("docNo", 80), { name: "docDate", type: "date", nullable: false }, { name: "dueDate", type: "date", nullable: true },
      dec("amount"), int("purchaseReceiptId", true), { name: "receiptInvoiceId", type: "int", nullable: true, generated: LEDGER_PHASE_GENERATED.receiptInvoiceId },
      int("appliesToDocumentId", true), int("transactionId"), int("reversalTransactionId", true), int("createdByEmployeeId"), ts("createdAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lsd_tenant_id_unique", columns: ["tenantId", "id"] }, { name: "lsd_tenant_supplier_doc_unique", columns: ["tenantId", "supplierId", "docType", "docNo"] },
      { name: "lsd_tenant_receipt_invoice_unique", columns: ["tenantId", "receiptInvoiceId"] }, { name: "lsd_tenant_transaction_unique", columns: ["tenantId", "transactionId"] }],
    indexes: [{ name: "lsd_tenant_supplier_date", columns: ["tenantId", "supplierId", "docDate"] }],
    foreignKeys: [ten("fk_lsd_tenant"), fk("fk_lsd_tenant_supplier", ["tenantId", "supplierId"], "ledger_suppliers", ["tenantId", "id"]), biz("fk_lsd_tenant_business"),
      fk("fk_lsd_tenant_applies", ["tenantId", "appliesToDocumentId"], "ledger_supplier_documents", ["tenantId", "id"]), tx("fk_lsd_tenant_transaction", "transactionId"),
      tx("fk_lsd_tenant_reversal", "reversalTransactionId"), emp("fk_lsd_tenant_creator", "createdByEmployeeId")],
    checks: ["chk_lsd_amount", "chk_lsd_docno", "chk_lsd_due", "chk_lsd_applies"],
  },
  ledger_workshop_batches: {
    columns: [int("id"), int("tenantId"), int("supplierId"), int("businessId"), vc("reference", 80), en("status"), int("sentQuantity"), dec("sentValue"), int("receivedQuantity"), dec("receivedValue"),
      int("shortageQuantity"), dec("shortageValue"), dec("pieceWage"), int("createdByEmployeeId"), ts("createdAt"), ts("updatedAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lwb_tenant_id_unique", columns: ["tenantId", "id"] }, { name: "lwb_tenant_reference_unique", columns: ["tenantId", "reference"] }],
    indexes: [],
    foreignKeys: [ten("fk_lwb_tenant"), fk("fk_lwb_tenant_supplier", ["tenantId", "supplierId"], "ledger_suppliers", ["tenantId", "id"]), biz("fk_lwb_tenant_business"), emp("fk_lwb_tenant_creator", "createdByEmployeeId")],
    checks: ["chk_lwb_quantities", "chk_lwb_values", "chk_lwb_reference"],
  },
  ledger_workshop_events: {
    columns: [int("id"), int("tenantId"), int("batchId"), en("eventType"), int("quantity"), dec("value"), int("transactionId", true), vc("idempotencyKey", 191), int("actorEmployeeId"), vc("note", 500, true), ts("createdAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lwe_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] }],
    indexes: [{ name: "lwe_tenant_batch_created", columns: ["tenantId", "batchId", "createdAt"] }],
    foreignKeys: [ten("fk_lwe_tenant"), fk("fk_lwe_tenant_batch", ["tenantId", "batchId"], "ledger_workshop_batches", ["tenantId", "id"]), tx("fk_lwe_tenant_transaction", "transactionId"), emp("fk_lwe_tenant_actor", "actorEmployeeId")],
    checks: ["chk_lwe_values", "chk_lwe_key"],
  },
};

export const SNAPSHOT_SPEC: Record<(typeof SNAPSHOT_TABLES)[number], TableSpec> = {
  ledger_period_snapshots: {
    columns: [int("id"), int("tenantId"), ch("period", 7), int("version"), int("lockEventId"), { name: "figuresJson", type: "json", nullable: false }, { name: "checklistJson", type: "json", nullable: false },
      ch("figuresHash", 64), int("createdByEmployeeId"), ts("createdAt")],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "lps_tenant_period_version_unique", columns: ["tenantId", "period", "version"] }, { name: "lps_lock_event_unique", columns: ["lockEventId"] }],
    indexes: [],
    foreignKeys: [ten("fk_lps_tenant"), fk("fk_lps_tenant_period", ["tenantId", "period"], "ledger_periods", ["tenantId", "period"]),
      fk("fk_lps_lock_event", ["lockEventId"], "ledger_period_events", ["id"]), emp("fk_lps_tenant_creator", "createdByEmployeeId")],
    checks: ["chk_lps_version", "chk_lps_period", "chk_lps_hash"],
  },
};
