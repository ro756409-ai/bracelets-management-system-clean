import mysql from "mysql2/promise";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { splitMigrationStatements, type ApplicationState, type VerifyIssue } from "../shared/ledgerV3Spec";
import { openReadOnlyExecutor } from "./balanceReconciliation.service";
import { verifyLedgerV3OnDatabase } from "./ledgerV3Verify.service";

/**
 * تطبيق الترحيلة 0040 (Ledger V3) تشغيليًا — بلا نسخ SQL يدوي وبلا drizzle-kit:
 *   • `check` (افتراضي، قراءة فقط): حالة التطبيق not_applied / partial / applied + جدول حالة العبارات التسع.
 *   • `apply`: بوابات قبل أي اتصال كتابة: DEPLOY_ENV=staging، الهدف ليس إنتاجًا، اسم القاعدة يدل على Staging،
 *     وعبارة تأكيد تتضمن اسم القاعدة. ثم: applied → replay بلا تغيير؛ partial → توقف وعرض المنفَّذ والناقص بلا
 *     إكمال تلقائي؛ not_applied → تنفيذ العبارات التسع بالترتيب مع تحقق بعد كل عبارة، ثم تحقق المواصفة كاملًا.
 *   • لا يُرجع ولا يطبع الرابط أو كلمة السر — المضيف واسم القاعدة فقط. (DDL في MySQL غير معاملاتي: التوقف
 *     عند أول خطأ يترك حالة partial تُعرض في التشغيل التالي.)
 */
export type MigrateMode = "check" | "apply";
export type StatementStatus = { n: number; kind: "index" | "table"; table: string; name: string; present: boolean };
export type MigrateResult = {
  ok: boolean;
  mode: MigrateMode;
  target: { host: string; database: string };
  state: ApplicationState | null;
  statements: StatementStatus[];
  issues: VerifyIssue[];
  /** replay = كانت مطبَّقة مسبقًا ولم يُنفَّذ شيء */
  replay: boolean;
  applied: number;
  refused: string | null;
  lines: string[];
};

export const migrationConfirmationPhrase = (database: string) => `APPLY LEDGER V3 0040 TO ${database}`;

