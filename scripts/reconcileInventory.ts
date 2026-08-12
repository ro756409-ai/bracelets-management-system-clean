/**
 * مصالحة المخزون القديم — **قراءة فقط**.
 *
 * السكربت ده **مابيكتبش ولا حرف**. مفيش insert/update/delete/transaction، وفيه اختبار
 * بيقفل ده. تقدر تشغّله على الإنتاج وإنت مطمّن.
 *
 *   corepack pnpm tsx scripts/reconcileInventory.ts
 *   corepack pnpm tsx scripts/reconcileInventory.ts --business 7
 *   corepack pnpm tsx scripts/reconcileInventory.ts --show mismatch   (أو ambiguous)
 *
 * بيقارن الرصيد المخزّن (`products.currentStock` / `product_variants.currentStock`)
 * بمجموع حركات `inventory_movements`، وبيصنّف: MATCH / AMBIGUOUS / MISMATCH.
 * المنطق في `shared/inventoryReconcile.ts` ومُختبَر هناك — هنا بنجيب الأرقام بس.
 *
 * **بيغطّي المسار القديم بس** (`products`/`product_variants`.currentStock). الأنشطة
 * اللي بعد Go-Live مخزونها في `inventory_balances` بحركات V2 مقفولة — خارج النطاق ده.
 */

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import {
  inventoryMovements,
  productVariants,
  products,
} from "../drizzle/schema";
import {
  classifyBalance,
  summariseReconcile,
  type ReconcileStatus,
  type ReconcileVerdict,
} from "../shared/inventoryReconcile";
import { getDb } from "../server/db";

type Row = ReconcileVerdict & {
  kind: "product" | "variant";
  id: number;
  name: string;
  businessId: number;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

export async function reconcileInventory(businessId?: number): Promise<Row[]> {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات مش متاحة — لازم DATABASE_URL");

  // مجموع الحركات لكل (product, variant). variantId فاضي = حركة على منتج بلا أنواع.
  const movementAgg = await db
    .select({
      productId: inventoryMovements.productId,
      variantId: inventoryMovements.variantId,
      totalIn: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} = 'in' THEN ${inventoryMovements.quantity} ELSE 0 END), 0)`,
      totalOut: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.type} = 'out' THEN ${inventoryMovements.quantity} ELSE 0 END), 0)`,
    })
    .from(inventoryMovements)
    .groupBy(inventoryMovements.productId, inventoryMovements.variantId);

  const keyOf = (productId: number, variantId: number | null) =>
    `${productId}:${variantId ?? "base"}`;
  const sumsByKey = new Map(
    movementAgg.map(m => [
      keyOf(m.productId, m.variantId),
      { totalIn: Number(m.totalIn), totalOut: Number(m.totalOut) },
    ])
  );

  const rows: Row[] = [];

  // ── الأنواع (variants) — كل نوع بيمسك رصيده ──
  const variantCond = businessId
    ? and(eq(products.businessId, businessId))
    : undefined;
  const variantRows = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      name: productVariants.name,
      currentStock: productVariants.currentStock,
      businessId: products.businessId,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(variantCond);
  const variantProductIds = new Set(variantRows.map(v => v.productId));

  for (const v of variantRows) {
    const sums = sumsByKey.get(keyOf(v.productId, v.id)) ?? { totalIn: 0, totalOut: 0 };
    rows.push({
      kind: "variant",
      id: v.id,
      name: v.name,
      businessId: v.businessId,
      ...classifyBalance(v.currentStock, sums),
    });
  }

  // ── المنتجات اللي مالهاش أنواع — بتمسك رصيدها بنفسها ──
  const productCond = businessId ? eq(products.businessId, businessId) : undefined;
  const productRows = await db
    .select({
      id: products.id,
      name: products.name,
      currentStock: products.currentStock,
      businessId: products.businessId,
    })
    .from(products)
    .where(productCond);

  for (const p of productRows) {
    // المنتج اللي ليه أنواع مابيمسكش رصيد بنفسه — الرصيد على الأنواع، فبيتساب هناك.
    if (variantProductIds.has(p.id)) continue;
    const sums = sumsByKey.get(keyOf(p.id, null)) ?? { totalIn: 0, totalOut: 0 };
    rows.push({
      kind: "product",
      id: p.id,
      name: p.name,
      businessId: p.businessId,
      ...classifyBalance(p.currentStock, sums),
    });
  }

  return rows;
}

function printReport(rows: Row[], show?: string) {
  const counts = summariseReconcile(rows);
  const businesses = new Set(rows.map(r => r.businessId)).size;

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  مصالحة المخزون — قراءة فقط، مفيش أي كتابة");
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`  أنشطة اتفحصت        : ${businesses}`);
  console.log(`  أصناف/أنواع اتفحصت  : ${counts.total}`);
  console.log(`  ✅ MATCH            : ${counts.match}`);
  console.log(`  ⚠️  AMBIGUOUS        : ${counts.ambiguous}  (غالبًا رصيد افتتاحي مش متسجّل)`);
  console.log(`  ❌ MISMATCH         : ${counts.mismatch}`);

  const worst = [...rows]
    .filter(r => r.status === "MISMATCH")
    .sort((a, b) => Math.abs(b.impliedOpening) - Math.abs(a.impliedOpening));
  if (worst.length > 0) {
    console.log(`\n──── أكبر فروقات MISMATCH (أول ${Math.min(20, worst.length)}) ────`);
    for (const r of worst.slice(0, 20)) {
      console.log(
        `  ${r.kind} #${r.id} «${r.name}» (نشاط ${r.businessId}): مخزّن ${r.storedBalance} · صافي حركات ${r.netMovements} · فرق ${r.impliedOpening}`
      );
      console.log(`    ${r.reason}`);
    }
  }

  const filter = (show ?? "").toLowerCase();
  if (filter === "mismatch" || filter === "ambiguous") {
    const target = rows.filter(r => r.status.toLowerCase() === filter);
    console.log(`\n──── كل الـ${filter.toUpperCase()} (${target.length}) ────`);
    for (const r of target) {
      console.log(
        `  ${r.kind} #${r.id} «${r.name}» (نشاط ${r.businessId}): مخزّن ${r.storedBalance} · حركات ${r.netMovements} · افتتاحي مُستنتَج ${r.impliedOpening}`
      );
    }
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  مفيش أي رقم اتغيّر. ده تشخيص بس.");
  console.log("  AMBIGUOUS مش غلط بالضرورة — غالبًا رصيد افتتاحي شرعي مش متسجّل كحركة.");
  console.log("════════════════════════════════════════════════════════\n");
}

async function main() {
  const business = arg("business");
  const rows = await reconcileInventory(business ? Number(business) : undefined);
  printReport(rows, arg("show"));
  process.exit(0);
}

if (process.argv[1]?.includes("reconcileInventory")) {
  main().catch(error => {
    console.error("فشل التشخيص:", error?.message ?? error);
    process.exit(1);
  });
}
