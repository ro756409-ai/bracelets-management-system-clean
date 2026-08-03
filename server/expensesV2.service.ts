import { and, asc, eq, inArray } from "drizzle-orm";
import {
  adSpendEntries,
  businesses,
  costCenters,
  expenseAccrualSchedules,
  expenseCategories,
  expensePayments,
  expenses,
} from "../drizzle/schema";
import { allocateDaily } from "../shared/accrualAllocation";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { businessDayRange } from "../shared/businessTime";
import {
  createBusinessEventInTransaction,
  postFinancialTransactionInTransaction,
  type Actor,
} from "./accountingV2.service";
import { getDb } from "./db";

type ExpenseDraftInput = {
  businessId: number;
  categoryId?: number;
  costCenterId?: number;
  amount: string;
  currencyCode?: string;
  description: string;
  serviceFrom: string;
  serviceTo: string;
  reference?: string;
  /**
   * Optional, matching the nullable column. It used to be required all the way up to the
   * router, which made a routine 200 EGP cash expense impossible to record without first
   * producing a link for it.
   */
  evidenceUrl?: string;
  taxCode?: string;
  taxAmount?: string;
  actor: Actor;
};

async function validateExpenseDimensions(tx: any, input: ExpenseDraftInput) {
  const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
  if (!business) throw new Error("Business not found");
  if (input.currencyCode && business.baseCurrency !== input.currencyCode) throw new Error("Expense currency must match Business Base Currency");
  if (input.categoryId != null) {
    const [category] = await tx.select().from(expenseCategories).where(and(
      eq(expenseCategories.id, input.categoryId), eq(expenseCategories.businessId, input.businessId),
    )).limit(1);
    if (!category) throw new Error("Expense Category is outside this business");
  }
  if (input.costCenterId != null) {
    const [costCenter] = await tx.select().from(costCenters).where(and(
      eq(costCenters.id, input.costCenterId), eq(costCenters.businessId, input.businessId),
    )).limit(1);
    if (!costCenter) throw new Error("Cost Center is outside this business");
  }
  return business;
}

export async function createExpenseDraft(input: ExpenseDraftInput) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const business = await validateExpenseDimensions(tx, input);
    if (toMinorUnits(input.amount) <= 0n) throw new Error("Expense amount must be positive");
    const from = businessDayRange(input.serviceFrom, business.timezone).from;
    const to = businessDayRange(input.serviceTo, business.timezone).from;
    if (to < from) throw new Error("Service period end must not precede start");
    const result: any = await tx.insert(expenses).values({
      businessId: input.businessId,
      categoryId: input.categoryId ?? null,
      costCenterId: input.costCenterId ?? null,
      amount: fromMinorUnits(toMinorUnits(input.amount)),
      currencyCode: business.baseCurrency,
      status: "draft",
      serviceFrom: from,
      serviceTo: to,
      taxCode: input.taxCode ?? null,
      taxAmount: fromMinorUnits(toMinorUnits(input.taxAmount ?? "0")),
      description: input.description,
      expenseDate: from,
      reference: input.reference ?? null,
      attachmentUrl: input.evidenceUrl ?? null,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    const expenseId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!expenseId) throw new Error("Could not create Expense");
    return { expenseId };
  });
}

export async function submitExpense(input: { businessId: number; expenseId: number; actor: Actor }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.update(expenses).set({ status: "pending_approval" }).where(and(
    eq(expenses.id, input.expenseId),
    eq(expenses.businessId, input.businessId),
    eq(expenses.status, "draft"),
  ));
  return { success: Number((result as any)?.[0]?.affectedRows ?? (result as any)?.affectedRows ?? 0) === 1 };
}

export async function approveExpense(input: { businessId: number; expenseId: number; actor: Actor }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [expense] = await tx.select().from(expenses).where(and(
      eq(expenses.id, input.expenseId), eq(expenses.businessId, input.businessId),
    )).limit(1).for("update");
    if (!expense) throw new Error("Expense is outside this business");
    if (expense.status !== "pending_approval") throw new Error("Only a pending Expense can be approved");
    if (expense.createdBy === input.actor.id) throw new Error("Maker cannot approve their own Expense");
    if (!expense.serviceFrom || !expense.serviceTo) throw new Error("Expense Service Period is required");
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new Error("Business not found");
    const fromKey = new Intl.DateTimeFormat("en-CA", { timeZone: business.timezone }).format(expense.serviceFrom);
    const toKey = new Intl.DateTimeFormat("en-CA", { timeZone: business.timezone }).format(expense.serviceTo);
    const allocations = allocateDaily(expense.amount, fromKey, toKey);
    for (const allocation of allocations) {
      const accrualDate = businessDayRange(allocation.date, business.timezone).from;
      await tx.insert(expenseAccrualSchedules).values({
        businessId: input.businessId,
        expenseId: expense.id,
        accrualDate,
        amount: allocation.amount,
        status: "recognized",
      });
      await createBusinessEventInTransaction(tx, {
        businessId: input.businessId,
        eventType: "expense.accrued",
        sourceType: "expense_accrual",
        sourceReference: `${expense.id}:${allocation.date}`,
        idempotencyKey: `expense:${expense.id}:accrual:${allocation.date}`,
        occurredAt: accrualDate,
        payload: {
          expenseId: expense.id,
          categoryId: expense.categoryId,
          costCenterId: expense.costCenterId,
          accrualDate: allocation.date,
          amount: allocation.amount,
          taxCode: expense.taxCode,
          taxAmount: expense.taxAmount,
        },
        actor: input.actor,
      });
    }
    await tx.update(expenses).set({
      status: "accrued",
      recognizedAmount: expense.amount,
      approvedBy: input.actor.id,
      approvedAt: new Date(),
    }).where(eq(expenses.id, expense.id));
    return { expenseId: expense.id, accrualDays: allocations.length };
  });
}

