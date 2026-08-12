/**
 * تدقيق أسماء بنود الأوردرات القديمة — **قراءة فقط**.
 *
 * السكربت ده **مابيكتبش ولا حرف**. مفيش `insert` ولا `update` ولا `delete` ولا
 * `transaction` في الملف كله، وفيه اختبار بيقفل ده. تقدر تشغّله على الإنتاج وإنت مطمّن.
 *
 *   corepack pnpm tsx scripts/auditLegacyItemNames.ts
 *   corepack pnpm tsx scripts/auditLegacyItemNames.ts --business 7
 *   corepack pnpm tsx scripts/auditLegacyItemNames.ts --examples 20
 *
 * بيدوّر على الصف اللي نوع الحفر متلزّق جوه اسمه:
 *
 *     productName = "أسورة نحاس - ذكر التحصين"   ← الاسم فيه النوع
 *     variantId   = <أي نوع>                      ← والنوع متسجّل هنا كمان
 *
 * التصنيف نفسه في `shared/legacyItemNames.ts` ومُختبَر هناك. هنا بنجيب الصفوف بس
 * ونعرض النتيجة.
 */

import { eq, inArray } from "drizzle-orm";
import { orderItems, orders, productVariants, products } from "../drizzle/schema";
import {
  classifyItemName,
  summariseVerdicts,
  type ItemNameVerdict,
} from "../shared/legacyItemNames";
import { getDb } from "../server/db";

type Row = {
  itemId: number;
  orderId: number;
  orderNumber: string | null;
  productId: number | null;
  variantId: number | null;
  currentName: string;
  canonicalName: string | null;
  variantName: string | null;
  verdict: ItemNameVerdict;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

export async function auditLegacyItemNames(businessId?: number): Promise<Row[]> {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات مش متاحة — لازم DATABASE_URL");

  // البنود ومعاها رقم الأوردر، عشان التقرير يبقى قابل للمراجعة على الشاشة.
  const base = db
    .select({
      itemId: orderItems.id,
      orderId: orderItems.orderId,
      orderNumber: orders.orderNumber,
      businessId: orders.businessId,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      currentName: orderItems.productName,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id));
  const items = businessId
    ? await base.where(eq(orders.businessId, businessId))
    : await base;
  if (items.length === 0) return [];

  const productIds = [
    ...new Set(items.map(i => i.productId).filter((id): id is number => id != null)),
  ];
  const catalog = productIds.length
    ? await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(inArray(products.id, productIds))
    : [];
  const productName = new Map(catalog.map(p => [p.id, p.name]));

  // كل أنواع المنتجات اللي ظهرت — الإثبات بيتعمل عليها، مش على نوع الصف بس.
  const variants = productIds.length
    ? await db
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          name: productVariants.name,
        })
        .from(productVariants)
        .where(inArray(productVariants.productId, productIds))
    : [];
  const variantsByProduct = new Map<number, string[]>();
  const variantNameById = new Map<number, string | null>();
  for (const variant of variants) {
    variantNameById.set(variant.id, variant.name ?? null);
    const bucket = variantsByProduct.get(variant.productId) ?? [];
    if (variant.name) bucket.push(variant.name);
    variantsByProduct.set(variant.productId, bucket);
  }

  return items.map(item => {
    const canonicalName = item.productId != null ? (productName.get(item.productId) ?? null) : null;
    const verdict = classifyItemName({
      currentName: item.currentName ?? "",
      canonicalProductName: canonicalName,
      hasProductId: item.productId != null,
      productVariantNames:
        item.productId != null ? (variantsByProduct.get(item.productId) ?? []) : [],
    });
    return {
      itemId: item.itemId,
      orderId: item.orderId,
      orderNumber: item.orderNumber,
      productId: item.productId,
      variantId: item.variantId,
      currentName: item.currentName ?? "",
      canonicalName,
      variantName: item.variantId != null ? (variantNameById.get(item.variantId) ?? null) : null,
      verdict,
    };
  });
}

function printReport(rows: Row[], exampleLimit: number) {
  const counts = summariseVerdicts(rows.map(r => r.verdict));

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  تدقيق أسماء بنود الأوردرات — قراءة فقط، مفيش أي كتابة");
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`  إجمالي البنود        : ${counts.total}`);
  console.log(`  سليمة                : ${counts.clean}`);
  console.log(`  تنفع تتصلّح (SAFE)   : ${counts.safe}`);
  console.log(`  محتاجة قرارك (AMBIGUOUS) : ${counts.ambiguous}`);

  const safe = rows.filter(r => r.verdict.status === "safe");
  if (safe.length > 0) {
    console.log(`\n──── أمثلة SAFE (أول ${Math.min(exampleLimit, safe.length)}) ────`);
    for (const row of safe.slice(0, exampleLimit)) {
      console.log(
        `\n  أوردر ${row.orderNumber ?? row.orderId} · بند #${row.itemId} · منتج ${row.productId} · نوع ${row.variantId ?? "—"}`
      );
      console.log(`    قبل  : "${row.currentName}"`);
      console.log(`    بعد  : "${row.verdict.proposedName}"`);
      console.log(`    اسم المنتج في الكتالوج : "${row.canonicalName}"`);
      console.log(`    نوع الصف الحالي        : "${row.variantName ?? "—"}"`);
      console.log(`    السبب: ${row.verdict.reason}`);
    }
  }

  const ambiguous = rows.filter(r => r.verdict.status === "ambiguous");
  if (ambiguous.length > 0) {
    console.log(`\n──── أمثلة AMBIGUOUS (أول ${Math.min(exampleLimit, ambiguous.length)}) ────`);
    console.log("  الصفوف دي **مش هتتغيّر** — بتتعرض عشان تقرر إنت.");
    for (const row of ambiguous.slice(0, exampleLimit)) {
      console.log(
        `\n  أوردر ${row.orderNumber ?? row.orderId} · بند #${row.itemId} · منتج ${row.productId ?? "—"} · نوع ${row.variantId ?? "—"}`
      );
      console.log(`    الاسم الحالي           : "${row.currentName}"`);
      console.log(`    اسم المنتج في الكتالوج : "${row.canonicalName ?? "— مش موجود —"}"`);
      console.log(`    نوع الصف الحالي        : "${row.variantName ?? "—"}"`);
      console.log(`    السبب: ${row.verdict.reason}`);
    }
    // تجميع الأسباب — أسرع طريقة تعرف بيها إيه اللي مانع الأغلبية.
    const byReason = new Map<string, number>();
    for (const row of ambiguous) {
      const key = row.verdict.reason.replace(/«[^»]*»/g, "«…»");
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    console.log("\n──── أسباب AMBIGUOUS مجمّعة ────");
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(6)} × ${reason}`);
    }
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  مفيش أي صف اتغيّر. التصحيح في سكربت تاني ومحتاج --apply.");
  console.log("════════════════════════════════════════════════════════\n");
}

async function main() {
  const business = arg("business");
  const examples = Number(arg("examples") ?? 10);
  const rows = await auditLegacyItemNames(business ? Number(business) : undefined);
  printReport(rows, Number.isFinite(examples) ? examples : 10);
  process.exit(0);
}

if (process.argv[1]?.includes("auditLegacyItemNames")) {
  main().catch(error => {
    console.error("فشل التدقيق:", error?.message ?? error);
    process.exit(1);
  });
}
