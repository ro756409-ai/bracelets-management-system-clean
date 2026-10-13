import { LEDGER_MIGRATION_MARKERS, LEDGER_PREREQ_TABLES } from "../shared/ledgerPrereqsSpec";

type Exec = { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> };
export type PrereqRow = { area: string; table: string; required: boolean; present: boolean; missingColumns: string[]; ok: boolean };

/**
 * فحص قراءة فقط لمتطلبات Ledger V3 على قاعدة قائمة: الجداول والأعمدة المطلوبة (المخزون/الشحن/المرتبات…)، قيم ENUM المضافة
 * (0045 accounts_manager، 0046 أنواع الحسابات)، وحالة Migrations الدفتر. لا يكتب شيئًا (المنفّذ يرفض غير SELECT).
 */
export async function checkLedgerPrereqs(exec: Exec) {
  const cols = await exec.query<{ t: string; c: string }>("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()");
  const byTable = new Map<string, Set<string>>();
  for (const r of cols) { const k = String(r.t); if (!byTable.has(k)) byTable.set(k, new Set()); byTable.get(k)!.add(String(r.c)); }
  const tables: PrereqRow[] = LEDGER_PREREQ_TABLES.map(p => {
    const have = byTable.get(p.table);
    const missingColumns = have ? p.columns.filter(c => !have.has(c)) : p.columns;
    const present = Boolean(have);
    return { area: p.area, table: p.table, required: p.required, present, missingColumns, ok: !p.required || (present && missingColumns.length === 0) };
  });
  const enumOf = async (table: string, column: string) => String((await exec.query<{ t: string }>(
    "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, column]))[0]?.t ?? "");
  const roleType = await enumOf("employees", "role");
  const kindType = await enumOf("ledger_accounts", "kind");
  const enums = [
    { id: "0045", label: "دور «مدير الحسابات» في employees.role", ok: roleType.includes("'accounts_manager'") },
    { id: "0046", label: "أنواع الحسابات payroll_payable / supplier_advance", ok: kindType.includes("'payroll_payable'") && kindType.includes("'supplier_advance'") },
  ];
  const migrations = LEDGER_MIGRATION_MARKERS.map(m => {
    const present = m.tables.filter(t => byTable.has(t));
    return { id: m.id, label: m.label, state: present.length === m.tables.length ? "present" : present.length === 0 ? "absent" : "partial", missing: m.tables.filter(t => !byTable.has(t)) };
  });
  const prerequisitesOk = tables.every(t => t.ok);
  return { prerequisitesOk, tables, enums, migrations };
}
