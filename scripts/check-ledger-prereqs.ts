/**
 * فحص قراءة فقط لمتطلبات Ledger V3 (جداول المخزون والشحن والمرتبات القائمة وأعمدتها، أدوار 0045، أنواع 0046، وحالة 0040/0047–0050).
 *   node dist/scripts/check-ledger-prereqs.mjs [--json] [--i-understand-production]
 * رمز الخروج: 0 = المتطلبات كاملة، 1 = جدول/عمود مطلوب ناقص، 2 = خطأ تشغيل، 3 = هدف إنتاجي بلا إقرار.
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { checkLedgerPrereqs } from "../server/ledgerPrereqs.service";

const args = process.argv.slice(2);
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    const r = await checkLedgerPrereqs(exec);
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`${target.host} / ${target.database} · متطلبات Ledger V3: ${r.prerequisitesOk ? "كاملة" : "ناقصة"}`);
      for (const t of r.tables) console.log(`  ${t.ok ? "✓" : "✗"} [${t.area}] ${t.table}${!t.present ? (t.required ? " — الجدول غير موجود" : " — غير موجود (اختياري)") : t.missingColumns.length ? ` — أعمدة ناقصة: ${t.missingColumns.join(", ")}` : ""}`);
      for (const e of r.enums) console.log(`  ${e.ok ? "✓" : "·"} ${e.id} ${e.label}${e.ok ? "" : " — غير مطبّقة"}`);
      for (const m of r.migrations) console.log(`  · ${m.id} ${m.label}: ${m.state}${m.missing.length && m.state !== "absent" ? ` (ناقص: ${m.missing.join(", ")})` : ""}`);
    }
    process.exitCode = r.prerequisitesOk ? 0 : 1;
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
