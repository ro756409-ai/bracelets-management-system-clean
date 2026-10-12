import mysql from "mysql2/promise";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import { enumColumnType } from "../shared/employeeRoleEnumSpec";
import { LEDGER_ACCOUNT_KINDS_AFTER_0046, LEDGER_ACCOUNT_KINDS_BEFORE_0046, LEDGER_ACCOUNT_KINDS_NEW_0046 } from "../shared/ledgerAccountKindsSpec";
import { migrationGate } from "./handMigration.service";

/**
 * Migration 0046 (نوعا حساب ledger_accounts.kind) — نفس انضباط 0045 لعبارة «تعديل ENUM» واحدة:
 *   • check (قراءة فقط): not_applied (التعريف القديم حرفيًا) / applied (الجديد حرفيًا) / partial (أي شكل آخر، أو 0040 غائبة).
 *   • apply: بوابات البيئة والتأكيد قبل أي اتصال كتابة؛ applied ⇒ replay؛ partial ⇒ رفض بلا DDL؛ not_applied ⇒ ALTER واحد
 *     يعيد charset/collation العمود صراحةً، ثم تحقق أن كل الخصائص كما هي.
 *   • rollback: نفس البوابات + يُرفض لو أي حساب يستخدم أحد النوعين الجديدين.
 */
export type KindsState = "not_applied" | "applied" | "partial";
export type KindsColumn = { columnType: string; nullable: boolean; defaultValue: string | null; charset: string | null; collation: string | null; comment: string; extra: string };
export type KindsResult = {
  ok: boolean; mode: "check" | "apply" | "rollback"; target: { host: string; database: string };
  state: KindsState | null; column: KindsColumn | null; issues: string[]; replay: boolean; applied: boolean; refused: string | null; lines: string[];
};

export const KINDS_BEFORE_TYPE = enumColumnType(LEDGER_ACCOUNT_KINDS_BEFORE_0046);
export const KINDS_AFTER_TYPE = enumColumnType(LEDGER_ACCOUNT_KINDS_AFTER_0046);

async function readKindColumn(conn: mysql.Connection): Promise<KindsColumn | null> {
  const [r] = await conn.query(`SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT, EXTRA
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_accounts' AND COLUMN_NAME = 'kind'`);
  const c = (r as any[])[0];
  if (!c) return null;
  return { columnType: String(c.COLUMN_TYPE), nullable: c.IS_NULLABLE === "YES", defaultValue: c.COLUMN_DEFAULT == null ? null : String(c.COLUMN_DEFAULT),
    charset: c.CHARACTER_SET_NAME ?? null, collation: c.COLLATION_NAME ?? null, comment: String(c.COLUMN_COMMENT ?? ""), extra: String(c.EXTRA ?? "") };
}

/** الحكم على التعريف (نقي). */
export function evaluateKindColumn(c: KindsColumn | null): { state: KindsState; issues: string[] } {
  if (!c) return { state: "partial", issues: ["العمود ledger_accounts.kind غير موجود (0040 غير مطبّقة)"] };
  const issues: string[] = [];
  if (c.nullable) issues.push("ledger_accounts.kind يقبل NULL (المتوقع NOT NULL)");
  if (c.defaultValue != null) issues.push(`قيمة افتراضية غير متوقعة: ${c.defaultValue}`);
  if (c.comment) issues.push("للعمود تعليق غير متوقع");
  if (c.extra) issues.push(`EXTRA غير متوقع: ${c.extra}`);
  if (c.columnType !== KINDS_BEFORE_TYPE && c.columnType !== KINDS_AFTER_TYPE) issues.push(`تعريف ENUM مختلف عن المتوقع: ${c.columnType}`);
  if (issues.length) return { state: "partial", issues };
  return { state: c.columnType === KINDS_AFTER_TYPE ? "applied" : "not_applied", issues };
}

const ident = (s: string) => { if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`قيمة غير صالحة في التعريف: ${s}`); return s; };
export function alterKindSql(type: string, c: Pick<KindsColumn, "charset" | "collation">): string {
  const cs = c.charset && c.collation ? ` CHARACTER SET ${ident(c.charset)} COLLATE ${ident(c.collation)}` : "";
  return `ALTER TABLE \`ledger_accounts\` MODIFY COLUMN \`kind\` ${type}${cs} NOT NULL`;
}

