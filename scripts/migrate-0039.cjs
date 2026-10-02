// Migration 0039 — carrier_webhook_inbox (idempotent, verifying). Same contract as migrate-0037/0038.
// Usage (from the app directory):  DATABASE_URL=... node scripts/migrate-0039.cjs
// The table and each index are checked separately; only what is missing is created; an existing
// table whose structure differs is a hard error (exit 1) — never "success".
const mysql = require("mysql2/promise");

const TABLES = {
  carrier_webhook_inbox: {
    create: "CREATE TABLE `carrier_webhook_inbox` (\n" +
      "\t`id` int AUTO_INCREMENT NOT NULL,\n\t`tenantId` int,\n\t`businessId` int,\n\t`provider` varchar(30) NOT NULL,\n" +
      "\t`shipmentId` varchar(100),\n\t`trackingNumber` varchar(100),\n\t`eventKey` varchar(64) NOT NULL,\n\t`stateCode` int,\n" +
      "\t`eventType` varchar(40),\n\t`eventTimestamp` bigint,\n\t`orderId` int,\n\t`processingStatus` varchar(16) NOT NULL DEFAULT 'received',\n" +
      "\t`failureReason` text,\n\t`payloadJson` mediumtext NOT NULL,\n\t`attempts` int NOT NULL DEFAULT 1,\n\t`duplicateCount` int NOT NULL DEFAULT 0,\n" +
      "\t`receivedAt` timestamp NOT NULL DEFAULT (now()),\n\t`processedAt` timestamp NULL,\n" +
      "\tCONSTRAINT `carrier_webhook_inbox_id` PRIMARY KEY(`id`),\n" +
      "\tCONSTRAINT `cwi_business_provider_event_unique` UNIQUE(`businessId`,`provider`,`eventKey`)\n);",
    columns: [
      ["id", "int", "NO"], ["tenantId", "int", "YES"], ["businessId", "int", "YES"], ["provider", "varchar(30)", "NO"],
      ["shipmentId", "varchar(100)", "YES"], ["trackingNumber", "varchar(100)", "YES"], ["eventKey", "varchar(64)", "NO"], ["stateCode", "int", "YES"],
      ["eventType", "varchar(40)", "YES"], ["eventTimestamp", "bigint", "YES"], ["orderId", "int", "YES"], ["processingStatus", "varchar(16)", "NO"],
      ["failureReason", "text", "YES"], ["payloadJson", "mediumtext", "NO"], ["attempts", "int", "NO"], ["duplicateCount", "int", "NO"],
      ["receivedAt", "timestamp", "NO"], ["processedAt", "timestamp", "YES"],
    ],
    indexes: [
      { name: "PRIMARY", unique: true, columns: ["id"] },
      { name: "cwi_business_provider_event_unique", unique: true, columns: ["businessId", "provider", "eventKey"], create: "CREATE UNIQUE INDEX `cwi_business_provider_event_unique` ON `carrier_webhook_inbox` (`businessId`,`provider`,`eventKey`)" },
      { name: "cwi_business_status_idx", unique: false, columns: ["businessId", "processingStatus"], create: "CREATE INDEX `cwi_business_status_idx` ON `carrier_webhook_inbox` (`businessId`,`processingStatus`)" },
      { name: "cwi_shipment_idx", unique: false, columns: ["shipmentId"], create: "CREATE INDEX `cwi_shipment_idx` ON `carrier_webhook_inbox` (`shipmentId`)" },
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
    const required = ["cwi_business_provider_event_unique", "cwi_business_status_idx", "cwi_shipment_idx"];
    const ix = await readIndexes(c, "carrier_webhook_inbox");
    for (const r of required) if (!ix.get(r)) problems.push(`الفهرس ${r} غير موجود`);
    console.log(log.join("\n"));
    if (problems.length) { console.error(`✖ التحقق النهائي فشل:\n  - ${problems.join("\n  - ")}`); process.exit(1); }
    console.log("✔ 0039 مكتمل: carrier_webhook_inbox + كل الأعمدة (18) + الفهارس (" + required.join(", ") + ") موجودة ومطابقة");
  } finally { await c.end(); }
})().catch(e => { console.error("✖ فشل 0039:", e.message); process.exit(1); });
