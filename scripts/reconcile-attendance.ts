/**
 * Reconcile الحضور — قراءة فقط: يعيد حساب كل يوم من أحداثه ويقارنه بالمجاميع المخزنة (Projection).
 *   corepack pnpm tsx scripts/reconcile-attendance.ts --tenant <id> [--from YYYY-MM-DD --to YYYY-MM-DD] [--json] [--i-understand-production]
 * لا يصلح شيئًا: أي فرق يُعرض للمراجعة فقط.
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { reconcileAttendance } from "../server/attendance.service";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const tenantId = Number(opt("--tenant"));
  if (!Number.isInteger(tenantId) || tenantId <= 0) { console.error("--tenant <id> مطلوب"); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    const r = await reconcileAttendance(exec, tenantId, opt("--from"), opt("--to"));
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`أيام مفحوصة: ${r.checked} · فروق: ${r.mismatches.length}`);
      for (const m of r.mismatches) console.log(`  ✗ يوم #${m.dayId} موظف ${m.employeeId} ${m.workDate} ${m.field}: مخزَّن ${m.stored} ≠ محسوب ${m.computed}`);
    }
    process.exitCode = r.mismatches.length ? 1 : 0;
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
