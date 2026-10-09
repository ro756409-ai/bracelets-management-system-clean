/**
 * معاينة إنفاذ حالة الشركات — قراءة فقط: ماذا سيحدث لكل شركة **لو** فُعّل TENANT_ACCESS_ENFORCEMENT_ENABLED.
 * لا يفعّل شيئًا ولا يغيّر أي حالة. للتشغيل قبل قرار التفعيل:
 *   corepack pnpm tsx scripts/preview-tenant-access.ts [--json] [--i-understand-production]
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { computeTenantAccess, TENANT_ACCESS_MESSAGES } from "../shared/tenantAccess";

const args = process.argv.slice(2);
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    const now = new Date();
    const tenants = await exec.query<{ id: number; name: string; status: string; trialEndsMs: number | null }>(
      "SELECT id, name, status, UNIX_TIMESTAMP(trialEndsAt) * 1000 AS trialEndsMs FROM tenants ORDER BY id");
    const pastDue = await exec.query<{ tenantId: number; endMs: number | null }>(
      "SELECT tenantId, MAX(UNIX_TIMESTAMP(currentPeriodEnd)) * 1000 AS endMs FROM subscriptions WHERE status = 'past_due' GROUP BY tenantId");
    const rows = tenants.map(t => {
      const since = pastDue.find(p => Number(p.tenantId) === Number(t.id))?.endMs;
      const a = computeTenantAccess({ status: t.status, trialEndsAt: t.trialEndsMs == null ? null : new Date(Number(t.trialEndsMs)) }, since == null ? null : new Date(Number(since)), now);
      return { tenantId: Number(t.id), name: t.name, status: t.status, level: a.level, reason: a.reason, message: TENANT_ACCESS_MESSAGES[a.reason], until: a.until?.toISOString() ?? null };
    });
    if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else {
      console.log(`معاينة الإنفاذ (قراءة فقط) — ${rows.length} شركة · full ${rows.filter(r => r.level === "full").length} · read_only ${rows.filter(r => r.level === "read_only").length} · blocked ${rows.filter(r => r.level === "blocked").length}`);
      for (const r of rows) console.log(`  #${r.tenantId} ${r.name} [${r.status}] ⇒ ${r.level} — ${r.message}${r.until ? ` (${r.until})` : ""}`);
    }
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
