/**
 * B1 — وضع `--production` المشترك لسكربتات الـmigrations (0040 / 0041–0052 / 0055 / 0045). مغلق افتراضيًا.
 *   MIGRATION_PRODUCTION_ENABLED=1 DEPLOY_ENV=production node dist/scripts/migrate-00XX-*.mjs --apply --production \
 *     --approval-file /tmp/<ملف مؤقت 600 خارج المستودع> --backup-sha256 <sha256 للنسخة المختبرة> \
 *     --confirm "APPLY 00XX TO <db> ON PRODUCTION <approvalRef>"
 * الموافقة من ملف وقت التشغيل فقط؛ scripts/migration-targets.json يبقى فارغًا في Git. لا يُطبع رابط ولا كلمة سر ولا
 * server_uuid ولا محتوى ملف الموافقة.
 */
import path from "path";
import {
  appendAuditFile,
  assertProductionEnabled,
  authorizeProductionMigration,
  ProductionMigrationRefused,
  readApprovalFile,
  runProductionMigration,
  type ProductionAuthorization,
  type ProductionMigrationId,
  type ProductionMode,
  type RunnerOutcome,
} from "../server/productionMigration";

/** جذر المستودع/التطبيق: المجلد الأب لـscripts/ أو dist/scripts/ (يُستخدم لرفض ملف موافقة داخله). */
function repoRootOf(scriptPath: string): string {
  const dir = path.dirname(path.resolve(scriptPath));
  return path.basename(path.dirname(dir)) === "dist" ? path.dirname(path.dirname(dir)) : path.dirname(dir);
}

export async function runProductionCli(opts: {
  migrationId: ProductionMigrationId; mode: ProductionMode; args: string[]; databaseUrl: string;
  check: () => Promise<RunnerOutcome>;
  run: (auth: ProductionAuthorization) => Promise<RunnerOutcome>;
}): Promise<never> {
  const opt = (name: string): string | undefined => { const i = opts.args.indexOf(name); return i >= 0 ? opts.args[i + 1] : opts.args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
  let auth: ProductionAuthorization;
  try {
    assertProductionEnabled(process.env);
    // الموافقة من ملف محلي مؤقت خارج المستودع (600) — لا يُطبع أي جزء من محتواه.
    const approval = readApprovalFile(opt("--approval-file"), { repoRoot: repoRootOf(process.argv[1] ?? ""), cwd: process.cwd() });
    auth = authorizeProductionMigration({
      env: process.env, databaseUrl: opts.databaseUrl, migrationId: opts.migrationId, mode: opts.mode,
      confirm: opt("--confirm") ?? null, backupSha256: opt("--backup-sha256") ?? null, targets: approval.targets, approvalFileSha256: approval.sha256,
    });
  } catch (e) {
    if (e instanceof ProductionMigrationRefused) { console.error(`✗ مرفوض قبل أي اتصال: ${e.message}`); process.exit(3); }
    throw e;
  }
  const r = await runProductionMigration({
    auth, databaseUrl: opts.databaseUrl, check: opts.check, run: () => opts.run(auth), audit: appendAuditFile,
    rollbackHint: `--rollback --production --approval-file <ملف موافقة rollback> --confirm "ROLLBACK ${opts.migrationId} TO <القاعدة> ON PRODUCTION <approvalRef>" (يتطلب allowRollback في موافقة منفصلة)`,
  });
  for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : r.refused ? 3 : 1);
}
