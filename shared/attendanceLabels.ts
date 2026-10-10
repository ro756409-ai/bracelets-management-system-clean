import { zonedDateTimeToUtc } from "./businessTime";
import type { AttendanceDayStatus, CorrectionRequestType, AssignmentTarget } from "./attendanceSpec";

/** تسميات الحضور العربية + تحويلات الوقت للواجهة — نقية ومختبرة، مشتركة بين شاشة الموظف والمالك. */
export const DAY_STATUS_LABELS: Record<AttendanceDayStatus, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" | "primary" }> = {
  open: { label: "حاضر", tone: "primary" },
  on_break: { label: "في استراحة", tone: "info" },
  closed: { label: "مكتمل", tone: "success" },
  absent: { label: "غائب", tone: "danger" },
  leave: { label: "إجازة", tone: "neutral" },
  mission: { label: "مأمورية", tone: "neutral" },
  holiday: { label: "عطلة", tone: "neutral" },
  day_off: { label: "يوم راحة", tone: "neutral" },
  incomplete: { label: "بلا انصراف", tone: "warning" },
};

export const REQUEST_TYPE_LABELS: Record<CorrectionRequestType, string> = {
  missing_clock_in: "نسيت تسجيل الحضور",
  missing_clock_out: "نسيت تسجيل الانصراف",
  wrong_time: "وقت مسجّل خطأ",
  break_fix: "تصحيح استراحة",
  absence_to_leave: "تحويل غياب إلى إجازة",
  absence_to_mission: "تحويل غياب إلى مأمورية",
  early_leave_reason: "سبب خروج مبكر",
  other: "أخرى",
};

export const REQUEST_STATUS_LABELS: Record<string, { label: string; tone: "warning" | "success" | "danger" | "neutral" }> = {
  pending: { label: "قيد المراجعة", tone: "warning" },
  approved: { label: "معتمد", tone: "success" },
  rejected: { label: "مرفوض", tone: "danger" },
  canceled: { label: "ملغي", tone: "neutral" },
};

export const ASSIGNMENT_TARGET_LABELS: Record<AssignmentTarget, string> = {
  employee: "موظف محدد",
  role: "دور",
  business: "نشاط",
  tenant_default: "افتراضي الشركة",
};

export const CLOCK_ACTION_LABELS = { clock_in: "تسجيل الحضور", break_start: "بداية استراحة", break_end: "نهاية استراحة", clock_out: "تسجيل الانصراف" } as const;
export type ClockActionKey = keyof typeof CLOCK_ACTION_LABELS;

/** الأفعال المتاحة الآن من حالة اليوم المفتوح (السيرفر هو الحكم النهائي). */
export function availableClockActions(open: { status: string } | null | undefined): ClockActionKey[] {
  if (!open) return ["clock_in"];
  if (open.status === "on_break") return ["break_end", "clock_out"];
  if (open.status === "open") return ["break_start", "clock_out"];
  return ["clock_in"];
}

/** «YYYY-MM-DD» + «HH:MM» بتوقيت IANA ⇒ ISO UTC؛ nextDay للوردية الليلية بعد منتصف الليل. */
export function localTimeToIso(workDate: string, hhmm: string, timeZone: string, nextDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [year, month, day] = workDate.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day + (nextDay ? 1 : 0)));
  return zonedDateTimeToUtc({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), hour, minute }, timeZone).toISOString();
}

/** ms ⇒ «HH:MM» بتوقيت اليوم. */
export function formatClock(ms: number | string | null | undefined, timeZone: string): string {
  if (ms == null || ms === "") return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Number(ms)));
}

export const formatMinutes = (m: number | string | null | undefined) => {
  const n = Number(m ?? 0);
  if (!n) return "0";
  const h = Math.floor(n / 60), r = n % 60;
  return h ? `${h}س ${r}د` : `${r}د`;
};

/** أسماء أحداث التسجيل القابلة للتصحيح (اختيار الحدث في «وقت مسجّل خطأ»). */
export const CORRECTABLE_EVENT_LABELS = { clock_in: "حضور", break_start: "بداية استراحة", break_end: "نهاية استراحة", clock_out: "انصراف" } as const;

/** ms ⇒ «12:16 م» (12 ساعة، أرقام لاتينية كبقية الشاشة) بتوقيت اليوم. */
export function formatClock12(ms: number | string | null | undefined, timeZone: string): string {
  if (ms == null || ms === "") return "—";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(Number(ms)));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase() === "AM" ? "ص" : "م"}`;
}
