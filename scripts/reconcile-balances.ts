/**
 * مطابقة أرصدة الخزن والحسابات — **قراءة فقط**.
 *
 * يقارن الرصيد المخزّن لكل خزنة (`treasury_transactions`) وكل حساب (`financial_accounts`)
 * بالمجموع المحسوب من حركاته، ويعرض: الفرق، عدد الحركات، آخر حركة، وكسور سلسلة الرصيد.
 * لا يكتب حرفًا: الاتصال `READ ONLY` على مستوى MySQL والمنفّذ يرفض أي عبارة غير SELECT.
 *
 *   corepack pnpm tsx scripts/reconcile-balances.ts --business 7
 *   corepack pnpm tsx scripts/reconcile-balances.ts --all
 *   corepack pnpm tsx scripts/reconcile-balances.ts --all --json > balances.json
 *
 * على قاعدة تبدو إنتاجًا (مضيف غير محلي واسم قاعدة بلا test/staging) يتوقف ما لم يُمرَّر
 * `--i-understand-production` صراحةً. لا يطبع الرابط ولا كلمات السر — المضيف واسم القاعدة فقط.
 */
import "dotenv/config";
import { looksLikeProductionTarget, type BalanceLine } from "../shared/balanceReconciliation";
import { listBusinessIds, loadBalanceReport, openReadOnlyExecutor } from "../server/balanceReconciliation.service";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const all = args.includes("--all");
const confirmProduction = args.includes("--i-understand-production");
const businessArgs = args.flatMap((a, i) => (a === "--business" && args[i + 1] ? [Number(args[i + 1])] : a.startsWith("--business=") ? [Number(a.slice(11))] : []));

function money(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printLine(l: BalanceLine) {
  const mark = l.ok ? "✓" : "✗";
  console.log(`  ${mark} [${l.businessId}] ${l.key} — ${l.label}`);
  console.log(`      مخزّن ${money(l.stored)} · محسوب ${money(l.computed)} · الفرق ${money(l.difference)} · حركات ${l.movements} · آخر حركة ${l.lastMovementAt ?? "—"}`);
  if (l.chainBreaks.length) console.log(`      كسور السلسلة في الصفوف: ${l.chainBreaks.slice(0, 20).join(", ")}${l.chainBreaks.length > 20 ? " …" : ""}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  if (!all && businessArgs.length === 0) { console.error("حدد --business <id> (يتكرر) أو --all."); process.exit(2); }
  if (businessArgs.some(id => !Number.isInteger(id) || id <= 0)) { console.error("قيمة --business غير صالحة."); process.exit(2); }

  const target = looksLikeProductionTarget(url);
  if (!asJson) console.log(`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""}`);
  if (target.production && !confirmProduction) {
    console.error("هذه القاعدة تبدو إنتاجًا. التشغيل قراءة فقط لكنه يتطلب تأكيدًا صريحًا: أضف --i-understand-production");
    process.exit(3);
  }

  const exec = await openReadOnlyExecutor(url);
  try {
    const businessIds = all ? await listBusinessIds(exec) : [...new Set(businessArgs)];
    const report = await loadBalanceReport(exec, businessIds);
    if (asJson) { console.log(JSON.stringify(report, null, 2)); }
    else {
      console.log(`\nمطابقة الأرصدة — ${report.generatedAt} — أنشطة: ${businessIds.join(", ") || "لا شيء"}\n`);
      for (const l of report.lines) printLine(l);
      console.log(`\nالخلاصة: ${report.ok ? "✓ كل الأرصدة مطابقة" : `✗ ${report.mismatches.length} عدم تطابق`}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await exec.close();
  }
}

main().catch(err => {
  // رسالة الخطأ فقط — بلا أي رابط أو بيانات اتصال.
  console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
