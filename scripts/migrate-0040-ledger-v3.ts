/**
 * تطبيق الترحيلة 0040 (Ledger V3) على Staging — بلا نسخ SQL يدوي وبلا drizzle-kit.
 *
 *   node scripts/migrate-0040-ledger-v3.cjs --check                                            # افتراضي، قراءة فقط
 *   node scripts/migrate-0040-ledger-v3.cjs --apply --confirm "APPLY LEDGER V3 0040 TO <database>"
 *
 * (داخل صورة النشر يُشغَّل بـnode العادي عبر النسخة المبنية dist/scripts؛ في التطوير: corepack pnpm tsx scripts/migrate-0040-ledger-v3.ts)
 * DATABASE_URL وDEPLOY_ENV من البيئة فقط؛ لا يُطبع الرابط ولا كلمة السر. --apply يشترط DEPLOY_ENV=staging وقاعدة
 * غير إنتاجية باسم يدل على Staging. applied مسبقًا → replay؛ partial → توقف بلا إكمال.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { runMigrate0040 } from "../server/ledgerV3Migrate.service";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };

/** ملف 0040 يُقرأ من جذر المشروع (cwd) أو نسبةً إلى موقع السكربت (scripts/ أو dist/scripts/). */
function readMigrationSql(): string {
  const scriptDir = path.dirname(process.argv[1] ?? "");
  const candidates = ["drizzle/0040_ledger_v3.sql", path.join(scriptDir, "../drizzle/0040_ledger_v3.sql"), path.join(scriptDir, "../../drizzle/0040_ledger_v3.sql")];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, "utf-8");
  throw new Error("ملف drizzle/0040_ledger_v3.sql غير موجود — شغّل الأمر من جذر المشروع (/app)");
}

async function main() {
  const apply = args.includes("--apply");
  if (apply && args.includes("--check")) { console.error("--apply و--check معًا غير مسموح."); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const r = await runMigrate0040({ databaseUrl: url, mode: apply ? "apply" : "check", sqlText: readMigrationSql(), confirm: opt("--confirm") ?? null, deployEnv: process.env.DEPLOY_ENV ?? null });
  if (args.includes("--json")) console.log(JSON.stringify({ ...r, lines: undefined }, null, 2));
  else for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : r.refused ? 3 : 1);
}

main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
