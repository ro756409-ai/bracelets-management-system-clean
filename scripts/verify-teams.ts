/**
 * تحقق 0044 (الفرق) — قراءة فقط: الحالة + المطابقة الكاملة للمواصفة (الأعمدة والأعمدة المولّدة بتعبيرها/الفهارس/
 * FK المركّبة/CHECK) أو --preflight.
 *   node dist/scripts/verify-teams.mjs [--preflight] [--json] [--i-understand-production]
 */
import "dotenv/config";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { openReadOnlyExecutor } from "../server/balanceReconciliation.service";
import { evaluate, loadSchemaSnapshot, preflight } from "../server/handMigration.service";
import { TEAMS_MIGRATION } from "../server/teamsMigration";
import { TENANT_COMPOSITE_INDEXES } from "../shared/schemaSpec";

const args = process.argv.slice(2);
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL غير مضبوط — إيقاف."); process.exit(2); }
  const target = looksLikeProductionTarget(url);
  if (target.production && !args.includes("--i-understand-production")) { console.error("قاعدة تبدو إنتاجًا — يتطلب --i-understand-production (قراءة فقط)"); process.exit(3); }
  const exec = await openReadOnlyExecutor(url);
  try {
    if (args.includes("--preflight")) {
      const rows = await preflight(exec, TEAMS_MIGRATION);
      if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.label}: ${r.actual || "—"} (متوقع ${r.expected || "—"})`);
      process.exitCode = rows.every(r => r.ok) ? 0 : 1; return;
    }
    const snap = await loadSchemaSnapshot(exec, [...TEAMS_MIGRATION.tables, ...TENANT_COMPOSITE_INDEXES.map(i => i.table)]);
    const r = evaluate(TEAMS_MIGRATION, snap);
    if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`${target.host} / ${target.database} · 0044: ${r.state} · الفهرسان: ${r.composite}`);
      if (r.state === "applied") console.log("✓ مطابق للمواصفة بالكامل (بما فيها تعبيرات الأعمدة المولّدة)");
      for (const i of r.issues) console.log(`  ✗ ${i.table} [${i.kind}] ${i.detail}`);
    }
    process.exitCode = r.state === "partial" ? 1 : 0;
  } finally { await exec.close(); }
}
main().catch(err => { console.error("فشل التشغيل:", err instanceof Error ? err.message : String(err)); process.exit(2); });
