/**
 * خطة الرجوع «توقف ومطابقة» بعد 0051 — صورة التوقف ثم إدخال أرصدتها في V1/V2 كفروق ورفع الحظر (طريقة واحدة، لا إعادة حركات).
 *   node dist/scripts/legacy-recovery.mjs snapshot --tenant <id> --actor <ownerId> --reason "<سبب>"                     # dry-run
 *   DEPLOY_ENV=test node dist/scripts/legacy-recovery.mjs snapshot ... --apply --confirm "SNAPSHOT LEGACY TENANT <id> ON <db>"
 *   node dist/scripts/legacy-recovery.mjs recover --tenant <id> --actor <ownerId> --reason "<سبب>" --plan plan.json        # dry-run
 *   DEPLOY_ENV=test node dist/scripts/legacy-recovery.mjs recover ... --apply --confirm "RECOVER LEGACY TENANT <id> ON <db>"
 * plan.json: { snapshotEventId, figuresHash, cash: [{ code, target: { kind: "v1_treasury", businessId } | { kind: "v2_account", accountId } }],
 *              acknowledgedNonCash: [code],
 *              zeroTargets: [{ target, reconciledBalance, explanation, evidenceRef, approvedByEmployeeId }] }  ← غير المحسوم يمنع التنفيذ
 * الشروط (V3 مطفأ، الشركة suspended والإيقاف مُطبَّق، مالك من نفس الشركة، البصمة، الخريطة الكاملة) في legacyRecovery.service.
 * الإنتاج مرفوض دائمًا في هذه المرحلة؛ apply على test/local بمضيف محلي (أو staging باسم يدل عليه لاحقًا بموافقة). لا يُطبع الرابط.
 */
import "dotenv/config";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { environmentGate } from "../server/handMigration.service";
import type { LedgerDb } from "../server/ledgerV3.service";
import { LegacyRecoveryError, recoverLegacyFromSnapshot, recoveryConfirmPhrase, takeStopSnapshot } from "../server/legacyRecovery.service";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const mode = args[0];
  if (mode !== "snapshot" && mode !== "recover") { console.error("الأمر: snapshot أو recover"); process.exit(2); }
  const tenantId = Number(opt("--tenant")), actorEmployeeId = Number(opt("--actor"));
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !Number.isInteger(actorEmployeeId) || actorEmployeeId <= 0) { console.error("حدد --tenant <id> و--actor <employeeId المالك>."); process.exit(2); }
  const apply = args.includes("--apply");
  const target = looksLikeProductionTarget(url);
  console.log(`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""} · ${mode} · ${apply ? "apply" : "dry-run"}`);
  if (target.production) { console.error("✗ القاعدة تبدو إنتاجًا — مرفوض في هذه المرحلة"); process.exit(3); }
  if (apply) {
    const why = environmentGate(target, process.env.DEPLOY_ENV);
    const expected = recoveryConfirmPhrase(mode, tenantId, target.database);
    if (why) { console.error(`✗ مرفوض قبل أي كتابة: ${why}`); process.exit(3); }
    if ((opt("--confirm") ?? "") !== expected) { console.error(`✗ عبارة التأكيد غير مطابقة — المطلوب حرفيًا: ${expected}`); process.exit(3); }
  }
  const db = drizzle(url) as unknown as LedgerDb;
  try {
    const reason = opt("--reason") ?? "";
    if (mode === "snapshot") {
      const r = await takeStopSnapshot({ tenantId, actorEmployeeId, reason, apply }, db);
      for (const b of r.figures.balances) console.log(`  ${b.code.padEnd(24)} ${b.kind.padEnd(20)} ${b.balance} ${b.currency}`);
      console.log(`آخر حركة V3 #${r.figures.lastTransactionId} · البصمة ${r.figuresHash}`);
      console.log(r.applied ? `✓ صورة التوقف #${r.snapshotEventId}${r.replay ? " (موجودة مسبقًا — replay)" : ""}` : "dry-run: لم يُكتب شيء");
    } else {
      const file = opt("--plan");
      if (!file || !fs.existsSync(file)) { console.error("حدد --plan <ملف JSON>"); process.exitCode = 2; return; }
      const plan = JSON.parse(fs.readFileSync(file, "utf-8"));
      const r = await recoverLegacyFromSnapshot({ tenantId, actorEmployeeId, reason, plan, apply }, db);
      for (const l of r.lines) console.log(`  ${(l.code ?? "(تصفير)").padEnd(24)} → ${l.target.padEnd(10)} قبل ${l.before} · بعد ${l.after} · الفرق ${l.delta}`);
      console.log(r.applied ? `✓ الاستعادة #${r.recoveryEventId}${r.replay ? " (منفّذة مسبقًا — replay بلا كتابة)" : " — رُفع الحظر وطابقت الأرصدة الصورة"} · الشركة ما زالت متوقفة حتى يرفع مدير المنصة الإيقاف` : "dry-run: لم يُكتب شيء");
    }
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof LegacyRecoveryError) { console.error(`✗ مرفوض [${err.code}]: ${err.message}`); process.exitCode = 3; }
    else { console.error(`✗ ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; }
  } finally {
    await new Promise<void>(resolve => { const c = (db as any).$client; if (c?.end) c.end(() => resolve()); else resolve(); });
  }
}

main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
