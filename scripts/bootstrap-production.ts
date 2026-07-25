/**
 * One-time production bootstrap — for the specific situation where `businesses` and
 * `products` are completely empty but `employees` already has a real owner account.
 * This is why the legacy-orders importer's commit mode silently skipped every single
 * order (product matching against an empty catalog can never succeed) while still
 * reporting the batch as "completed" — a bug now fixed separately in
 * import-legacy-orders.ts / import-orders-csv.ts (strict post-import DB verification).
 *
 * This script is intentionally narrow and refuses to run against a database that
 * already has ANY business or product rows — it is a bootstrap for an empty state,
 * not a general-purpose fixup tool for a partially-seeded one. It never deletes or
 * overwrites anything; every write is either an INSERT into an empty table or a
 * narrowly-scoped UPDATE of exactly one row identified by its id.
 *
 * Default mode is DRY RUN — prints exactly what it would do without writing anything.
 * Pass --confirm to actually execute.
 *
 * Usage (dry run, safe, default):
 *   tsx scripts/bootstrap-production.ts --owner-employee-id=1 --void-batch-id=1
 *
 * Usage (execute):
 *   tsx scripts/bootstrap-production.ts --owner-employee-id=1 --void-batch-id=1 --confirm
 *
 * Optional overrides:
 *   --business-name "اسم العمل"     (default: "متجرك - الأساور النحاسية")
 *   --business-slug "slug"          (default: "bracelets")
 */
import "dotenv/config";
import { getDb } from "../server/db";
import { businesses, employees, products, importBatches, orders } from "../drizzle/schema";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { isAdminTierRole } from "../server/permissions";

