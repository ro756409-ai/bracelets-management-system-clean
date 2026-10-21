import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { openReadOnlyExecutor, type ReadOnlyExecutor } from "./balanceReconciliation.service";

/**
 * B1 — المسار المحمي لتطبيق الـmigrations المكتوبة يدويًا على Production. **مغلق افتراضيًا**.
 *
 * كل runner (0040 / 0041–0052 / 0055 / 0045) يرفض أي هدف إنتاجي كما كان. الاستثناء الوحيد: «إذن إنتاج» تصدره
 * `authorizeProductionMigration` بعد استيفاء كل البوابات، ولا يُقبل إلا كما صدر (سجل خاص بالوحدة — كائن مُعاد
 * بناؤه بنفس الحقول لا يُعتبر إذنًا)، ولنفس الـmigration ونفس الوضع ونفس الهدف.
 *
 * بوابات قبل أي اتصال (نقية):
 *  1. `MIGRATION_PRODUCTION_ENABLED=1` لهذا التشغيل فقط (الافتراضي: غير مضبوط).
 *  2. `DEPLOY_ENV=production`.
 *  3. الموافقة تُقدَّم وقت التشغيل فقط من ملف محلي مؤقت `--approval-file` **خارج المستودع**: مسار مطلق، ملف عادي (لا
 *     symlink)، مملوك لنفس المستخدم، وصلاحياته 600 بالضبط — وإلا رفض آمن بلا عرض محتواه. `scripts/migration-targets.json`
 *     يبقى فارغًا في Git ولا يُقرأ للإنتاج. داخل الموافقة: المضيف/المنفذ/القاعدة مطابقة حرفيًا للرابط، و`serverUuid`،
 *     و`approvedBy`/`approvalRef`، ونافذة صلاحية ≤ 24 ساعة، وقائمة الـmigrations المسموحة. اسم قاعدة وحده لا يكفي أبدًا.
 *  4. بصمة النسخة الاحتياطية `--backup-sha256` = المسجلة في الموافقة، مع `backupRestoreVerifiedAt` خلال 24 ساعة.
 *  5. عبارة تأكيد حرفية: `APPLY 00XX TO <database> ON PRODUCTION <approvalRef>`.
 *  6. rollback على Production مرفوض إلا لو الموافقة تنص عليه صراحة (`allowRollback: true`).
 * بعد الاتصال (`runProductionMigration`): @@server_uuid وDATABASE() = الموثّق، ثم قفل واحد
 * `GET_LOCK('matjarak_hand_migrations', 0)`، ثم check قبل → التنفيذ → check بعد (لازم `applied`)، ثم سطر تدقيق JSON
 * بلا رابط ولا مستخدم ولا كلمة سر ولا server_uuid ولا محتوى ملف الموافقة (بصمة الملف فقط).
 */

export const PRODUCTION_MIGRATION_ENABLE_ENV = "MIGRATION_PRODUCTION_ENABLED";
export const PRODUCTION_MIGRATION_LOCK = "matjarak_hand_migrations";
export const MIGRATION_TARGETS_FILE = "scripts/migration-targets.json";
export const MAX_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

export type ProductionMigrationId = "0040" | "0041" | "0042" | "0043" | "0044" | "0045" | "0046" | "0047" | "0048" | "0049" | "0050" | "0051" | "0052" | "0055";
export type ProductionMode = "apply" | "rollback";
export type MigrationTarget = {
  id: string;
  host: string; port: number; database: string; serverUuid: string;
  migrations: ProductionMigrationId[];
  approvedBy: string; approvalRef: string; approvedAt: string; expiresAt: string;
  backupSha256: string; backupRestoreVerifiedAt: string;
  allowRollback?: boolean;
};
export type MigrationTargets = { version: 1; targets: MigrationTarget[] };

export type ProductionAuthorization = Readonly<{
  migrationId: ProductionMigrationId; mode: ProductionMode;
  target: Readonly<MigrationTarget>; backupSha256: string; confirm: string; approvalFileSha256: string | null;
}>;

const ISSUED = new WeakSet<object>();
/** هل هذا إذن صادر فعلًا من `authorizeProductionMigration` (لا نسخة مصنوعة يدويًا)؟ */
export function isProductionAuthorization(x: unknown): x is ProductionAuthorization {
  return typeof x === "object" && x !== null && ISSUED.has(x);
}

