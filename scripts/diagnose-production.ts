/**
 * فحص تشخيصي لقاعدة البيانات — للقراءة فقط.
 *
 * الغرض: الإجابة على "ليه الأوردرات اختفت؟" بالأرقام بدل التخمين، من غير أي خطر.
 *
 * ⚠️ ضمانات السلامة — السكربت ده:
 *   • بينفّذ SELECT و SHOW و DESCRIBE فقط
 *   • مافيهوش ولا عبارة INSERT / UPDATE / DELETE / ALTER / DROP / CREATE
 *   • مافيهوش أي كتابة على القرص
 *   • بيفتح الاتصال بصلاحية القراءة اللي في DATABASE_URL ويقفله
 *   • مابيطبعش أي بيانات عميل (أسماء/تليفونات/عناوين) — أعداد وأسماء أعمدة بس
 *   • مابيطبعش قيم أسرار البيئة — بيقول "مضبوط / غير مضبوط" بس
 *
 * التشغيل:
 *   DATABASE_URL="..." node --import tsx scripts/diagnose-production.ts
 */
import mysql from "mysql2/promise";

const RESET = "\x1b[0m", BOLD = "\x1b[1m";
const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m";

const ok = (s: string) => `${GREEN}✅ ${s}${RESET}`;
const bad = (s: string) => `${RED}❌ ${s}${RESET}`;
const warn = (s: string) => `${YELLOW}⚠️  ${s}${RESET}`;
const head = (s: string) => `\n${BOLD}${CYAN}${s}${RESET}\n${"─".repeat(60)}`;

/** الأعمدة اللي migration 0032 بتضيفها على orders — غيابها هو سبب اختفاء الأوردرات. */
const ORDERS_0032_COLUMNS = ["collectedAmount", "collectedAt", "collectionStatus"];

