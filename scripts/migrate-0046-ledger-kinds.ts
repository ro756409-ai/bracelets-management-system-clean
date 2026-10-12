/**
 * Migration 0046 (نوعا حساب الدفتر payroll_payable / supplier_advance) — بلا نسخ SQL يدوي وبلا drizzle-kit. يتطلب 0040.
 *   node dist/scripts/migrate-0046-ledger-kinds.mjs                      # check/verify (قراءة فقط)
 *   DEPLOY_ENV=test node dist/scripts/migrate-0046-ledger-kinds.mjs --apply --confirm "APPLY 0046 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0046-ledger-kinds.mjs --rollback --confirm "ROLLBACK 0046 TO <db>"
 * applied → replay؛ partial → رفض بلا أي DDL؛ rollback يُرفض لو حساب يستخدم نوعًا جديدًا. في هذه المرحلة: Docker محلي مؤقت فقط.
 */
import "dotenv/config";
import { runLedgerKindsMigration } from "../server/ledgerKindsMigration.service";

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
  const modes = ["--apply", "--rollback", "--check"].filter(m => args.includes(m));
  if (modes.length > 1) { console.error("اختر وضعًا واحدًا فقط."); process.exit(2); }
  const mode = modes[0] === "--apply" ? "apply" : modes[0] === "--rollback" ? "rollback" : "check";
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const r = await runLedgerKindsMigration({ databaseUrl: url, mode, confirm: opt("--confirm") ?? null, deployEnv: process.env.DEPLOY_ENV ?? null });
  if (args.includes("--json")) console.log(JSON.stringify({ ...r, lines: undefined }, null, 2));
  else for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : r.refused ? 3 : 1);
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
