/**
 * تعطيل دفتر V3 لشركة — العلم فقط (لا حذف جداول ولا حركات).
 *
 *   node scripts/disable-ledger-v3.cjs --tenant <id> --actor <superAdminId> --reason "<سبب>"                 # dry-run (افتراضي)
 *   node scripts/disable-ledger-v3.cjs --tenant <id> --actor <superAdminId> --reason "<سبب>" --apply --confirm "DISABLE LEDGER V3 TENANT <id>"
 *
 * DATABASE_URL من البيئة فقط؛ لا يُطبع الرابط ولا أسرار. يرفض غير المالك وأي شركة أخرى؛ معطّل مسبقًا → replay.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import type { LedgerDb } from "../server/ledgerV3.service";
import { runDisableLedgerV3 } from "../server/ledgerV3Disable.service";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };

async function main() {
  const tenantId = Number(opt("--tenant")), actorEmployeeId = Number(opt("--actor"));
  if (!Number.isInteger(tenantId) || tenantId <= 0) { console.error("حدد --tenant <id>."); process.exit(2); }
  if (!Number.isInteger(actorEmployeeId) || actorEmployeeId <= 0) { console.error("حدد --actor <employeeId المالك>."); process.exit(2); }
  const reason = opt("--reason") ?? "";
  const apply = args.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  console.log(`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""}`);
  if (target.production && !args.includes("--i-understand-production")) { console.error("هذه القاعدة تبدو إنتاجًا. يتطلب --i-understand-production صراحةً."); process.exit(3); }

  const db = drizzle(url) as unknown as LedgerDb;
  try {
    const r = await runDisableLedgerV3({ tenantId, db, actorEmployeeId, reason, apply, confirm: opt("--confirm") ?? null });
    for (const l of r.lines) console.log(l);
    process.exitCode = r.ok ? 0 : 3;
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await new Promise<void>(resolve => { const c = (db as any).$client; if (c?.end) c.end(() => resolve()); else resolve(); });
  }
}

main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