export const productionConfirmPhrase = (id: ProductionMigrationId, mode: ProductionMode, database: string, approvalRef: string) =>
  `${mode === "apply" ? "APPLY" : "ROLLBACK"} ${id} TO ${database} ON PRODUCTION ${approvalRef}`;

export class ProductionMigrationRefused extends Error {}
const refuse = (why: string): never => { throw new ProductionMigrationRefused(why); };

function urlIdentity(databaseUrl: string): { host: string; port: number; database: string } {
  let u: URL;
  try { u = new URL(databaseUrl); } catch { return refuse("رابط الاتصال غير صالح"); }
  return { host: u.hostname, port: Number(u.port || 3306), database: u.pathname.replace(/^\//, "") };
}

/** البوابة 1 وحدها: المسار مغلق ما لم يُفعَّل صراحة لهذا التشغيل (تُفحص قبل قراءة أي ملف). */
export function assertProductionEnabled(env: NodeJS.ProcessEnv): void {
  if (env[PRODUCTION_MIGRATION_ENABLE_ENV] !== "1") refuse(`تطبيق الـmigrations على Production معطّل افتراضيًا — يحتاج ${PRODUCTION_MIGRATION_ENABLE_ENV}=1 لهذا التشغيل`);
}

/** البوابات 1–6 (بلا اتصال). ترجع إذنًا لا يُزوَّر أو ترمي سببًا واضحًا. */
export function authorizeProductionMigration(input: {
  env: NodeJS.ProcessEnv; databaseUrl: string; migrationId: ProductionMigrationId; mode: ProductionMode;
  confirm: string | null | undefined; backupSha256: string | null | undefined; targets: MigrationTargets; now?: Date;
  /** بصمة ملف الموافقة (للتدقيق فقط — لا محتواه) */ approvalFileSha256?: string | null;
}): ProductionAuthorization {
  const now = (input.now ?? new Date()).getTime();
  assertProductionEnabled(input.env);
  if (input.env.DEPLOY_ENV !== "production") refuse(`DEPLOY_ENV يجب أن يكون production (الحالي: ${input.env.DEPLOY_ENV || "غير مضبوط"})`);
  const id = urlIdentity(input.databaseUrl);
  if (!input.targets || input.targets.version !== 1 || !Array.isArray(input.targets.targets)) refuse("ملف الأهداف المعتمدة غير صالح");
  const t = input.targets.targets.find(x => x.host === id.host && Number(x.port) === id.port && x.database === id.database);
  if (!t) refuse("الهدف غير موثّق في الأهداف المعتمدة (المضيف/المنفذ/القاعدة يجب أن تطابق حرفيًا)");
  const target = t!;
  if (!target.approvedBy || !/^[A-Za-z0-9._-]{3,64}$/.test(target.approvalRef ?? "")) refuse("الموافقة بلا approvedBy أو approvalRef صالح (حروف/أرقام . _ - من 3 إلى 64)");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.serverUuid ?? "")) refuse("الموافقة بلا serverUuid صالح");
  if (!target.migrations?.includes(input.migrationId)) refuse(`الموافقة لا تشمل ${input.migrationId}`);
  const from = Date.parse(target.approvedAt), to = Date.parse(target.expiresAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) refuse("نافذة الموافقة غير صالحة");
  if (to - from > MAX_APPROVAL_WINDOW_MS) refuse("نافذة الموافقة أطول من 24 ساعة — موافقة جديدة لكل يوم تنفيذ");
  if (now < from || now > to) refuse("الموافقة منتهية أو لم تبدأ بعد");
  if (!/^[0-9a-f]{64}$/.test(target.backupSha256 ?? "")) refuse("الموافقة بلا بصمة نسخة احتياطية صالحة (sha256)");
  if ((input.backupSha256 ?? "").toLowerCase() !== target.backupSha256) refuse("بصمة النسخة الاحتياطية لا تطابق النسخة المعتمدة في الموافقة");
  const verified = Date.parse(target.backupRestoreVerifiedAt);
  if (!Number.isFinite(verified) || verified > now || now - verified > MAX_BACKUP_AGE_MS) refuse("اختبار استعادة النسخة الاحتياطية غير مسجّل أو أقدم من 24 ساعة");
  if (input.mode === "rollback" && target.allowRollback !== true) refuse("rollback على Production غير مسموح في هذه الموافقة");
  const expected = productionConfirmPhrase(input.migrationId, input.mode, target.database, target.approvalRef);
  if ((input.confirm ?? "") !== expected) refuse(`عبارة التأكيد غير مطابقة — الصيغة: ${input.mode === "apply" ? "APPLY" : "ROLLBACK"} ${input.migrationId} TO <القاعدة> ON PRODUCTION <approvalRef>`);
  const auth: ProductionAuthorization = Object.freeze({ migrationId: input.migrationId, mode: input.mode, target: Object.freeze({ ...target }), backupSha256: target.backupSha256, confirm: expected, approvalFileSha256: input.approvalFileSha256 ?? null });
  ISSUED.add(auth);
  return auth;
}

