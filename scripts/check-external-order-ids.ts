/**
 * فحص قراءة فقط قبل Migration 0053 المقترحة (قيد فريد على orders(businessId, externalOrderId)) — لا يكتب شيئًا ولا يطبّق شيئًا.
 *   node dist/scripts/check-external-order-ids.mjs [--json] [--limit 20] [--i-understand-production]
 * رمز الخروج: 0 = جاهز (لا تكرار يمنع القيد)، 1 = تكرارات/فهرس متعارض يمنع القيد، 2 = خطأ تشغيل، 3 = هدف إنتاجي بلا إقرار.
 * المخرجات: معرّفات الأوردرات وأرقامها وحالاتها للمجموعات المكررة (لا بيانات عملاء). لا يُطبع الرابط ولا كلمة السر.
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { checkExternalOrderIds, PROPOSED_INDEX } from "../server/externalOrderIdPrecheck.service";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    const r = await checkExternalOrderIds(exec, { sampleLimit: Number(opt("--limit") ?? 20) });
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else if (!r.column) console.log(`${target.host} / ${target.database} · ✗ ${r.reason}`);
    else {
      console.log(`${target.host} / ${target.database} · فحص 0053 (${PROPOSED_INDEX}): ${r.ready ? "✓ جاهز" : `✗ غير جاهز — ${r.reason}`}`);
      console.log(`  العمود: ${r.column.type} · ${r.column.collation} · ${r.column.nullable ? "NULL مسموح" : "NOT NULL"} · الفهرس المقترح: ${r.proposedIndex}`);
      console.log(`  فهارس قائمة ذات صلة: ${r.relatedIndexes.map(i => `${i.name}(${i.columns.join(",")}${i.unique ? ",unique" : ""})`).join(" · ") || "لا يوجد"}`);
      const t = r.totals;
      console.log(`  الأوردرات ${t.orders} · بلا معرّف (NULL) ${t.nullKeys} · فارغ/مسافات ${t.blankKeys} · بمسافات طرفية ${t.paddedKeys} · مفاتيح مميزة ${t.distinctKeys}`);
      const d = r.duplicates;
      console.log(`  مجموعات مكررة داخل النشاط ${d.groups} (صفوف ${d.rowsInGroups}، منها فارغة ${d.blankGroups}، تختلف بالحالة/التشكيل فقط ${d.caseOrAccentVariantGroups}) · مفاتيح مشتركة بين أنشطة (مسموح) ${r.crossBusinessKeys}`);
      for (const s of d.samples)
        console.log(`  · نشاط #${s.businessId} × ${s.count}: أوردرات ${s.orderNumbers.join(",")} (ids ${s.orderIds.join(",")}) · حالات ${s.statuses.join(",")} · مصادر ${s.sources.join(",")}`);
    }
    process.exitCode = r.ready ? 0 : 1;
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
