/**
 * تحقق Ledger V3 — **قراءة فقط**: هل الجداول السبعة وأعمدتها وفهارسها الفريدة ومفاتيحها الأجنبية
 * وقيود CHECK مطابقة لمواصفة `shared/ledgerV3Spec.ts` (التي يُفترض أن ينتجها
 * `drizzle/0040_ledger_v3.sql`)؟ ومع `--preflight`: فحوص ما قبل التطبيق (تعيد قيمًا متوقعة).
 *
 *   corepack pnpm tsx scripts/verify-ledger-v3.ts               # بعد التطبيق: مطابقة كاملة
 *   corepack pnpm tsx scripts/verify-ledger-v3.ts --preflight   # قبل التطبيق
 *   corepack pnpm tsx scripts/verify-ledger-v3.ts --json
 *
 * الجلسة READ ONLY على مستوى MySQL والمنفّذ يرفض غير SELECT. لا يطبع رابطًا ولا أسرارًا.
 * الإنتاج يتطلب --i-understand-production (قراءة فقط أيضًا).
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { ledgerV3Preflight, verifyLedgerV3OnDatabase } from "../server/ledgerV3Verify.service";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const preflight = args.includes("--preflight");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (!asJson) console.log(`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""}`);
  if (target.production && !args.includes("--i-understand-production")) {
    console.error("هذه القاعدة تبدو إنتاجًا. التشغيل قراءة فقط لكنه يتطلب --i-understand-production");
    process.exit(3);
  }
  const exec = await openReadOnlyExecutor(url);
  try {
    if (preflight) {
      const rows = await ledgerV3Preflight(exec);
      if (asJson) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}: ${r.actual || "—"} (متوقع ${r.expected || "—"})`);
      process.exitCode = rows.every(r => r.ok) ? 0 : 1;
      return;
    }
    const { issues, present, state } = await verifyLedgerV3OnDatabase(exec);
    if (asJson) console.log(JSON.stringify({ state, present, issues }, null, 2));
    else {
      console.log(`حالة التطبيق: ${state === "applied" ? "مطبَّق" : state === "not_applied" ? "غير مطبَّق" : "⚠️ جزئي — تشغيل متقطّع، راجع قبل أي إعادة"}`);
      console.log(`الجداول الموجودة: ${present.join(", ") || "لا شيء"}`);
      if (issues.length === 0) console.log("✓ Ledger V3 مطابق للمواصفة بالكامل (الجداول السبعة + الفهرسان المركّبان + كل FK مركّب للـtenant + currentBalance/payloadHash/العكس مرة واحدة/CHECK amount)");
      else for (const i of issues) console.log(`  ✗ ${i.table} [${i.kind}] ${i.detail}`);
    }
    process.exitCode = issues.length === 0 ? 0 : 1;
  } finally {
    await exec.close();
  }
}

main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
