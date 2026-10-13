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
