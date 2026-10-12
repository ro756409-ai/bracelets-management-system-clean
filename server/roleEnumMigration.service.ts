import mysql from "mysql2/promise";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import {
  ACCOUNTS_MANAGER_ROLE, EMPLOYEE_ROLE_ENUM_AFTER_0045, EMPLOYEE_ROLE_ENUM_BEFORE_0045, ROLE_REFERENCE_COLUMNS, enumColumnType,
} from "../shared/employeeRoleEnumSpec";
import { migrationGate } from "./handMigration.service";

/**
 * Migration 0045 (دور accounts_manager) — نفس انضباط المحرّك اليدوي، لعبارة «تعديل ENUM» واحدة:
 *   • check (افتراضي، قراءة فقط): يقرأ تعريف employees.role ويحكم: not_applied (التعريف القديم حرفيًا) / applied
 *     (الجديد حرفيًا) / partial (أي شكل آخر: قيم أو ترتيب مختلف، nullable، افتراضي مختلف، تعليق، EXTRA).
 *   • apply: بوابات البيئة والتأكيد قبل أي اتصال كتابة؛ applied ⇒ replay بلا تغيير؛ partial ⇒ رفض بلا DDL؛
 *     not_applied ⇒ ALTER واحد يعيد charset/collation العمود الحالية صراحةً، ثم تحقق أن كل الخصائص كما هي.
 *   • rollback: نفس البوابات + يُرفض لو أي عمود يخزّن الدور (ROLE_REFERENCE_COLUMNS) يستخدم القيمة الجديدة.
 *   • لا يطبع ولا يرجع أي رابط أو كلمة سر.
 */
export type RoleEnumState = "not_applied" | "applied" | "partial";
export type RoleColumn = { columnType: string; nullable: boolean; defaultValue: string | null; charset: string | null; collation: string | null; comment: string; extra: string };
export type RoleEnumResult = {
  ok: boolean; mode: "check" | "apply" | "rollback"; target: { host: string; database: string };
  state: RoleEnumState | null; column: RoleColumn | null; issues: string[]; replay: boolean; applied: boolean; refused: string | null; lines: string[];
};

export const BEFORE_TYPE = enumColumnType(EMPLOYEE_ROLE_ENUM_BEFORE_0045);
export const AFTER_TYPE = enumColumnType(EMPLOYEE_ROLE_ENUM_AFTER_0045);

async function readRoleColumn(conn: mysql.Connection): Promise<RoleColumn | null> {
  const [r] = await conn.query(`SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT, EXTRA
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'role'`);
  const c = (r as any[])[0];
  if (!c) return null;
  return { columnType: String(c.COLUMN_TYPE), nullable: c.IS_NULLABLE === "YES", defaultValue: c.COLUMN_DEFAULT == null ? null : String(c.COLUMN_DEFAULT).replace(/^'(.*)'$/, "$1"),
    charset: c.CHARACTER_SET_NAME ?? null, collation: c.COLLATION_NAME ?? null, comment: String(c.COLUMN_COMMENT ?? ""), extra: String(c.EXTRA ?? "") };
}

/** الحكم على التعريف (نقي): الخصائص الثابتة يجب أن تطابق، والنوع يحدد الحالة. */
export function evaluateRoleColumn(c: RoleColumn | null): { state: RoleEnumState; issues: string[] } {
  if (!c) return { state: "partial", issues: ["العمود employees.role غير موجود"] };
  const issues: string[] = [];
  if (c.nullable) issues.push("employees.role يقبل NULL (المتوقع NOT NULL)");
  if (c.defaultValue !== "agent") issues.push(`القيمة الافتراضية ${c.defaultValue ?? "NULL"} (المتوقع 'agent')`);
  if (c.comment) issues.push("للعمود تعليق غير متوقع");
  if (c.extra) issues.push(`EXTRA غير متوقع: ${c.extra}`);
  if (c.columnType !== BEFORE_TYPE && c.columnType !== AFTER_TYPE) issues.push(`تعريف ENUM مختلف عن المتوقع: ${c.columnType}`);
  if (issues.length) return { state: "partial", issues };
  return { state: c.columnType === AFTER_TYPE ? "applied" : "not_applied", issues };
}

const ident = (s: string) => { if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`قيمة غير صالحة في التعريف: ${s}`); return s; };
/** نص ALTER — يعيد charset/collation الحالية للعمود صراحةً حتى لا تتغير. */
export function alterRoleSql(type: string, c: Pick<RoleColumn, "charset" | "collation">): string {
  const cs = c.charset && c.collation ? ` CHARACTER SET ${ident(c.charset)} COLLATE ${ident(c.collation)}` : "";
  return `ALTER TABLE \`employees\` MODIFY COLUMN \`role\` ${type}${cs} NOT NULL DEFAULT 'agent'`;
}

