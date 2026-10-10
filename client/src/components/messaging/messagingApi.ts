import type { inferRouterOutputs } from "@trpc/server";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "../../../../server/routers";

/**
 * طبقة الوصول لمركز الرسائل في الواجهة — نفس المكونات لجلستين:
 *   • "web"    → `trpc.messages.*`               (المالك/الأدمن/المدير داخل DashboardLayout)
 *   • "portal" → `trpc.employeePortal.messages.*` (الموظف داخل بوابته — كوكي البوابة فقط)
 * التعريف على السيرفر واحد (buildMessagingRouter)، فالشكل متطابق والاختيار ثابت لكل شاشة.
 * الهوية والشركة من الجلسة على السيرفر فقط — الواجهة لا ترسل tenantId/employeeId أبدًا.
 */
export type MessagingVia = "web" | "portal";
type Outputs = inferRouterOutputs<AppRouter>["messages"];
export type MessagingStatus = Outputs["status"];
export type ConversationsResult = Outputs["conversations"];
export type ConversationRow = Extract<ConversationsResult, { enabled: true }>["conversations"][number];
export type MonitorRow = Extract<ConversationsResult, { enabled: true }>["monitor"][number];
export type ReadResult = Outputs["read"];
export type ChatMessage = ReadResult["messages"][number];
export type DirectoryRow = Outputs["directory"][number];
export type HistoryRow = Outputs["history"][number];

/** إجراءات tRPC للجلسة المختارة (ثابتة طوال عمر الشاشة — لا تغيّر ترتيب الـhooks). */
export function useMessagingApi(via: MessagingVia) {
  return (via === "portal" ? trpc.employeePortal.messages : trpc.messages) as typeof trpc.messages;
}
export function useMessagingUtils(via: MessagingVia) {
  const utils = trpc.useUtils();
  return (via === "portal" ? utils.employeePortal.messages : utils.messages) as typeof utils.messages;
}

/** مسارات الشاشة لكل جلسة (المعرّف في الرابط للتنقل فقط — السيرفر يقرر الوصول). */
export const messagesBasePath = (via: MessagingVia) => (via === "portal" ? "/my-messages" : "/messages");
/** مسار الصوت المصرّح (لا روابط تخزين عامة). */
export const voiceUrl = (via: MessagingVia, messageId: number) => `/api/messages/voice/${messageId}?via=${via}`;
export const voiceUploadUrl = (via: MessagingVia) => `/api/messages/voice?via=${via}`;

/** رسائل عربية لكل حالة خطأ متوقعة — بلا تفاصيل تقنية ولا مفاتيح تخزين. */
const BY_CODE: Record<string, string> = {
  UNAUTHORIZED: "انتهت الجلسة — سجّل الدخول مرة أخرى.",
  FORBIDDEN: "ليست لديك صلاحية لهذا الإجراء.",
  NOT_FOUND: "المحادثة أو الرسالة غير موجودة أو لم تعد متاحة.",
  CONFLICT: "هذه العملية أُرسلت من قبل بمحتوى مختلف — حدّث الصفحة وحاول مرة أخرى.",
  PRECONDITION_FAILED: "مركز الرسائل غير متاح حاليًا.",
  BAD_REQUEST: "تعذّر تنفيذ الطلب — راجع المدخلات.",
  PAYLOAD_TOO_LARGE: "الملف أكبر من المسموح.",
  TOO_MANY_REQUESTS: "طلبات كثيرة — انتظر قليلًا ثم حاول.",
};
const BY_STATUS: Record<number, string> = {
  401: BY_CODE.UNAUTHORIZED,
  403: BY_CODE.FORBIDDEN,
  404: BY_CODE.NOT_FOUND,
  409: BY_CODE.CONFLICT,
  412: BY_CODE.PRECONDITION_FAILED,
  413: "التسجيل أطول من 5 دقائق أو أكبر من 10 ميجا.",
  415: "الملف ليس تسجيلًا صوتيًا مدعومًا.",
  502: "تعذّر حفظ التسجيل — لم تُرسل الرسالة، حاول مرة أخرى.",
  503: "التخزين الدائم غير مضبوط في هذه البيئة — الرسائل الصوتية غير متاحة.",
};
export const OFFLINE_TEXT = "لا يوجد اتصال بالإنترنت — ستُستأنف المزامنة عند عودة الاتصال.";

/** نص عربي مفهوم لأي خطأ (tRPC أو HTTP من مسار الصوت أو شبكة). */
export function messagingErrorText(error: unknown): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return OFFLINE_TEXT;
  if (error instanceof HttpError) return BY_STATUS[error.status] ?? (error.status >= 500 ? "حدث خطأ في الخادم — حاول مرة أخرى." : BY_CODE.BAD_REQUEST);
  if (error instanceof TRPCClientError) {
    const code = (error.data as { code?: string } | undefined)?.code ?? (error.shape as any)?.data?.code;
    if (code === "BAD_REQUEST" && error.message && !/[{}\[\]]/.test(error.message)) return error.message; // رسائل السيرفر العربية (مثل «الرسالة فارغة»)
    if (code && BY_CODE[code]) return BY_CODE[code];
    if (/الحساب في وضع القراءة فقط/.test(error.message)) return error.message;
  }
  return "تعذّر الاتصال — حاول مرة أخرى.";
}

/** خطأ HTTP من مسار الصوت (ليس tRPC) — يحمل الحالة فقط. */
export class HttpError extends Error {
  constructor(public status: number) { super(`HTTP ${status}`); this.name = "HttpError"; }
}

/** رمز tRPC من الخطأ (للحالات الخاصة: الصلاحية/العلم). */
export function errorCode(error: unknown): string | null {
  if (error instanceof TRPCClientError) return (error.data as { code?: string } | undefined)?.code ?? null;
  return null;
}
