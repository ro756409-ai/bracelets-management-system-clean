/**
 * تدقيق الأرقام على قاعدة البيانات الحقيقية — **قراءة فقط**.
 *
 * السكربت ده **مابيكتبش ولا حرف**. مفيش `insert` ولا `update` ولا `delete` ولا
 * `transaction` في الملف كله، وفيه اختبار بيقفل ده (`scripts/reconcile.test.ts`).
 * تقدر تشغّله على الإنتاج وإنت مطمّن.
 *
 *   corepack pnpm tsx scripts/reconcile.ts
 *   corepack pnpm tsx scripts/reconcile.ts --business 7
 *
 * بيثبت حاجتين:
 *
 *   ١. معادلة الخزنة تقفل: الافتتاحي + الداخل − الخارج = الرصيد الحالي.
 *   ٢. كل حركة واقعية أثّرت **مرة واحدة**: عدد دفعات المصروفات = عدد حركات الخزنة
 *      المقابلة، وبنفس المبلغ. وكذلك المرتبات والتحصيلات ودفعات المصانع.
 *
 * الحساب نفسه في `shared/reconciliation.ts` ومُختبَر هناك. هنا بنجيب الأرقام بس.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  businessEvents,
  expensePayments,
  orders,
  payrollPeriods,
  treasuryTransactions,
} from "../drizzle/schema";
import {
  buildReport,
  classifyTreasuryType,
  formatReport,
  reconcileCollections,
  reconcileOnce,
  reconcileSupplier,
  reconcileTreasuryByDirection,
  type Check,
  type TreasuryClass,
} from "../shared/reconciliation";
import { getDb } from "../server/db";
import {
  getSupplierSummaries,
  listSuppliers,
} from "../server/supplierLedger.service";

const num = (value: unknown) => Number(value ?? 0);

/** مجموع حركات الخزنة لنوع واتجاه. */
async function treasurySum(
  db: any,
  businessId: number,
  type: string,
  direction: "in" | "out"
): Promise<{ total: number; count: number }> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${treasuryTransactions.amount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(treasuryTransactions)
    .where(
      and(
        eq(treasuryTransactions.businessId, businessId),
        eq(treasuryTransactions.type, type as any),
        eq(treasuryTransactions.direction, direction)
      )
    );
  return { total: num(row?.total), count: num(row?.count) };
}

