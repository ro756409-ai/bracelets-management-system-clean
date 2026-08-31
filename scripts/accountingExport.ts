/**
 * Accounting Archive — Excel exporter (SELECT-only, safe).
 *
 * بيصدّر كل الجداول المحاسبية القديمة لملف .xlsx واحد (sheet لكل جدول) قبل أي أرشفة/إزالة.
 *
 * ⚠️ أمان — اقرأ قبل التشغيل:
 *   • **مايتصلش بالإنتاج.** شغّله على **نسخة/سناب‑شوت** من القاعدة (dump → restore على DB منفصلة).
 *   • SELECT فقط — مفيش INSERT/UPDATE/DELETE/DROP ولا أي DDL.
 *   • بيرفض التشغيل إلا لو `ACCOUNTING_EXPORT_CONFIRM=1` **و** `DATABASE_URL` متظبّط (حاجز نيّة).
 *   • مفيش أي host/كريدنشيال مكتوب هنا — بياخد الاتصال من `DATABASE_URL` اللي **إنت** بتحطه.
 *
 * التشغيل (على نسخة):
 *   export DATABASE_URL="mysql://user:pass@COPY_HOST:3306/matjarak_copy"
 *   export ACCOUNTING_EXPORT_CONFIRM=1
 *   corepack pnpm tsx scripts/accountingExport.ts
 *
 * الناتج: accounting-export-<timestamp>.xlsx (+ sheet "_manifest" بأسماء الجداول وأعداد الصفوف).
 */
import * as XLSX from "xlsx";
import { getDb } from "../server/db";
import {
  financialAccounts, financialTransactions, financialTransactionEntries,
  treasuryTransactions, expenses, expenseCategories, expensePayments,
  expenseAccrualSchedules, payrollSettings, employeeSalaryProfiles, payrollPeriods,
  payrollItems, employeeAdvances, employeeBonuses, businessEvents,
  carrierSettlements, carrierSettlementLines, adSpendEntries,
  accountingClosings, accountingClosingLines, accountingClosingAdjustments,
  accountingClosingActions, inventoryTransactions, inventoryBalances,
  stocktakes, stocktakeLines,
} from "../drizzle/schema";

// اسم الشيت ↔ الجدول. الترتيب حسب inventory الوثيقة (docs/accounting-archive-inventory.md).
const TABLES: Record<string, any> = {
  financial_accounts: financialAccounts,
  financial_transactions: financialTransactions,
  financial_transaction_entries: financialTransactionEntries,
  treasury_transactions: treasuryTransactions,
  expenses,
  expense_categories: expenseCategories,
  expense_payments: expensePayments,
  expense_accrual_schedules: expenseAccrualSchedules,
  payroll_settings: payrollSettings,
  employee_salary_profiles: employeeSalaryProfiles,
  payroll_periods: payrollPeriods,
  payroll_items: payrollItems,
  employee_advances: employeeAdvances,
  employee_bonuses: employeeBonuses,
  business_events: businessEvents,
  carrier_settlements: carrierSettlements,
  carrier_settlement_lines: carrierSettlementLines,
  ad_spend_entries: adSpendEntries,
  accounting_closings: accountingClosings,
  accounting_closing_lines: accountingClosingLines,
  accounting_closing_adjustments: accountingClosingAdjustments,
  accounting_closing_actions: accountingClosingActions,
  inventory_transactions: inventoryTransactions,
  inventory_balances: inventoryBalances,
  stocktakes,
  stocktake_lines: stocktakeLines,
};

// Excel بيقصّ اسم الشيت عند 31 حرف — نقصّره ونضمن التفرّد.
function sheetName(name: string, used: Set<string>): string {
  let base = name.slice(0, 31);
  let n = 1;
  while (used.has(base)) base = `${name.slice(0, 27)}_${++n}`;
  used.add(base);
  return base;
}

async function main() {
  if (process.env.ACCOUNTING_EXPORT_CONFIRM !== "1") {
    console.error(
      "رفض: لازم تأكيد صريح. اضبط ACCOUNTING_EXPORT_CONFIRM=1 وشغّل على نسخة من القاعدة (مش الإنتاج)."
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("رفض: DATABASE_URL مش متظبّط. حطّه على نسخة/سناب‑شوت — مش الإنتاج.");
    process.exit(1);
  }
  const db = await getDb();
  if (!db) {
    console.error("تعذّر الاتصال بقاعدة البيانات (تأكد إن DATABASE_URL يشاور على نسخة صالحة).");
    process.exit(1);
  }

  const wb = XLSX.utils.book_new();
  const manifest: Array<{ table: string; rows: number }> = [];
  const used = new Set<string>();

  for (const [name, table] of Object.entries(TABLES)) {
    let rows: any[] = [];
    try {
      rows = await db.select().from(table); // SELECT فقط
    } catch (e) {
      console.warn(`تخطّي ${name}: ${(e as Error).message}`);
      manifest.push({ table: name, rows: -1 });
      continue;
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName(name, used));
    manifest.push({ table: name, rows: rows.length });
    console.log(`✓ ${name}: ${rows.length} صف`);
  }

  const manifestWs = XLSX.utils.json_to_sheet(manifest);
  XLSX.utils.book_append_sheet(wb, manifestWs, "_manifest");

  // Date.now متاح في node script عادي (مش workflow) — للطابع الزمني في اسم الملف.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `accounting-export-${stamp}.xlsx`;
  XLSX.writeFile(wb, out);
  console.log(`\nتم: ${out} (${manifest.length} جدول).`);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