/** جداول 0032 (الحسابات) و 0033 (الرواتب). */
const TABLES_0032 = ["treasury_transactions", "expenses", "expense_categories"];
const TABLES_0033 = [
  "payroll_settings", "employee_salary_profiles",
  "payroll_periods", "payroll_items", "employee_advances",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(bad("DATABASE_URL غير مضبوط — شغّل السكربت بمتغيّر الاتصال"));
    process.exit(1);
  }

  const conn = await mysql.createConnection(url);
  const dbName = (await conn.query("SELECT DATABASE() AS d") as any)[0][0].d;
  console.log(`${BOLD}فحص قاعدة البيانات: ${dbName}${RESET}`);
  console.log(`الوقت: ${new Date().toLocaleString("ar-EG")}`);

  let problems = 0;

  // ---------- ١. الأعمدة الناقصة على orders ----------
  console.log(head("١. أعمدة جدول orders (سبب اختفاء الأوردرات)"));
  const [orderCols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders'`, [dbName],
  ) as any;
  const present = new Set(orderCols.map((r: any) => r.COLUMN_NAME));
  console.log(`إجمالي أعمدة orders: ${present.size}`);
  for (const col of ORDERS_0032_COLUMNS) {
    if (present.has(col)) console.log("  " + ok(`orders.${col} موجود`));
    else { console.log("  " + bad(`orders.${col} مفقود  ← ده اللي بيوقّف كل استعلامات الأوردرات`)); problems++; }
  }

  // ---------- ٢. الجداول ----------
  console.log(head("٢. جداول الحسابات والرواتب"));
  const [tableRows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`, [dbName],
  ) as any;
  const tables = new Set(tableRows.map((r: any) => r.TABLE_NAME));
  console.log(`إجمالي الجداول: ${tables.size}`);
  for (const [label, list] of [["0032 (الحسابات)", TABLES_0032], ["0033 (الرواتب)", TABLES_0033]] as const) {
    const missing = list.filter(t => !tables.has(t));
    if (missing.length === 0) console.log("  " + ok(`${label} — كل الجداول موجودة`));
    else { console.log("  " + bad(`${label} — ناقص: ${missing.join(", ")}`)); problems++; }
  }

  // ---------- ٣. أعداد البيانات ----------
  console.log(head("٣. أعداد البيانات (تأكيد عدم فقد أي شيء)"));
  const counts: Record<string, number> = {};
  for (const t of ["orders", "order_items", "products", "product_variants",
    "employees", "businesses", "tenants", "returns", "inventory_movements"]) {
    if (!tables.has(t)) { console.log(`  ${t.padEnd(22)} — الجدول غير موجود`); continue; }
    const [r] = await conn.query(`SELECT COUNT(*) AS c FROM \`${t}\``) as any;
    counts[t] = Number(r[0].c);
    console.log(`  ${t.padEnd(22)} ${String(counts[t]).padStart(8)}`);
  }

  // ---------- ٤. سلامة الأوردرات ----------
  console.log(head("٤. سلامة جدول الأوردرات"));
  const [statusRows] = await conn.query(
    `SELECT status, COUNT(*) AS c FROM orders GROUP BY status ORDER BY c DESC`,
  ) as any;
  console.log("  التوزيع حسب الحالة:");
  for (const r of statusRows) console.log(`    ${String(r.status).padEnd(12)} ${String(r.c).padStart(6)}`);

  const [range] = await conn.query(
    `SELECT MIN(id) AS minId, MAX(id) AS maxId,
            MIN(createdAt) AS oldest, MAX(createdAt) AS newest,
            COUNT(DISTINCT orderNumber) AS uniqueNumbers, COUNT(*) AS total
     FROM orders`,
  ) as any;
  const r0 = range[0];
  console.log(`\n  نطاق الـid:        ${r0.minId} → ${r0.maxId}`);
  console.log(`  أقدم أوردر:        ${r0.oldest}`);
  console.log(`  أحدث أوردر:        ${r0.newest}`);
  console.log(`  أرقام أوردر فريدة: ${r0.uniqueNumbers} من ${r0.total}`);
  if (Number(r0.uniqueNumbers) !== Number(r0.total)) {
    console.log("  " + warn("فيه أرقام أوردر مكررة"));
    problems++;
  } else console.log("  " + ok("مافيش أرقام أوردر مكررة"));

  // أوردرات بلا نشاط = غير مرئية في الواجهة لأن الفلترة بالنشاط
  const [orphans] = await conn.query(
    `SELECT COUNT(*) AS c FROM orders o
     LEFT JOIN businesses b ON o.businessId = b.id WHERE b.id IS NULL`,
  ) as any;
  if (Number(orphans[0].c) > 0) {
    console.log("  " + bad(`${orphans[0].c} أوردر مربوط بنشاط غير موجود ← مش هيظهر في الواجهة`));
    problems++;
  } else console.log("  " + ok("كل الأوردرات مربوطة بنشاط موجود"));

  // ---------- ٥. عزل الـtenant ----------
  console.log(head("٥. ربط الأنشطة بالتاجر (tenant)"));
  if (tables.has("businesses")) {
    const [biz] = await conn.query(
      `SELECT id, name, tenantId, isActive FROM businesses ORDER BY id`,
    ) as any;
    for (const b of biz) {
      const t = b.tenantId == null ? `${RED}NULL${RESET}` : String(b.tenantId);
      console.log(`  نشاط #${b.id} ${String(b.name).padEnd(20)} tenantId=${t} نشط=${b.isActive ? "نعم" : "لا"}`);
      if (b.tenantId == null) problems++;
    }
    const nullTenants = biz.filter((b: any) => b.tenantId == null).length;
    if (nullTenants > 0) {
      console.log("  " + bad(`${nullTenants} نشاط بلا tenantId ← أوردراته مش هتظهر لأي مستخدم`));
    } else console.log("  " + ok("كل الأنشطة مربوطة بتاجر"));
  }

  // ---------- ٦. سجل الـmigrations ----------
  console.log(head("٦. سجل الـmigrations المطبَّقة"));
  const [mig] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE '%drizzle%'`, [dbName],
  ) as any;
  if (mig.length === 0) {
    console.log("  " + warn("مافيش جدول سجل migrations (drizzle) — يعني migrate ماشتغلش هنا أبدًا"));
  } else {
    const [applied] = await conn.query(
      "SELECT COUNT(*) AS c FROM `__drizzle_migrations`",
    ).catch(() => [[{ c: "?" }]]) as any;
    console.log(`  عدد الـmigrations المطبَّقة: ${applied[0].c}`);
    console.log("  (المتوقع بعد الإصلاح: 34)");
  }

  // ---------- ٧. متغيّرات البيئة ----------
  console.log(head("٧. متغيّرات البيئة (بدون طباعة أي قيمة)"));
  const envVars = [
    ["DATABASE_URL", true], ["JWT_SECRET", true],
    ["BOSTA_API_KEY", false], ["BOSTA_WEBHOOK_SECRET", false],
    ["BOSTA_PICKUP_ADDRESS_ID", false], ["BOSTA_BASE_URL", false],
  ] as const;
  for (const [name, required] of envVars) {
    const set = Boolean(process.env[name]);
    if (set) console.log("  " + ok(`${name} مضبوط`));
    else if (required) { console.log("  " + bad(`${name} غير مضبوط`)); problems++; }
    else console.log("  " + warn(`${name} غير مضبوط — الميزة المرتبطة به معطّلة`));
  }
  if (!process.env.BOSTA_WEBHOOK_SECRET) {
    console.log("  " + warn("بدون BOSTA_WEBHOOK_SECRET كل webhooks بوسطة بتترفض بـ503 وحالات الشحن مش بتتحدّث"));
  }

  // ---------- الخلاصة ----------
  console.log(head("الخلاصة"));
  if (problems === 0) {
    console.log(ok("مافيش مشاكل — قاعدة البيانات مكتملة"));
  } else {
    console.log(bad(`${problems} مشكلة محتاجة إصلاح — راجع البنود المعلّمة بـ❌ فوق`));
  }
  console.log(`\n${BOLD}عدد الأوردرات الحالي: ${counts.orders ?? "غير معروف"}${RESET}`);
  console.log("(احتفظ بالرقم ده — هنقارن بيه بعد الإصلاح)\n");

  await conn.end();
}

main().catch((e) => {
  console.error(bad(`فشل الفحص: ${e?.message ?? e}`));
  process.exit(1);
});
