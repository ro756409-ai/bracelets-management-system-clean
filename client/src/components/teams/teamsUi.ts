import { TRPCClientError } from "@trpc/client";
import { useTenantAccess } from "@/contexts/TenantAccessContext";
import { businessDateKey } from "@shared/businessTime";

/**
 * مساعدات واجهة الفرق (0044، خلف TEAMS_ENABLED). العقد على السيرفر هو الحكم: الواجهة لا تفترض نجاح أي عملية،
 * ولا ترسل tenantId/employeeId/تواريخ سريان — التغييرات «من الآن» بتوقيت قاعدة البيانات.
 */
export const TEAMS_TZ = "Africa/Cairo";
const LOCALE = "ar-EG-u-nu-latn"; // أرقام إنجليزية داخل نص عربي

/** وقت epoch (ms UTC) بتوقيت النشاط (القاهرة افتراضيًا). */
export function formatMs(ms: number | null | undefined, tz = TEAMS_TZ): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(LOCALE, { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}
export function formatDay(ms: number | null | undefined, tz = TEAMS_TZ): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString(LOCALE, { timeZone: tz, day: "numeric", month: "short", year: "numeric" });
}
export function formatClockMs(ms: number | null | undefined, tz = TEAMS_TZ): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString(LOCALE, { timeZone: tz, hour: "numeric", minute: "2-digit" });
}
export const fmtNum = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-US").format(n));

const BY_CODE: Record<string, string> = {
  UNAUTHORIZED: "انتهت الجلسة — سجّل الدخول مرة أخرى.",
  FORBIDDEN: "ليست لديك صلاحية لهذا الإجراء.",
  NOT_FOUND: "غير موجود أو خارج نطاقك.",
  CONFLICT: "تعارض مع حالة حالية — حدّث الصفحة وحاول مرة أخرى.",
  PRECONDITION_FAILED: "نظام الفرق غير مفعّل.",
  BAD_REQUEST: "تعذّر تنفيذ الطلب — راجع المدخلات.",
  TOO_MANY_REQUESTS: "طلبات كثيرة — انتظر قليلًا ثم حاول.",
};

/** سبب رفض السيرفر بالعربي كما أرسله (رسائل الخدمة عربية)، وإلا رسالة عامة حسب الرمز. */
export function serverErrorText(error: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "لا يوجد اتصال بالإنترنت.";
  if (error instanceof TRPCClientError) {
    const code = (error.data as { code?: string } | undefined)?.code ?? "";
    const msg = error.message ?? "";
    // رسائل الخدمة العربية (مثل «يوجد فريق نشط لهذا النشاط — أوقفه أولًا») تُعرض كما هي؛ أخطاء التحقق التقنية لا.
    if (/[؀-ۿ]/.test(msg) && !/[{}\[\]]/.test(msg)) return msg;
    if (BY_CODE[code]) return BY_CODE[code];
  }
  return "تعذّر الاتصال — حاول مرة أخرى.";
}
export function errorCode(error: unknown): string | null {
  return error instanceof TRPCClientError ? ((error.data as { code?: string } | undefined)?.code ?? null) : null;
}

/** الكتابة متاحة؟ وضع القراءة فقط/الحظر للشركة يعطّل الكتابة ويُبقي القراءة. */
export function useWritesBlocked(): { blocked: boolean; reason: string | null } {
  const t = useTenantAccess();
  if (t.readOnly || t.blocked) return { blocked: true, reason: "الحساب في وضع القراءة فقط — الكتابة معطّلة." };
  return { blocked: false, reason: null };
}

export const TOUCH = "min-h-11 md:min-h-9";

/** مفتاح يوم «YYYY-MM-DD» بتوقيت النشاط، قبل n يوم من الآن. */
export function dayKey(daysAgo = 0, tz = TEAMS_TZ): string {
  return businessDateKey(new Date(Date.now() - daysAgo * 86_400_000), tz);
}
