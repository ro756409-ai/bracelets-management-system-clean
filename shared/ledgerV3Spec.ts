/**
 * مواصفة Ledger V3 كبيانات (بلا قاعدة بيانات): الجداول والأعمدة والفهارس الفريدة والمفاتيح الأجنبية
 * التي يجب أن ينتجها `drizzle/0040_ledger_v3.sql`. يستخدمها سكربت التحقق والاختبارات معًا حتى لا
 * تنحرف المواصفة عن الملف.
 */
export const LEDGER_V3_TABLES = [
  "ledger_accounts",
  "ledger_account_businesses",
  "ledger_periods",
  "ledger_period_events",
  "ledger_transactions",
  "ledger_entries",
  "ledger_tenant_flags",
] as const;
export type LedgerV3Table = (typeof LEDGER_V3_TABLES)[number];

/** ترتيب الحذف الآمن (عكس المفاتيح الأجنبية). */
export const LEDGER_V3_DROP_ORDER: readonly LedgerV3Table[] = [
  "ledger_tenant_flags",
  "ledger_entries",
  "ledger_transactions",
  "ledger_period_events",
  "ledger_periods",
  "ledger_account_businesses",
  "ledger_accounts",
];

export type ColumnSpec = { name: string; type: string; nullable: boolean };
export type ForeignKeySpec = { name: string; columns: string[]; refTable: string; refColumns: string[] };
export type UniqueSpec = { name: string; columns: string[] };

