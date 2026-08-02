import { allocateEvenly, fromMinorUnits } from "./accountingMoney";

export type DailyAccrual = { date: string; amount: string };

export function allocateDaily(
  total: string,
  serviceFrom: string,
  serviceToInclusive: string,
): DailyAccrual[] {
  const from = parseDate(serviceFrom);
  const to = parseDate(serviceToInclusive);
  if (to.getTime() < from.getTime()) throw new Error("Service period end must not precede start");
  const dates: string[] = [];
  for (let cursor = from; cursor.getTime() <= to.getTime(); cursor = addUtcDays(cursor, 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  const allocations = allocateEvenly(total, dates.length);
  return dates.map((date, index) => ({ date, amount: fromMinorUnits(allocations[index]) }));
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date must use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return date;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
