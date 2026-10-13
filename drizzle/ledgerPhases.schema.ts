import { char, date, decimal, int, json, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * تعريفات Drizzle لجداول مراحل الدفتر (0047…) — للاستعلام فقط. الجداول تُنشأ بالـMigrations اليدوية (drizzle/0047_*.sql) عبر
 * scripts/migrate-00NN، لا بـdrizzle-kit. أي اختلاف هنا عن ملف الـSQL خطأ — والخدمات تتحقق من وجود الجداول قبل استخدامها.
 */

// 0047 — شركات الشحن
export const ledgerShipments = mysqlTable("ledger_shipments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  businessId: int("businessId").notNull(),
  orderId: int("orderId").notNull(),
  carrier: varchar("carrier", { length: 20 }).notNull(),
  shipmentId: varchar("shipmentId", { length: 100 }).notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
});

export const ledgerCarrierReviewItems = mysqlTable("ledger_carrier_review_items", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  businessId: int("businessId"),
  source: mysqlEnum("source", ["delivery", "settlement", "payout"]).notNull(),
  referenceKey: varchar("referenceKey", { length: 191 }).notNull(),
  orderId: int("orderId"),
  shipmentId: varchar("shipmentId", { length: 100 }),
  reason: varchar("reason", { length: 500 }).notNull(),
  status: mysqlEnum("status", ["open", "resolved", "dismissed"]).default("open").notNull(),
  resolvedByEmployeeId: int("resolvedByEmployeeId"),
  resolvedAt: timestamp("resolvedAt", { fsp: 3 }),
  resolutionNote: varchar("resolutionNote", { length: 500 }),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

export const ledgerSettings = mysqlTable("ledger_settings", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  scopeBusinessId: int("scopeBusinessId").default(0).notNull(),
  settingKey: varchar("settingKey", { length: 60 }).notNull(),
  valueDecimal: decimal("valueDecimal", { precision: 18, scale: 4 }),
  valueInt: int("valueInt"),
  updatedByEmployeeId: int("updatedByEmployeeId").notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

// 0048 — المرتبات والسلف
export const ledgerPayrollRuns = mysqlTable("ledger_payroll_runs", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  period: char("period", { length: 7 }).notNull(),
  status: mysqlEnum("status", ["draft", "approved", "paid", "cancelled"]).default("draft").notNull(),
  // activePeriod عمود مولّد في الـSQL — لا يُكتب أبدًا
  gross: decimal("gross", { precision: 18, scale: 4 }).default("0").notNull(),
  totalDeductions: decimal("totalDeductions", { precision: 18, scale: 4 }).default("0").notNull(),
  net: decimal("net", { precision: 18, scale: 4 }).default("0").notNull(),
  accrualTransactionId: int("accrualTransactionId"),
  paymentTransactionId: int("paymentTransactionId"),
  createdByEmployeeId: int("createdByEmployeeId").notNull(),
  approvedByEmployeeId: int("approvedByEmployeeId"),
  approvedAt: timestamp("approvedAt", { fsp: 3 }),
  paidByEmployeeId: int("paidByEmployeeId"),
  paidAt: timestamp("paidAt", { fsp: 3 }),
  cancelledByEmployeeId: int("cancelledByEmployeeId"),
  cancelledAt: timestamp("cancelledAt", { fsp: 3 }),
  cancelReason: varchar("cancelReason", { length: 500 }),
  idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

export const ledgerPayrollLines = mysqlTable("ledger_payroll_lines", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  runId: int("runId").notNull(),
  employeeId: int("employeeId").notNull(),
  businessId: int("businessId"),
  inputsJson: json("inputsJson").notNull(),
  resultJson: json("resultJson").notNull(),
  gross: decimal("gross", { precision: 18, scale: 4 }).notNull(),
  totalDeductions: decimal("totalDeductions", { precision: 18, scale: 4 }).notNull(),
  net: decimal("net", { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
});

export const ledgerAdvances = mysqlTable("ledger_advances", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  employeeId: int("employeeId").notNull(),
  businessId: int("businessId"),
  principal: decimal("principal", { precision: 18, scale: 4 }).notNull(),
  issuedOn: date("issuedOn", { mode: "string" }).notNull(),
  installmentsCount: int("installmentsCount").notNull(),
  status: mysqlEnum("status", ["active", "settled", "cancelled"]).default("active").notNull(),
  issueTransactionId: int("issueTransactionId").notNull(),
  cancelTransactionId: int("cancelTransactionId"),
  idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
  createdByEmployeeId: int("createdByEmployeeId").notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

export const ledgerAdvanceInstallments = mysqlTable("ledger_advance_installments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  advanceId: int("advanceId").notNull(),
  seq: int("seq").notNull(),
  dueMonth: char("dueMonth", { length: 7 }).notNull(),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  status: mysqlEnum("status", ["pending", "deducted", "cancelled"]).default("pending").notNull(),
  payrollRunId: int("payrollRunId"),
  deductedAmount: decimal("deductedAmount", { precision: 18, scale: 4 }).default("0").notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

// 0049 — الموردون والورشة
export const ledgerSuppliers = mysqlTable("ledger_suppliers", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  code: varchar("code", { length: 40 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  phone: varchar("phone", { length: 30 }),
  isWorkshop: int("isWorkshop").default(0).notNull(),
  isActive: int("isActive").default(1).notNull(),
  createdByEmployeeId: int("createdByEmployeeId").notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

export const ledgerSupplierDocuments = mysqlTable("ledger_supplier_documents", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  supplierId: int("supplierId").notNull(),
  businessId: int("businessId"),
  docType: mysqlEnum("docType", ["invoice", "payment", "advance", "advance_application", "return_credit"]).notNull(),
  docNo: varchar("docNo", { length: 80 }).notNull(),
  docDate: date("docDate", { mode: "string" }).notNull(),
  dueDate: date("dueDate", { mode: "string" }),
  amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
  purchaseReceiptId: int("purchaseReceiptId"),
  // receiptInvoiceId عمود مولّد في الـSQL — لا يُكتب أبدًا
  appliesToDocumentId: int("appliesToDocumentId"),
  transactionId: int("transactionId").notNull(),
  reversalTransactionId: int("reversalTransactionId"),
  createdByEmployeeId: int("createdByEmployeeId").notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
});

export const ledgerWorkshopBatches = mysqlTable("ledger_workshop_batches", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  supplierId: int("supplierId").notNull(),
  businessId: int("businessId").notNull(),
  reference: varchar("reference", { length: 80 }).notNull(),
  status: mysqlEnum("status", ["open", "partially_received", "closed"]).default("open").notNull(),
  sentQuantity: int("sentQuantity").default(0).notNull(),
  sentValue: decimal("sentValue", { precision: 18, scale: 4 }).default("0").notNull(),
  receivedQuantity: int("receivedQuantity").default(0).notNull(),
  receivedValue: decimal("receivedValue", { precision: 18, scale: 4 }).default("0").notNull(),
  shortageQuantity: int("shortageQuantity").default(0).notNull(),
  shortageValue: decimal("shortageValue", { precision: 18, scale: 4 }).default("0").notNull(),
  pieceWage: decimal("pieceWage", { precision: 18, scale: 4 }).default("0").notNull(),
  createdByEmployeeId: int("createdByEmployeeId").notNull(),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { fsp: 3 }).defaultNow().onUpdateNow().notNull(),
});

export const ledgerWorkshopEvents = mysqlTable("ledger_workshop_events", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  batchId: int("batchId").notNull(),
  eventType: mysqlEnum("eventType", ["send", "receive", "shortage", "repair_cost", "wage"]).notNull(),
  quantity: int("quantity").default(0).notNull(),
  value: decimal("value", { precision: 18, scale: 4 }).default("0").notNull(),
  transactionId: int("transactionId"),
  idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
  actorEmployeeId: int("actorEmployeeId").notNull(),
  note: varchar("note", { length: 500 }),
  createdAt: timestamp("createdAt", { fsp: 3 }).defaultNow().notNull(),
});