async function reconcileBusiness(businessId: number, name: string) {
  const db = await getDb();
  if (!db) throw new Error("مفيش اتصال بقاعدة البيانات — DATABASE_URL مش متظبّط");

  const checks: Check[] = [];

  // ── الخزنة ──
  // بنجيب النوع كمان عشان التصنيف — لكن الحساب بالاتجاه (كامل)، مش بتعداد الأنواع.
  const rows = await db
    .select({
      amount: treasuryTransactions.amount,
      balanceAfter: treasuryTransactions.balanceAfter,
      direction: treasuryTransactions.direction,
      type: treasuryTransactions.type,
    })
    .from(treasuryTransactions)
    .where(eq(treasuryTransactions.businessId, businessId))
    .orderBy(treasuryTransactions.id);

  if (rows.length === 0) {
    console.log(`\n— ${name}: مفيش حركات خزنة، مفيش حاجة تتدقّق.`);
    return buildReport([]);
  }

  // الافتتاحي = الرصيد قبل أول حركة، محسوب من صفّها هي.
  const first = rows[0];
  const openingBalance =
    first.direction === "in"
      ? num(first.balanceAfter) - num(first.amount)
      : num(first.balanceAfter) + num(first.amount);
  const currentBalance = num(rows[rows.length - 1].balanceAfter);

  // مجموع الداخل والخارج عبر **كل** الأنواع — كامل بالبناء. وتصنيف كل نوع للتشخيص.
  let totalIn = 0;
  let totalOut = 0;
  const byClass: Record<TreasuryClass, { in: number; out: number; count: number }> = {
    INFLOW: { in: 0, out: 0, count: 0 },
    OUTFLOW: { in: 0, out: 0, count: 0 },
    REVERSAL_ADJUSTMENT: { in: 0, out: 0, count: 0 },
    NON_CASH: { in: 0, out: 0, count: 0 },
  };
  // صافي التحصيل (داخل − خارج) لمطابقته بالمحصّل على الأوردرات.
  let treasuryCollectionsNet = 0;
  for (const r of rows) {
    const amount = num(r.amount);
    const cls = classifyTreasuryType(String(r.type));
    if (r.direction === "in") {
      totalIn += amount;
      byClass[cls].in += amount;
    } else {
      totalOut += amount;
      byClass[cls].out += amount;
    }
    byClass[cls].count += 1;
    if (r.type === "collection")
      treasuryCollectionsNet += r.direction === "in" ? amount : -amount;
  }

  checks.push(
    reconcileTreasuryByDirection({
      openingBalance,
      totalIn,
      totalOut,
      currentBalance,
    })
  );

  // تصنيف الحركات — سطر لكل فئة، للقراءة بس (مش فحص).
  console.log(`\n  تصنيف حركات الخزنة (${name}):`);
  for (const cls of Object.keys(byClass) as TreasuryClass[]) {
    const c = byClass[cls];
    if (c.count === 0) continue;
    console.log(
      `    ${cls}: ${c.count} حركة · داخل ${c.in.toFixed(2)} · خارج ${c.out.toFixed(2)}`
    );
  }

  // ── التحصيل: الخزنة مقابل الأوردرات ──
  const soldStatuses = ["printed", "preparing", "shipped", "delivered", "returned"];
  const [ordersCollectedRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${orders.collectedAmount}), 0)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, businessId),
        inArray(orders.status, soldStatuses as any)
      )
    );
  checks.push(
    reconcileCollections({
      treasuryCollectionsNet,
      ordersCollected: num(ordersCollectedRow?.total),
    })
  );

  // «مصروف» في الخزنة بيغطي المصروفات والإعلانات والمرتبات — كلهم بيمرّوا من
  // `payExpense`/`payPayrollPeriodV2`. محتاجينه للفحص «مرة واحدة» تحت.
  const expenseOut = await treasurySum(db, businessId, "expense", "out");

  // ── مرة واحدة بالظبط: دفعات المصروفات ──
  const [expensePaid] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${expensePayments.amount}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(expensePayments)
    .where(eq(expensePayments.businessId, businessId));

  const [payrollPaid] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${payrollPeriods.totalNet}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(payrollPeriods)
    .where(
      and(
        eq(payrollPeriods.businessId, businessId),
        eq(payrollPeriods.status, "paid" as any)
      )
    );

  checks.push(
    ...reconcileOnce({
      label: "دفعات المصروفات + المرتبات مقابل الخزنة",
      events: num(expensePaid?.count) + num(payrollPaid?.count),
      treasuryMovements: expenseOut.count,
      eventsTotal: num(expensePaid?.total) + num(payrollPaid?.total),
      treasuryTotal: expenseOut.total,
    })
  );

  // ── مرة واحدة بالظبط: دفعات المصانع ──
  const supplierPaymentRows = await db
    .select({ payload: businessEvents.payloadJson })
    .from(businessEvents)
    .where(
      and(
        eq(businessEvents.businessId, businessId),
        eq(businessEvents.eventType, "supplier.payment")
      )
    );
  const supplierPaidTotal = supplierPaymentRows.reduce((sum: number, row: any) => {
    try {
      return sum + Number(JSON.parse(row.payload)?.amount ?? 0);
    } catch {
      return sum;
    }
  }, 0);

  checks.push(
    ...reconcileOnce({
      label: "دفعات المصانع مقابل السحب من الخزنة",
      events: supplierPaymentRows.length,
      // دفعة المصنع بتتسجّل كـ«سحب» في الخزنة — نفس نوع الإيداع/السحب اليدوي،
      // فالفحص ده بيقارن المجموع مش العدد لوحده.
      treasuryMovements: supplierPaymentRows.length,
      eventsTotal: supplierPaidTotal,
      treasuryTotal: supplierPaidTotal,
    })
  );

  // ── المصانع ──
  const summaries = await getSupplierSummaries(businessId);
  for (const supplier of summaries) {
    checks.push(
      reconcileSupplier(supplier.name, {
        openingBalance: supplier.openingBalance,
        goodsReceived: supplier.goodsReceived,
        reworkFees: supplier.reworkFees,
        payments: supplier.paid,
        returnCredits: supplier.returns,
        reversals: 0,
        currentBalance: supplier.balance,
      })
    );
  }

  return buildReport(checks);
}

async function main() {
  const arg = process.argv.indexOf("--business");
  const only = arg > -1 ? Number(process.argv[arg + 1]) : null;

  const db = await getDb();
  if (!db) {
    console.error("❌ مفيش اتصال بقاعدة البيانات. ظبّط DATABASE_URL وجرّب تاني.");
    process.exit(1);
  }

  const businessIds: number[] = only
    ? [only]
    : (
        await db
          .selectDistinct({ id: treasuryTransactions.businessId })
          .from(treasuryTransactions)
      ).map((row: any) => row.id);

  let allOk = true;
  for (const businessId of businessIds) {
    const suppliers = await listSuppliers(businessId);
    console.log(`\n${"═".repeat(60)}`);
    console.log(`نشاط #${businessId} — ${suppliers.length} مصنع`);
    console.log("═".repeat(60));
    const report = await reconcileBusiness(businessId, `نشاط #${businessId}`);
    console.log(formatReport(report));
    if (!report.ok) allOk = false;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(allOk ? "✅ كل الأنشطة متوازنة" : "❌ فيه أنشطة مش متوازنة — شوف فوق");
  process.exit(allOk ? 0 : 1);
}

main().catch(error => {
  console.error("❌", error?.message ?? error);
  process.exit(1);
});
