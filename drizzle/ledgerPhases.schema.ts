import { decimal, int, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";

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
