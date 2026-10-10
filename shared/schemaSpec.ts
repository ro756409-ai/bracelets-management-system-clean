/**
 * أدوات عامة لمواصفات الـMigrations المكتوبة يدويًا (0041 / 0042): لقطة information_schema → مقارنة بالمواصفة.
 * نفس منهج `shared/ledgerV3Spec.ts` لكن عامة (أي قائمة جداول)، ونقية (بلا قاعدة بيانات) لتُختبر بلقطات مكسورة.
 */
/** generated: تعبير عمود مولّد STORED كما يُكتب في الملف — يُقارن بعد التطبيع (normalizeGenerationExpression). */
export type ColumnSpec = { name: string; type: string; nullable: boolean; generated?: string };
/** onDelete (اختياري): قاعدة الحذف المتوقعة (RESTRICT/NO ACTION تُعامل كواحدة) — تُفحص فقط إن وُصفت. */
export type ForeignKeySpec = { name: string; columns: string[]; refTable: string; refColumns: string[]; onDelete?: "SET NULL" | "CASCADE" | "RESTRICT" };
export type IndexSpec = { name: string; columns: string[] };
export type TableSpec = {
  columns: ColumnSpec[];
  /** الفهارس الفريدة (بما فيها PRIMARY) */
  uniques: IndexSpec[];
  /** الفهارس غير الفريدة المطلوبة للتقارير */
  indexes: IndexSpec[];
  foreignKeys: ForeignKeySpec[];
  checks: string[];
};

export type SchemaSnapshot = {
  tables: Set<string>;
  /** generated: «STORED|<التعبير>» أو «VIRTUAL|<التعبير>» للعمود المولّد فقط (من EXTRA/GENERATION_EXPRESSION) */
  columns: Record<string, Array<{ name: string; columnType: string; nullable: boolean; generated?: string | null }>>;
  uniques: Record<string, Record<string, string[]>>;
  indexes: Record<string, Record<string, string[]>>;
  foreignKeys: Record<string, Record<string, { columns: string[]; refTable: string; refColumns: string[]; deleteRule?: string | null }>>;
  checks: Record<string, Set<string>>;
};

export type SchemaIssue = { table: string; kind: "table" | "column" | "unique" | "index" | "foreign_key" | "check" | "composite_index"; detail: string };

/** تقسيم ملف الـmigration إلى عبارات (نفس فاصل drizzle) وحذف أسطر التعليق. */
export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(/-->\s*statement-breakpoint/)
    .map(chunk => chunk.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").trim())
    .filter(chunk => chunk.length > 0);
}

/**
 * تطبيع تعبير العمود المولّد للمقارنة: MySQL يعيد كتابته (أقواس، حروف صغيرة، `_utf8mb4\'x\'`)، فالمقارنة على
 * الشكل المجرد: بلا مسافات/backticks/أقواس/مقدّمات charset/هروب، وبحروف صغيرة.
 */
