/**
 * حذف ملفات مرفقات الرسائل المنتهية (الصوت بعد 6 أشهر، أو فور حذف الرسالة) من التخزين الدائم.
 *   node dist/scripts/purge-message-attachments.mjs                 ← dry-run: عدد المستحق فقط
 *   node dist/scripts/purge-message-attachments.mjs --apply [--limit 500] [--i-understand-production]
 * Idempotent وآمن للتشغيل المتكرر/المتزامن (FOR UPDATE SKIP LOCKED + purgedAt). لا يحذف إلا مفتاحًا مولَّدًا
 * داخل بادئة شركة الصف نفسه. لا يطبع مفاتيح التخزين ولا روابط — أرقام فقط.
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { purgeExpiredAttachments } from "../server/messaging.service";
import { resolveMessagingStorage } from "../server/messagingStorage";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const apply = args.includes("--apply");
  if (apply && looksLikeProductionTarget(url).production && !args.includes("--i-understand-production")) {
    console.error("قاعدة تبدو إنتاجًا — الحذف يتطلب --i-understand-production"); process.exit(3);
  }
  const storage = resolveMessagingStorage();
  if (!storage) { console.error("التخزين الدائم غير مضبوط في هذه البيئة — لا شيء يُحذف."); process.exit(2); }
  const limit = Number(opt("--limit") ?? 500);
  const r = await purgeExpiredAttachments({ storage, limit, dryRun: !apply });
  console.log(`الحالة: ${r.state} · مستحق: ${r.due} · حُذف: ${r.purged} · فشل: ${r.failed} · مفاتيح خارج نطاق الشركة (تُركت): ${r.skippedForeignKey}`);
  process.exitCode = r.failed || r.skippedForeignKey ? 1 : 0;
}
main().then(() => process.exit()).catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.name : "Error"); process.exit(2); });
