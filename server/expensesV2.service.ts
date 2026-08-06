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
  resolveDefaultTreasuryAccountInTransaction,
  type Actor,
} from "./accountingV2.service";
import { addTreasuryTransactionInTransaction, getDb } from "./db";

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

/**
 * اعتماد المصروف.
 *
 * الحاجز الأصلي: اللي سجّل المصروف مايقدرش يعتمده. ده صح في نشاط فيه محاسب ومدير —
 * بس التاجر اللي شغّال لوحده كان بيتقفل عليه المسار بالكامل. `allowSelfApproval` بيتبعت
 * من الراوتر للمالك بس (نفس نمط `voidPurchaseReceipt` في المخزون): الحاجز يفضل قايم
 * لكل الموظفين، والمالك — اللي هو الطرفين أصلاً — بيعدّي.
 */
export async function approveExpense(input: {
  businessId: number;
  expenseId: number;
  allowSelfApproval?: boolean;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [expense] = await tx.select().from(expenses).where(and(
      eq(expenses.id, input.expenseId), eq(expenses.businessId, input.businessId),
    )).limit(1).for("update");
    if (!expense) throw new Error("Expense is outside this business");
    if (expense.status !== "pending_approval") throw new Error("Only a pending Expense can be approved");
    if (expense.createdBy === input.actor.id && !input.allowSelfApproval)
      throw new Error("اللي سجّل المصروف مايقدرش يعتمده — لازم حساب تاني");
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

/**
 * دفع مصروف — والجسر بين دفترَي الفلوس.
 *
 * المشروع فيه دفترين للفلوس اتبنوا في وقتين مختلفين: `treasury_transactions` (الخزنة
 * اللي التاجر بيشوف رصيدها) و`financial_transactions` (القيد المحاسبي). الدفع كان
 * بيكتب في التاني وبس، فالتاجر يدفع إعلان بألف جنيه ويلاقي «مصروفات مدفوعة» زادت
 * والخزنة زي ما هي. الرقمين الاتنين صح كل واحد في دفتره، والتاجر شايف تناقض.
 *
 * فالدفع دلوقتي بيكتب في الاتنين **جوه نفس الترانزاكشن**. مش دفتر تالت ولا محرّك جديد —
 * نفس فكرة `mirrorLegacyStock` في المخزون: مكان واحد مسؤول عن إن الدفترين يتحركوا مع
 * بعض، فمستحيل واحد يسبق التاني.
 *
 * «مرة واحدة بالظبط»: قفل الصف على `expenses` فوق بيسلسل أي دفعتين على نفس المصروف،
 * وشرط الحالة بيرفض المدفوع بالكامل، وشرط `remaining` بيرفض الزيادة. فكل صف في
 * `expense_payments` بيقابله حركة خزنة واحدة — وكلهم في ترانزاكشن واحدة، يا ينجحوا
 * كلهم يا يترجعوا كلهم.
 */
export async function payExpense(input: {
  businessId: number;
  expenseId: number;
  /** اختياري — لو مااتبعتش، بيتصرف من «الخزنة الرئيسية». */
  sourceAccountId?: number;
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
    // التاجر اللي مانشأش حسابات بيصرف من الخزنة الرئيسية، وبتتعمل هنا لو لسه مش موجودة.
    // قبل الحدث عن قصد: الحدث بيسجّل الحساب اللي اتصرف منه فعلًا مش اللي اتطلب.
    const sourceAccountId =
      input.sourceAccountId ??
      (await resolveDefaultTreasuryAccountInTransaction(tx, input.businessId)).id;
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "expense.paid",
      sourceType: "expense",
      sourceReference: String(expense.id),
      idempotencyKey: `expense:${expense.id}:payment:${expense.paidAmount}:${input.amount}`,
      occurredAt: input.paidAt,
      payload: { expenseId: expense.id, amount: fromMinorUnits(paymentMinor), sourceAccountId },
      actor: input.actor,
    });
    const financial = await postFinancialTransactionInTransaction(tx, {
      businessId: input.businessId,
      transactionType: "expense_payment",
      sourceAccountId,
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
    const treasury = await addTreasuryTransactionInTransaction(tx, {
      businessId: input.businessId,
      type: "expense",
      direction: "out",
      amount: fromMinorUnits(paymentMinor),
      description: `دفع مصروف #${expense.id}: ${expense.description}`,
      referenceType: "expense",
      referenceId: expense.id,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
      transactionDate: input.paidAt,
    });
    // لو الخزنة مااتكتبتش، الدفعة كلها ترجع. الفشل الصريح أرحم من دفترين مختلفين.
    if (!treasury) throw new Error("تعذر تسجيل حركة الخزنة — الدفعة اترجعت");
    return {
      transactionId: financial.id,
      treasuryTransactionId: treasury.id,
      remainingAmount: fromMinorUnits(toMinorUnits(expense.amount) - paid),
    };
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

// ==================== SIMPLE EXPENSE ====================
//
// دورة حياة المصروف الكاملة أربع خطوات: مسودة ← إرسال ← اعتماد ← دفع. الأربعة موجودين
// لسبب — الاستحقاق اليومي، وفصل مين سجّل عن مين اعتمد، وسجل مراجعة كامل. بس التاجر
// اللي دفع ٢٠٠ جنيه بنزين مش هيمشي في أربع شاشات عشان يسجّلها، وأول ما المسار يبقى تقيل
// كده بيتساب خالص — والمصروف مايتسجّلش أصلاً، وده أسوأ من إنه يتسجّل ببساطة.
//
// `recordSimpleExpense` بيمشي الأربع خطوات في نداء واحد. **مش مسار موازي** — نفس
// الدوال بالظبط بنفس الترتيب، فالمصروف اللي بيطلع منه مايتفرقش عن أي مصروف تاني: نفس
// الجدول، نفس الاستحقاق، نفس الأحداث، ونفس الجسر للخزنة.

/**
 * تسجيل مصروف بسيط — بخطوة واحدة.
 *
 * `payNow` بيحدد النهاية: مستحق (لسه مادفعش) ولا مدفوع دلوقتي من الخزنة الرئيسية.
 *
 * فترة الخدمة يوم واحد — يوم المصروف نفسه. المصروفات اللي بتتوزّع على شهر (إيجار،
 * اشتراك) لسه ليها المسار الكامل بفترة من/إلى.
 *
 * كل خطوة ترانزاكشن لوحدها لأن الدوال الأصلية كده، وده مقصود: لو الاعتماد وقع، المصروف
 * بيفضل مسجّل في انتظار الاعتماد بدل ما يختفي. ولو الدفع وقع، بيفضل **مستحق** — وهي
 * بالظبط النتيجة اللي التاجر كان هيختارها لو ضغط «سجّل بس».
 */
export async function recordSimpleExpense(input: {
  businessId: number;
  categoryId?: number;
  amount: string;
  /** يوم المصروف — فترة الخدمة يوم واحد. */
  expenseDate: string;
  description: string;
  attachmentUrl?: string;
  payNow: boolean;
  actor: Actor;
}) {
  const draft = await createExpenseDraft({
    businessId: input.businessId,
    categoryId: input.categoryId,
    amount: input.amount,
    description: input.description,
    serviceFrom: input.expenseDate,
    serviceTo: input.expenseDate,
    evidenceUrl: input.attachmentUrl,
    actor: input.actor,
  });

  const submitted = await submitExpense({
    businessId: input.businessId,
    expenseId: draft.expenseId,
    actor: input.actor,
  });
  if (!submitted.success)
    throw new Error("تعذر إرسال المصروف للاعتماد — راجعه من شاشة المصروفات");

  await approveExpense({
    businessId: input.businessId,
    expenseId: draft.expenseId,
    allowSelfApproval: true,
    actor: input.actor,
  });

  if (!input.payNow)
    return { expenseId: draft.expenseId, status: "accrued" as const, paid: false };

  const payment = await payExpense({
    businessId: input.businessId,
    expenseId: draft.expenseId,
    amount: input.amount,
    paidAt: new Date(),
    // المرفق اختياري، والقيد المالي بيطلب دليل مش فاضي — فبنقول الحقيقة: اتسجّل يدوي.
    evidenceUrl: input.attachmentUrl ?? "manual-simple-expense",
    actor: input.actor,
  });

  return {
    expenseId: draft.expenseId,
    status: "paid" as const,
    paid: true,
    treasuryTransactionId: payment.treasuryTransactionId,
  };
}