export async function runLedgerKindsMigration(opts: { databaseUrl: string; mode: "check" | "apply" | "rollback"; confirm?: string | null; deployEnv?: string | null }): Promise<KindsResult> {
  const target = looksLikeProductionTarget(opts.databaseUrl);
  const lines: string[] = [`0046 ledger account kinds · الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""} · الوضع: ${opts.mode}`];
  const base: KindsResult = { ok: false, mode: opts.mode, target: { host: target.host, database: target.database }, state: null, column: null, issues: [], replay: false, applied: false, refused: null, lines };
  if (opts.mode !== "check") {
    const why = migrationGate("0046", opts.mode, target, opts.deployEnv, opts.confirm);
    if (why) { lines.push(`✗ مرفوض قبل أي DDL: ${why}`); return { ...base, refused: why }; }
  }
  const conn = await mysql.createConnection(opts.databaseUrl);
  try {
    const column = await readKindColumn(conn);
    const { state, issues } = evaluateKindColumn(column);
    lines.push(`حالة 0046: ${state === "applied" ? "مطبَّقة" : state === "not_applied" ? "غير مطبَّقة" : "⚠️ جزئية/شكل مختلف"}`);
    for (const i of issues) lines.push(`  ✗ ${i}`);
    const out = { ...base, state, column, issues };
    if (opts.mode === "check") return { ...out, ok: state !== "partial" };
    if (opts.mode === "apply") {
      if (state === "applied") { lines.push("↻ مطبَّقة مسبقًا — replay بلا أي تغيير"); return { ...out, ok: true, replay: true }; }
      if (state === "partial") { lines.push("⚠️ الشكل الحالي غير المتوقع — لا تعديل تلقائي"); return { ...out, refused: "partial" }; }
      await conn.query(alterKindSql(KINDS_AFTER_TYPE, column!));
      const after = await readKindColumn(conn);
      const ev = evaluateKindColumn(after);
      const same = after && after.charset === column!.charset && after.collation === column!.collation;
      if (ev.state !== "applied" || !same) { lines.push("✗ بعد التنفيذ: التعريف لا يطابق المتوقع — راجع يدويًا"); return { ...out, state: ev.state, column: after, refused: "verify" }; }
      lines.push("✓ 0046 مطبَّقة: القيم القديمة وترتيبها كما هي + payroll_payable وsupplier_advance في الآخر، والخصائص كما هي");
      return { ...out, ok: true, applied: true, state: "applied", column: after };
    }
    if (state === "not_applied") { lines.push("لا شيء للتراجع — غير مطبَّقة"); return { ...out, ok: true }; }
    if (state === "partial") { lines.push("⚠️ الشكل الحالي غير المتوقع — لا تراجع تلقائي"); return { ...out, refused: "partial" }; }
    const [r] = await conn.query(`SELECT COUNT(*) n FROM \`ledger_accounts\` WHERE \`kind\` IN (?)`, [[...LEDGER_ACCOUNT_KINDS_NEW_0046]]);
    const n = Number((r as any)[0]?.n ?? 0);
    if (n > 0) { lines.push(`✗ مرفوض: ${n} حساب يستخدم نوعًا جديدًا — لا تراجع`); return { ...out, refused: "kind_in_use" }; }
    await conn.query(alterKindSql(KINDS_BEFORE_TYPE, column!));
    const after = await readKindColumn(conn);
    const ev = evaluateKindColumn(after);
    if (ev.state !== "not_applied") { lines.push("✗ بعد التراجع: التعريف لا يطابق القديم"); return { ...out, state: ev.state, column: after, refused: "verify" }; }
    lines.push("✓ rollback 0046: عاد التعريف القديم حرفيًا");
    return { ...out, ok: true, state: "not_applied", column: after };
  } finally {
    await conn.end();
  }
}

/** هل تقبل القاعدة النوعين الجديدين؟ (قراءة فقط — قبل إنشاء حساب منهما في التطبيق) */
export async function ledgerKindsSupported(exec: { query: (sql: string) => Promise<any> }): Promise<boolean> {
  const r = await exec.query("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_accounts' AND COLUMN_NAME = 'kind'");
  const rows = Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : (r?.rows ?? []);
  const t = String(rows[0]?.COLUMN_TYPE ?? "");
  return LEDGER_ACCOUNT_KINDS_NEW_0046.every(k => t.includes(`'${k}'`));
}
