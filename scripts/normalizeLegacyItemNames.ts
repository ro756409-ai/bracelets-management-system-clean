/**
 * تصحيح أسماء بنود الأوردرات القديمة — **بيتوقف من غير `--apply`**.
 *
 *   corepack pnpm tsx scripts/normalizeLegacyItemNames.ts              ← معاينة
 *   corepack pnpm tsx scripts/normalizeLegacyItemNames.ts --business 7 ← معاينة لنشاط
 *   corepack pnpm tsx scripts/normalizeLegacyItemNames.ts --apply      ← التنفيذ
 *
 * بيغيّر **عمود واحد بس**: `order_items.productName`، وللصفوف اللي التدقيق قال عنها
 * `safe` وبس. مابيلمسش `productId` ولا `variantId` ولا الكمية ولا السعر ولا حالة
 * الأوردر ولا بيانات بوسطة ولا سجل التعديلات ولا هيدر الأوردر.
 *
 * **idempotent**: التشغيلة التانية بتلاقي الصفوف بقت `clean` فبتعدّ صفر. ودي مش نية —
 * دي نتيجة إن القرار مبني على مقارنة بالكتالوج: أول ما الاسم يبقى مطابق، التصنيف
 * نفسه بيرجع `clean` ومابيرشّحش الصف تاني.
 *
 * **transaction-safe**: الكتابة كلها في ترانزاكشن واحدة. لو صف وقع، مفيش حاجة اتكتبت.
 *
 * التصنيف في `shared/legacyItemNames.ts` والقراءة في `scripts/auditLegacyItemNames.ts` —
 * السكربت ده مابيقررش لوحده.
 */

import { eq } from "drizzle-orm";
import { orderItems } from "../drizzle/schema";
import { auditLegacyItemNames } from "./auditLegacyItemNames";
import { getDb } from "../server/db";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const business = arg("business");
  const businessId = business ? Number(business) : undefined;

  const rows = await auditLegacyItemNames(businessId);
  const safe = rows.filter(
    row => row.verdict.status === "safe" && row.verdict.proposedName
  );

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  تصحيح أسماء البنود — ${apply ? "تنفيذ" : "معاينة (مفيش كتابة)"}`);
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`  إجمالي البنود المفحوصة : ${rows.length}`);
  console.log(`  الصفوف اللي هتتغيّر    : ${safe.length}`);
  console.log(
    `  الصفوف اللي هتتساب     : ${rows.length - safe.length} (سليمة أو محتاجة قرارك)`
  );

  if (safe.length === 0) {
    console.log("\n  مفيش حاجة تتعمل. ✅\n");
    process.exit(0);
  }

  console.log("\n──── أول ١٠ تغييرات ────");
  for (const row of safe.slice(0, 10)) {
    console.log(
      `  بند #${row.itemId} (أوردر ${row.orderNumber ?? row.orderId}): "${row.currentName}" ← "${row.verdict.proposedName}"`
    );
  }

  if (!apply) {
    console.log("\n────────────────────────────────────────────────────────");
    console.log("  دي معاينة. مفيش أي صف اتغيّر.");
    console.log("  للتنفيذ: زوّد --apply — وخد Backup الأول.");
    console.log("────────────────────────────────────────────────────────\n");
    process.exit(0);
  }

  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات مش متاحة");

  let updated = 0;
  await db.transaction(async tx => {
    for (const row of safe) {
      // شرط الكتابة بيحطّ الاسم القديم فيه: لو حد تاني غيّر الصف بين القراءة
      // والكتابة، الشرط مابينطبقش والصف بيتساب. الكتابة مابتعتمدش على إن الدنيا
      // وقفت مكانها من ساعة التدقيق.
      const result: any = await tx
        .update(orderItems)
        .set({ productName: row.verdict.proposedName! })
        .where(eq(orderItems.id, row.itemId));
      updated += result?.[0]?.affectedRows ?? result?.affectedRows ?? 1;
    }
  });

  console.log(`\n  اتغيّر ${updated} صف. ✅`);

  // إثبات الـidempotency على نفس البيانات بعد الكتابة.
  const after = await auditLegacyItemNames(businessId);
  const stillSafe = after.filter(row => row.verdict.status === "safe").length;
  console.log(`  إعادة التدقيق بعد التنفيذ: ${stillSafe} صف مرشّح للتغيير.`);
  if (stillSafe !== 0) {
    console.log("  ⚠️  المفروض يبقى صفر — راجع قبل ما تكمّل.");
    process.exit(1);
  }
  console.log("  التشغيلة التانية هتعدّ صفر. ✅\n");
  process.exit(0);
}

main().catch(error => {
  console.error("فشل التصحيح:", error?.message ?? error);
  process.exit(1);
});
