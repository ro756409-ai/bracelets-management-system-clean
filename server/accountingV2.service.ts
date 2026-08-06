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
  businessEvents,
  businesses,
  financialAccounts,
  financialTransactionEntries,
  financialTransactions,
  orderItems,
  orders,
  shipmentChargeSnapshots,
  type FinancialAccount,
  type InsertBusinessEvent,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { getDb } from "./db";

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
export async function resolveDefaultTreasuryAccountInTransaction(
  tx: any,
  businessId: number
): Promise<FinancialAccount> {
  const find = async (): Promise<FinancialAccount | undefined> => {
    const [row] = await tx
      .select()
      .from(financialAccounts)
      .where(
        and(
          eq(financialAccounts.businessId, businessId),
          eq(financialAccounts.code, DEFAULT_TREASURY_ACCOUNT_CODE)
        )
      )
      .limit(1);
    return row;
  };

  const existing = await find();
  if (existing) {
    if (!existing.isActive)
      throw new Error("الخزنة الرئيسية موقوفة — فعّلها من إعدادات الحسابات");
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
      code: DEFAULT_TREASURY_ACCOUNT_CODE,
      name: DEFAULT_TREASURY_ACCOUNT_NAME,
      accountType: "cash",
      isCashEquivalent: true,
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
  if (!created) throw new Error("تعذر إنشاء الخزنة الرئيسية");
  return created;
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

  const eventConditions: any[] = [
    inArray(businessEvents.businessId, input.businessIds),
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
  let expensesAmount = 0n;
  let scrapLoss = 0n;
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
      expensesAmount += readMoney(payload, "amount");
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
  const realizedRevenue = revenue - revenueReversals;
  const realizedProfit =
    realizedRevenue - cogs - shippingCost - expensesAmount - scrapLoss;

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
      revenue: Number(fromMinorUnits(realizedRevenue)),
      revenueReversals: Number(fromMinorUnits(revenueReversals)),
      cogs: Number(fromMinorUnits(cogs)),
      shippingCost: Number(fromMinorUnits(shippingCost)),
      expenses: Number(fromMinorUnits(expensesAmount)),
      scrapLoss: Number(fromMinorUnits(scrapLoss)),
      netProfit: Number(fromMinorUnits(realizedProfit)),
      profitMargin:
        realizedRevenue > 0n
          ? Number((realizedProfit * 10000n) / realizedRevenue) / 100
          : 0,
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
