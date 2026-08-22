import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { purchaseReceipts } from "../drizzle/schema";
import {
  getDb,
  getTreasurySummary,
  getPayrollPeriods,
  cairoStartOfDay,
  cairoEndOfDay,
} from "./db";
import { getSupplierDashboardTotals } from "./supplierLedger.service";
import { getFinancialAccounts } from "./accountingV2.service";

/**
 * ملخص لوحة المحاسب — **تجميع فقط** من دوال موجودة، مفيش أي حساب أرصدة جديد ولا جدول جديد.
 *
 *   • الخزنة/تحصيلات ومصاريف اليوم/المستحق من الشحن/آخر الحركات ← getTreasurySummary
 *   • المدفوع/المتبقي للموردين ← getSupplierDashboardTotals
 *   • رصيد البنك ← currentBalance المحفوظ في financialAccounts (قراءة عمود، مش إعادة حساب)
 *   • مرتبات الشهر ← getPayrollPeriods (حالة الدورة الحالية)
 *   • بضاعة اليوم ← مجموع إيصالات الشراء المعتمدة النهاردة (قراءة، مش حركة مخزون)
 *
 * كله للقراءة — الشاشة بتعرض بس، مابتحركش رصيد ولا بتكرّر دفتر.
 */
export async function getAccountantSummary(businessIds: number[] | null) {
  const scope = businessIds && businessIds.length > 0 ? businessIds : null;

  const treasury = await getTreasurySummary(scope);
  const suppliers = await getSupplierDashboardTotals(scope);

  // رصيد البنك = مجموع الأرصدة المحفوظة للحسابات غير النقدية (بنك) عبر الأنشطة في النطاق.
  let bankBalance = 0;
  if (scope) {
    const perBusiness = await Promise.all(scope.map(id => getFinancialAccounts(id)));
    for (const account of perBusiness.flat()) {
      if (!account.isCashEquivalent) bankBalance += Number(account.currentBalance ?? 0);
    }
  }

  // مرتبات الشهر الحالي — على مستوى الدورة (payrollPeriods)، زي النموذج الموجود بالظبط.
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const { periods } = await getPayrollPeriods({ businessIds: scope, year });
  const current = periods.find((p: any) => p.month === month) ?? null;
  const payrollNet = current ? Number(current.totalNet ?? 0) : 0;
  const payrollPaid = current?.status === "paid" ? payrollNet : 0;
  const payroll = {
    exists: Boolean(current),
    status: current?.status ?? null,
    due: payrollNet,
    paid: payrollPaid,
    remaining: payrollNet - payrollPaid,
  };

  // قيمة البضاعة المستلمة النهاردة = مجموع الإيصالات المعتمدة (اللي دخلت المخزون فعلاً).
  let goodsReceivedToday = 0;
  if (scope) {
    const db = await getDb();
    if (db) {
      const [row] = await db
        .select({
          total: sql<string>`COALESCE(SUM(${purchaseReceipts.totalAmount}), 0)`,
        })
        .from(purchaseReceipts)
        .where(
          and(
            inArray(purchaseReceipts.businessId, scope),
            eq(purchaseReceipts.status, "approved"),
            ne(purchaseReceipts.status, "voided"),
            gte(purchaseReceipts.receiptDate, cairoStartOfDay(now)),
            lte(purchaseReceipts.receiptDate, cairoEndOfDay(now))
          )
        );
      goodsReceivedToday = Number(row?.total ?? 0);
    }
  }

  return {
    // نقدية وبنك
    cashBalance: treasury.balance,
    bankBalance,
    // اليوم
    todayExpenses: treasury.todayExpenses,
    todayCollections: treasury.todayCollections,
    goodsReceivedToday,
    // شحن وموردين
    pendingCollection: treasury.pendingCollection,
    owedToSuppliers: suppliers.owedToFactories,
    owedBySuppliers: suppliers.owedByFactories,
    supplierCount: suppliers.suppliers,
    // مرتبات الشهر
    payroll,
    // آخر الحركات (تنبيه بأحدث العمليات)
    recentTransactions: treasury.recentTransactions,
  };
}
