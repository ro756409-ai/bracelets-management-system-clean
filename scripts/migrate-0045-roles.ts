/**
 * Migration 0045 (دور مدير الحسابات accounts_manager) — بلا نسخ SQL يدوي وبلا drizzle-kit.
 *   node dist/scripts/migrate-0045-roles.mjs                       # check/verify (قراءة فقط): not_applied / applied / partial
 *   DEPLOY_ENV=test node dist/scripts/migrate-0045-roles.mjs --apply --confirm "APPLY 0045 TO <db>"
 *   DEPLOY_ENV=test node dist/scripts/migrate-0045-roles.mjs --rollback --confirm "ROLLBACK 0045 TO <db>"
 * applied → replay؛ partial (شكل مختلف) → رفض بلا أي DDL؛ rollback يُرفض لو الدور مستخدم في أي عمود يخزّن الدور.
 * في هذه المرحلة: Docker محلي مؤقت فقط (DEPLOY_ENV=test). لا أسرار في المخرجات.
 */
import "dotenv/config";
import { runRoleEnumMigration } from "../server/roleEnumMigration.service";
import { runProductionCli } from "./_productionMigrationCli";

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
  const modes = ["--apply", "--rollback", "--check"].filter(m => args.includes(m));
  if (modes.length > 1) { console.error("اختر وضعًا واحدًا فقط."); process.exit(2); }
  const mode = modes[0] === "--apply" ? "apply" : modes[0] === "--rollback" ? "rollback" : "check";
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  if (args.includes("--production") && mode !== "check") {
    // B1: المسار المحمي فقط.
    const asOutcome = (r: Awaited<ReturnType<typeof runRoleEnumMigration>>) => ({ ok: r.ok, state: r.state, refused: r.refused, lines: r.lines });
    return runProductionCli({
      migrationId: "0045", mode, args, databaseUrl: url,
      check: async () => asOutcome(await runRoleEnumMigration({ databaseUrl: url, mode: "check" })),
      run: async auth => asOutcome(await runRoleEnumMigration({ databaseUrl: url, mode, confirm: auth.confirm, production: auth })),
    });
  }
  const r = await runRoleEnumMigration({ databaseUrl: url, mode, confirm: opt("--confirm") ?? null, deployEnv: process.env.DEPLOY_ENV ?? null });
  if (args.includes("--json")) console.log(JSON.stringify({ ...r, lines: undefined }, null, 2));
  else for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : r.refused ? 3 : 1);
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
