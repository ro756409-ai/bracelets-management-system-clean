/**
 * تصنيف دورات الرواتب التاريخية مقابل التعريف المعتمد الجديد — **قراءة فقط**.
 *
 * السكربت ده **مابيكتبش ولا حرف**. مفيش insert/update/delete/transaction، وفيه اختبار
 * حارس (`scripts/classifyPayrollHistory.test.ts`) بيقفل ده. تقدر تشغّله على الإنتاج مطمّن.
 *
 *   corepack pnpm tsx scripts/classifyPayrollHistory.ts
 *   corepack pnpm tsx scripts/classifyPayrollHistory.ts --business 7
 *
 * الخلفية: المحرّك القديم كان بيستحق `totalGross` في أحداث `expense.accrued`. المحرّك
 * الجديد (`computeRealizedProfit`) بيحسب المرتب من `payroll_items` بالتعريف المعتمد
 * `salaryCostForProfit` = إجمالي − غياب − خصومات. لكل دورة بنقارن القيمتين ونصنّف:
 *
 *   • MATCHES            — القديم = الجديد.
 *   • LEGACY_DIFFERENCE  — الفرق = (غياب + خصومات) بالظبط، فرق منهجي مفهوم.
 *   • AMBIGUOUS          — الفرق حاجة تانية، محتاج نظرة بشرية.
 *
 * **مفيش backfill ولا تعديل على الأحداث.** ده تشخيص بس. لو احتجنا نطابق الفترات
 * التاريخية، ده بيتعرض كخطة منفصلة وبيقف قبل أي كتابة على الإنتاج.
 *
 * المنطق في `shared/payrollCalc` (`classifyPayrollHistory` + `salaryCostForProfit`)
 * ومُختبَر هناك — هنا بنجيب الأرقام بس.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  businessEvents,
  payrollItems,
  payrollPeriods,
} from "../drizzle/schema";
import {
  classifyPayrollHistory,
  salaryCostForProfit,
  toNumber,
  type PayrollHistoryVerdict,
} from "../shared/payrollCalc";
import { getDb } from "../server/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

type PeriodVerdict = {
  periodId: number;
  businessId: number;
  label: string;
  canonicalCost: number;
  legacyAccrued: number;
  absencePlusDeductions: number;
  verdict: PayrollHistoryVerdict;
  difference: number;
};

export async function classifyAll(businessId?: number): Promise<PeriodVerdict[]> {
  const db = await getDb();
  if (!db) throw new Error("قاعدة البيانات مش متاحة — لازم DATABASE_URL");

  const periodCond = businessId
    ? and(eq(payrollPeriods.businessId, businessId))
    : undefined;
  const periods = await db
    .select({
      id: payrollPeriods.id,
      businessId: payrollPeriods.businessId,
      year: payrollPeriods.year,
      month: payrollPeriods.month,
      status: payrollPeriods.status,
    })
    .from(payrollPeriods)
    .where(periodCond);

  const out: PeriodVerdict[] = [];
  for (const period of periods) {
    // التكلفة المعتمدة الجديدة — نفس البدائية المشتركة على كل بنود الدورة.
    const items = await db
      .select({
        baseSalary: payrollItems.baseSalary,
        overtimeAmount: payrollItems.overtimeAmount,
        bonuses: payrollItems.bonuses,
        commissions: payrollItems.commissions,
        absenceDeduction: payrollItems.absenceDeduction,
        deductions: payrollItems.deductions,
      })
      .from(payrollItems)
      .where(eq(payrollItems.periodId, period.id));
    let canonicalCost = 0;
    let absencePlusDeductions = 0;
    for (const it of items) {
      canonicalCost += salaryCostForProfit(it);
      absencePlusDeductions +=
        toNumber(it.absenceDeduction) + toNumber(it.deductions);
    }

    // القيمة القديمة المستحقة في الأحداث — أحداث المرتبات للدورة دي.
    // sourceReference = `${period.id}:${date}`، فبنطابق بالبادئة، ونجمع مبلغ كل يوم.
    const [legacyRow] = await db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(JSON_EXTRACT(${businessEvents.payloadJson}, '$.amount') AS DECIMAL(14,4))), 0)`,
      })
      .from(businessEvents)
      .where(
        and(
          eq(businessEvents.businessId, period.businessId),
          eq(businessEvents.eventType, "expense.accrued"),
          eq(businessEvents.sourceType, "payroll_period"),
          sql`${businessEvents.sourceReference} LIKE ${`${period.id}:%`}`
        )
      );

    const legacyAccrued = toNumber(legacyRow?.total);
    const { verdict, difference } = classifyPayrollHistory({
      canonicalCost,
      legacyAccrued,
      absencePlusDeductions,
    });
    out.push({
      periodId: period.id,
      businessId: period.businessId,
      label: `${period.month}/${period.year} (${period.status})`,
      canonicalCost,
      legacyAccrued,
      absencePlusDeductions,
      verdict,
      difference,
    });
  }
  return out;
}

function printReport(rows: PeriodVerdict[]) {
  const count = (v: PayrollHistoryVerdict) =>
    rows.filter(r => r.verdict === v).length;
  console.log("\n════════════════════════════════════════════════════════");
  console.log("  تصنيف دورات الرواتب التاريخية — قراءة فقط، مفيش أي كتابة");
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`  دورات اتفحصت        : ${rows.length}`);
  console.log(`  ✅ MATCHES          : ${count("MATCHES")}`);
  console.log(`  🟡 LEGACY_DIFFERENCE: ${count("LEGACY_DIFFERENCE")}  (فرق = غياب + خصومات، مفهوم)`);
  console.log(`  ❌ AMBIGUOUS        : ${count("AMBIGUOUS")}  (محتاج نظرة بشرية)`);

  const notable = rows.filter(r => r.verdict !== "MATCHES");
  if (notable.length > 0) {
    console.log(`\n──── الدورات اللي فيها فرق (${notable.length}) ────`);
    for (const r of notable) {
      console.log(
        `  دورة #${r.periodId} «${r.label}» (نشاط ${r.businessId}) — ${r.verdict}`
      );
      console.log(
        `    الجديد ${r.canonicalCost.toFixed(2)} · القديم ${r.legacyAccrued.toFixed(2)} · فرق ${r.difference.toFixed(2)} · (غياب+خصومات) ${r.absencePlusDeductions.toFixed(2)}`
      );
    }
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  مفيش أي رقم اتغيّر. ده تشخيص بس — مفيش backfill.");
  console.log("  LEGACY_DIFFERENCE فرق منهجي متوقّع، مش غلط. AMBIGUOUS محتاج مراجعة.");
  console.log("════════════════════════════════════════════════════════\n");
}

async function main() {
  const business = arg("business");
  const rows = await classifyAll(business ? Number(business) : undefined);
  printReport(rows);
  process.exit(0);
}

if (process.argv[1]?.includes("classifyPayrollHistory")) {
  main().catch(error => {
    console.error("فشل التصنيف:", error?.message ?? error);
    process.exit(1);
  });
}
