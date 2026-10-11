import mysql from "mysql2/promise";
import { looksLikeProductionTarget } from "../shared/balanceReconciliation";
import {
  compositeIndexState,
  splitStatements,
  TENANT_COMPOSITE_INDEXES,
  verifyTable,
  type CompositeIndexState,
  type SchemaIssue,
  type SchemaSnapshot,
  type TableSpec,
} from "../shared/schemaSpec";
import { openReadOnlyExecutor, type ReadOnlyExecutor } from "./balanceReconciliation.service";

/**
 * محرّك الـMigrations المكتوبة يدويًا 0041 / 0042 / 0043 / 0044 — نفس انضباط 0040 (ledgerV3Migrate.service) بشكل عام:
 *   • check (افتراضي، قراءة فقط): الحالة not_applied / applied / partial + جدول العبارات + فروق المواصفة + preflight.
 *   • apply: بوابات **قبل أي اتصال كتابة** (البيئة، الهدف ليس إنتاجًا، عبارة تأكيد فيها اسم القاعدة)، ثم:
 *     applied → replay بلا تغيير؛ partial → رفض بلا إكمال؛ not_applied → العبارات بالترتيب مع تحقق بعد كل واحدة.
 *   • rollback: نفس البوابات + عبارة مختلفة، وكل الجداول **فارغة**؛ الفهرسان المركّبان لا يُحذفان إلا بطلب صريح
 *     وبشرط ألا يعتمد عليهما أي FK آخر.
 *   • الفهرسان المركّبان (businesses_tenant_id / employees_tenant_id): كلاهما غائب → 0041 ينشئهما؛ كلاهما موجود
 *     بنفس الأعمدة والترتيب → skip؛ واحد فقط أو تعريف مختلف → partial ورفض. 0042 و0043 و0044 تشترط وجودهما.
 *   • الأعمدة المولّدة (0044): النوع STORED وتعبير التوليد جزء من المطابقة (بعد التطبيع)، لا الاسم والنوع فقط.
 *   • قاعدة ON DELETE لـFK جزء من المطابقة حين تصفها المواصفة (0044: team_task_operations.taskId → SET NULL).
 *   • لا يُطبع ولا يُرجع أي رابط أو كلمة سر. DDL في MySQL غير معاملاتي — التوقف عند أول خطأ يترك partial ظاهرًا.
 *
 * البيئات المسموح فيها apply/rollback: DEPLOY_ENV=staging مع قاعدة غير إنتاجية باسم staging/stage/test (للـRunbook
 * لاحقًا — **ممنوع تشغيله في هذه المرحلة**)، أو DEPLOY_ENV=test/local على مضيف محلي (Docker مؤقت).
 */
export type HandMigrationId = "0041" | "0042" | "0043" | "0044" | "0045";
export type HandMigrationDef = {
  id: HandMigrationId;
  title: string;
  /** الجداول بترتيب الإنشاء */
  tables: string[];
  specs: Record<string, TableSpec>;
  /** قيود FK تُضاف بـALTER بعد الإنشاء (كسر الدورة) */
  lateForeignKeys: { table: string; name: string }[];
  compositeIndexes: "create_if_absent" | "require_present";
};

export type StatementKind = "composite_index" | "table" | "late_fk";
export type DescribedStatement = { kind: StatementKind; table: string; name: string; sql: string };
export type MigrationState = "not_applied" | "applied" | "partial";
export type PreflightRow = { label: string; expected: string; actual: string; ok: boolean };
export type HandMigrationResult = {
  ok: boolean;
  mode: "check" | "apply" | "rollback";
  target: { host: string; database: string };
  state: MigrationState | null;
  compositeIndexes: CompositeIndexState | null;
  statements: { n: number; kind: StatementKind; table: string; name: string; present: boolean }[];
  issues: SchemaIssue[];
  preflight: PreflightRow[];
  replay: boolean;
  applied: number;
  skipped: number;
  refused: string | null;
  lines: string[];
};

export const confirmPhrase = (id: HandMigrationId, mode: "apply" | "rollback", database: string) =>
  `${mode === "apply" ? "APPLY" : "ROLLBACK"} ${id} TO ${database}`;

