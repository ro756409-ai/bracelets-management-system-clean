export type BusinessDateRange = { from: Date; toExclusive: Date };

function partsAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(part => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    assertValidTimeZone(timeZone);
    return true;
  } catch {
    return false;
  }
}

function offsetAt(date: Date, timeZone: string): number {
  const p = partsAt(date, timeZone);
  const representedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return representedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function zonedDateTimeToUtc(
  date: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): Date {
  assertValidTimeZone(timeZone);
  const utcGuess = Date.UTC(
    date.year, date.month - 1, date.day,
    date.hour ?? 0, date.minute ?? 0, date.second ?? 0,
  );
  let candidate = new Date(utcGuess - offsetAt(new Date(utcGuess), timeZone));
  candidate = new Date(utcGuess - offsetAt(candidate, timeZone));
  return candidate;
}

export function businessDayRange(date: string, timeZone: string): BusinessDateRange {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error("Date must use YYYY-MM-DD");
  const [, year, month, day] = match.map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    from: zonedDateTimeToUtc({ year, month, day }, timeZone),
    toExclusive: zonedDateTimeToUtc({
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
    }, timeZone),
  };
}

export function businessDateKey(date: Date, timeZone: string): string {
  const p = partsAt(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
