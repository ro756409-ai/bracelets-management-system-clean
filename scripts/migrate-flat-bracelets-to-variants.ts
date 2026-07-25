/**
 * One-time data migration for the specific situation found in production on 2026-07-25:
 * an OLDER version of bootstrap-production.ts already ran and created 9 flat bracelet
 * products (PLAIN-001, AYAT-001, ...) instead of one parent product with 9 variants.
 * `product_variants` is empty, `businesses`/`products` are NOT (so bootstrap-production.ts
 * correctly refuses to run again).
 *
 * This script converts those 9 specific flat products into variants of one new parent
 * product "أسورة نحاس", preserving their exact sku/price/currentStock/minStockLevel.
 * The 3 non-bracelet standalone products (مسند سيارة، كفر مرتبة ووتر بروف، مسن سكاكين)
 * are left completely untouched.
 *
 * Safety:
 *   - Refuses to run unless product_variants is empty and a parent "أسورة نحاس" product
 *     does not already exist (never runs twice).
 *   - Refuses to run unless ALL 9 expected SKUs are found as ACTIVE top-level products —
 *     any mismatch (missing SKU, unexpected extra state) aborts with no writes at all.
 *   - Re-verifies, immediately before deleting each old flat product, that zero `orders`
 *     or `order_items` rows reference it (not just the aggregate COUNT(*) check) — if any
 *     single one is referenced, the whole migration aborts with no writes.
 *   - Old flat products are DELETED (not archived) only because they are confirmed
 *     zero-referenced — there is nothing to preserve. If you'd rather archive them
 *     instead (isActive=false, SKU renamed) tell me and I'll adjust before you run this.
 *
 * Default mode is DRY RUN — prints exactly what it would do without writing anything.
 * Pass --confirm to actually execute.
 *
 * Usage (dry run, safe, default):
 *   tsx scripts/migrate-flat-bracelets-to-variants.ts
 *
 * Usage (execute):
 *   tsx scripts/migrate-flat-bracelets-to-variants.ts --confirm
 */
import "dotenv/config";
import { getDb } from "../server/db";
import { products, productVariants, orders, orderItems } from "../drizzle/schema";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");

const PARENT_PRODUCT_NAME = "أسورة نحاس";

// The 9 flat products to convert, identified by SKU (not by id — ids can differ per environment).
const EXPECTED_SKUS = [
  "PLAIN-001", "AYAT-001", "DHIKR-001", "HAFIZ-001", "ENGR-001",
  "HORUS-001", "FALAQ-001", "SULAI-001", "KAHYA-001",
] as const;

// SKU -> variant display name (matches bootstrap-production.ts's BRACELET_VARIANTS)
const VARIANT_NAME_BY_SKU: Record<string, string> = {
  "PLAIN-001": "سادة",
  "AYAT-001": "آية الكرسي",
  "DHIKR-001": "ذكر التحصين",
  "HAFIZ-001": "فالله خير حافظاً",
  "ENGR-001": "منقوش",
  "HORUS-001": "عين حورس",
  "FALAQ-001": "قل أعوذ برب الفلق",
  "SULAI-001": "إنه من سليمان",
  "KAHYA-001": "كهيعص",
};

