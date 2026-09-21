// Migration 0037 — business_carrier_accounts + carrier_webhook_events (idempotent, verifying).
// Usage (from the app directory, so mysql2 resolves):  DATABASE_URL=... node scripts/migrate-0037.cjs
// Each table and each index is checked separately; only what is missing is created; an existing
// table whose structure differs from the expected one is a hard error (exit 1) — never "success".
const mysql = require("mysql2/promise");

const TABLES = {
  business_carrier_accounts: {
    create: "CREATE TABLE `business_carrier_accounts` (\n" +
      "\t`id` int AUTO_INCREMENT NOT NULL,\n\t`tenantId` int NOT NULL,\n\t`businessId` int NOT NULL,\n\t`provider` varchar(30) NOT NULL,\n" +
      "\t`encryptedApiKey` text,\n\t`apiKeyLast4` varchar(4),\n\t`encryptionIv` varchar(64),\n\t`encryptionTag` varchar(64),\n" +
      "\t`apiBaseUrl` varchar(200),\n\t`apiAuthScheme` varchar(16),\n\t`pickupLocationId` varchar(100),\n\t`pickupLocationName` varchar(255),\n" +
      "\t`allowOpenPackageDefault` tinyint(1) NOT NULL DEFAULT 1,\n\t`webhookSalt` varchar(64) NOT NULL,\n\t`webhookSecretHash` varchar(128) NOT NULL,\n" +
      "\t`status` varchar(20) NOT NULL DEFAULT 'disconnected',\n\t`lastVerifiedAt` timestamp NULL,\n\t`lastError` text,\n\t`createdBy` int NOT NULL,\n\t`updatedBy` int,\n" +
      "\t`createdAt` timestamp NOT NULL DEFAULT (now()),\n\t`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,\n" +
      "\tCONSTRAINT `business_carrier_accounts_id` PRIMARY KEY(`id`),\n" +
      "\tCONSTRAINT `bca_business_provider_unique` UNIQUE(`businessId`,`provider`),\n" +
      "\tCONSTRAINT `bca_webhook_secret_hash_unique` UNIQUE(`webhookSecretHash`)\n);",
    // [name, COLUMN_TYPE, IS_NULLABLE]
    columns: [
      ["id", "int", "NO"], ["tenantId", "int", "NO"], ["businessId", "int", "NO"], ["provider", "varchar(30)", "NO"],
      ["encryptedApiKey", "text", "YES"], ["apiKeyLast4", "varchar(4)", "YES"], ["encryptionIv", "varchar(64)", "YES"], ["encryptionTag", "varchar(64)", "YES"],
      ["apiBaseUrl", "varchar(200)", "YES"], ["apiAuthScheme", "varchar(16)", "YES"], ["pickupLocationId", "varchar(100)", "YES"], ["pickupLocationName", "varchar(255)", "YES"],
      ["allowOpenPackageDefault", "tinyint(1)", "NO"], ["webhookSalt", "varchar(64)", "NO"], ["webhookSecretHash", "varchar(128)", "NO"],
      ["status", "varchar(20)", "NO"], ["lastVerifiedAt", "timestamp", "YES"], ["lastError", "text", "YES"], ["createdBy", "int", "NO"], ["updatedBy", "int", "YES"],
      ["createdAt", "timestamp", "NO"], ["updatedAt", "timestamp", "NO"],
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "bca_business_provider_unique", unique: true, columns: ["businessId", "provider"], create: "CREATE UNIQUE INDEX `bca_business_provider_unique` ON `business_carrier_accounts` (`businessId`,`provider`)" },
      { name: "bca_webhook_secret_hash_unique", unique: true, columns: ["webhookSecretHash"], create: "CREATE UNIQUE INDEX `bca_webhook_secret_hash_unique` ON `business_carrier_accounts` (`webhookSecretHash`)" },
      { name: "bca_tenant_idx", unique: false, columns: ["tenantId"], create: "CREATE INDEX `bca_tenant_idx` ON `business_carrier_accounts` (`tenantId`)" },
    ],
  },
  carrier_webhook_events: {
    create: "CREATE TABLE `carrier_webhook_events` (\n" +
      "\t`id` int AUTO_INCREMENT NOT NULL,\n\t`businessId` int NOT NULL,\n\t`provider` varchar(30) NOT NULL,\n\t`eventHash` varchar(64) NOT NULL,\n" +
      "\t`shipmentId` varchar(100),\n\t`stateCode` int,\n\t`receivedAt` timestamp NOT NULL DEFAULT (now()),\n" +
      "\tCONSTRAINT `carrier_webhook_events_id` PRIMARY KEY(`id`),\n" +
      "\tCONSTRAINT `cwe_business_provider_event_unique` UNIQUE(`businessId`,`provider`,`eventHash`)\n);",
    columns: [
      ["id", "int", "NO"], ["businessId", "int", "NO"], ["provider", "varchar(30)", "NO"], ["eventHash", "varchar(64)", "NO"],
      ["shipmentId", "varchar(100)", "YES"], ["stateCode", "int", "YES"], ["receivedAt", "timestamp", "NO"],
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "cwe_business_provider_event_unique", unique: true, columns: ["businessId", "provider", "eventHash"], create: "CREATE UNIQUE INDEX `cwe_business_provider_event_unique` ON `carrier_webhook_events` (`businessId`,`provider`,`eventHash`)" },
    ],
  },
};

