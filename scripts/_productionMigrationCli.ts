/**
 * B1 — وضع `--production` المشترك لسكربتات الـmigrations (0040 / 0041–0052 / 0055 / 0045). مغلق افتراضيًا.
 *   MIGRATION_PRODUCTION_ENABLED=1 DEPLOY_ENV=production node dist/scripts/migrate-00XX-*.mjs --apply --production \
 *     --backup-sha256 <sha256 للنسخة المختبرة> --confirm "APPLY 00XX TO <db> ON PRODUCTION <أول 8 من server_uuid>"
 * الهدف يجب أن يكون موثّقًا في scripts/migration-targets.json الملتزَم (فارغ افتراضيًا). لا يُطبع رابط ولا كلمة سر.
 */
import {
  appendAuditFile,
  authorizeProductionMigration,
  ProductionMigrationRefused,
  productionConfirmPhrase,
  readMigrationTargets,
  runProductionMigration,
  type ProductionAuthorization,
  type ProductionMigrationId,
  type ProductionMode,
  type RunnerOutcome,
} from "../server/productionMigration";

export async function runProductionCli(opts: {
  migrationId: ProductionMigrationId; mode: ProductionMode; args: string[]; databaseUrl: string;
  check: () => Promise<RunnerOutcome>;
  run: (auth: ProductionAuthorization) => Promise<RunnerOutcome>;
}): Promise<never> {
  const opt = (name: string): string | undefined => { const i = opts.args.indexOf(name); return i >= 0 ? opts.args[i + 1] : opts.args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1); };
  let auth: ProductionAuthorization;
  try {
    auth = authorizeProductionMigration({
      env: process.env, databaseUrl: opts.databaseUrl, migrationId: opts.migrationId, mode: opts.mode,
      confirm: opt("--confirm") ?? null, backupSha256: opt("--backup-sha256") ?? null, targets: readMigrationTargets(process.argv[1] ?? ""),
    });
  } catch (e) {
    if (e instanceof ProductionMigrationRefused) { console.error(`✗ مرفوض قبل أي اتصال: ${e.message}`); process.exit(3); }
    throw e;
  }
  const t = auth.target;
  const r = await runProductionMigration({
    auth, databaseUrl: opts.databaseUrl, check: opts.check, run: () => opts.run(auth), audit: appendAuditFile,
    rollbackHint: `--rollback --production --confirm "${productionConfirmPhrase(opts.migrationId, "rollback", t.database, t.serverUuid)}" (يتطلب allowRollback في موافقة منفصلة)`,
  });
  for (const l of r.lines) console.log(l);
  process.exit(r.ok ? 0 : r.refused ? 3 : 1);
}
