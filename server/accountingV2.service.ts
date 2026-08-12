import { createHash } from "crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  accountingClosings,
  adSpendEntries,
  businessEvents,
  businesses,
  financialAccounts,
  financialTransactionEntries,
  financialTransactions,
  orderItems,
  orders,
  payrollItems,
  payrollPeriods,
  shipmentChargeSnapshots,
  type FinancialAccount,
  type InsertBusinessEvent,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { salaryCostForProfit } from "../shared/payrollCalc";
import { addTreasuryTransactionInTransaction, getDb } from "./db";

export type Actor = { id: number; name: string };

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export async function createBusinessEventInTransaction(
  tx: any,
  input: {
    businessId: number;
    eventType: string;
    sourceType: string;
    sourceReference: string;
    idempotencyKey: string;
    occurredAt: Date;
    payload: unknown;
    actor?: Actor;
    reversesEventId?: number;
  }
) {
  const payloadJson = stableJson(input.payload);
  const hash = payloadHash(input.payload);
  const [existing] = await tx
    .select()
    .from(businessEvents)
    .where(
      and(
        eq(businessEvents.businessId, input.businessId),
        eq(businessEvents.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (existing) {
    if (existing.payloadHash !== hash)
      throw new Error("Idempotency key reused with a different payload");
    return { event: existing, duplicate: true } as const;
  }

  const [latestLocked] = await tx
    .select()
    .from(accountingClosings)
    .where(
      and(
        eq(accountingClosings.businessId, input.businessId),
        eq(accountingClosings.status, "locked")
      )
    )
    .orderBy(desc(accountingClosings.periodTo))
    .limit(1);
  let accountingEffectiveAt = input.occurredAt;
  let originalClosingId: number | null = null;
  if (latestLocked && input.occurredAt < latestLocked.periodTo) {
    accountingEffectiveAt = latestLocked.periodTo;
    const [originalClosing] = await tx
      .select()
      .from(accountingClosings)
      .where(
        and(
          eq(accountingClosings.businessId, input.businessId),
          eq(accountingClosings.status, "locked"),
          lte(accountingClosings.periodFrom, input.occurredAt),
          gt(accountingClosings.periodTo, input.occurredAt)
        )
      )
      .orderBy(desc(accountingClosings.periodTo))
      .limit(1);
    originalClosingId = originalClosing?.id ?? null;
  }

  const result: any = await tx.insert(businessEvents).values({
    businessId: input.businessId,
    eventType: input.eventType,
    sourceType: input.sourceType,
    sourceReference: input.sourceReference,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    accountingEffectiveAt,
    isPostClosingAdjustment: originalClosingId != null,
    originalClosingId,
    payloadJson,
    payloadHash: hash,
    reversesEventId: input.reversesEventId ?? null,
    createdBy: input.actor?.id ?? null,
    createdByName: input.actor?.name ?? null,
  } as InsertBusinessEvent);
  const eventId = Number(result?.insertId ?? result?.[0]?.insertId);
  if (!eventId) throw new Error("Could not create business event");

  await tx
    .update(accountingClosings)
    .set({ isStale: true })
    .where(
      and(
        eq(accountingClosings.businessId, input.businessId),
        eq(accountingClosings.status, "pending_approval"),
        sql`${accountingEffectiveAt} >= ${accountingClosings.periodFrom}`,
        sql`${accountingEffectiveAt} < ${accountingClosings.periodTo}`
      )
    );

  const [event] = await tx
    .select()
    .from(businessEvents)
    .where(eq(businessEvents.id, eventId))
    .limit(1);
  return { event, duplicate: false } as const;
}

export async function createBusinessEvent(input: {
  businessId: number;
  eventType: string;
  sourceType: string;
  sourceReference: string;
  idempotencyKey: string;
  occurredAt: Date;
  payload: unknown;
  actor?: Actor;
  reversesEventId?: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(tx => createBusinessEventInTransaction(tx, input));
}

export async function createFinancialAccount(input: {
  businessId: number;
  code: string;
  name: string;
  accountType: string;
  isCashEquivalent?: boolean;
  allowNegativeBalance?: boolean;
  currencyCode: string;
  openingBalance?: string;
  openingBalanceAt?: Date;
  openingEvidenceUrl?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [business] = await db
    .select({ baseCurrency: businesses.baseCurrency })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  if (!business) throw new Error("Business not found");
  if (business.baseCurrency !== input.currencyCode)
    throw new Error(
      "Financial Account currency must match Business Base Currency"
    );
  const opening = fromMinorUnits(toMinorUnits(input.openingBalance ?? "0"));
  const result: any = await db.insert(financialAccounts).values({
    ...input,
    isCashEquivalent: input.isCashEquivalent ?? true,
    allowNegativeBalance: input.allowNegativeBalance ?? false,
    openingBalance: opening,
    currentBalance: opening,
  });
  return { id: Number(result?.insertId ?? result?.[0]?.insertId) };
}

/**
 * كود «الخزنة الرئيسية» — ثابت عن قصد.
 *
 * فيه `uniqueIndex` على (businessId, code)، فالكود الثابت هو اللي بيضمن إن النشاط
 * مايعملش خزنتين رئيسيتين مهما اتنادت الدالة كام مرة أو من كام تبويب في نفس اللحظة.
 */
export const DEFAULT_TREASURY_ACCOUNT_CODE = "CASH-MAIN";
export const DEFAULT_TREASURY_ACCOUNT_NAME = "الخزنة الرئيسية";

/**
 * الخزنة الرئيسية للنشاط — بتلاقيها أو بتعملها.
 *
 * التاجر مش محاسب. الدفع كان بيطلب منه «حساب مالي مصدر» من قايمة فاضية — ولو مالاقاش
 * حاجة يختارها، `postFinancialTransaction` بيرمي «Financial account is outside this
 * business» وهو مش فاهم يعني إيه. فالمسار ده بيديله خزنة واحدة اسمها «الخزنة الرئيسية»
 * من غير ما يشوف كود ولا نوع حساب ولا مدين ودائن.
 *
 * **بتسمح بالرصيد السالب عن قصد.** الحساب بيتعمل برصيد افتتاحي صفر — لأن التاجر مش
 * هيقعد يجرد الدُرج عشان يسجّل مصروف — وبعدين `postFinancialTransaction` بيرفض أي
 * حركة بتنزّل الرصيد تحت الصفر. يعني أول مصروف كان هيترفض برسالة محاسبية بحتة. الرقم
 * اللي التاجر بيصدّقه هو رصيد الخزنة في `treasury_transactions`، والحساب ده مراية ليه.
 *
 * جوه ترانزاكشن الدفع عن قصد: لو الدفعة رجعت، الخزنة اللي اتعملت معاها ترجع كمان.
 */
export const EMPLOYEE_ADVANCES_ACCOUNT_CODE = "EMP-ADVANCES";
export const EMPLOYEE_ADVANCES_ACCOUNT_NAME = "سُلف الموظفين";

/**
 * حساب افتراضي بيتلاقى أو يتعمل — الشكل العام للي «الخزنة الرئيسية» بتستخدمه.
 *
 * اتعمّم لما السُلفة احتاجت حسابين: الخزنة اللي الفلوس خرجت منها، وحساب بيمسك إن
 * الموظف مدين بيها. الاتنين نفس المشكلة — التاجر مالوش دعوة يعرف إن فيه حاجة اسمها
 * حساب مدينين — ونفس الحل: كود ثابت، والقيد الفريد بيمنع التكرار حتى مع نداءين
 * متوازيين.
 */
async function resolveDefaultAccountInTransaction(
  tx: any,
  businessId: number,
  spec: {
    code: string;
    name: string;
    accountType: string;
    isCashEquivalent: boolean;
    inactiveMessage: string;
  }
): Promise<FinancialAccount> {
  const find = async (): Promise<FinancialAccount | undefined> => {
    const [row] = await tx
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.businessId, businessId),
          eq(financialAccounts.code, spec.code)
        )
      )
      .limit(1);
    return row;
  };

  const existing = await find();
  if (existing) {
    if (!existing.isActive) throw new Error(spec.inactiveMessage);
    return existing;
  }

  const [business] = await tx
    .select({ baseCurrency: businesses.baseCurrency })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!business) throw new Error("Business not found");

  try {
    await tx.insert(financialAccounts).values({
      businessId,
      code: spec.code,
      name: spec.name,
      accountType: spec.accountType,
      isCashEquivalent: spec.isCashEquivalent,
      allowNegativeBalance: true,
      currencyCode: business.baseCurrency,
      openingBalance: "0",
      currentBalance: "0",
    });
  } catch (error) {
    // نداءين متوازيين: التاني بيقع على الـunique index. ده النتيجة الصح مش خطأ —
    // الخزنة اتعملت خلاص، فنقراها ونكمّل.
    const raced = await find();
    if (!raced) throw error;
    return raced;
  }

  const created = await find();
  if (!created) throw new Error(`تعذر إنشاء ${spec.name}`);
  return created;
}

/** الخزنة الرئيسية — الفلوس النقدية بتخرج وتدخل منها. */
export async function resolveDefaultTreasuryAccountInTransaction(
  tx: any,
  businessId: number
): Promise<FinancialAccount> {
  return resolveDefaultAccountInTransaction(tx, businessId, {
    code: DEFAULT_TREASURY_ACCOUNT_CODE,
    name: DEFAULT_TREASURY_ACCOUNT_NAME,
    accountType: "cash",
    isCashEquivalent: true,
    inactiveMessage: "الخزنة الرئيسية موقوفة — فعّلها من إعدادات الحسابات",
  });
}

/**
 * سُلف الموظفين — اللي الموظفين مدينين بيه.
 *
 * مش «cash equivalent» عن قصد: الفلوس دي مش في الدُرج، هي دَيْن على موظف. لو اتحسبت
 * نقدية كان رصيد الخزنة هيعدّ نفس الجنيه مرتين.
 */
export async function resolveEmployeeAdvancesAccountInTransaction(
  tx: any,
  businessId: number
): Promise<FinancialAccount> {
  return resolveDefaultAccountInTransaction(tx, businessId, {
    code: EMPLOYEE_ADVANCES_ACCOUNT_CODE,
    name: EMPLOYEE_ADVANCES_ACCOUNT_NAME,
    accountType: "receivable",
    isCashEquivalent: false,
    inactiveMessage: "حساب سُلف الموظفين موقوف — فعّله من إعدادات الحسابات",
  });
}

export async function getFinancialAccounts(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(financialAccounts)
    .where(eq(financialAccounts.businessId, businessId))
    .orderBy(asc(financialAccounts.name));
}

type DashboardPayload = Record<string, any>;

function readMoney(payload: DashboardPayload, key: string): bigint {
  const value = payload[key];
  return value == null ? 0n : toMinorUnits(String(value));
}

function parseEventPayload(payloadJson: string): DashboardPayload {
  try {
    return JSON.parse(payloadJson) as DashboardPayload;
  } catch {
    return {};
  }
}

/**
 * المحرّك الوحيد لصافي الربح الفعلي — **مصدر الحقيقة الوحيد** لكل شاشة (المحاسبة،
 * مركز التحكّم، الـKPIs، التقارير). ممنوع أي معادلة ربح تانية في أي مكان؛ الكل بينده هنا.
 *
 * أساس **الاستحقاق** (accrual) للفترة اللي حصل فيها الإيراد والتكلفة — مش تاريخ خروج
 * الكاش. الكاش حاجة تانية بتتعرض في الخزنة، ومابتتخلطش بالربح.
 *
 * كل جنيه تكلفة بيقع في سلة واحدة بس — الحماية من الازدواج مبنية في القراءة:
 *  • الإيراد/COGS/الشحن/الخسائر: من `business_events` (delivered/returned/shipping/scrap).
 *  • المصروفات التشغيلية والإعلانات: من أحداث `expense.accrued` بتاعة `expense_accrual`،
 *    والإعلان بيتفرز بعضوية `ad_spend_entries.expenseId` — فالإعلان بيتحسب مرة واحدة،
 *    ومابيتطرحش تاني كتشغيلي.
 *  • المرتبات: **مش** من أحداث `expense.accrued` (اللي بتُنشأ بقيمة `totalGross` قديمة)،
 *    لكن من `payroll_items` بالتعريف المعتمد الوحيد `salaryCostForProfit`. أحداث المرتبات
 *    (`sourceType = 'payroll_period'`) **مستبعدة** من سلة المصروفات هنا، فالمرتب بيتحسب
 *    مرة واحدة بالتعريف الصح. مافيش أي كتابة على الأحداث التاريخية — استبعاد وقت القراءة بس.
 *
 * ملاحظة توافق تاريخي: أحداث المرتبات القديمة سايبينها زي ما هي في الجدول (append-only)،
 * بس مش بنعتمد على قيمتها في الربح. سكربت التصنيف بيقارن القديم بالجديد للتشخيص.
 */
export type RealizedProfitBreakdown = {
  revenue: number;
  revenueReversals: number;
  netRevenue: number;
  cogs: number;
  shippingCost: number;
  operatingExpenses: number;
  advertising: number;
  payrollCost: number;
  scrapLoss: number;
  netProfit: number;
  profitMargin: number;
};

/** أول يوم من شهر الدورة كـDate بتوقيت UTC — للفلترة على نافذة الفترة. */
function payrollPeriodMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

export async function computeRealizedProfit(input: {
  businessIds?: number[] | null;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<RealizedProfitBreakdown> {
  const empty: RealizedProfitBreakdown = {
    revenue: 0,
    revenueReversals: 0,
    netRevenue: 0,
    cogs: 0,
    shippingCost: 0,
    operatingExpenses: 0,
    advertising: 0,
    payrollCost: 0,
    scrapLoss: 0,
    netProfit: 0,
    profitMargin: 0,
  };
  const db = await getDb();
  // نطاق فاضي = رفض (نفس نمط denyWhenEmpty في العزل) — مش "كل الأنشطة".
  const businessIds = input.businessIds ?? [];
  if (!db || businessIds.length === 0) return empty;

  const eventConditions: any[] = [
    inArray(businessEvents.businessId, businessIds),
    eq(businessEvents.status, "active"),
  ];
  if (input.dateFrom)
    eventConditions.push(
      gte(businessEvents.accountingEffectiveAt, input.dateFrom)
    );
  if (input.dateTo)
    eventConditions.push(
      lt(businessEvents.accountingEffectiveAt, input.dateTo)
    );
  const events = await db
    .select()
    .from(businessEvents)
    .where(and(...eventConditions))
    .orderBy(asc(businessEvents.accountingEffectiveAt));

  let revenue = 0n;
  let revenueReversals = 0n;
  let cogs = 0n;
  let shippingCost = 0n;
  let scrapLoss = 0n;
  // أحداث المصروفات غير-المرتبات: بنجمّعها بالـexpenseId عشان نفرز الإعلان عن التشغيلي
  // بعد ما نعرف مين مربوط بحملة. المرتبات (payroll_period) مستبعدة تمامًا من هنا.
  const expenseAccrualByExpenseId = new Map<number, bigint>();
  let expenseAccrualNoId = 0n;
  for (const event of events) {
    const payload = parseEventPayload(event.payloadJson);
    if (event.eventType === "shipment.delivered") {
      revenue += readMoney(payload, "revenue");
      cogs += readMoney(payload, "cogs");
    } else if (
      event.eventType === "shipment.returned" ||
      event.eventType === "shipment.partial_return"
    ) {
      revenueReversals += readMoney(payload, "revenueReversal");
      cogs -= readMoney(payload, "returnsPendingInspection");
    } else if (event.eventType === "shipping.charge_recognized") {
      shippingCost += readMoney(payload, "amount");
    } else if (event.eventType === "shipping.cost_adjustment") {
      shippingCost += readMoney(payload, "amount");
    } else if (event.eventType === "expense.accrued") {
      // المرتبات ليها مصدرها المعتمد (payroll_items) — بنستبعد حدثها من سلة المصروفات
      // عشان مايتحسبش مرتين. ما عداها بيتجمّع بالـexpenseId للفرز.
      if (event.sourceType === "payroll_period") continue;
      const amount = readMoney(payload, "amount");
      const expenseId = Number(payload.expenseId ?? 0);
      if (expenseId > 0) {
        expenseAccrualByExpenseId.set(
          expenseId,
          (expenseAccrualByExpenseId.get(expenseId) ?? 0n) + amount
        );
      } else {
        expenseAccrualNoId += amount;
      }
    } else if (
      event.eventType === "inventory.return_inspected" &&
      Array.isArray(payload.items)
    ) {
      for (const item of payload.items) {
        if (item.disposition === "scrap" || item.disposition === "missing") {
          scrapLoss +=
            toMinorUnits(String(item.unitCostSnapshot ?? "0")) *
            BigInt(Number(item.quantity ?? 0));
        }
      }
    }
  }

  // فرز الإعلانات: أي مصروف مربوط بحملة (`ad_spend_entries.expenseId`) بيتحسب إعلان،
  // والباقي تشغيلي. الإعلان جوّه المصروفات أصلاً — الفرز بيمنع خصمه مرتين.
  let advertising = 0n;
  let operatingExpenses = expenseAccrualNoId;
  const expenseIds = [...expenseAccrualByExpenseId.keys()];
  const adExpenseIds = new Set<number>();
  if (expenseIds.length > 0) {
    const adRows = await db
      .select({ expenseId: adSpendEntries.expenseId })
      .from(adSpendEntries)
      .where(inArray(adSpendEntries.expenseId, expenseIds));
    for (const row of adRows) adExpenseIds.add(Number(row.expenseId));
  }
  for (const [expenseId, amount] of expenseAccrualByExpenseId) {
    if (adExpenseIds.has(expenseId)) advertising += amount;
    else operatingExpenses += amount;
  }

  // المرتبات — التعريف المعتمد الوحيد، مرة واحدة. الدورات المعتمدة/المدفوعة اللي شهرها
  // واقع في نافذة الفترة. كل صف بيمرّ على `salaryCostForProfit` (نفس المنطق في كل مكان).
  const payrollConditions: any[] = [
    inArray(payrollPeriods.businessId, businessIds),
    inArray(payrollPeriods.status, ["approved", "paid"] as any),
  ];
  const payrollRows = await db
    .select({
      year: payrollPeriods.year,
      month: payrollPeriods.month,
      baseSalary: payrollItems.baseSalary,
      overtimeAmount: payrollItems.overtimeAmount,
      bonuses: payrollItems.bonuses,
      commissions: payrollItems.commissions,
      absenceDeduction: payrollItems.absenceDeduction,
      deductions: payrollItems.deductions,
    })
    .from(payrollItems)
    .innerJoin(payrollPeriods, eq(payrollItems.periodId, payrollPeriods.id))
    .where(and(...payrollConditions));
  let payrollCost = 0n;
  for (const row of payrollRows) {
    const monthStart = payrollPeriodMonthStart(row.year, row.month);
    if (input.dateFrom && monthStart < input.dateFrom) continue;
    if (input.dateTo && monthStart >= input.dateTo) continue;
    // نفس البدائية المشتركة — بنحوّل لأصغر وحدة بعد الحساب عشان الجمع يفضل مضبوط.
    payrollCost += toMinorUnits(salaryCostForProfit(row).toFixed(2));
  }

  const netRevenueMinor = revenue - revenueReversals;
  const netProfitMinor =
    netRevenueMinor -
    cogs -
    shippingCost -
    operatingExpenses -
    advertising -
    payrollCost -
    scrapLoss;
  const netRevenue = Number(fromMinorUnits(netRevenueMinor));
  const netProfit = Number(fromMinorUnits(netProfitMinor));
  return {
    revenue: Number(fromMinorUnits(revenue)),
    revenueReversals: Number(fromMinorUnits(revenueReversals)),
    netRevenue,
    cogs: Number(fromMinorUnits(cogs)),
    shippingCost: Number(fromMinorUnits(shippingCost)),
    operatingExpenses: Number(fromMinorUnits(operatingExpenses)),
    advertising: Number(fromMinorUnits(advertising)),
    payrollCost: Number(fromMinorUnits(payrollCost)),
    scrapLoss: Number(fromMinorUnits(scrapLoss)),
    netProfit,
    profitMargin:
      netRevenueMinor > 0n
        ? Number((netProfitMinor * 10000n) / netRevenueMinor) / 100
        : 0,
  };
}

/** Accounting dashboard source of truth: immutable Business Events plus order snapshots. */
export async function getBusinessEventDashboard(input: {
  businessIds: number[];
  dateFrom?: Date;
  dateTo?: Date;
}) {
  const db = await getDb();
  const empty = {
    realized: {
      revenue: 0,
      revenueReversals: 0,
      cogs: 0,
      shippingCost: 0,
      operatingExpenses: 0,
      advertising: 0,
      payrollCost: 0,
      expenses: 0,
      scrapLoss: 0,
      netProfit: 0,
      profitMargin: 0,
    },
    projected: {
      revenue: 0,
      productCost: 0,
      shippingCost: 0,
      profit: 0,
      orderCount: 0,
    },
    cash: { balance: 0, inflow: 0, outflow: 0 },
    movementByDay: [] as Array<{
      day: string;
      inflow: number;
      outflow: number;
    }>,
  };
  if (!db || input.businessIds.length === 0) return empty;

  // الربح الفعلي من المحرّك الوحيد — مافيش حساب ربح تاني هنا.
  const realized = await computeRealizedProfit(input);

  const orderConditions: any[] = [
    inArray(orders.businessId, input.businessIds),
    notInArray(orders.status, ["cancelled", "returned", "delivered"] as any[]),
  ];
  if (input.dateFrom)
    orderConditions.push(gte(orders.createdAt, input.dateFrom));
  if (input.dateTo) orderConditions.push(lt(orders.createdAt, input.dateTo));
  const projectedOrders = await db
    .select({
      id: orders.id,
      projectedShippingCostSnapshot: orders.projectedShippingCostSnapshot,
    })
    .from(orders)
    .where(and(...orderConditions));
  const projectedOrderIds = projectedOrders.map(order => order.id);
  const projectedItems =
    projectedOrderIds.length > 0
      ? await db
          .select()
          .from(orderItems)
          .where(inArray(orderItems.orderId, projectedOrderIds))
      : [];
  let projectedRevenue = 0n;
  let projectedProductCost = 0n;
  for (const item of projectedItems) {
    projectedRevenue +=
      toMinorUnits(item.netAmountSnapshot ?? "0") +
      toMinorUnits(item.customerShippingSnapshot ?? "0");
    projectedProductCost +=
      toMinorUnits(item.projectedUnitCostSnapshot ?? "0") *
      BigInt(item.quantity);
  }
  const projectedShipping = projectedOrders.reduce(
    (sum, order) =>
      sum + toMinorUnits(order.projectedShippingCostSnapshot ?? "0"),
    0n
  );
  const projectedProfit =
    projectedRevenue - projectedProductCost - projectedShipping;

  const accounts = await db
    .select()
    .from(financialAccounts)
    .where(
      and(
        inArray(financialAccounts.businessId, input.businessIds),
        eq(financialAccounts.isActive, true)
      )
    );
  const transactionConditions: any[] = [
    inArray(financialTransactions.businessId, input.businessIds),
  ];
  if (input.dateFrom)
    transactionConditions.push(
      gte(financialTransactions.occurredAt, input.dateFrom)
    );
  if (input.dateTo)
    transactionConditions.push(
      lt(financialTransactions.occurredAt, input.dateTo)
    );
  const transactions = await db
    .select()
    .from(financialTransactions)
    .where(and(...transactionConditions));
  let inflow = 0n;
  let outflow = 0n;
  const movement = new Map<string, { inflow: bigint; outflow: bigint }>();
  for (const transaction of transactions) {
    const amount = toMinorUnits(transaction.amount);
    if (transaction.targetAccountId) inflow += amount;
    if (transaction.sourceAccountId) outflow += amount;
    const day = transaction.occurredAt.toISOString().slice(0, 10);
    const row = movement.get(day) ?? { inflow: 0n, outflow: 0n };
    if (transaction.targetAccountId) row.inflow += amount;
    if (transaction.sourceAccountId) row.outflow += amount;
    movement.set(day, row);
  }

  return {
    realized: {
      revenue: realized.revenue,
      revenueReversals: realized.revenueReversals,
      cogs: realized.cogs,
      shippingCost: realized.shippingCost,
      // البنود المفصّلة — الإعلانات والمرتبات كل واحدة لوحدها، والتشغيلي من غيرهم.
      operatingExpenses: realized.operatingExpenses,
      advertising: realized.advertising,
      payrollCost: realized.payrollCost,
      // `expenses` = مجموع السلال التلاتة، للتوافق مع أي قارئ قديم بيعرض المصروفات كرقم
      // واحد. البنود فوق بتجمعه بالظبط — مفيش ازدواج.
      expenses:
        realized.operatingExpenses + realized.advertising + realized.payrollCost,
      scrapLoss: realized.scrapLoss,
      netProfit: realized.netProfit,
      profitMargin: realized.profitMargin,
    },
    projected: {
      revenue: Number(fromMinorUnits(projectedRevenue)),
      productCost: Number(fromMinorUnits(projectedProductCost)),
      shippingCost: Number(fromMinorUnits(projectedShipping)),
      profit: Number(fromMinorUnits(projectedProfit)),
      orderCount: projectedOrders.length,
    },
    cash: {
      balance: Number(
        fromMinorUnits(
          accounts.reduce(
            (sum, account) => sum + toMinorUnits(account.currentBalance),
            0n
          )
        )
      ),
      inflow: Number(fromMinorUnits(inflow)),
      outflow: Number(fromMinorUnits(outflow)),
    },
    movementByDay: [...movement.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, row]) => ({
        day,
        inflow: Number(fromMinorUnits(row.inflow)),
        outflow: Number(fromMinorUnits(row.outflow)),
      })),
  };
}

export async function postFinancialTransaction(input: {
  businessId: number;
  transactionType: string;
  sourceAccountId?: number;
  targetAccountId?: number;
  amount: string;
  currencyCode: string;
  description: string;
  evidenceUrl: string;
  externalCounterparty?: string;
  occurredAt: Date;
  businessEventId?: number;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(tx => postFinancialTransactionInTransaction(tx, input));
}

export async function postFinancialTransactionInTransaction(
  tx: any,
  input: {
    businessId: number;
    transactionType: string;
    sourceAccountId?: number;
    targetAccountId?: number;
    amount: string;
    currencyCode: string;
    description: string;
    evidenceUrl: string;
    externalCounterparty?: string;
    occurredAt: Date;
    businessEventId?: number;
    actor: Actor;
  }
) {
  if (!input.sourceAccountId && !input.targetAccountId)
    throw new Error("A source or target account is required");
  if (
    input.sourceAccountId &&
    input.sourceAccountId === input.targetAccountId
  ) {
    throw new Error("Source and target accounts must be different");
  }
  const amountMinor = toMinorUnits(input.amount);
  if (amountMinor <= 0n) throw new Error("Transaction amount must be positive");
  {
    const accountIds = [input.sourceAccountId, input.targetAccountId]
      .filter((id): id is number => id != null)
      .sort((a, b) => a - b);
    const lockedAccounts = await tx
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.businessId, input.businessId),
          inArray(financialAccounts.id, accountIds)
        )
      )
      .orderBy(asc(financialAccounts.id))
      .for("update");
    if (lockedAccounts.length !== accountIds.length)
      throw new Error("Financial account is outside this business");
    if (
      lockedAccounts.some(
        (account: FinancialAccount) =>
          account.currencyCode !== input.currencyCode
      )
    ) {
      throw new Error(
        "Financial account currency does not match the business transaction currency"
      );
    }

    const result: any = await tx.insert(financialTransactions).values({
      businessId: input.businessId,
      businessEventId: input.businessEventId ?? null,
      transactionType: input.transactionType,
      sourceAccountId: input.sourceAccountId ?? null,
      targetAccountId: input.targetAccountId ?? null,
      amount: fromMinorUnits(amountMinor),
      currencyCode: input.currencyCode,
      externalCounterparty: input.externalCounterparty ?? null,
      description: input.description,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.occurredAt,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    const transactionId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!transactionId) throw new Error("Could not post financial transaction");

    for (const account of lockedAccounts) {
      const direction = account.id === input.sourceAccountId ? "out" : "in";
      const signedAmount = direction === "in" ? amountMinor : -amountMinor;
      const balanceAfter = toMinorUnits(account.currentBalance) + signedAmount;
      if (balanceAfter < 0n && !account.allowNegativeBalance) {
        throw new Error(
          `Financial Account #${account.id} does not allow a negative balance`
        );
      }
      await tx
        .update(financialAccounts)
        .set({
          currentBalance: fromMinorUnits(balanceAfter),
          version: account.version + 1,
        })
        .where(eq(financialAccounts.id, account.id));
      await tx.insert(financialTransactionEntries).values({
        transactionId,
        businessId: input.businessId,
        accountId: account.id,
        direction,
        amount: fromMinorUnits(amountMinor),
        balanceAfter: fromMinorUnits(balanceAfter),
      });
    }
    return { id: transactionId };
  }
}

