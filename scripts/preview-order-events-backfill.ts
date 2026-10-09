/**
 * معاينة Backfill لأحداث الأوردرات — قراءة فقط، بلا أي كتابة (التنفيذ الفعلي غير موجود ولا مسموح الآن).
 *   corepack pnpm tsx scripts/preview-order-events-backfill.ts --tenant <id> [--json] [--i-understand-production]
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { previewOrderEventsBackfill } from "../server/orderEventsBackfillPreview.service";

const args = process.argv.slice(2);
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const i = args.indexOf("--tenant"); const tenantId = Number(i >= 0 ? args[i + 1] : NaN);
  if (!Number.isInteger(tenantId) || tenantId <= 0) { console.error("--tenant <id> مطلوب"); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    const p = await previewOrderEventsBackfill(exec, tenantId);
    if (args.includes("--json")) console.log(JSON.stringify(p, null, 2));
    else {
      console.log(`معاينة Backfill (قراءة فقط) — tenant ${tenantId}`);
      console.log(`  مؤكد: تأكيدات من الأوردرات ${p.confirmed.confirmFromOrders} · تغييرات حالة من سجل التعديل ${p.confirmed.statusFromEditLogs}`);
      console.log(`  جزئي (خارج الترتيب الافتراضي): سجل النشاط ${p.partial.activityLogs}`);
      console.log(`  غير معروف (بلا حدث): لم يرد ${p.unknown.noAnswerOrders} · مؤجل ${p.unknown.postponedOrders} · مُسنَد ${p.unknown.assignedOrders} · مطبوع ${p.unknown.printedOrders}`);
    }
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