async function tableExists(c, table) {
  const [r] = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?", [table]);
  return r.length > 0;
}
async function readColumns(c, table) {
  const [r] = await c.query("SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nl FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ORDINAL_POSITION", [table]);
  return r;
}
async function readIndexes(c, table) {
  const [r] = await c.query("SELECT INDEX_NAME n, NON_UNIQUE nu, COLUMN_NAME col, SEQ_IN_INDEX seq FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? ORDER BY INDEX_NAME, SEQ_IN_INDEX", [table]);
  const m = new Map();
  for (const row of r) { if (!m.has(row.n)) m.set(row.n, { unique: Number(row.nu) === 0, columns: [] }); m.get(row.n).columns.push(row.col); }
  return m;
}
/** Structural mismatches of an existing table (columns only). Empty = matches. */
async function columnMismatches(c, table, spec) {
  const have = await readColumns(c, table);
  const byName = new Map(have.map(x => [x.n, x]));
  const out = [];
  for (const [name, type, nullable] of spec.columns) {
    const h = byName.get(name);
    if (!h) { out.push(`العمود ${name} مفقود`); continue; }
    if (h.t.toLowerCase() !== type) out.push(`العمود ${name}: النوع ${h.t} بدل ${type}`);
    if (h.nl !== nullable) out.push(`العمود ${name}: NULL=${h.nl} بدل ${nullable}`);
  }
  for (const h of have) if (!spec.columns.some(([n]) => n === h.n)) out.push(`عمود غير متوقع: ${h.n}`);
  return out;
}
/** Index mismatches: returns { missing: [...specs to create], wrong: [...messages] }. */
async function indexState(c, table, spec) {
  const have = await readIndexes(c, table);
  const missing = [], wrong = [];
  for (const ix of spec.indexes) {
    const h = have.get(ix.name);
    if (!h) { if (ix.create) missing.push(ix); else wrong.push(`${table}: ${ix.name} مفقود`); continue; }
    if (h.unique !== ix.unique || h.columns.join(",") !== ix.columns.join(","))
      wrong.push(`${table}: الفهرس ${ix.name} موجود ببنية مختلفة (${h.unique ? "UNIQUE" : "غير فريد"} على ${h.columns.join(",")}) بدل (${ix.unique ? "UNIQUE" : "غير فريد"} على ${ix.columns.join(",")})`);
  }
  return { missing, wrong };
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL غير مضبوط"); process.exit(1); }
  const c = await mysql.createConnection(process.env.DATABASE_URL);
  const log = [];
  try {
    // ── المرحلة 1: فحص كل جدول منفصلًا؛ إنشاء المفقود فقط؛ بنية مختلفة = توقف ──
    for (const [table, spec] of Object.entries(TABLES)) {
      if (!(await tableExists(c, table))) {
        await c.query(spec.create);
        log.push(`✚ أُنشئ الجدول ${table}`);
      } else {
        const bad = await columnMismatches(c, table, spec);
        if (bad.length) { console.error(`✖ الجدول ${table} موجود ببنية غير مطابقة — لم يُلمس:\n  - ${bad.join("\n  - ")}`); process.exit(1); }
        log.push(`= الجدول ${table} موجود ومطابق`);
      }
      // ── المرحلة 2: كل index منفصلًا (للجدول الجديد والموجود على السواء) ──
      const { missing, wrong } = await indexState(c, table, spec);
      if (wrong.length) { console.error(`✖ فهارس غير مطابقة — لم يُلمس شيء:\n  - ${wrong.join("\n  - ")}`); process.exit(1); }
      for (const ix of missing) { await c.query(ix.create); log.push(`✚ أُنشئ الفهرس ${table}.${ix.name}`); }
    }
    // ── المرحلة 3: تحقق نهائي من الجدولين والأعمدة والقيود الفريدة الثلاثة ──
    const problems = [];
    for (const [table, spec] of Object.entries(TABLES)) {
      if (!(await tableExists(c, table))) { problems.push(`الجدول ${table} غير موجود`); continue; }
      problems.push(...(await columnMismatches(c, table, spec)).map(m => `${table}: ${m}`));
      const { missing, wrong } = await indexState(c, table, spec);
      problems.push(...wrong, ...missing.map(ix => `${table}: الفهرس ${ix.name} مفقود`));
    }
    const uniques = ["bca_business_provider_unique", "bca_webhook_secret_hash_unique", "cwe_business_provider_event_unique"];
    const bcaIx = await readIndexes(c, "business_carrier_accounts"), cweIx = await readIndexes(c, "carrier_webhook_events");
    for (const u of uniques) { const h = bcaIx.get(u) || cweIx.get(u); if (!h || !h.unique) problems.push(`القيد الفريد ${u} غير موجود`); }
    console.log(log.join("\n"));
    if (problems.length) { console.error(`✖ التحقق النهائي فشل:\n  - ${problems.join("\n  - ")}`); process.exit(1); }
    console.log("✔ 0037 مكتمل: الجدولان + كل الأعمدة + القيود الفريدة الثلاثة (" + uniques.join(", ") + ") موجودة ومطابقة");
  } finally { await c.end(); }
})().catch(e => { console.error("✖ فشل 0037:", e.message); process.exit(1); });