/**
 * للـrunners: يقبل الهدف الإنتاجي فقط بإذن صادر لنفس الـmigration والوضع والهدف (المضيف/المنفذ/القاعدة).
 * يرجع null (مسموح) أو سبب الرفض.
 */
export function productionGate(production: unknown, migrationId: ProductionMigrationId, mode: ProductionMode, databaseUrl: string, confirm: string | null | undefined): string | null {
  if (!isProductionAuthorization(production)) return "إذن Production غير صالح (لم يصدر من المسار المحمي)";
  if (production.migrationId !== migrationId || production.mode !== mode) return "إذن Production لا يخص هذه الـmigration أو هذا الوضع";
  const id = urlIdentity(databaseUrl);
  if (id.host !== production.target.host || id.port !== Number(production.target.port) || id.database !== production.target.database) return "إذن Production لهدف آخر";
  if ((confirm ?? "") !== production.confirm) return "عبارة التأكيد غير مطابقة لإذن Production";
  return null;
}

/**
 * ملف الموافقة وقت التشغيل (B1): مسار مطلق خارج المستودع ودليل العمل، ملف عادي غير symlink، مملوك لنفس المستخدم،
 * وصلاحياته 600 بالضبط، وفيه موافقة واحدة. أي خلل = رفض آمن برسالة لا تعرض أي جزء من المحتوى.
 * يرجع الموافقة + بصمة sha256 للملف (للتدقيق).
 */
