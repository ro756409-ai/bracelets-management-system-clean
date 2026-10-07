/**
 * تفعيل Ledger V3 لشركة — آمن، صريح، بلا تخمين.
 *
 *   corepack pnpm tsx scripts/activate-ledger-v3.ts --tenant 3                       # dry-run (الافتراضي، قراءة فقط)
 *   corepack pnpm tsx scripts/activate-ledger-v3.ts --tenant 3 --opening-file docs/ledger-v3-opening.example.json
 *   corepack pnpm tsx scripts/activate-ledger-v3.ts --tenant 3 --go-live 2026-11-01 --actor 12          # صفري بلا ملف
 *   corepack pnpm tsx scripts/activate-ledger-v3.ts --tenant 3 --opening-file opening.json --actor 12 \
 *       --apply --confirm "ACTIVATE LEDGER V3 TENANT 3 GO-LIVE 2026-11-01"
 *
 * الخيارات: --tenant <id> · --dry-run (افتراضي) · --apply · --confirm <العبارة المطابقة> · --opening-file <json>
 *           --go-live <YYYY-MM-DD> (إن لم يكن في الملف) · --actor <employeeId المالك> (إلزامي لـ--apply) · --json
 *           --i-understand-production (القاعدة تبدو إنتاجًا)
 *
 * --apply يرفض: 0040 غير كاملة، فروق V2 غير معتمدة، تفعيل سابق بتاريخ مختلف (نفس التاريخ = replay)،
 * أرقام float في الملف، قيد افتتاحي غير متوازن، حساب مجهول، فاعل/معتمِد ليس مالكًا، عبارة تأكيد غير مطابقة.
 * التفعيل كله (الحسابات + الربط + القيد الافتتاحي + العلم) معاملة واحدة في الخدمة. لا يطبع روابط ولا أسرارًا.
 */
import "dotenv/config";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { parseOpeningFile } from "../shared/ledgerV3Activation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { LEDGER_BASE_ACCOUNTS, type LedgerDb } from "../server/ledgerV3.service";
import { applyLedgerV3Activation, planLedgerV3Activation, renderActivationPlan } from "../server/ledgerV3Activation.service";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
const has = (name: string) => args.includes(name);

async function main() {
  const tenantId = Number(opt("--tenant"));
  if (!Number.isInteger(tenantId) || tenantId <= 0) { console.error("حدد --tenant <id> (عدد صحيح موجب)."); process.exit(2); }
  const apply = has("--apply");
  if (apply && has("--dry-run")) { console.error("--apply و--dry-run معًا غير مسموح."); process.exit(2); }
  const asJson = has("--json");
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (!asJson) console.log(`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""} · الوضع: ${apply ? "APPLY" : "dry-run (قراءة فقط)"}`);
  if (target.production && !has("--i-understand-production")) { console.error("هذه القاعدة تبدو إنتاجًا. يتطلب --i-understand-production صراحةً."); process.exit(3); }

  let opening = null;
  const openingPath = opt("--opening-file");
  if (openingPath) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(openingPath, "utf-8")); } catch (e) { console.error(`تعذر قراءة ملف الأرصدة: ${(e as Error).message}`); process.exit(2); }
    const parsed = parseOpeningFile(raw, LEDGER_BASE_ACCOUNTS.filter(a => a.money).map(a => a.code));
    if (!parsed.ok) { console.error("ملف الأرصدة مرفوض — لا كتابة:"); for (const e of parsed.errors) console.error(`  ✗ ${e}`); process.exit(4); }
    opening = parsed.file;
  }
  const actorRaw = opt("--actor");
  const actorEmployeeId = actorRaw !== undefined ? Number(actorRaw) : null;
  if (actorRaw !== undefined && (!Number.isInteger(actorEmployeeId) || (actorEmployeeId as number) <= 0)) { console.error("--actor يجب أن يكون معرّف موظف صحيحًا."); process.exit(2); }
  if (apply && actorEmployeeId == null) { console.error("--apply يتطلب --actor <employeeId المالك>."); process.exit(2); }

  const exec = await openReadOnlyExecutor(url);
  const db = drizzle(url) as unknown as LedgerDb;
  try {
    const plan = await planLedgerV3Activation({ tenantId, db, exec, opening, goLiveDate: opt("--go-live") ?? null, actorEmployeeId });
    if (asJson) console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", plan }, null, 2));
    else console.log(renderActivationPlan(plan));

    if (!apply) { process.exitCode = plan.blockers.length ? 1 : 0; return; }

    const confirm = opt("--confirm") ?? "";
    const result = await applyLedgerV3Activation({ tenantId, plan, db, exec, actorEmployeeId: actorEmployeeId as number, confirm });
    if (asJson) console.log(JSON.stringify({ result }, null, 2));
    else {
      console.log(result.replay ? "↻ الشركة كانت مفعّلة بنفس التاريخ — replay بلا أي تكرار" : "✓ تم التفعيل (معاملة واحدة)");
      console.log(`  openingTransactionId: ${result.openingTransactionId ?? "NULL (أرصدة صفرية)"}`);
      console.log(`  الحسابات: ${Object.entries(result.accounts).map(([c, id]) => `${c}#${id}`).join("، ")}`);
      console.log(`  صفوف V2 قبل/بعد: ${result.v2Changed.length === 0 ? "بلا تغيير ✓" : `⚠️ تغيّرت: ${result.v2Changed.join(", ")}`}`);
    }
    process.exitCode = result.v2Changed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 5;
  } finally {
    await exec.close();
    // drizzle(url) ينشئ pool بواجهة callbacks — إغلاقه لا يُرجع Promise
    await new Promise<void>(resolve => { const c = (db as any).$client; if (c?.end) c.end(() => resolve()); else resolve(); });
  }
}

main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