export const normalizeGenerationExpression = (expr: string) =>
  expr.toLowerCase().replace(/\\'/g, "'").replace(/_[a-z0-9]+'/g, "'").replace(/[\s`()]/g, "");

const typeMatches = (spec: string, actual: string) =>
  spec === "enum" ? actual.startsWith("enum(") : actual.replace(/ unsigned$/, "") === spec.replace(/ unsigned$/, "") && (spec.endsWith(" unsigned") === actual.endsWith(" unsigned"));

/** مقارنة جدول واحد بمواصفته. */
export function verifyTable(table: string, spec: TableSpec, snapshot: SchemaSnapshot): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!snapshot.tables.has(table)) return [{ table, kind: "table", detail: "الجدول غير موجود" }];
  const cols = new Map((snapshot.columns[table] ?? []).map(c => [c.name, c]));
  for (const c of spec.columns) {
    const actual = cols.get(c.name);
    if (!actual) { issues.push({ table, kind: "column", detail: `العمود ${c.name} غير موجود` }); continue; }
    if (!typeMatches(c.type, actual.columnType)) issues.push({ table, kind: "column", detail: `${c.name}: النوع ${actual.columnType} ≠ ${c.type}` });
    if (actual.nullable !== c.nullable) issues.push({ table, kind: "column", detail: `${c.name}: nullable=${actual.nullable} ≠ ${c.nullable}` });
    if (c.generated) {
      const [kind, expr] = (actual.generated ?? "").split(/\|(.*)/s);
      if (kind !== "STORED") issues.push({ table, kind: "column", detail: `${c.name}: ليس عمودًا مولّدًا STORED (${kind || "عمود عادي"})` });
      else if (normalizeGenerationExpression(expr ?? "") !== normalizeGenerationExpression(c.generated))
        issues.push({ table, kind: "column", detail: `${c.name}: تعبير التوليد ${expr} ≠ ${c.generated}` });
    } else if (actual.generated) issues.push({ table, kind: "column", detail: `${c.name}: عمود مولّد غير موصوف` });
  }
  for (const extra of cols.keys()) if (!spec.columns.some(c => c.name === extra)) issues.push({ table, kind: "column", detail: `عمود زائد غير موصوف: ${extra}` });
  for (const u of spec.uniques) {
    const actual = snapshot.uniques[table]?.[u.name];
    if (!actual) issues.push({ table, kind: "unique", detail: `الفهرس الفريد ${u.name} غير موجود` });
    else if (actual.join(",") !== u.columns.join(",")) issues.push({ table, kind: "unique", detail: `${u.name}: (${actual.join(",")}) ≠ (${u.columns.join(",")})` });
  }
  for (const ix of spec.indexes) {
    const actual = snapshot.indexes[table]?.[ix.name];
    if (!actual) issues.push({ table, kind: "index", detail: `الفهرس ${ix.name} غير موجود` });
    else if (actual.join(",") !== ix.columns.join(",")) issues.push({ table, kind: "index", detail: `${ix.name}: (${actual.join(",")}) ≠ (${ix.columns.join(",")})` });
  }
  for (const fk of spec.foreignKeys) {
    const actual = snapshot.foreignKeys[table]?.[fk.name];
    if (!actual) { issues.push({ table, kind: "foreign_key", detail: `المفتاح الأجنبي ${fk.name} غير موجود` }); continue; }
    if (actual.columns.join(",") !== fk.columns.join(",") || actual.refTable !== fk.refTable || actual.refColumns.join(",") !== fk.refColumns.join(","))
      issues.push({ table, kind: "foreign_key", detail: `${fk.name}: (${actual.columns}) → ${actual.refTable}(${actual.refColumns}) ≠ (${fk.columns}) → ${fk.refTable}(${fk.refColumns})` });
    else if (fk.onDelete) {
      const norm = (r: string | null | undefined) => (r == null || r === "NO ACTION" ? "RESTRICT" : r);
      if (norm(actual.deleteRule) !== norm(fk.onDelete)) issues.push({ table, kind: "foreign_key", detail: `${fk.name}: ON DELETE ${actual.deleteRule ?? "?"} ≠ ${fk.onDelete}` });
    }
  }
  for (const chk of spec.checks) if (!snapshot.checks[table]?.has(chk)) issues.push({ table, kind: "check", detail: `قيد CHECK ${chk} غير موجود` });
  return issues;
}

/** الفهرسان الفريدان المركّبان على الجدولين القديمين (هدفا كل FK مركّب للـtenant) — نفس تعريف 0040. */
export const TENANT_COMPOSITE_INDEXES: { table: "businesses" | "employees"; name: string; columns: string[] }[] = [
  { table: "businesses", name: "businesses_tenant_id", columns: ["tenantId", "id"] },
  { table: "employees", name: "employees_tenant_id", columns: ["tenantId", "id"] },
];

/**
 * حالة الفهرسين: absent (كلاهما غائب) / present (كلاهما بنفس الأعمدة والترتيب) / partial (واحد فقط أو تعريف مختلف).
 * partial = رفض أي تطبيق تلقائي.
 */
export type CompositeIndexState = "absent" | "present" | "partial";
export function compositeIndexState(snapshot: SchemaSnapshot): { state: CompositeIndexState; detail: string[] } {
  const detail: string[] = [];
  let present = 0, correct = 0;
  for (const ci of TENANT_COMPOSITE_INDEXES) {
    const actual = snapshot.uniques[ci.table]?.[ci.name] ?? snapshot.indexes[ci.table]?.[ci.name];
    if (!actual) { detail.push(`${ci.table}.${ci.name}: غائب`); continue; }
    present++;
    const unique = Boolean(snapshot.uniques[ci.table]?.[ci.name]);
    if (unique && actual.join(",") === ci.columns.join(",")) { correct++; detail.push(`${ci.table}.${ci.name}: موجود وصحيح`); }
    else detail.push(`${ci.table}.${ci.name}: تعريف مختلف (${unique ? "فريد" : "غير فريد"} على ${actual.join(",")})`);
  }
  if (present === 0) return { state: "absent", detail };
  if (correct === TENANT_COMPOSITE_INDEXES.length) return { state: "present", detail };
  return { state: "partial", detail };
}