export function readApprovalFile(file: string | null | undefined, opts: { repoRoot: string; cwd?: string; uid?: number | null } = { repoRoot: process.cwd() }): { targets: MigrationTargets; sha256: string } {
  if (!file) return refuse("ملف الموافقة مطلوب: --approval-file <مسار مطلق لملف خارج المستودع بصلاحيات 600>");
  if (!path.isAbsolute(file)) return refuse("مسار ملف الموافقة يجب أن يكون مطلقًا");
  const abs = path.resolve(file);
  const inside = (root: string) => { const r = path.resolve(root); return abs === r || abs.startsWith(r + path.sep); };
  if (inside(opts.repoRoot) || (opts.cwd && inside(opts.cwd))) return refuse("ملف الموافقة يجب أن يكون خارج المستودع ودليل التشغيل");
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return refuse("ملف الموافقة غير موجود أو لا يمكن قراءته"); }
  if (st.isSymbolicLink() || !st.isFile()) return refuse("ملف الموافقة يجب أن يكون ملفًا عاديًا (لا symlink)");
  if ((st.mode & 0o777) !== 0o600) return refuse("صلاحيات ملف الموافقة غير آمنة — المطلوب 600 بالضبط");
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid !== null && st.uid !== uid) return refuse("ملف الموافقة غير مملوك لمستخدم التشغيل");
  let bytes: Buffer;
  try { bytes = fs.readFileSync(abs); } catch { return refuse("ملف الموافقة لا يمكن قراءته"); }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf-8")); } catch { return refuse("ملف الموافقة ليس JSON صالحًا"); }
  const t = parsed as MigrationTargets;
  if (!t || t.version !== 1 || !Array.isArray(t.targets) || t.targets.length !== 1) return refuse("ملف الموافقة يجب أن يحوي موافقة واحدة بصيغة {version:1, targets:[…]}");
  return { targets: t, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export type RunnerOutcome = { ok: boolean; state: string | null; refused: string | null; lines: string[] };
export type AuditRecord = {
  at: string; migration: ProductionMigrationId; mode: ProductionMode; approvalRef: string; approvalFileSha256Prefix: string | null;
  backupVerified: boolean; before: string | null; after: string | null; ok: boolean; refused: string | null; durationMs: number;
};

/**
 * المسار الكامل بعد الإذن: هوية الخادم ← القفل ← check قبل ← التنفيذ ← check بعد ← تدقيق.
 * `check`/`run` هما الـrunner نفسه (نفس منطق الحالة والـreplay والرفض الموجود).
 */
export async function runProductionMigration(opts: {
  auth: ProductionAuthorization; databaseUrl: string;
  check: () => Promise<RunnerOutcome>; run: () => Promise<RunnerOutcome>;
  rollbackHint: string; audit?: (rec: AuditRecord) => void; openExecutor?: (url: string) => Promise<ReadOnlyExecutor>;
}): Promise<{ ok: boolean; refused: string | null; lines: string[]; audit: AuditRecord }> {
  const started = Date.now();
  const { auth } = opts;
  const lines: string[] = [`Production · ${auth.migrationId} · ${auth.mode} · موافقة ${auth.target.approvalRef}`];
  let before: string | null = null, after: string | null = null, refused: string | null = null, ok = false;
  const finish = () => {
    const rec: AuditRecord = { at: new Date().toISOString(), migration: auth.migrationId, mode: auth.mode, approvalRef: auth.target.approvalRef, approvalFileSha256Prefix: auth.approvalFileSha256 ? auth.approvalFileSha256.slice(0, 12) : null, backupVerified: true, before, after, ok, refused, durationMs: Date.now() - started };
    lines.push(`AUDIT ${JSON.stringify(rec)}`);
    opts.audit?.(rec);
    return { ok, refused, lines, audit: rec };
  };
  if (!isProductionAuthorization(auth)) { refused = "إذن Production غير صالح"; lines.push(`✗ ${refused}`); return finish(); }
  const lockExec = await (opts.openExecutor ?? openReadOnlyExecutor)(opts.databaseUrl);
  let locked = false;
  try {
    const [id] = await lockExec.query<{ uuid: string; db: string }>("SELECT @@server_uuid AS uuid, DATABASE() AS db");
    if (!id || id.uuid !== auth.target.serverUuid || id.db !== auth.target.database) {
      refused = "هوية الخادم/القاعدة (server_uuid / DATABASE()) لا تطابق الموافقة — توقف قبل أي DDL"; lines.push(`✗ ${refused}`); return finish();
    }
    const [l] = await lockExec.query<{ got: number | null }>("SELECT GET_LOCK(?, 0) AS got", [PRODUCTION_MIGRATION_LOCK]);
    if (Number(l?.got) !== 1) { refused = "تشغيل آخر يحمل قفل الـmigrations — توقف قبل أي DDL"; lines.push(`✗ ${refused}`); return finish(); }
    locked = true;
    const pre = await opts.check();
    before = pre.state; lines.push(...pre.lines.map(x => `  [قبل] ${x}`));
    if (!pre.ok || before === null) { refused = `فحص ما قبل التنفيذ: ${before ?? "تعذّر"}`; lines.push(`✗ ${refused}`); return finish(); }
    const res = await opts.run();
    lines.push(...res.lines.map(x => `  ${x}`));
    const post = await opts.check();
    after = post.state; lines.push(...post.lines.map(x => `  [بعد] ${x}`));
    const wanted = auth.mode === "apply" ? "applied" : "not_applied";
    ok = res.ok && post.ok && after === wanted;
    if (!ok) { refused = res.refused ?? `الحالة بعد التنفيذ ${after ?? "?"} (المطلوب ${wanted})`; lines.push(`✗ ${refused}`); if (auth.mode === "apply") lines.push(`↩ للتراجع (بموافقة rollback منفصلة): ${opts.rollbackHint}`); }
    else lines.push(`✓ ${auth.migrationId} ${auth.mode === "apply" ? "مطبَّقة" : "متراجَع عنها"} على Production ومتحقَّق منها`);
    return finish();
  } finally {
    if (locked) await lockExec.query("SELECT RELEASE_LOCK(?) AS r", [PRODUCTION_MIGRATION_LOCK]).catch(() => {});
    await lockExec.close().catch(() => {});
  }
}

/** سطر التدقيق في ملف داخل الحاوية (اختياري) — فشل الكتابة لا يوقف التشغيل والسطر مطبوع على stdout دائمًا. */
export function appendAuditFile(rec: AuditRecord, file = process.env.MIGRATION_AUDIT_LOG || "migration-audit.log"): void {
  try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch { /* stdout يكفي */ }
}
