import { and, eq } from "drizzle-orm";
import { businesses, employeeAdvances, employees } from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import {
  createBusinessEventInTransaction,
  postFinancialTransactionInTransaction,
  type Actor,
} from "./accountingV2.service";
import { getDb } from "./db";

export async function issueEmployeeAdvance(input: {
  businessId: number;
  employeeId: number;
  amount: string;
  advanceDate: Date;
  reason?: string;
  sourceAccountId: number;
  receivableAccountId: number;
  evidenceUrl: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [employee] = await tx.select().from(employees).where(and(
      eq(employees.id, input.employeeId), eq(employees.businessId, input.businessId),
    )).limit(1);
    if (!employee) throw new Error("Employee is outside this business");
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new Error("Business not found");
    const amount = fromMinorUnits(toMinorUnits(input.amount));
    const event = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "employee_advance.issued",
      sourceType: "employee",
      sourceReference: String(employee.id),
      idempotencyKey: `employee:${employee.id}:advance:${input.advanceDate.toISOString()}:${amount}`,
      occurredAt: input.advanceDate,
      payload: { employeeId: employee.id, amount, receivableAccountId: input.receivableAccountId },
      actor: input.actor,
    });
    const transaction = await postFinancialTransactionInTransaction(tx, {
      businessId: input.businessId,
      transactionType: "employee_advance",
      sourceAccountId: input.sourceAccountId,
      targetAccountId: input.receivableAccountId,
      amount,
      currencyCode: business.baseCurrency,
      description: `Employee Advance - ${employee.name}`,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.advanceDate,
      businessEventId: event.event.id,
      actor: input.actor,
    });
    const result: any = await tx.insert(employeeAdvances).values({
      businessId: input.businessId,
      employeeId: employee.id,
      employeeName: employee.name,
      amount,
      advanceDate: input.advanceDate,
      reason: input.reason ?? null,
      sourceAccountId: input.sourceAccountId,
      receivableAccountId: input.receivableAccountId,
      financialTransactionId: transaction.id,
      evidenceUrl: input.evidenceUrl,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    return { id: Number(result?.insertId ?? result?.[0]?.insertId), transactionId: transaction.id };
  });
}

export async function cancelEmployeeAdvance(input: {
  businessId: number;
  advanceId: number;
  reason: string;
  evidenceUrl: string;
  occurredAt: Date;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [advance] = await tx.select().from(employeeAdvances).where(and(
      eq(employeeAdvances.id, input.advanceId), eq(employeeAdvances.businessId, input.businessId),
    )).limit(1).for("update");
    if (!advance) throw new Error("Employee Advance is outside this business");
    if (advance.status !== "pending") throw new Error("Only a pending Employee Advance can be cancelled");
    if (!advance.sourceAccountId || !advance.receivableAccountId) {
      throw new Error("Legacy Employee Advance requires a manual reviewed adjustment");
    }
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new Error("Business not found");
    const event = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "employee_advance.cancelled",
      sourceType: "employee_advance",
      sourceReference: String(advance.id),
      idempotencyKey: `employee-advance:${advance.id}:cancelled`,
      occurredAt: input.occurredAt,
      payload: { advanceId: advance.id, amount: advance.amount, reason: input.reason },
      actor: input.actor,
    });
    const transaction = await postFinancialTransactionInTransaction(tx, {
      businessId: input.businessId,
      transactionType: "employee_advance_reversal",
      sourceAccountId: advance.receivableAccountId,
      targetAccountId: advance.sourceAccountId,
      amount: advance.amount,
      currencyCode: business.baseCurrency,
      description: `Employee Advance cancellation - ${advance.employeeName}`,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.occurredAt,
      businessEventId: event.event.id,
      actor: input.actor,
    });
    await tx.update(employeeAdvances).set({ status: "cancelled" }).where(eq(employeeAdvances.id, advance.id));
    return { transactionId: transaction.id };
  });
}
