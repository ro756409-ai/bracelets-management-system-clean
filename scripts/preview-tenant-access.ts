/**
 * معاينة إنفاذ حالة الشركات — قراءة فقط: ماذا سيحدث لكل شركة **لو** فُعّل TENANT_ACCESS_ENFORCEMENT_ENABLED.
 * لا يفعّل شيئًا ولا يغيّر أي حالة. قسما تحذير مستقلان: trialing بلا trialEndsAt، وpast_due بلا فترة اشتراك.
 *   node dist/scripts/preview-tenant-access.mjs [--json] [--i-understand-production]
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { buildTenantAccessPreview, formatTenantAccessPreview, type PreviewTenant } from "../shared/tenantAccessPreview";

const args = process.argv.slice(2);
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    const tenants = await exec.query<PreviewTenant>("SELECT id, name, status, UNIX_TIMESTAMP(trialEndsAt) * 1000 AS trialEndsMs FROM tenants ORDER BY id");
    const pastDue = await exec.query<{ tenantId: number; endMs: number | null }>(
      "SELECT tenantId, MAX(UNIX_TIMESTAMP(currentPeriodEnd)) * 1000 AS endMs FROM subscriptions WHERE status = 'past_due' GROUP BY tenantId");
    const preview = buildTenantAccessPreview(tenants, new Map(pastDue.map(p => [Number(p.tenantId), p.endMs == null ? null : Number(p.endMs)])), new Date());
    console.log(args.includes("--json") ? JSON.stringify(preview, null, 2) : formatTenantAccessPreview(preview));
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