async function tableExists(conn: mysql.Connection, table: string): Promise<boolean> {
  const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]);
  return Number((r as any)[0]?.n ?? 0) > 0;
}

export async function runRoleEnumMigration(opts: { databaseUrl: string; mode: "check" | "apply" | "rollback"; confirm?: string | null; deployEnv?: string | null }): Promise<RoleEnumResult> {
  const target = looksLikeProductionTarget(opts.databaseUrl);
  const lines: string[] = [`0045 accounts_manager role · الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""} · الوضع: ${opts.mode}`];
  const base: RoleEnumResult = { ok: false, mode: opts.mode, target: { host: target.host, database: target.database }, state: null, column: null, issues: [], replay: false, applied: false, refused: null, lines };
  if (opts.mode !== "check") {
    const why = migrationGate("0045", opts.mode, target, opts.deployEnv, opts.confirm);
    if (why) { lines.push(`✗ مرفوض قبل أي DDL: ${why}`); return { ...base, refused: why }; }
  }
  const conn = await mysql.createConnection(opts.databaseUrl);
  try {
    const column = await readRoleColumn(conn);
    const { state, issues } = evaluateRoleColumn(column);
    lines.push(`حالة 0045: ${state === "applied" ? "مطبَّقة" : state === "not_applied" ? "غير مطبَّقة" : "⚠️ جزئية/شكل مختلف"}`);
    for (const i of issues) lines.push(`  ✗ ${i}`);
    const out = { ...base, state, column, issues };

    if (opts.mode === "check") return { ...out, ok: state !== "partial" };

    if (opts.mode === "apply") {
      if (state === "applied") { lines.push("↻ مطبَّقة مسبقًا — replay بلا أي تغيير"); return { ...out, ok: true, replay: true }; }
      if (state === "partial") { lines.push("⚠️ الشكل الحالي غير المتوقع — لا تعديل تلقائي"); return { ...out, refused: "partial" }; }
      await conn.query(alterRoleSql(AFTER_TYPE, column!));
      const after = await readRoleColumn(conn);
      const ev = evaluateRoleColumn(after);
      const same = after && after.charset === column!.charset && after.collation === column!.collation;
      if (ev.state !== "applied" || !same) {
        lines.push("✗ بعد التنفيذ: التعريف لا يطابق المتوقع — راجع يدويًا");
        return { ...out, state: ev.state, column: after, issues: [...ev.issues, ...(same ? [] : ["charset/collation تغيّرت"])], refused: "verify" };
      }
      lines.push("✓ 0045 مطبَّقة: القيم القديمة وترتيبها كما هي + accounts_manager في الآخر، والخصائص كما هي");
      return { ...out, ok: true, applied: true, state: "applied", column: after };
    }

    // rollback
    if (state === "not_applied") { lines.push("لا شيء للتراجع — غير مطبَّقة"); return { ...out, ok: true }; }
    if (state === "partial") { lines.push("⚠️ الشكل الحالي غير المتوقع — لا تراجع تلقائي"); return { ...out, refused: "partial" }; }
    for (const ref of ROLE_REFERENCE_COLUMNS) {
      if (!(await tableExists(conn, ref.table))) continue;
      const [r] = await conn.query(`SELECT COUNT(*) n FROM \`${ref.table}\` WHERE \`${ref.column}\` = ?`, [ACCOUNTS_MANAGER_ROLE]);
      const n = Number((r as any)[0]?.n ?? 0);
      if (n > 0) {
        lines.push(`✗ مرفوض: ${ref.table}.${ref.column} فيه ${n} صف بالدور accounts_manager — غيّر الدور أولًا`);
        return { ...out, refused: "role_in_use" };
      }
    }
    await conn.query(alterRoleSql(BEFORE_TYPE, column!));
    const after = await readRoleColumn(conn);
    const ev = evaluateRoleColumn(after);
    if (ev.state !== "not_applied") { lines.push("✗ بعد التراجع: التعريف لا يطابق القديم"); return { ...out, state: ev.state, column: after, refused: "verify" }; }
    lines.push("✓ rollback 0045: عاد التعريف القديم حرفيًا");
    return { ...out, ok: true, state: "not_applied", column: after };
  } finally {
    await conn.end();
  }
}

/** هل القاعدة الحالية تقبل الدور الجديد؟ (قراءة فقط، للتطبيق قبل عرض الدور أو حفظه) */
export async function accountsManagerRoleSupported(exec: { query: (sql: string) => Promise<any> }): Promise<boolean> {
  const r = await exec.query("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'role'");
  const rows = Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : (r?.rows ?? []);
  return String(rows[0]?.COLUMN_TYPE ?? "").includes(`'${ACCOUNTS_MANAGER_ROLE}'`);
}