export function describeStatements(sqlText: string): DescribedStatement[] {
  return splitStatements(sqlText).map(sql => {
    const idx = sql.match(/^ALTER TABLE `([^`]+)`\s+ADD UNIQUE INDEX `([^`]+)`/i);
    if (idx) return { kind: "composite_index" as const, table: idx[1], name: idx[2], sql };
    const fk = sql.match(/^ALTER TABLE `([^`]+)`\s+ADD CONSTRAINT `([^`]+)`\s+FOREIGN KEY/i);
    if (fk) return { kind: "late_fk" as const, table: fk[1], name: fk[2], sql };
    const tbl = sql.match(/^CREATE TABLE `([^`]+)`/i);
    if (tbl) return { kind: "table" as const, table: tbl[1], name: tbl[1], sql };
    throw new Error(`عبارة غير متوقعة في الملف: ${sql.slice(0, 70)}…`);
  });
}

/** لقطة information_schema لمجموعة جداول (قراءة فقط). */
export async function loadSchemaSnapshot(exec: ReadOnlyExecutor, tableNames: string[]): Promise<SchemaSnapshot> {
  const ph = tableNames.map(() => "?").join(",");
  const tables = await exec.query<{ TABLE_NAME: string }>(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph})`, tableNames);
  const cols = await exec.query<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string; EXTRA: string | null; GENERATION_EXPRESSION: string | null }>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) ORDER BY TABLE_NAME, ORDINAL_POSITION`, tableNames);
  const idx = await exec.query<{ TABLE_NAME: string; INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number }>(
    `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, tableNames);
  const fks = await exec.query<{ TABLE_NAME: string; CONSTRAINT_NAME: string; COLUMN_NAME: string; REFERENCED_TABLE_NAME: string; REFERENCED_COLUMN_NAME: string }>(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, tableNames);
  const rules = await exec.query<{ TABLE_NAME: string; CONSTRAINT_NAME: string; DELETE_RULE: string }>(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph})`, tableNames);
  const checks = await exec.query<{ TABLE_NAME: string; CONSTRAINT_NAME: string }>(
    `SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) AND CONSTRAINT_TYPE = 'CHECK'`, tableNames);
  const s: SchemaSnapshot = { tables: new Set(tables.map(t => t.TABLE_NAME)), columns: {}, uniques: {}, indexes: {}, foreignKeys: {}, checks: {} };
  // EXTRA لأعمدة الوقت = «DEFAULT_GENERATED» — ليس عمودًا مولّدًا؛ المولّد فقط «STORED GENERATED» / «VIRTUAL GENERATED».
  const generatedKind = (extra: string | null) => /\bSTORED GENERATED\b/i.test(extra ?? "") ? "STORED" : /\bVIRTUAL GENERATED\b/i.test(extra ?? "") ? "VIRTUAL" : null;
  for (const c of cols) {
    const kind = generatedKind(c.EXTRA);
    (s.columns[c.TABLE_NAME] ??= []).push({ name: c.COLUMN_NAME, columnType: c.COLUMN_TYPE, nullable: c.IS_NULLABLE === "YES", generated: kind ? `${kind}|${c.GENERATION_EXPRESSION ?? ""}` : null });
  }
  for (const i of idx) {
    const bucket = Number(i.NON_UNIQUE) === 0 ? s.uniques : s.indexes;
    ((bucket[i.TABLE_NAME] ??= {})[i.INDEX_NAME] ??= []).push(i.COLUMN_NAME);
  }
  for (const f of fks) {
    const slot = ((s.foreignKeys[f.TABLE_NAME] ??= {})[f.CONSTRAINT_NAME] ??= { columns: [], refTable: f.REFERENCED_TABLE_NAME, refColumns: [] });
    slot.columns.push(f.COLUMN_NAME); slot.refColumns.push(f.REFERENCED_COLUMN_NAME);
  }
  for (const r of rules) { const fk = s.foreignKeys[r.TABLE_NAME]?.[r.CONSTRAINT_NAME]; if (fk) fk.deleteRule = r.DELETE_RULE; }
  for (const k of checks) (s.checks[k.TABLE_NAME] ??= new Set()).add(k.CONSTRAINT_NAME);
  return s;
}

/** حالة التطبيق + الفروق (نقية على اللقطة). */
export function evaluate(def: HandMigrationDef, snapshot: SchemaSnapshot): { state: MigrationState; issues: SchemaIssue[]; composite: CompositeIndexState; compositeDetail: string[] } {
  const ci = compositeIndexState(snapshot);
  const present = def.tables.filter(t => snapshot.tables.has(t)).length;
  const issues: SchemaIssue[] = [];
  for (const t of def.tables) issues.push(...verifyTable(t, def.specs[t], snapshot));
  if (ci.state !== "present") issues.push({ table: "businesses/employees", kind: "composite_index", detail: ci.detail.join(" · ") });
  let state: MigrationState;
  if (ci.state === "partial") state = "partial";
  else if (present === 0) state = "not_applied";
  else if (present === def.tables.length && issues.length === 0) state = "applied";
  else state = "partial";
  return { state, issues: present === 0 ? [] : issues, composite: ci.state, compositeDetail: ci.detail };
}

const SNAPSHOT_TABLES = (def: HandMigrationDef) => [...def.tables, ...TENANT_COMPOSITE_INDEXES.map(i => i.table)];

async function readState(exec: ReadOnlyExecutor, def: HandMigrationDef) {
  return evaluate(def, await loadSchemaSnapshot(exec, SNAPSHOT_TABLES(def)));
}

/** Preflight قراءة فقط — كل سطر بقيمته المتوقعة. */
export async function preflight(exec: ReadOnlyExecutor, def: HandMigrationDef): Promise<PreflightRow[]> {
  const one = async <T>(q: string, p: unknown[] = []) => (await exec.query<T>(q, p))[0];
  const version = await one<{ v: string }>("SELECT VERSION() v");
  const [maj, min, patch] = String(version?.v ?? "0.0.0").split(/[.-]/).map(n => Number(n) || 0);
  const versionOk = maj > 8 || (maj === 8 && (min > 0 || patch >= 16));
  const base = await one<{ n: number }>("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('tenants','businesses','employees')");
  const nullBiz = await one<{ n: number }>("SELECT COUNT(*) n FROM businesses WHERE tenantId IS NULL");
  const nullEmp = await one<{ n: number }>("SELECT COUNT(*) n FROM employees WHERE tenantId IS NULL");
  const orphanBiz = await one<{ n: number }>("SELECT COUNT(*) n FROM businesses b LEFT JOIN tenants t ON t.id = b.tenantId WHERE b.tenantId IS NOT NULL AND t.id IS NULL");
  const orphanEmp = await one<{ n: number }>("SELECT COUNT(*) n FROM employees e LEFT JOIN tenants t ON t.id = e.tenantId WHERE e.tenantId IS NOT NULL AND t.id IS NULL");
  const fkChecks = await one<{ v: number }>("SELECT @@foreign_key_checks v");
  const idTypes = await exec.query<{ TABLE_NAME: string; COLUMN_TYPE: string }>(
    "SELECT TABLE_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'id' AND TABLE_NAME IN ('tenants','businesses','employees')");
  const nonInt = idTypes.filter(r => !/^int(\(\d+\))?$/.test(r.COLUMN_TYPE)).map(r => `${r.TABLE_NAME}:${r.COLUMN_TYPE}`);
  const ci = compositeIndexState(await loadSchemaSnapshot(exec, TENANT_COMPOSITE_INDEXES.map(i => i.table)));
  const rows: Omit<PreflightRow, "ok">[] = [
    { label: "إصدار MySQL يفرض CHECK (≥ 8.0.16)", expected: "yes", actual: versionOk ? "yes" : `no (${version?.v})` },
    { label: "الجداول المرجعية tenants/businesses/employees", expected: "3", actual: String(Number(base?.n ?? 0)) },
    { label: "businesses.tenantId = NULL", expected: "0", actual: String(Number(nullBiz?.n ?? 0)) },
    { label: "employees.tenantId = NULL", expected: "0", actual: String(Number(nullEmp?.n ?? 0)) },
    { label: "أنشطة يتيمة", expected: "0", actual: String(Number(orphanBiz?.n ?? 0)) },
    { label: "موظفون يتامى", expected: "0", actual: String(Number(orphanEmp?.n ?? 0)) },
    { label: "foreign_key_checks", expected: "1", actual: String(Number(fkChecks?.v ?? 0)) },
    { label: "أعمدة id المرجعية من نوع int", expected: "", actual: nonInt.join(",") },
    def.compositeIndexes === "require_present"
      ? { label: "الفهرسان المركّبان موجودان بالتعريف الصحيح (من 0040 أو 0041)", expected: "present", actual: ci.state }
      : { label: "الفهرسان المركّبان: غائبان (سيُنشآن) أو موجودان بالتعريف الصحيح (skip)", expected: ci.state === "partial" ? "absent|present" : ci.state, actual: ci.state },
  ];
  return rows.map(r => ({ ...r, ok: r.expected === r.actual }));
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const looksLikeStaging = (database: string) => /staging|stage|test/i.test(database);

function gate(def: HandMigrationDef, mode: "apply" | "rollback", target: { host: string; database: string; production: boolean }, deployEnv: string | null | undefined, confirm: string | null | undefined): string | null {
  return migrationGate(def.id, mode, target, deployEnv, confirm);
}

/** بوابات apply/rollback المشتركة (لا إنتاج، DEPLOY_ENV، عبارة تأكيد باسم القاعدة) — يعيد استخدامها 0045. */
export function migrationGate(id: HandMigrationId, mode: "apply" | "rollback", target: { host: string; database: string; production: boolean }, deployEnv: string | null | undefined, confirm: string | null | undefined): string | null {
  if (target.production) return "القاعدة تبدو إنتاجًا — مرفوض دائمًا";
  const env = deployEnv ?? "";
  if (env === "staging") {
    if (!looksLikeStaging(target.database)) return `اسم القاعدة «${target.database}» لا يدل على Staging`;
  } else if (env === "test" || env === "local") {
    if (!LOCAL_HOSTS.has(target.host)) return `DEPLOY_ENV=${env} مسموح على مضيف محلي فقط (الحالي: ${target.host})`;
  } else return `DEPLOY_ENV يجب أن يكون staging أو test/local (الحالي: ${env || "غير مضبوط"})`;
  const expected = confirmPhrase(id, mode, target.database);
  if ((confirm ?? "") !== expected) return `عبارة التأكيد غير مطابقة — المطلوب حرفيًا: ${expected}`;
  return null;
}

async function presence(conn: mysql.Connection, s: DescribedStatement): Promise<boolean> {
  if (s.kind === "table") {
    const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [s.name]);
    return Number((r as any)[0]?.n ?? 0) > 0;
  }
  if (s.kind === "composite_index") {
    const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [s.table, s.name]);
    return Number((r as any)[0]?.n ?? 0) > 0;
  }
  const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'", [s.table, s.name]);
  return Number((r as any)[0]?.n ?? 0) > 0;
}

const describeLine = (s: { kind: StatementKind; table: string; name: string }) =>
  s.kind === "table" ? `جدول ${s.name}` : s.kind === "composite_index" ? `فهرس مركّب ${s.table}.${s.name}` : `FK لاحق ${s.table}.${s.name}`;

export async function runHandMigration(def: HandMigrationDef, opts: {
  databaseUrl: string;
  mode: "check" | "apply" | "rollback";
  sqlText: string;
  confirm?: string | null;
  deployEnv?: string | null;
  /** rollback فقط: حذف الفهرسين المركّبين إن لم يعتمد عليهما أي FK آخر (افتراضيًا يُبقيان) */
  dropCompositeIndexes?: boolean;
}): Promise<HandMigrationResult> {
  const target = looksLikeProductionTarget(opts.databaseUrl);
  const lines: string[] = [`${def.title} · الهدف: ${target.host} / ${target.database}${target.production ? "  ⚠️ يبدو إنتاجًا" : ""} · الوضع: ${opts.mode}`];
  const base: HandMigrationResult = { ok: false, mode: opts.mode, target: { host: target.host, database: target.database }, state: null, compositeIndexes: null, statements: [], issues: [], preflight: [], replay: false, applied: 0, skipped: 0, refused: null, lines };
  const refuse = (why: string): HandMigrationResult => { lines.push(`✗ مرفوض قبل أي DDL: ${why}`); return { ...base, refused: why, lines }; };
  if (opts.mode !== "check") { const why = gate(def, opts.mode, target, opts.deployEnv, opts.confirm); if (why) return refuse(why); }

  const described = describeStatements(opts.sqlText);
  const exec = await openReadOnlyExecutor(opts.databaseUrl);
  let st: ReturnType<typeof evaluate>, pre: PreflightRow[];
  try { st = await readState(exec, def); pre = await preflight(exec, def); } finally { await exec.close(); }
  const conn = await mysql.createConnection(opts.databaseUrl);
  const statementTable = async () => {
    const out: HandMigrationResult["statements"] = [];
    for (const [i, s] of described.entries()) out.push({ n: i + 1, kind: s.kind, table: s.table, name: s.name, present: await presence(conn, s) });
    return out;
  };
  try {
    let statements = await statementTable();
    lines.push(`حالة ${def.id}: ${st.state === "applied" ? "مطبَّقة" : st.state === "not_applied" ? "غير مطبَّقة" : "⚠️ جزئية"} · الفهرسان المركّبان: ${st.composite}`);
    for (const s of statements) lines.push(`  ${s.present ? "✓" : "✗"} [${s.n}/${statements.length}] ${describeLine(s)}`);
    for (const p of pre) lines.push(`  ${p.ok ? "✓" : "✗"} preflight: ${p.label} = ${p.actual || "—"}`);
    const out = { ...base, state: st.state, compositeIndexes: st.composite, statements, issues: st.issues, preflight: pre };

    if (opts.mode === "check") {
      for (const i of st.issues) lines.push(`  ✗ ${i.table} [${i.kind}] ${i.detail}`);
      return { ...out, ok: st.state !== "partial" };
    }

    if (opts.mode === "rollback") return await rollback(def, conn, out, opts.dropCompositeIndexes === true, lines, described);

    // apply
    if (st.state === "applied") { lines.push("↻ مطبَّقة مسبقًا — replay بلا أي تغيير"); return { ...out, ok: true, replay: true }; }
    if (st.state === "partial") { lines.push("⚠️ تطبيق جزئي: لا إكمال تلقائي — راجع العبارات أعلاه"); return { ...out, refused: "partial" }; }
    const badPre = pre.filter(p => !p.ok);
    if (badPre.length) { lines.push(`✗ preflight غير مستوفى: ${badPre.map(p => p.label).join(" · ")}`); return { ...out, refused: "preflight" }; }
    let applied = 0, skipped = 0;
    for (const [i, s] of described.entries()) {
      if (s.kind === "composite_index") {
        if (def.compositeIndexes === "require_present") throw new Error("ملف يطلب الفهرسين لا يجب أن يحتوي عبارات إنشائهما");
        if (st.composite === "present") { skipped++; lines.push(`  ↷ [${i + 1}] ${describeLine(s)} — موجود بالتعريف الصحيح (skip)`); continue; }
      }
      try { await conn.query(s.sql); }
      catch (e: any) {
        lines.push(`✗ فشلت العبارة [${i + 1}] ${describeLine(s)}: ${e?.code ?? "ERR"} — ${String(e?.sqlMessage ?? e?.message ?? e)}`);
        statements = await statementTable();
        return { ...out, statements, applied, skipped, state: "partial", refused: `statement ${i + 1}` };
      }
      if (!(await presence(conn, s))) {
        lines.push(`✗ العبارة [${i + 1}] نُفِّذت بلا خطأ لكن الكائن غير موجود بعدها — توقف`);
        statements = await statementTable();
        return { ...out, statements, applied, skipped, state: "partial", refused: `verify ${i + 1}` };
      }
      applied++; lines.push(`  ✓ [${i + 1}] ${describeLine(s)} — نُفِّذ وتحقّق`);
    }
    const exec2 = await openReadOnlyExecutor(opts.databaseUrl);
    let after: ReturnType<typeof evaluate>;
    try { after = await readState(exec2, def); } finally { await exec2.close(); }
    statements = await statementTable();
    if (after.state === "applied") lines.push(`✓ ${def.id} مطبَّقة ومطابقة للمواصفة بالكامل`);
    else { lines.push(`✗ بعد التنفيذ: ${after.state} مع ${after.issues.length} فرق`); for (const i of after.issues) lines.push(`  ✗ ${i.table} [${i.kind}] ${i.detail}`); }
    return { ...out, ok: after.state === "applied", state: after.state, issues: after.issues, statements, applied, skipped };
  } finally {
    await conn.end();
  }
}

async function rollback(def: HandMigrationDef, conn: mysql.Connection, out: HandMigrationResult, dropIndexes: boolean, lines: string[], described: DescribedStatement[]): Promise<HandMigrationResult> {
  if (out.state === "not_applied") { lines.push("لا شيء للتراجع — غير مطبَّقة"); return { ...out, ok: true }; }
  // كل الجداول فارغة؟
  for (const t of def.tables) {
    const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]);
    if (Number((r as any)[0]?.n ?? 0) === 0) continue;
    const [c] = await conn.query(`SELECT COUNT(*) n FROM \`${t}\``);
    const n = Number((c as any)[0]?.n ?? 0);
    if (n > 0) { lines.push(`✗ مرفوض: الجدول ${t} فيه ${n} صف — بعد وجود بيانات لا DROP؛ أطفئ العلم فقط`); return { ...out, refused: "not_empty" }; }
  }
  let dropped = 0;
  for (const fk of def.lateForeignKeys) {
    const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?", [fk.table, fk.name]);
    if (Number((r as any)[0]?.n ?? 0) > 0) { await conn.query(`ALTER TABLE \`${fk.table}\` DROP FOREIGN KEY \`${fk.name}\``); lines.push(`  ✓ حذف FK لاحق ${fk.table}.${fk.name}`); }
  }
  for (const t of [...def.tables].reverse()) {
    const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]);
    if (Number((r as any)[0]?.n ?? 0) === 0) continue;
    await conn.query(`DROP TABLE \`${t}\``); dropped++; lines.push(`  ✓ DROP TABLE ${t}`);
  }
  if (described.some(s => s.kind === "composite_index")) {
    // من يعتمد على الفهرسين بعد حذف جداولنا؟ أي FK يشير إلى businesses/employees على (tenantId,id)
    const [deps] = await conn.query(
      `SELECT DISTINCT k.TABLE_NAME t, k.CONSTRAINT_NAME c FROM information_schema.KEY_COLUMN_USAGE k
       WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IN ('businesses','employees') AND k.REFERENCED_COLUMN_NAME = 'tenantId'`);
    const dependants = (deps as any[]).map(d => `${d.t}.${d.c}`);
    if (!dropIndexes) lines.push("  ↷ الفهرسان المركّبان باقيان (لم يُطلب حذفهما — الافتراضي الآمن)");
    else if (dependants.length) lines.push(`  ↷ الفهرسان المركّبان باقيان: تعتمد عليهما FK أخرى (${dependants.join(", ")})`);
    else for (const ci of [...TENANT_COMPOSITE_INDEXES].reverse()) {
      const [r] = await conn.query("SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [ci.table, ci.name]);
      if (Number((r as any)[0]?.n ?? 0) > 0) { await conn.query(`ALTER TABLE \`${ci.table}\` DROP INDEX \`${ci.name}\``); lines.push(`  ✓ حذف الفهرس ${ci.table}.${ci.name}`); }
    }
  }
  lines.push(`✓ rollback ${def.id}: ${dropped} جدول`);
  return { ...out, ok: true, state: "not_applied" };
}
