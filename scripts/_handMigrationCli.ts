/**
 * واجهة سطر أوامر مشتركة لـ 0041 / 0042 (لا أسرار في المخرجات؛ DATABASE_URL وDEPLOY_ENV من البيئة فقط).
 *   --check (افتراضي، قراءة فقط) · --apply --confirm "APPLY <id> TO <db>" · --rollback --confirm "ROLLBACK <id> TO <db>"
 *   [--drop-composite-indexes] (rollback 0041 فقط، ويُرفض إن اعتمد عليهما FK آخر) · [--json]
 * في هذه المرحلة: Docker محلي مؤقت فقط (DEPLOY_ENV=test). Staging لاحقًا بالـRunbook وبقرار منفصل.
 */
import fs from "fs";
import path from "path";
import { runHandMigration, type HandMigrationDef } from "../server/handMigration.service";
import { runProductionCli } from "./_productionMigrationCli";

export async function runHandMigrationCli(def: HandMigrationDef, sqlFile: string) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
  const modes = ["--apply", "--rollback", "--check"].filter(m => args.includes(m));
  if (modes.length > 1) { console.error("اختر وضعًا واحدًا فقط."); process.exit(2); }
  const mode = modes[0] === "--apply" ? "apply" : modes[0] === "--rollback" ? "rollback" : "check";
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const scriptDir = path.dirname(process.argv[1] ?? "");
  const candidates = [sqlFile, path.join(scriptDir, "..", sqlFile), path.join(scriptDir, "../..", sqlFile)];
  const file = candidates.find(c => fs.existsSync(c));
  if (!file) { console.error(`ملف ${sqlFile} غير موجود — شغّل الأمر من جذر المشروع`); process.exit(2); }
  const sqlText = fs.readFileSync(file, "utf-8");
  if (args.includes("--production") && mode !== "check") {
    // B1: المسار المحمي فقط — الإذن والهوية والقفل والفحص قبل/بعد والتدقيق في runProductionCli.
    const asOutcome = (r: Awaited<ReturnType<typeof runHandMigration>>) => ({ ok: r.ok, state: r.state, refused: r.refused, lines: r.lines });
    return runProductionCli({
      migrationId: def.id, mode, args, databaseUrl: url,
      check: async () => asOutcome(await runHandMigration(def, { databaseUrl: url, mode: "check", sqlText })),
      run: async auth => asOutcome(await runHandMigration(def, { databaseUrl: url, mode, sqlText, confirm: auth.confirm, production: auth, dropCompositeIndexes: args.includes("--drop-composite-indexes") })),
    });
  }
  const r = await runHandMigration(def, {
    databaseUrl: url, mode, sqlText,
    confirm: opt("--confirm") ?? null, deployEnv: process.env.DEPLOY_ENV ?? null,
    dropCompositeIndexes: args.includes("--drop-composite-indexes"),
  });
  if (args.includes("--json")) console.log(JSON.stringify({ ...r, lines: undefined }, null, 2));
  else for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : r.refused ? 3 : 1);
}
