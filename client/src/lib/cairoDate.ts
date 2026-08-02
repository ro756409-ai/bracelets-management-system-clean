import { businessDateKey, businessDayRange } from "@shared/businessTime";

const CAIRO_TIMEZONE = "Africa/Cairo";

export function cairoDateKey(date = new Date()): string {
  return businessDateKey(date, CAIRO_TIMEZONE);
}

export function previousDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function cairoDayRange(dateKey: string): { from: Date; to: Date } {
  const range = businessDayRange(dateKey, CAIRO_TIMEZONE);
  return { from: range.from, to: new Date(range.toExclusive.getTime() - 1) };
}

export function cairoArabicWeekday(date = new Date()): string {
  return new Intl.DateTimeFormat("ar-EG", { timeZone: CAIRO_TIMEZONE, weekday: "long" }).format(date).replace("الأحد", "الاحد").replace("الأربعاء", "الاربعاء");
}
