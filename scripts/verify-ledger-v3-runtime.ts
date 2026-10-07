/**
 * Smoke test لدفتر V3 بعد التفعيل — **قراءة فقط**.
 *
 *   corepack pnpm tsx scripts/verify-ledger-v3-runtime.ts --tenant 3
 *   corepack pnpm tsx scripts/verify-ledger-v3-runtime.ts --tenant 3 --json
 *
 * يتحقق من: العلم، الحسابات الأساسية مرة واحدة، الربط بالأنشطة، openingTransactionId (أو NULL عند الصفر)،
 * مطابقة V3 = صفر فروق، لا كتابة في V2 في نافذة التفعيل، واستجابة routers القراءة للمالك والمحاسب
 * (الإجراء الوحيد غير القرائي المستدعى `period.reopen` للمحاسب يُرفض في البوابة قبل أي كتابة).
 * يحتاج JWT_SECRET (بيئة التطبيق) لبناء جلسات الاختبار. لا يطبع روابط ولا أسرارًا.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import type { LedgerDb } from "../server/ledgerV3.service";
import { verifyLedgerV3Runtime } from "../server/ledgerV3Runtime.service";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
const asJson = args.includes("--json");

async function main() {
  const tenantId = Number(opt("--tenant"));
  if (!Number.isInteger(tenantId) || tenantId <= 0) { console.error("حدد --tenant <id>."); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (!asJson) console.log(`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""}`);
  if (target.production && !args.includes("--i-understand-production")) { console.error("هذه القاعدة تبدو إنتاجًا. التشغيل قراءة فقط لكنه يتطلب --i-understand-production"); process.exit(3); }

  const exec = await openReadOnlyExecutor(url);
  const db = drizzle(url) as unknown as LedgerDb;
  try {
    const r = await verifyLedgerV3Runtime({ tenantId, db, exec });
    if (asJson) console.log(JSON.stringify(r, null, 2));
    else {
      for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`);
      console.log(r.ok ? "✓ الدفتر سليم تشغيليًا" : "✗ توجد فحوص فاشلة — لا تبدأ التشغيل قبل مراجعتها");
    }
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await exec.close();
    // drizzle(url) ينشئ pool بواجهة callbacks — إغلاقه لا يُرجع Promise
    await new Promise<void>(resolve => { const c = (db as any).$client; if (c?.end) c.end(() => resolve()); else resolve(); });
    // routers المستوردة كسولًا قد تُبقي pool getDb مفتوحًا — الخروج الصريح بعد تحديد الرمز
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  }
}

main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