export async function payExpense(input: {
  businessId: number;
  expenseId: number;
  sourceAccountId: number;
  amount: string;
  paidAt: Date;
  evidenceUrl: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [expense] = await tx.select().from(expenses).where(and(
      eq(expenses.id, input.expenseId), eq(expenses.businessId, input.businessId),
    )).limit(1).for("update");
    if (!expense) throw new Error("Expense is outside this business");
    if (!['accrued', 'partially_paid'].includes(expense.status)) throw new Error("Expense must be approved before payment");
    const paymentMinor = toMinorUnits(input.amount);
    const remaining = toMinorUnits(expense.amount) - toMinorUnits(expense.paidAmount);
    if (paymentMinor <= 0n || paymentMinor > remaining) throw new Error("Expense payment exceeds the remaining amount");
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "expense.paid",
      sourceType: "expense",
      sourceReference: String(expense.id),
      idempotencyKey: `expense:${expense.id}:payment:${expense.paidAmount}:${input.amount}`,
      occurredAt: input.paidAt,
      payload: { expenseId: expense.id, amount: fromMinorUnits(paymentMinor), sourceAccountId: input.sourceAccountId },
      actor: input.actor,
    });
    const financial = await postFinancialTransactionInTransaction(tx, {
      businessId: input.businessId,
      transactionType: "expense_payment",
      sourceAccountId: input.sourceAccountId,
      amount: fromMinorUnits(paymentMinor),
      currencyCode: expense.currencyCode,
      description: `Expense #${expense.id}: ${expense.description}`,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.paidAt,
      businessEventId: eventResult.event.id,
      actor: input.actor,
    });
    const paid = toMinorUnits(expense.paidAmount) + paymentMinor;
    await tx.insert(expensePayments).values({
      businessId: input.businessId,
      expenseId: expense.id,
      financialTransactionId: financial.id,
      amount: fromMinorUnits(paymentMinor),
      paidAt: input.paidAt,
    });
    await tx.update(expenses).set({
      paidAmount: fromMinorUnits(paid),
      status: paid === toMinorUnits(expense.amount) ? "paid" : "partially_paid",
    }).where(eq(expenses.id, expense.id));
    return { transactionId: financial.id, remainingAmount: fromMinorUnits(toMinorUnits(expense.amount) - paid) };
  });
}

export async function createAdSpendDraft(input: ExpenseDraftInput & {
  platformId: string;
  platformName: string;
  accountId: string;
  accountName: string;
  campaignId: string;
  campaignName: string;
  adSetId?: string;
  adId?: string;
  manualMetrics?: Record<string, number>;
  overrideReason?: string;
  notes?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const business = await validateExpenseDimensions(tx, input);
    const from = businessDayRange(input.serviceFrom, business.timezone).from;
    const to = businessDayRange(input.serviceTo, business.timezone).from;
    const expenseResult: any = await tx.insert(expenses).values({
      businessId: input.businessId,
      categoryId: input.categoryId ?? null,
      costCenterId: input.costCenterId ?? null,
      amount: fromMinorUnits(toMinorUnits(input.amount)),
      currencyCode: business.baseCurrency,
      status: "draft",
      serviceFrom: from,
      serviceTo: to,
      description: input.description,
      expenseDate: from,
      reference: input.reference ?? null,
      attachmentUrl: input.evidenceUrl,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    const expenseId = Number(expenseResult?.insertId ?? expenseResult?.[0]?.insertId);
    if (!expenseId) throw new Error("Could not create Ad Spend Expense");
    const adResult: any = await tx.insert(adSpendEntries).values({
      businessId: input.businessId,
      expenseId,
      spendDate: from,
      platformId: input.platformId,
      platformNameSnapshot: input.platformName,
      accountId: input.accountId,
      accountNameSnapshot: input.accountName,
      campaignId: input.campaignId,
      campaignNameSnapshot: input.campaignName,
      adSetId: input.adSetId ?? null,
      adId: input.adId ?? null,
      amount: fromMinorUnits(toMinorUnits(input.amount)),
      manualMetricsJson: input.manualMetrics ? JSON.stringify(input.manualMetrics) : null,
      overrideReason: input.overrideReason ?? null,
      notes: input.notes ?? null,
      createdBy: input.actor.id,
    });
    return { expenseId, adSpendId: Number(adResult?.insertId ?? adResult?.[0]?.insertId) };
  });
}
