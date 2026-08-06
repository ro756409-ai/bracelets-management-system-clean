import { and, eq } from "drizzle-orm";
import { businesses, payrollPeriods } from "../drizzle/schema";
import { allocateDaily } from "../shared/accrualAllocation";
import { businessDayRange } from "../shared/businessTime";
import {
  createBusinessEvent,
  createBusinessEventInTransaction,
  postFinancialTransactionInTransaction,
  type Actor,
} from "./accountingV2.service";
import {
  addTreasuryTransactionInTransaction,
  approvePayrollPeriodInTransaction,
  getDb,
} from "./db";

function monthKeys(year: number, month: number) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year, month, 0));
  const to = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
  return { from, to };
}

export async function accrueApprovedPayrollPeriod(input: {
  periodId: number;
  evidenceUrl: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [period] = await db
    .select()
    .from(payrollPeriods)
    .where(eq(payrollPeriods.id, input.periodId))
    .limit(1);
  if (!period) throw new Error("Payroll Period not found");
  if (period.status !== "approved" && period.status !== "paid")
    throw new Error("Payroll Period must be approved first");
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, period.businessId))
    .limit(1);
  if (!business) throw new Error("Business not found");
  const keys = monthKeys(period.year, period.month);
  const allocations = allocateDaily(period.totalGross, keys.from, keys.to);
  for (const allocation of allocations) {
    await createBusinessEvent({
      businessId: period.businessId,
      eventType: "expense.accrued",
      sourceType: "payroll_period",
      sourceReference: `${period.id}:${allocation.date}`,
      idempotencyKey: `payroll-period:${period.id}:accrual:${allocation.date}`,
      occurredAt: businessDayRange(allocation.date, business.timezone).from,
      payload: {
        payrollPeriodId: period.id,
        category: "payroll",
        accrualDate: allocation.date,
        amount: allocation.amount,
        evidenceUrl: input.evidenceUrl,
      },
      actor: input.actor,
    });
  }
  return { accrualDays: allocations.length, totalGross: period.totalGross };
}

export async function approveAndAccruePayrollPeriod(input: {
  periodId: number;
  evidenceUrl: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const approval = await approvePayrollPeriodInTransaction(
      tx,
      input.periodId,
      input.actor
    );
    const [period] = await tx
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, input.periodId))
      .limit(1);
    if (!period) throw new Error("Payroll Period not found after approval");
    const [business] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, period.businessId))
      .limit(1);
    if (!business) throw new Error("Business not found");
    const keys = monthKeys(period.year, period.month);
    const allocations = allocateDaily(period.totalGross, keys.from, keys.to);
    for (const allocation of allocations) {
      await createBusinessEventInTransaction(tx, {
        businessId: period.businessId,
        eventType: "expense.accrued",
        sourceType: "payroll_period",
        sourceReference: `${period.id}:${allocation.date}`,
        idempotencyKey: `payroll-period:${period.id}:accrual:${allocation.date}`,
        occurredAt: businessDayRange(allocation.date, business.timezone).from,
        payload: {
          payrollPeriodId: period.id,
          category: "payroll",
          accrualDate: allocation.date,
          amount: allocation.amount,
          evidenceUrl: input.evidenceUrl,
        },
        actor: input.actor,
      });
    }
    return {
      ...approval,
      accrualDays: allocations.length,
      totalGross: period.totalGross,
    };
  });
}

export async function payPayrollPeriodV2(input: {
  periodId: number;
  sourceAccountId: number;
  evidenceUrl: string;
  paidAt: Date;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [period] = await tx
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, input.periodId))
      .limit(1)
      .for("update");
    if (!period) throw new Error("Payroll Period not found");
    if (period.status !== "approved")
      throw new Error("Payroll Period must be approved before payment");
    const [business] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, period.businessId))
      .limit(1);
    if (!business) throw new Error("Business not found");
    const event = await createBusinessEventInTransaction(tx, {
      businessId: period.businessId,
      eventType: "payroll.paid",
      sourceType: "payroll_period",
      sourceReference: String(period.id),
      idempotencyKey: `payroll-period:${period.id}:paid`,
      occurredAt: input.paidAt,
      payload: {
        payrollPeriodId: period.id,
        grossSalaryExpense: period.totalGross,
        netPaid: period.totalNet,
        advanceAndDeductionSettlement: (
          Number(period.totalGross) - Number(period.totalNet)
        ).toFixed(4),
      },
      actor: input.actor,
    });
    // الحارس ضد الصرف مرتين: المفتاح ثابت (`payroll-period:{id}:paid`)، فالنداء التاني
    // بيرجع من هنا من غير قيد مالي ومن غير حركة خزنة.
    if (event.duplicate)
      return {
        transactionId: null,
        treasuryTransactionId: null,
        amount: Number(period.totalNet),
        duplicate: true,
      };
    const transaction = await postFinancialTransactionInTransaction(tx, {
      businessId: period.businessId,
      transactionType: "payroll_payment",
      sourceAccountId: input.sourceAccountId,
      amount: period.totalNet,
      currencyCode: business.baseCurrency,
      description: `Payroll ${period.month}/${period.year}`,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.paidAt,
      businessEventId: event.event.id,
      actor: input.actor,
    });
    await tx
      .update(payrollPeriods)
      .set({
        status: "paid",
        paidBy: input.actor.id,
        paidByName: input.actor.name,
        paidAt: input.paidAt,
      })
      .where(
        and(
          eq(payrollPeriods.id, period.id),
          eq(payrollPeriods.businessId, period.businessId)
        )
      );
    // نفس جسر `payExpense`: المرتبات كانت بتنزل القيد المالي وبس، فرصيد الخزنة كان
    // بيفضل زي ما هو بعد صرف الشهر. الصافي (مش الإجمالي) هو اللي خرج من الدُرج —
    // السُلف والخصومات اتسوّت قبل كده ومااتدفعتش نقدًا هنا.
    const treasury = await addTreasuryTransactionInTransaction(tx, {
      businessId: period.businessId,
      type: "expense",
      direction: "out",
      amount: period.totalNet,
      description: `صرف مرتبات ${period.month}/${period.year}`,
      referenceType: "expense",
      referenceId: period.id,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
      transactionDate: input.paidAt,
    });
    if (!treasury) throw new Error("تعذر تسجيل حركة الخزنة — الصرف اترجع");
    return {
      transactionId: transaction.id,
      treasuryTransactionId: treasury.id,
      amount: Number(period.totalNet),
      duplicate: false,
    };
  });
}
