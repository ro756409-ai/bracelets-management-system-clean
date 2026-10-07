import type { ReadOnlyExecutor } from "./balanceReconciliation.service";
import { LEDGER_V3_TABLES, LEDGER_V3_OLD_TABLE_INDEXES, applicationState, verifyLedgerV3, type ApplicationState, type SchemaSnapshot, type VerifyIssue } from "../shared/ledgerV3Spec";

/**
 * لقطة information_schema لجداول Ledger V3 (قراءة فقط) → مقارنة بالمواصفة.
 * الاستعلامات على القاعدة الحالية للاتصال (`DATABASE()`), ولا تُطبع أي بيانات اتصال.
 */
export async function loadLedgerV3Snapshot(exec: ReadOnlyExecutor): Promise<SchemaSnapshot> {
  const names: string[] = [...LEDGER_V3_TABLES, ...LEDGER_V3_OLD_TABLE_INDEXES.map(i => i.table)];
  const ph = names.map(() => "?").join(",");
  const tables = await exec.query<{ TABLE_NAME: string }>(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph})`, names
  );
  const cols = await exec.query<{ TABLE_NAME: string; COLUMN_NAME: string; COLUMN_TYPE: string; IS_NULLABLE: string; ORDINAL_POSITION: number }>(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) ORDER BY TABLE_NAME, ORDINAL_POSITION`, names
  );
  const idx = await exec.query<{ TABLE_NAME: string; INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number; SEQ_IN_INDEX: number }>(
    `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) AND NON_UNIQUE = 0 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, names
  );
  const fks = await exec.query<{ TABLE_NAME: string; CONSTRAINT_NAME: string; COLUMN_NAME: string; REFERENCED_TABLE_NAME: string; REFERENCED_COLUMN_NAME: string; ORDINAL_POSITION: number }>(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, names
  );
  const checks = await exec.query<{ TABLE_NAME: string; CONSTRAINT_NAME: string }>(
    `SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph}) AND CONSTRAINT_TYPE = 'CHECK'`, names
  );

  const snapshot: SchemaSnapshot = { tables: new Set(tables.map(t => t.TABLE_NAME)), columns: {}, uniques: {}, foreignKeys: {}, checks: {} };
  for (const c of cols) (snapshot.columns[c.TABLE_NAME] ??= []).push({ name: c.COLUMN_NAME, columnType: c.COLUMN_TYPE, nullable: c.IS_NULLABLE === "YES" });
  for (const i of idx) ((snapshot.uniques[i.TABLE_NAME] ??= {})[i.INDEX_NAME] ??= []).push(i.COLUMN_NAME);
  for (const f of fks) {
    const slot = ((snapshot.foreignKeys[f.TABLE_NAME] ??= {})[f.CONSTRAINT_NAME] ??= { columns: [], refTable: f.REFERENCED_TABLE_NAME, refColumns: [] });
    slot.columns.push(f.COLUMN_NAME); slot.refColumns.push(f.REFERENCED_COLUMN_NAME);
  }
  for (const k of checks) (snapshot.checks[k.TABLE_NAME] ??= new Set()).add(k.CONSTRAINT_NAME);
  return snapshot;
}

export async function verifyLedgerV3OnDatabase(exec: ReadOnlyExecutor): Promise<{ issues: VerifyIssue[]; present: string[]; state: ApplicationState }> {
  const snapshot = await loadLedgerV3Snapshot(exec);
  const present = [...snapshot.tables].filter(t => (LEDGER_V3_TABLES as readonly string[]).includes(t)).sort();
  return { issues: verifyLedgerV3(snapshot), present, state: applicationState(snapshot) };
}

/** Preflight قبل تطبيق 0040 — قراءة فقط؛ القيم المتوقعة مذكورة مع كل سطر. */
export async function ledgerV3Preflight(exec: ReadOnlyExecutor): Promise<{ label: string; expected: string; actual: string; ok: boolean }[]> {
  const ph = LEDGER_V3_TABLES.map(() => "?").join(",");
  const one = async <T>(sql: string, params: unknown[] = []) => (await exec.query<T>(sql, params))[0];
  const existing = await one<{ n: number }>(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${ph})`, [...LEDGER_V3_TABLES]);
  const base = await one<{ n: number }>(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('tenants','businesses','employees')`);
  const nullBizTenant = await one<{ n: number }>(`SELECT COUNT(*) n FROM businesses WHERE tenantId IS NULL`);
  const nullEmpTenant = await one<{ n: number }>(`SELECT COUNT(*) n FROM employees WHERE tenantId IS NULL`);
  const orphanBiz = await one<{ n: number }>(`SELECT COUNT(*) n FROM businesses b LEFT JOIN tenants t ON t.id = b.tenantId WHERE b.tenantId IS NOT NULL AND t.id IS NULL`);
  const orphanEmp = await one<{ n: number }>(`SELECT COUNT(*) n FROM employees e LEFT JOIN tenants t ON t.id = e.tenantId WHERE e.tenantId IS NOT NULL AND t.id IS NULL`);
  const oldIdx = await one<{ n: number }>(`SELECT COUNT(DISTINCT INDEX_NAME) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('businesses_tenant_id','employees_tenant_id')`);
  const fkChecks = await one<{ v: number }>(`SELECT @@foreign_key_checks v`);
  const idTypes = await exec.query<{ TABLE_NAME: string; COLUMN_TYPE: string }>(
    `SELECT TABLE_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'id' AND TABLE_NAME IN ('tenants','businesses','employees')`
  );
  const nonInt = idTypes.filter(r => !/^int(\(\d+\))?$/.test(r.COLUMN_TYPE)).map(r => `${r.TABLE_NAME}:${r.COLUMN_TYPE}`);
  const rows = [
    { label: "جداول ledger_* موجودة مسبقًا", expected: "0", actual: String(Number(existing?.n ?? 0)) },
    { label: "الجداول المرجعية tenants/businesses/employees", expected: "3", actual: String(Number(base?.n ?? 0)) },
    { label: "الفهرسان المركّبان businesses_tenant_id/employees_tenant_id موجودان مسبقًا", expected: "0", actual: String(Number(oldIdx?.n ?? 0)) },
    { label: "businesses.tenantId = NULL", expected: "0", actual: String(Number(nullBizTenant?.n ?? 0)) },
    { label: "employees.tenantId = NULL", expected: "0", actual: String(Number(nullEmpTenant?.n ?? 0)) },
    { label: "أنشطة يتيمة (tenantId لا يشير إلى tenant)", expected: "0", actual: String(Number(orphanBiz?.n ?? 0)) },
    { label: "موظفون يتامى (tenantId لا يشير إلى tenant)", expected: "0", actual: String(Number(orphanEmp?.n ?? 0)) },
    { label: "foreign_key_checks", expected: "1", actual: String(Number(fkChecks?.v ?? 0)) },
    { label: "أعمدة id المرجعية من نوع int (لتطابق FK)", expected: "", actual: nonInt.join(",") },
  ];
  return rows.map(r => ({ ...r, ok: r.expected === r.actual }));
}