export const LEDGER_V3_SPEC: Record<LedgerV3Table, { columns: ColumnSpec[]; uniques: UniqueSpec[]; foreignKeys: ForeignKeySpec[] }> = {
  ledger_accounts: {
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "tenantId", type: "int", nullable: false },
      { name: "code", type: "varchar(50)", nullable: false },
      { name: "name", type: "varchar(120)", nullable: false },
      { name: "kind", type: "enum", nullable: false },
      { name: "normalSide", type: "enum", nullable: false },
      { name: "currency", type: "char(3)", nullable: false },
      { name: "currentBalance", type: "decimal(18,4)", nullable: false },
      { name: "allowNegative", type: "tinyint(1)", nullable: false },
      { name: "isActive", type: "tinyint(1)", nullable: false },
      { name: "actorType", type: "enum", nullable: false },
      { name: "actorEmployeeId", type: "int", nullable: true },
      { name: "createdAt", type: "timestamp", nullable: false },
    ],
    uniques: [
      { name: "ledger_accounts_tenant_code_unique", columns: ["tenantId", "code"] },
      { name: "ledger_accounts_tenant_id_unique", columns: ["tenantId", "id"] },
    ],
    foreignKeys: [
      { name: "fk_ledger_accounts_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_ledger_accounts_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
  },
  ledger_account_businesses: {
    columns: [
      { name: "tenantId", type: "int", nullable: false },
      { name: "accountId", type: "int", nullable: false },
      { name: "businessId", type: "int", nullable: false },
      { name: "canPost", type: "tinyint(1)", nullable: false },
      { name: "actorType", type: "enum", nullable: false },
      { name: "actorEmployeeId", type: "int", nullable: true },
      { name: "grantedAt", type: "timestamp", nullable: false },
    ],
    uniques: [{ name: "PRIMARY", columns: ["accountId", "businessId"] }],
    foreignKeys: [
      { name: "fk_lab_tenant_account", columns: ["tenantId", "accountId"], refTable: "ledger_accounts", refColumns: ["tenantId", "id"] },
      { name: "fk_lab_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
      { name: "fk_lab_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
  },
  ledger_periods: {
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "tenantId", type: "int", nullable: false },
      { name: "period", type: "char(7)", nullable: false },
      { name: "status", type: "enum", nullable: false },
      { name: "createdAt", type: "timestamp", nullable: false },
      { name: "updatedAt", type: "timestamp", nullable: false },
    ],
    uniques: [{ name: "ledger_periods_tenant_period_unique", columns: ["tenantId", "period"] }],
    foreignKeys: [{ name: "fk_ledger_periods_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] }],
  },
  ledger_period_events: {
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "tenantId", type: "int", nullable: false },
      { name: "periodId", type: "int", nullable: false },
      { name: "action", type: "enum", nullable: false },
      { name: "actorType", type: "enum", nullable: false },
      { name: "actorEmployeeId", type: "int", nullable: true },
      { name: "reason", type: "text", nullable: false },
      { name: "createdAt", type: "timestamp", nullable: false },
    ],
    uniques: [],
    foreignKeys: [
      { name: "fk_lpe_period", columns: ["periodId"], refTable: "ledger_periods", refColumns: ["id"] },
      { name: "fk_lpe_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_lpe_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
  },
  ledger_transactions: {
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "tenantId", type: "int", nullable: false },
      { name: "sourceBusinessId", type: "int", nullable: true },
      { name: "kind", type: "varchar(60)", nullable: false },
      { name: "idempotencyKey", type: "varchar(191)", nullable: false },
      { name: "payloadHash", type: "char(64)", nullable: false },
      { name: "currency", type: "char(3)", nullable: false },
      { name: "effectiveDate", type: "date", nullable: false },
      { name: "postingPeriod", type: "char(7)", nullable: false },
      { name: "reversalOfTransactionId", type: "int", nullable: true },
      { name: "sourceType", type: "varchar(50)", nullable: true },
      { name: "sourceReference", type: "varchar(160)", nullable: true },
      { name: "description", type: "text", nullable: false },
      { name: "actorType", type: "enum", nullable: false },
      { name: "actorEmployeeId", type: "int", nullable: true },
      { name: "createdAt", type: "timestamp", nullable: false },
    ],
    uniques: [
      { name: "ledger_transactions_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] },
      { name: "ledger_transactions_reversal_once_unique", columns: ["reversalOfTransactionId"] },
      { name: "ledger_transactions_tenant_id_unique", columns: ["tenantId", "id"] },
    ],
    foreignKeys: [
      { name: "fk_lt_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_lt_tenant_business", columns: ["tenantId", "sourceBusinessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
      { name: "fk_lt_period", columns: ["tenantId", "postingPeriod"], refTable: "ledger_periods", refColumns: ["tenantId", "period"] },
      { name: "fk_lt_reversal", columns: ["tenantId", "reversalOfTransactionId"], refTable: "ledger_transactions", refColumns: ["tenantId", "id"] },
      { name: "fk_lt_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
  },
  ledger_entries: {
    columns: [
      { name: "id", type: "int", nullable: false },
      { name: "tenantId", type: "int", nullable: false },
      { name: "transactionId", type: "int", nullable: false },
      { name: "accountId", type: "int", nullable: false },
      { name: "businessId", type: "int", nullable: true },
      { name: "side", type: "enum", nullable: false },
      { name: "amount", type: "decimal(18,4)", nullable: false },
      { name: "balanceAfter", type: "decimal(18,4)", nullable: false },
      { name: "createdAt", type: "timestamp", nullable: false },
    ],
    uniques: [],
    foreignKeys: [
      { name: "fk_le_tenant_tx", columns: ["tenantId", "transactionId"], refTable: "ledger_transactions", refColumns: ["tenantId", "id"] },
      { name: "fk_le_tenant_account", columns: ["tenantId", "accountId"], refTable: "ledger_accounts", refColumns: ["tenantId", "id"] },
      { name: "fk_le_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
    ],
  },
  ledger_tenant_flags: {
    columns: [
      { name: "tenantId", type: "int", nullable: false },
      { name: "ledgerV3Enabled", type: "tinyint(1)", nullable: false },
      { name: "goLiveDate", type: "date", nullable: true },
      { name: "openingTransactionId", type: "int", nullable: true },
      { name: "actorType", type: "enum", nullable: true },
      { name: "actorEmployeeId", type: "int", nullable: true },
      { name: "enabledAt", type: "timestamp", nullable: true },
      { name: "disabledAt", type: "timestamp", nullable: true },
      { name: "disabledReason", type: "text", nullable: true },
    ],
    uniques: [{ name: "PRIMARY", columns: ["tenantId"] }],
    foreignKeys: [
      { name: "fk_ltf_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_ltf_opening", columns: ["tenantId", "openingTransactionId"], refTable: "ledger_transactions", refColumns: ["tenantId", "id"] },
      { name: "fk_ltf_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
  },
};

/** الفهرسان الفريدان المركّبان المضافان إلى الجداول القديمة (additive) — هدفا الـFK المركّبة. */
export const LEDGER_V3_OLD_TABLE_INDEXES: { table: "businesses" | "employees"; name: string; columns: string[] }[] = [
  { table: "businesses", name: "businesses_tenant_id", columns: ["tenantId", "id"] },
  { table: "employees", name: "employees_tenant_id", columns: ["tenantId", "id"] },
];

/** قيود CHECK المطلوبة (MySQL 8.0.16+ يفرضها). */
export const LEDGER_V3_CHECKS: { table: LedgerV3Table; name: string }[] = [
  { table: "ledger_entries", name: "ledger_entries_amount_positive" },
];

/** تقسيم ملف الـmigration إلى عبارات تنفيذية (نفس فاصل drizzle). */
export function splitMigrationStatements(sqlText: string): string[] {
  return sqlText
    .split(/-->\s*statement-breakpoint/)
    .map(chunk => chunk.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").trim())
    .filter(chunk => chunk.length > 0);
}

export type VerifyIssue = { table: string; kind: "table" | "column" | "unique" | "foreign_key" | "check" | "old_index"; detail: string };

/** حالة التطبيق: لا شيء / كامل / **جزئي** (خطِر — تشغيل متقطّع). */
export type ApplicationState = "not_applied" | "applied" | "partial";
export function applicationState(snapshot: SchemaSnapshot): ApplicationState {
  const tables = LEDGER_V3_TABLES.filter(t => snapshot.tables.has(t)).length;
  const oldIdx = LEDGER_V3_OLD_TABLE_INDEXES.filter(i => Boolean(snapshot.uniques[i.table]?.[i.name])).length;
  const total = tables + oldIdx, max = LEDGER_V3_TABLES.length + LEDGER_V3_OLD_TABLE_INDEXES.length;
  // الفهرسان المركّبان قد يسبقان 0040 (ينشئهما 0041 إن كانا غائبين): وجودهما **بالتعريف الصحيح** بلا أي جدول ledger_*
  // = غير مطبَّقة (عبارتاهما تُتخطّيان عند التطبيق). واحد فقط أو تعريف مختلف = partial.
  if (tables === 0 && oldIdx === LEDGER_V3_OLD_TABLE_INDEXES.length && compositeIndexesCorrect(snapshot)) return "not_applied";
  return total === 0 ? "not_applied" : total === max ? "applied" : "partial";
}

/** الفهرسان المركّبان موجودان بنفس الأعمدة والترتيب المطلوبين؟ */
export function compositeIndexesCorrect(snapshot: SchemaSnapshot): boolean {
  return LEDGER_V3_OLD_TABLE_INDEXES.every(i => (snapshot.uniques[i.table]?.[i.name] ?? []).join(",") === i.columns.join(","));
}

/** صورة قاعدة البيانات كما يقرؤها information_schema (مُحمَّلة من الخارج). */
export type SchemaSnapshot = {
  tables: Set<string>;
  columns: Record<string, Array<{ name: string; columnType: string; nullable: boolean }>>;
  /** اسم الفهرس → أعمدته بالترتيب (الفريدة فقط) */
  uniques: Record<string, Record<string, string[]>>;
  /** اسم القيد → {columns, refTable, refColumns} */
  foreignKeys: Record<string, Record<string, { columns: string[]; refTable: string; refColumns: string[] }>>;
  checks: Record<string, Set<string>>;
};

/** يقارن اللقطة بالمواصفة — نقي، ويُختبر بلقطات مكسورة عمدًا. */
export function verifyLedgerV3(snapshot: SchemaSnapshot): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const table of LEDGER_V3_TABLES) {
    if (!snapshot.tables.has(table)) { issues.push({ table, kind: "table", detail: "الجدول غير موجود" }); continue; }
    const spec = LEDGER_V3_SPEC[table];
    const cols = new Map((snapshot.columns[table] ?? []).map(c => [c.name, c]));
    for (const c of spec.columns) {
      const actual = cols.get(c.name);
      if (!actual) { issues.push({ table, kind: "column", detail: `العمود ${c.name} غير موجود` }); continue; }
      const typeOk = c.type === "enum" ? actual.columnType.startsWith("enum(") : actual.columnType.replace(/ unsigned$/, "") === c.type;
      if (!typeOk) issues.push({ table, kind: "column", detail: `${c.name}: النوع ${actual.columnType} ≠ ${c.type}` });
      if (actual.nullable !== c.nullable) issues.push({ table, kind: "column", detail: `${c.name}: nullable=${actual.nullable} ≠ ${c.nullable}` });
    }
    for (const u of spec.uniques) {
      const actual = snapshot.uniques[table]?.[u.name];
      if (!actual) issues.push({ table, kind: "unique", detail: `الفهرس الفريد ${u.name} غير موجود` });
      else if (actual.join(",") !== u.columns.join(",")) issues.push({ table, kind: "unique", detail: `${u.name}: الأعمدة (${actual.join(",")}) ≠ (${u.columns.join(",")})` });
    }
    for (const fk of spec.foreignKeys) {
      const actual = snapshot.foreignKeys[table]?.[fk.name];
      if (!actual) { issues.push({ table, kind: "foreign_key", detail: `المفتاح الأجنبي ${fk.name} غير موجود` }); continue; }
      if (actual.columns.join(",") !== fk.columns.join(",") || actual.refTable !== fk.refTable || actual.refColumns.join(",") !== fk.refColumns.join(","))
        issues.push({ table, kind: "foreign_key", detail: `${fk.name}: (${actual.columns}) → ${actual.refTable}(${actual.refColumns}) ≠ (${fk.columns}) → ${fk.refTable}(${fk.refColumns})` });
    }
  }
  for (const oi of LEDGER_V3_OLD_TABLE_INDEXES) {
    const actual = snapshot.uniques[oi.table]?.[oi.name];
    if (!actual) issues.push({ table: oi.table, kind: "old_index", detail: `الفهرس الفريد المركّب ${oi.name} غير موجود` });
    else if (actual.join(",") !== oi.columns.join(",")) issues.push({ table: oi.table, kind: "old_index", detail: `${oi.name}: الأعمدة (${actual.join(",")}) ≠ (${oi.columns.join(",")})` });
  }
  for (const chk of LEDGER_V3_CHECKS) {
    if (snapshot.tables.has(chk.table) && !snapshot.checks[chk.table]?.has(chk.name))
      issues.push({ table: chk.table, kind: "check", detail: `قيد CHECK ${chk.name} غير موجود` });
  }
  return issues;
}
