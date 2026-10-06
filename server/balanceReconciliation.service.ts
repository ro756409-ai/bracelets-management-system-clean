import mysql from "mysql2/promise";
import { buildBalanceReport, type AccountRow, type BalanceReconciliationReport, type EntryRow, type TreasuryRow } from "../shared/balanceReconciliation";

/**
 * مطابقة الأرصدة — طبقة القراءة. **SELECT فقط**: الجلسة `SET SESSION TRANSACTION READ ONLY`
 * فيرفض MySQL نفسه أي كتابة، والمنفّذ يرفض أي عبارة لا تبدأ بـSELECT. لا يطبع الرابط ولا
 * أي سر. يعمل على أنشطة محددة أو على كل الأنشطة الممرَّرة له (النطاق يقرره المنادي).
 */
export type ReadOnlyExecutor = {
  query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
};

export async function openReadOnlyExecutor(databaseUrl: string): Promise<ReadOnlyExecutor> {
  const conn = await mysql.createConnection(databaseUrl);
  // وضع القراءة فقط على مستوى الجلسة: كل عبارة (autocommit) تعمل في معاملة قراءة فقط يرفض
  // فيها MySQL أي كتابة، وكل استعلام يرى أحدث البيانات (لا لقطة واحدة مجمّدة).
  await conn.query("SET SESSION TRANSACTION READ ONLY");
  return {
    async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
      if (!/^\s*select\b/i.test(sql)) throw new Error("Refusing to run a non-SELECT statement");
      const [rows] = await conn.query(sql, params);
      return rows as T[];
    },
    async close() {
      await conn.end();
    },
  };
}

/** كل الأنشطة الموجودة (للتشغيل على «الكل»). */
export async function listBusinessIds(exec: ReadOnlyExecutor): Promise<number[]> {
  const rows = await exec.query<{ id: number }>("SELECT id FROM businesses ORDER BY id");
  return rows.map(r => Number(r.id));
}

export async function loadBalanceReport(exec: ReadOnlyExecutor, businessIds: number[]): Promise<BalanceReconciliationReport> {
  if (businessIds.length === 0) return buildBalanceReport({ businessIds: [], treasury: [], accounts: [], entries: [] });
  const ph = businessIds.map(() => "?").join(",");
  const treasury = await exec.query<TreasuryRow>(
    `SELECT id, businessId, direction, amount, balanceAfter, transactionDate FROM treasury_transactions WHERE businessId IN (${ph}) ORDER BY id`,
    businessIds
  );
  const accounts = await exec.query<AccountRow>(
    `SELECT id, businessId, code, name, accountType, openingBalance, currentBalance, isActive FROM financial_accounts WHERE businessId IN (${ph}) ORDER BY businessId, code`,
    businessIds
  );
  const entries = accounts.length === 0 ? [] : await exec.query<EntryRow>(
    `SELECT e.accountId, e.direction, e.amount, e.createdAt, e.transactionId FROM financial_transaction_entries e WHERE e.businessId IN (${ph}) ORDER BY e.id`,
    businessIds
  );
  return buildBalanceReport({ businessIds, treasury, accounts, entries });
}
