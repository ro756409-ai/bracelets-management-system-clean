import {
  mysqlTable, int, varchar, char, text, decimal, date, timestamp, tinyint, mysqlEnum, uniqueIndex, index, primaryKey,
} from "drizzle-orm/mysql-core";

/**
 * Accounting Ledger V3 — تعريفات Drizzle **للقراءة والكتابة من الخدمة فقط**.
 *
 * هذا الملف **ليس** ضمن `drizzle.config.ts` (الذي يقرأ `./drizzle/schema.ts` وحده) عن قصد: لا
 * `push` ولا `generate` ينشئ هذه الجداول تلقائيًا في أي بيئة. المصدر الوحيد لإنشائها هو الملف
 * المكتوب بخط اليد `drizzle/0040_ledger_v3.sql` ويُطبَّق يدويًا بعد الموافقة. التعريفات هنا مطابقة
 * له حرفيًا (الأعمدة/الأنواع/الفهارس)؛ المفاتيح الأجنبية المركّبة موجودة في DDL ولا تُكرَّر هنا.
 * الخدمة ترفض برسالة واضحة إذا لم تجد الجداول (ER_NO_SUCH_TABLE) ولا تسقط على V2.
 */
export const LEDGER_ACTOR_TYPES = ["employee", "system", "webhook"] as const;
export const LEDGER_ACCOUNT_KINDS = [
  "cash", "bank", "wallet", "carrier_receivable", "employee_receivable", "supplier_payable", "customer_advance",
  "owner_current", "revenue", "expense", "cogs", "inventory", "equity", "suspense",
  // 0046 (في الآخر): رواتب مستحقة، ودفعات مقدمة لموردين — لا تُستخدم قبل تطبيق 0046 (ledgerKindsSupported)
  "payroll_payable", "supplier_advance",
] as const;

export const ledgerAccounts = mysqlTable(
  "ledger_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull(),
    code: varchar("code", { length: 50 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    kind: mysqlEnum("kind", LEDGER_ACCOUNT_KINDS).notNull(),
    normalSide: mysqlEnum("normalSide", ["debit", "credit"]).notNull(),
    currency: char("currency", { length: 3 }).default("EGP").notNull(),
    currentBalance: decimal("currentBalance", { precision: 18, scale: 4 }).default("0").notNull(),
    allowNegative: tinyint("allowNegative").default(0).notNull(),
    isActive: tinyint("isActive").default(1).notNull(),
    actorType: mysqlEnum("actorType", LEDGER_ACTOR_TYPES).notNull(),
    actorEmployeeId: int("actorEmployeeId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    tenantCode: uniqueIndex("ledger_accounts_tenant_code_unique").on(t.tenantId, t.code),
    tenantId: uniqueIndex("ledger_accounts_tenant_id_unique").on(t.tenantId, t.id),
  })
);

export const ledgerAccountBusinesses = mysqlTable(
  "ledger_account_businesses",
  {
    tenantId: int("tenantId").notNull(),
    accountId: int("accountId").notNull(),
    businessId: int("businessId").notNull(),
    canPost: tinyint("canPost").default(1).notNull(),
    actorType: mysqlEnum("actorType", LEDGER_ACTOR_TYPES).notNull(),
    actorEmployeeId: int("actorEmployeeId"),
    grantedAt: timestamp("grantedAt").defaultNow().notNull(),
  },
  t => ({ pk: primaryKey({ columns: [t.accountId, t.businessId], name: "ledger_account_businesses_pk" }) })
);

export const ledgerPeriods = mysqlTable(
  "ledger_periods",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull(),
    period: char("period", { length: 7 }).notNull(),
    status: mysqlEnum("status", ["open", "locked"]).default("open").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({ tenantPeriod: uniqueIndex("ledger_periods_tenant_period_unique").on(t.tenantId, t.period) })
);

export const ledgerPeriodEvents = mysqlTable(
  "ledger_period_events",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull(),
    periodId: int("periodId").notNull(),
    action: mysqlEnum("action", ["lock", "reopen"]).notNull(),
    actorType: mysqlEnum("actorType", LEDGER_ACTOR_TYPES).notNull(),
    actorEmployeeId: int("actorEmployeeId"),
    reason: text("reason").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({ periodIdx: index("ledger_period_events_period_idx").on(t.periodId, t.createdAt) })
);

export const ledgerTransactions = mysqlTable(
  "ledger_transactions",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull(),
    sourceBusinessId: int("sourceBusinessId"),
    kind: varchar("kind", { length: 60 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
    payloadHash: char("payloadHash", { length: 64 }).notNull(),
    currency: char("currency", { length: 3 }).default("EGP").notNull(),
    effectiveDate: date("effectiveDate", { mode: "string" }).notNull(),
    postingPeriod: char("postingPeriod", { length: 7 }).notNull(),
    reversalOfTransactionId: int("reversalOfTransactionId"),
    sourceType: varchar("sourceType", { length: 50 }),
    sourceReference: varchar("sourceReference", { length: 160 }),
    description: text("description").notNull(),
    actorType: mysqlEnum("actorType", LEDGER_ACTOR_TYPES).notNull(),
    actorEmployeeId: int("actorEmployeeId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    tenantIdem: uniqueIndex("ledger_transactions_tenant_idem_unique").on(t.tenantId, t.idempotencyKey),
    reversalOnce: uniqueIndex("ledger_transactions_reversal_once_unique").on(t.reversalOfTransactionId),
    tenantId: uniqueIndex("ledger_transactions_tenant_id_unique").on(t.tenantId, t.id),
    tenantPeriod: index("ledger_transactions_tenant_period_idx").on(t.tenantId, t.postingPeriod),
    businessDate: index("ledger_transactions_business_date_idx").on(t.sourceBusinessId, t.effectiveDate),
  })
);

export const ledgerEntries = mysqlTable(
  "ledger_entries",
  {
    id: int("id").autoincrement().primaryKey(),
    tenantId: int("tenantId").notNull(),
    transactionId: int("transactionId").notNull(),
    accountId: int("accountId").notNull(),
    businessId: int("businessId"),
    side: mysqlEnum("side", ["debit", "credit"]).notNull(),
    amount: decimal("amount", { precision: 18, scale: 4 }).notNull(),
    balanceAfter: decimal("balanceAfter", { precision: 18, scale: 4 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    accountTx: index("ledger_entries_account_tx_idx").on(t.accountId, t.transactionId),
    tx: index("ledger_entries_tx_idx").on(t.transactionId),
    business: index("ledger_entries_business_idx").on(t.businessId),
  })
);

export const ledgerTenantFlags = mysqlTable("ledger_tenant_flags", {
  tenantId: int("tenantId").primaryKey(),
  ledgerV3Enabled: tinyint("ledgerV3Enabled").default(0).notNull(),
  goLiveDate: date("goLiveDate", { mode: "string" }),
  openingTransactionId: int("openingTransactionId"),
  actorType: mysqlEnum("actorType", LEDGER_ACTOR_TYPES),
  actorEmployeeId: int("actorEmployeeId"),
  enabledAt: timestamp("enabledAt"),
  disabledAt: timestamp("disabledAt"),
  disabledReason: text("disabledReason"),
});

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type LedgerPeriod = typeof ledgerPeriods.$inferSelect;