/**
 * إيداع/سحب يدوي على الخزنة — **idempotent بمعرّف عملية**.
 *
 * الإدخال اليدوي كان بينادي `addTreasuryTransaction` مباشرة بلا أي حماية، فـdouble-click
 * = حركتين. الحل مش heuristic على (المبلغ + الوصف + اليوم) — عمليتين شرعيتين ممكن
 * يبقوا متطابقين تمامًا (إيداعين ٥٠٠ نفس اليوم بنفس الوصف). الحل معرّف عملية بيولّده
 * العميل لكل ضغطة مقصودة:
 *
 *   نفس الطلب اتبعت تاني (retry شبكة) → نفس المعرّف → حركة واحدة.
 *   عملية جديدة مقصودة حتى بنفس البيانات → معرّف جديد → حركة جديدة.
 *
 * بيعيد استخدام `business_events` (UNIQUE على businessId + idempotencyKey) — **مفيش
 * migration**. الحدث والحركة في transaction واحدة.
 */
export async function recordManualTreasuryEntry(input: {
  businessId: number;
  type: "deposit" | "withdrawal";
  amount: string;
  description: string;
  notes?: string;
  transactionDate: Date;
  operationId: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const event = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: `treasury.manual_${input.type}`,
      sourceType: "treasury_manual",
      sourceReference: input.operationId,
      idempotencyKey: `treasury:manual:${input.operationId}`,
      occurredAt: input.transactionDate,
      payload: {
        type: input.type,
        amount: input.amount,
        description: input.description,
      },
      actor: input.actor,
    });
    // نفس معرّف العملية اتبعت قبل كده → الحركة اتعملت خلاص. مفيش حركة تانية.
    if (event.duplicate) {
      return { duplicate: true as const, transaction: null };
    }
    const treasury = await addTreasuryTransactionInTransaction(tx, {
      businessId: input.businessId,
      type: input.type,
      direction: input.type === "deposit" ? "in" : "out",
      amount: input.amount,
      description: input.description,
      notes: input.notes ?? null,
      referenceType: "manual",
      referenceId: null,
      performedBy: input.actor.id,
      performedByName: input.actor.name,
      transactionDate: input.transactionDate,
    } as any);
    return { duplicate: false as const, transaction: treasury };
  });
}