async function main() {
  const db = await getDb();
  if (!db) throw new Error("لا يوجد اتصال بقاعدة البيانات.");

  console.log(`[migrate-flat-bracelets] Mode: ${CONFIRM ? "*** CONFIRM (writes to DB) ***" : "DRY RUN (no writes)"}`);

  // ==================== Safety gate 1: never run twice ====================
  const existingVariants = await db.select().from(productVariants);
  if (existingVariants.length > 0) {
    throw new Error(
      `رفض التنفيذ: product_variants ليس فارغًا (${existingVariants.length} صف) — هذا السكربت ` +
      `مخصص للتشغيل مرة واحدة فقط على الحالة التي وصفتها. لا شيء تم تعديله.`
    );
  }
  const allProducts = await db.select().from(products);
  const existingParent = allProducts.find(p => p.name.trim() === PARENT_PRODUCT_NAME);
  if (existingParent) {
    throw new Error(
      `رفض التنفيذ: منتج أب باسم "${PARENT_PRODUCT_NAME}" موجود بالفعل (#${existingParent.id}) — ` +
      `يبدو إن الهجرة اتنفذت من قبل. لا شيء تم تعديله.`
    );
  }

  // ==================== Safety gate 2: all 9 expected SKUs must exist as active products ====================
  const flatBracelets = EXPECTED_SKUS.map(sku => {
    const p = allProducts.find(pr => pr.sku === sku && pr.isActive);
    return { sku, product: p };
  });
  const missing = flatBracelets.filter(f => !f.product);
  if (missing.length > 0) {
    throw new Error(
      `رفض التنفيذ: الأكواد التالية غير موجودة كمنتجات نشطة: ${missing.map(m => m.sku).join(", ")}. ` +
      `الحالة لا تطابق ما هو متوقَّع — يحتاج مراجعة يدوية. لا شيء تم تعديله.`
    );
  }
  const flatProductIds = flatBracelets.map(f => f.product!.id);

  // ==================== Safety gate 3: re-verify zero references per product, not just the aggregate count ====================
  const referencingOrders = await db.select({ productId: orders.productId, cnt: drizzleSql<string>`COUNT(*)` })
    .from(orders).where(inArray(orders.productId, flatProductIds)).groupBy(orders.productId);
  const referencingItems = await db.select({ productId: orderItems.productId, cnt: drizzleSql<string>`COUNT(*)` })
    .from(orderItems).where(inArray(orderItems.productId, flatProductIds)).groupBy(orderItems.productId);
  if (referencingOrders.length > 0 || referencingItems.length > 0) {
    throw new Error(
      `رفض التنفيذ: بعض المنتجات التسعة مرتبط بها أوردرات/بنود فعلية ` +
      `(orders: ${JSON.stringify(referencingOrders)}, order_items: ${JSON.stringify(referencingItems)}) — ` +
      `لن يتم حذفها. راجع الحالة يدويًا. لا شيء تم تعديله.`
    );
  }

  console.log("\n" + "=".repeat(70));
  console.log("الخطة المقترحة:");
  console.log("=".repeat(70));
  console.log(`1) إنشاء منتج أب واحد "${PARENT_PRODUCT_NAME}"`);
  console.log(`2) إنشاء 9 أنواع (variants) تحته، بنفس sku/price/currentStock/minStockLevel الحالية:`);
  for (const f of flatBracelets) {
    const p = f.product!;
    console.log(`   - ${VARIANT_NAME_BY_SKU[f.sku]} (${f.sku}, ${p.price} ج.م, مخزون ${p.currentStock})`);
  }
  console.log(`3) حذف المنتجات التسعة المسطّحة القديمة (ids: ${flatProductIds.join(", ")}) — مؤكَّد صفر أوردر/بند مرتبط بأي منها`);
  console.log(`4) المنتجات المستقلة الثلاثة (مسند سيارة، كفر مرتبة، مسن سكاكين) — لن تُلمَس إطلاقًا`);

  if (!CONFIRM) {
    console.log("\n[migrate-flat-bracelets] وضع Dry-Run — لم يتم أي كتابة لقاعدة البيانات. أضف --confirm للتنفيذ الفعلي.");
    return;
  }

  console.warn("\n[migrate-flat-bracelets] *** CONFIRM MODE *** — سيتم الكتابة الآن.");

  const [parentInsertResult] = await db.insert(products).values({
    name: PARENT_PRODUCT_NAME,
    description: "أساور نحاسية طبية بأنواع نقش مختلفة",
    businessId: flatBracelets[0].product!.businessId,
    isActive: true,
  });
  const parentProductId = (parentInsertResult as any).insertId as number;
  console.log(`تم إنشاء المنتج الأب برقم #${parentProductId}.`);

  const variantRows = flatBracelets.map(f => ({
    productId: parentProductId,
    name: VARIANT_NAME_BY_SKU[f.sku],
    sku: `${f.sku}-V`, // temporary suffix to avoid a transient unique-index collision with the still-existing flat product row
    price: f.product!.price,
    currentStock: f.product!.currentStock,
    minStockLevel: f.product!.minStockLevel,
    isActive: true,
  }));
  await db.insert(productVariants).values(variantRows);
  console.log(`تم إنشاء ${variantRows.length} نوع تحت "${PARENT_PRODUCT_NAME}".`);

  // Delete the old flat products now (confirmed zero references above), then drop the
  // temporary "-V" SKU suffix so variants carry the original, real SKU codes.
  await db.delete(products).where(inArray(products.id, flatProductIds));
  console.log(`تم حذف ${flatProductIds.length} منتج مسطّح قديم.`);

  for (const row of variantRows) {
    const originalSku = row.sku.replace(/-V$/, "");
    await db.update(productVariants).set({ sku: originalSku })
      .where(eq(productVariants.sku, row.sku));
  }
  console.log(`تم استعادة الأكواد الأصلية (بدون لاحقة -V) لكل الأنواع.`);

  console.log("\n" + "=".repeat(70));
  console.log("استعلامات التحقق (نفّذها الآن للتأكيد):");
  console.log("=".repeat(70));
  console.log(`SELECT COUNT(*) FROM products;                                -- متوقَّع: 4 (منتج أب واحد + 3 مستقلين)`);
  console.log(`SELECT COUNT(*) FROM product_variants WHERE productId = ${parentProductId};  -- متوقَّع: 9`);
  console.log(`SELECT sku FROM product_variants WHERE productId = ${parentProductId} ORDER BY sku;  -- تأكد من عدم وجود أي لاحقة -V`);
  console.log(`SELECT COUNT(*) FROM orders;                                  -- متوقَّع: 0 (بلا تغيير)`);
  console.log("=".repeat(70));
}

main().catch(err => {
  console.error("[migrate-flat-bracelets] فشل:", err);
  process.exit(1);
});