/** وصف كل عبارة من ملف 0040 (فهرس فريد أو جدول) — يُستخرج من نص العبارة نفسه، لا من قائمة مكتوبة يدويًا. */
export function describeStatements(sqlText: string): { kind: "index" | "table"; table: string; name: string; sql: string }[] {
  return splitMigrationStatements(sqlText).map(sql => {
    const idx = sql.match(/ALTER TABLE `([^`]+)`\s+ADD UNIQUE INDEX `([^`]+)`/i);
    if (idx) return { kind: "index" as const, table: idx[1], name: idx[2], sql };
    const tbl = sql.match(/CREATE TABLE `([^`]+)`/i);
    if (tbl) return { kind: "table" as const, table: tbl[1], name: tbl[1], sql };
    throw new Error(`عبارة غير متوقعة في ملف 0040 (لا ALTER TABLE ADD UNIQUE INDEX ولا CREATE TABLE): ${sql.slice(0, 60)}…`);
  });
}

async function presence(conn: mysql.Connection, s: { kind: "index" | "table"; table: string; name: string }): Promise<boolean> {
  const [rows] = s.kind === "table"
    ? await conn.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [s.name])
    : await conn.query("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [s.table, s.name]);
  return Number((rows as any)[0]?.n ?? 0) > 0;
}

async function statementTable(conn: mysql.Connection, sqlText: string): Promise<StatementStatus[]> {
  const out: StatementStatus[] = [];
  for (const [i, s] of describeStatements(sqlText).entries()) out.push({ n: i + 1, kind: s.kind, table: s.table, name: s.name, present: await presence(conn, s) });
  return out;
}

const fmt = (s: StatementStatus) => `  ${s.present ? "✓" : "✗"} [${s.n}/9] ${s.kind === "index" ? `فهرس فريد ${s.table}.${s.name}` : `جدول ${s.name}`} — ${s.present ? "منفَّذ" : "ناقص"}`;

const looksLikeStaging = (database: string) => /staging|stage|test/i.test(database);

export async function runMigrate0040(opts: { databaseUrl: string; mode: MigrateMode; sqlText: string; confirm?: string | null; deployEnv?: string | null }): Promise<MigrateResult> {
  const target = looksLikeProductionTarget(opts.databaseUrl);
  const lines: string[] = [`الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""} · الوضع: ${opts.mode === "apply" ? "APPLY" : "check (قراءة فقط)"}`];
  const base: MigrateResult = { ok: false, mode: opts.mode, target: { host: target.host, database: target.database }, state: null, statements: [], issues: [], replay: false, applied: 0, refused: null, lines };
  const refuse = (why: string): MigrateResult => { lines.push(`✗ مرفوض قبل أي DDL: ${why}`); return { ...base, refused: why, lines }; };

  if (opts.mode === "apply") {
    if (opts.deployEnv !== "staging") return refuse(`DEPLOY_ENV يجب أن يكون staging (الحالي: ${opts.deployEnv || "غير مضبوط"})`);
    if (target.production) return refuse("القاعدة تبدو إنتاجًا (مضيف غير محلي واسم بلا staging/test)");
    if (!looksLikeStaging(target.database)) return refuse(`اسم القاعدة «${target.database}» لا يدل على Staging (يجب أن يحوي staging أو stage أو test)`);
    const expected = migrationConfirmationPhrase(target.database);
    if ((opts.confirm ?? "") !== expected) return refuse(`عبارة التأكيد غير مطابقة — المطلوب حرفيًا: ${expected}`);
  }

  // قراءة الحالة (اتصال قراءة فقط)
  const exec = await openReadOnlyExecutor(opts.databaseUrl);
  let state: ApplicationState, issues: VerifyIssue[];
  try { ({ state, issues } = await verifyLedgerV3OnDatabase(exec)); } finally { await exec.close(); }
  const conn = await mysql.createConnection(opts.databaseUrl);
  try {
    let statements = await statementTable(conn, opts.sqlText);
    lines.push(`حالة 0040: ${state === "applied" ? "مطبَّقة" : state === "not_applied" ? "غير مطبَّقة" : "⚠️ جزئية"}`);
    for (const s of statements) lines.push(fmt(s));

    if (opts.mode === "check") {
      if (state === "applied") lines.push(issues.length === 0 ? "✓ مطابق بالكامل لمواصفة ledgerV3Spec" : `✗ مطبَّقة لكن ${issues.length} فرق عن المواصفة`);
      for (const i of issues) lines.push(`  ✗ ${i.table} [${i.kind}] ${i.detail}`);
      return { ...base, ok: state !== "partial" && !(state === "applied" && issues.length > 0), state, statements, issues, lines };
    }

    if (state === "applied") {
      lines.push(issues.length === 0 ? "↻ مطبَّقة مسبقًا — replay آمن بلا أي تغيير · ✓ مطابق بالكامل" : `↻ مطبَّقة مسبقًا لكن ${issues.length} فرق عن المواصفة — لا تغيير تلقائي`);
      for (const i of issues) lines.push(`  ✗ ${i.table} [${i.kind}] ${i.detail}`);
      return { ...base, ok: issues.length === 0, state, statements, issues, replay: true, lines };
    }
    if (state === "partial") {
      lines.push("⚠️ تطبيق جزئي: لا إكمال تلقائي — راجع العبارات المنفَّذة والناقصة أعلاه ثم قرّر (استعادة النسخة الاحتياطية أو إكمال يدوي مراجَع)");
      return { ...base, ok: false, state, statements, issues, refused: "partial", lines };
    }

    // not_applied → تنفيذ بالترتيب مع تحقق بعد كل عبارة
    const described = describeStatements(opts.sqlText);
    let applied = 0;
    for (const [i, s] of described.entries()) {
      try {
        await conn.query(s.sql);
      } catch (e: any) {
        lines.push(`✗ فشلت العبارة [${i + 1}/9] (${s.kind === "index" ? `فهرس ${s.table}.${s.name}` : `جدول ${s.name}`}): ${e?.code ?? "ERR"} — ${String(e?.sqlMessage ?? e?.message ?? e)}`);
        statements = await statementTable(conn, opts.sqlText);
        return { ...base, ok: false, state: "partial", statements, issues, applied, refused: `statement ${i + 1}`, lines };
      }
      if (!(await presence(conn, s))) {
        lines.push(`✗ العبارة [${i + 1}/9] نُفِّذت بلا خطأ لكن الكائن غير موجود بعدها — توقف`);
        statements = await statementTable(conn, opts.sqlText);
        return { ...base, ok: false, state: "partial", statements, issues, applied, refused: `verify ${i + 1}`, lines };
      }
      applied++;
      lines.push(`  ✓ [${i + 1}/9] ${s.kind === "index" ? `فهرس فريد ${s.table}.${s.name}` : `جدول ${s.name}`} — نُفِّذ وتحقّق`);
    }
    const exec2 = await openReadOnlyExecutor(opts.databaseUrl);
    let after: { state: ApplicationState; issues: VerifyIssue[] };
    try { after = await verifyLedgerV3OnDatabase(exec2); } finally { await exec2.close(); }
    statements = await statementTable(conn, opts.sqlText);
    if (after.state === "applied" && after.issues.length === 0) lines.push("✓ 0040 مطبَّقة · ✓ مطابق بالكامل لمواصفة ledgerV3Spec");
    else { lines.push(`✗ بعد التنفيذ: الحالة ${after.state} مع ${after.issues.length} فرق`); for (const i of after.issues) lines.push(`  ✗ ${i.table} [${i.kind}] ${i.detail}`); }
    return { ...base, ok: after.state === "applied" && after.issues.length === 0, state: after.state, statements, issues: after.issues, applied, lines };
  } finally {
    await conn.end();
  }
}