const args = process.argv.slice(2);
function argValue(name: string, def?: string): string | undefined {
  const withEq = args.find(a => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split("=").slice(1).join("=");
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return def;
}
const CONFIRM = args.includes("--confirm");
const BUSINESS_NAME = argValue("business-name", "متجرك - الأساور النحاسية")!;
const BUSINESS_SLUG = argValue("business-slug", "bracelets")!;
const OWNER_EMPLOYEE_ID = argValue("owner-employee-id");
const VOID_BATCH_ID = argValue("void-batch-id");

// Product catalog to bootstrap: the 9 items already defined in seedInitialData() (server/db.ts)
// plus the 3 additional real product lines confirmed present in the legacy XLSX but absent
// from that seed list (found via frequency analysis of all 7247 reconstructed legacy orders).
// Prices for the 3 new lines are the AVERAGE historical unit price (total ÷ quantity) observed
// across their own matching legacy orders — a data-grounded starting point, not a verified
// retail price. Review and adjust before relying on them for new sales.
const PRODUCT_CATALOG: { name: string; sku: string; price: string; currentStock: number; minStockLevel: number }[] = [
  // Existing seedInitialData() set — unchanged names/skus/prices, kept identical for consistency.
  { name: "أسورة سادة", sku: "PLAIN-001", price: "150.00", currentStock: 100, minStockLevel: 20 },
  { name: "آية الكرسي", sku: "AYAT-001", price: "180.00", currentStock: 80, minStockLevel: 15 },
  { name: "ذكر التحصين", sku: "DHIKR-001", price: "175.00", currentStock: 60, minStockLevel: 15 },
  { name: "فالله خير حافظاً", sku: "HAFIZ-001", price: "185.00", currentStock: 70, minStockLevel: 15 },
  { name: "منقوش", sku: "ENGR-001", price: "200.00", currentStock: 50, minStockLevel: 10 },
  { name: "عين حورس", sku: "HORUS-001", price: "160.00", currentStock: 90, minStockLevel: 20 },
  { name: "قل أعوذ برب الفلق", sku: "FALAQ-001", price: "180.00", currentStock: 65, minStockLevel: 15 },
  { name: "أسورة إنه من سليمان", sku: "SULAI-001", price: "185.00", currentStock: 50, minStockLevel: 15 },
  { name: "أسورة كهيعص", sku: "KAHYA-001", price: "185.00", currentStock: 50, minStockLevel: 15 },
  // New — confirmed real, non-bracelet product lines found in the legacy file (2026-07-25 analysis).
  // Prices below are historical averages (n=430/78/20 matching legacy orders respectively) — NOT
  // vetted retail prices. currentStock intentionally set to 0 (unknown real stock) pending review.
  { name: "مسند سيارة 5 في 1 متعدد الوظائف", sku: "CARMNT-001", price: "472.51", currentStock: 0, minStockLevel: 10 },
  { name: "كفر مرتبة ووتر بروف", sku: "MATCVR-001", price: "297.10", currentStock: 0, minStockLevel: 10 },
  { name: "مسن سكاكين", sku: "KNFSHRP-001", price: "267.65", currentStock: 0, minStockLevel: 10 },
];

async function main() {
  if (!OWNER_EMPLOYEE_ID) throw new Error("--owner-employee-id مطلوب.");

  const db = await getDb();
  if (!db) throw new Error("لا يوجد اتصال بقاعدة البيانات.");

  console.log(`[bootstrap] Mode: ${CONFIRM ? "*** CONFIRM (writes to DB) ***" : "DRY RUN (no writes)"}`);

  // ==================== Safety gate: refuse unless businesses AND products are both empty ====================
  const existingBusinesses = await db.select().from(businesses);
  const existingProducts = await db.select().from(products);
  if (existingBusinesses.length > 0 || existingProducts.length > 0) {
    throw new Error(
      `رفض التنفيذ: هذا السكربت مخصص فقط لحالة قاعدة بيانات فارغة تمامًا من businesses/products. ` +
      `الحالي: businesses=${existingBusinesses.length}, products=${existingProducts.length}. ` +
      `لا شيء تم تعديله — هذه الحالة تحتاج مراجعة يدوية منفصلة، لا bootstrap تلقائي.`
    );
  }

  const [owner] = await db.select().from(employees).where(eq(employees.id, Number(OWNER_EMPLOYEE_ID))).limit(1);
  if (!owner) throw new Error(`لا يوجد موظف بالرقم ${OWNER_EMPLOYEE_ID}.`);
  if (!isAdminTierRole(owner.role)) {
    throw new Error(`الموظف رقم ${OWNER_EMPLOYEE_ID} (${owner.name}, دور: ${owner.role}) ليس مسؤولًا إداريًا — لن يُربط تلقائيًا.`);
  }

  let voidBatch: typeof importBatches.$inferSelect | undefined;
  let voidBatchOrderCount = 0;
  if (VOID_BATCH_ID) {
    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, Number(VOID_BATCH_ID))).limit(1);
    if (!batch) throw new Error(`لا توجد دفعة استيراد بالرقم ${VOID_BATCH_ID}.`);
    const [cntRow] = await db.select({ cnt: drizzleSql<string>`COUNT(*)` }).from(orders).where(eq(orders.importBatchId, batch.id));
    voidBatchOrderCount = Number(cntRow?.cnt ?? 0);
    if (voidBatchOrderCount > 0) {
      throw new Error(
        `رفض التنفيذ: دفعة #${batch.id} مرتبط بها ${voidBatchOrderCount} أوردر فعلي في orders — ` +
        `هذا السكربت لا يلمس أي دفعة بها بيانات حقيقية. لا شيء تم تعديله.`
      );
    }
    voidBatch = batch;
  }

  console.log("\n" + "=".repeat(70));
  console.log("الخطة المقترحة:");
  console.log("=".repeat(70));
  console.log(`1) إنشاء عمل واحد: name="${BUSINESS_NAME}", slug="${BUSINESS_SLUG}", isActive=true`);
  console.log(`2) ربط الموظف #${OWNER_EMPLOYEE_ID} (${owner.name}, ${owner.role}) بهذا العمل عبر UPDATE employees.businessId`);
  console.log(`3) إنشاء ${PRODUCT_CATALOG.length} منتج (9 من الكتالوج القياسي + 3 مؤكَّدة من الملف القديم)`);
  if (voidBatch) {
    console.log(`4) تعليم دفعة الاستيراد #${voidBatch.id} (حالتها الحالية: "${voidBatch.status}", ${voidBatchOrderCount} أوردر مرتبط) كـ "failed"`);
  } else {
    console.log(`4) (لم يُطلب --void-batch-id — لن تُعدَّل أي دفعة استيراد)`);
  }

  if (!CONFIRM) {
    console.log("\n[bootstrap] وضع Dry-Run — لم يتم أي كتابة لقاعدة البيانات. أضف --confirm للتنفيذ الفعلي.");
    return;
  }

  console.warn("\n[bootstrap] *** CONFIRM MODE *** — سيتم الكتابة الآن.");

  const [businessInsertResult] = await db.insert(businesses).values({
    name: BUSINESS_NAME,
    slug: BUSINESS_SLUG,
    isActive: true,
  });
  const businessId = (businessInsertResult as any).insertId as number;
  console.log(`تم إنشاء العمل برقم #${businessId}.`);

  await db.update(employees).set({ businessId }).where(eq(employees.id, Number(OWNER_EMPLOYEE_ID)));
  console.log(`تم ربط الموظف #${OWNER_EMPLOYEE_ID} بالعمل #${businessId}.`);

  const productRows = PRODUCT_CATALOG.map(p => ({ ...p, businessId, isActive: true }));
  await db.insert(products).values(productRows);
  console.log(`تم إنشاء ${productRows.length} منتج تحت العمل #${businessId}.`);

  if (voidBatch) {
    await db.update(importBatches).set({
      status: "failed",
      errorSummary: `دفعة فارغة بسبب باگ سابق في تحديد حالة النجاح (أُصلح في السكربت لاحقًا) — لا يوجد أي أوردر حقيقي مرتبط بها. عُلِّمت "failed" يدويًا بواسطة bootstrap-production.ts.`,
    }).where(eq(importBatches.id, voidBatch.id));
    console.log(`تم تعليم دفعة #${voidBatch.id} كـ "failed".`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("استعلامات التحقق (نفّذها الآن للتأكيد):");
  console.log("=".repeat(70));
  console.log(`SELECT COUNT(*) FROM businesses;              -- متوقَّع: 1`);
  console.log(`SELECT id, name, businessId FROM employees WHERE id = ${OWNER_EMPLOYEE_ID};  -- متوقَّع businessId=${businessId}`);
  console.log(`SELECT COUNT(*) FROM products WHERE businessId = ${businessId};  -- متوقَّع: ${PRODUCT_CATALOG.length}`);
  console.log(`SELECT COUNT(*) FROM orders;                   -- متوقَّع: 0 (لم يُشغَّل أي استيراد بعد)`);
  console.log(`SELECT COUNT(*) FROM order_items;              -- متوقَّع: 0`);
  if (voidBatch) console.log(`SELECT id, status FROM import_batches WHERE id = ${voidBatch.id};  -- متوقَّع status='failed'`);
  console.log("=".repeat(70));
}

main().catch(err => {
  console.error("[bootstrap] فشل:", err);
  process.exit(1);
});
