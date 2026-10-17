import { TRPCError } from "@trpc/server";

/**
 * خطأ أعمال رسالته مقصودة للعميل (تصنيف صريح). أي خطأ تاني بيوصل للعميل/اللوج كـ«خطأ داخلي» + كود آمن بس.
 * أخطاء الأعمال المسمّاة (OrderStatusGuardError، StockShortfallError، InventoryScopeError، ...) بتورث منه.
 */
export class ClientSafeError extends Error {}

const GENERIC = "خطأ داخلي";
const MAX_MESSAGE = 300;
/** أخطاء التشغيل نفسها (مش رسائل أعمال): نصها ممكن يحمل أجزاء من البيانات (JSON.parse، قراءة خاصية من قيمة عميل...). */
const RUNTIME_ERROR_NAMES = new Set(["TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError"]);
/** خصائص أخطاء الـdriver/الـORM/HTTP — وجود أي منها = مش رسالة أعمال. */
const DRIVER_KEYS = ["errno", "sql", "sqlMessage", "sqlState", "sqlstate", "query", "params", "response", "$metadata"];
/** محتوى ممنوع في أي رسالة توصل للعميل حتى لو صنّفها الكود كرسالة أعمال: SQL، stack، روابط، إيميلات، أرقام طويلة (هواتف/بطاقات). */
const UNSAFE_CONTENT = [
  /failed query|params:|\bselect\b|\binsert\s+into\b|\bupdate\s+`|\bdelete\s+from\b|\bfrom\s+`|\bwhere\s+`|\bvalues\s*\(|\b(alter|create|drop)\s+table\b/i,
  /\bat\s+\S+\s+\(|node:internal|\.(?:ts|js|mjs):\d+/i,
  /https?:\/\/|www\./i,
  /@/,
  /[\r\n`{}<>]/,
];

function hasLongDigitRun(message: string): boolean {
  // أرقام لاتينية أو عربية-هندية؛ المسافات/الشرط بين الأرقام مابتكسرش الرقم (010 1234 5678)
  const digits = message.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/(\d)[\s-]+(?=\d)/g, "$1");
  return /\d{9,}/.test(digits);
}

function isSafeContent(message: string, requireArabic: boolean): boolean {
  if (!message || message.length > MAX_MESSAGE) return false;
  if (requireArabic && !/[؀-ۿ]/.test(message)) return false;
  if (UNSAFE_CONTENT.some(re => re.test(message))) return false;
  return !hasLongDigitRun(message);
}

function hasDriverShape(err: object): boolean {
  return DRIVER_KEYS.some(k => k in err) || ("code" in err && !(err instanceof TRPCError));
}

/**
 * التصنيف الصريح لرسالة صالحة للعميل:
 * 1. `ClientSafeError` (وأخطاء الأعمال المسمّاة اللي بتورث منه) — بفحص محتوى دفاعي.
 * 2. توافق مع رسائل الأعمال القديمة (`throw new Error("رسالة عربي")` — مئات المواضع): `Error` **بالظبط** (مش TypeError
 *    ولا خطأ driver ولا مكتبة)، أو `TRPCError` كتبه الكود من غير `cause` — ومن غير `cause` ولا خصائص driver، ورسالة
 *    بالعربي سطر واحد قصير تعدّي فحص المحتوى. رسائل المكتبات والـruntime إنجليزي فمابتعدّيش.
 * أي حاجة تانية = null.
 */
function clientMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  if (err instanceof ClientSafeError) return isSafeContent(err.message, false) ? err.message : null;
  if (RUNTIME_ERROR_NAMES.has(err.name)) return null;
  const plain = Object.getPrototypeOf(err) === Error.prototype && err.name === "Error";
  const authoredTrpc = err instanceof TRPCError && err.cause === undefined;
  if (!plain && !authoredTrpc) return null;
  if (!authoredTrpc && (err.cause !== undefined || hasDriverShape(err))) return null;
  return isSafeContent(err.message, true) ? err.message : null;
}

/**
 * كود تشخيصي آمن — Allowlist لأشكال معروفة بس، مفيش قيمة غير موثوقة بتنعكس كما هي (`code`/`errno`/`name` ممكن يحملوا
 * أي قيمة، زي رقم هاتف):
 * - كود MySQL (`ER_` + حروف كبيرة و`_`)، وكود نظام Node (`E` + حروف كبيرة، زي ECONNREFUSED)، وكود undici (`UND_ERR_...`) —
 *   من غير أرقام خالص.
 * - `HTTP_<status>` لـ`status` رقم صحيح بين 100 و599 بس.
 * - اسم صنف خطأ بالشكل `<Xxx>Error` حروف بس (TypeError، DrizzleQueryError، EasyOrderApiError، ...).
 * `errno` (رقم) مابيظهرش خالص. أي حاجة تانية = من غير كود.
 */
const KNOWN_CODE = /^(?:ER_[A-Z_]{2,60}|E[A-Z]{3,20}|UND_ERR_[A-Z_]{2,40})$/;
const KNOWN_ERROR_NAME = /^[A-Z][A-Za-z]{2,40}Error$/;

function diagnosticTag(err: unknown): string | null {
  const e = err as { name?: unknown; code?: unknown; status?: unknown; cause?: { code?: unknown } } | null;
  for (const c of [e?.cause?.code, err instanceof TRPCError ? undefined : e?.code])
    if (typeof c === "string" && KNOWN_CODE.test(c)) return c;
  const status = e?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP_${status}`;
  if (typeof e?.name === "string" && KNOWN_ERROR_NAME.test(e.name)) return e.name;
  return null;
}

/**
 * نص خطأ آمن للعميل وللّوج ولأي سجل محفوظ (سجلات Webhook وأسباب فشل الـinbox). رسالة الخطأ بتعدّي بس لو اتصنّفت صراحةً
 * كرسالة أعمال (`clientMessage`)؛ أي خطأ تاني — رسالة الـORM (نص الاستعلام + params = بيانات العميل)، خطأ driver، خطأ
 * runtime، رسالة مكتبة، رد API خارجي — بيرجع «خطأ داخلي (كود)» من غير نص الرسالة أبدًا.
 * (اتنقلت من bostaWebhook.ts عشان Easy Order وtRPC يستخدموها — INT-2 / INT-5.)
 */
export function safeErrorText(err: unknown): string {
  const message = clientMessage(err);
  if (message != null) return message;
  const tag = diagnosticTag(err);
  return tag ? `${GENERIC} (${tag})` : GENERIC;
}
