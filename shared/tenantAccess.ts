import type { BillingStatus } from "./billing";

/**
 * قرار وصول الشركة حسب حالتها (قرارات المالك) — دالة نقية واحدة، يستخدمها السيرفر (كل الطبقات) والواجهة للعرض.
 *
 *   trialing قبل trialEndsAt ⇒ full؛ عند/بعد trialEndsAt ⇒ read_only
 *   trialing بلا trialEndsAt ⇒ read_only كحالة آمنة (سبب مستقل trial_no_end_date — يظهر في قسم تحذير بالمعاينة)
 *   active ⇒ full
 *   past_due ⇒ full خلال 7 أيام من pastDueSince، ثم read_only
 *   past_due بلا فترة اشتراك معروفة ⇒ read_only فورًا (سبب مستقل past_due_unknown_period — قسم تحذير بالمعاينة)
 * لا يُفعَّل TENANT_ACCESS_ENFORCEMENT_ENABLED قبل مراجعة نتيجة scripts/preview-tenant-access يدويًا، ولا تعديل
 * تلقائي لحالة أي شركة في أي مكان.
 *   expired ⇒ read_only
 *   suspended / canceled ⇒ blocked
 *   حالة غير معروفة أو شركة غير موجودة ⇒ blocked (fail-closed)
 *
 * read_only: دخول، قراءة، تصدير، إعدادات الاشتراك، خروج — لا كتابة. blocked: لا شيء عدا الخروج وشاشة الحالة.
 * الويبهوك: يُستقبل ويُخزَّن دائمًا؛ يُعالج فقط والوصول full، والمؤجل يُعالج مرة واحدة بعد إعادة التفعيل.
 *
 * شركة على **نموذج الاشتراك** (`billing` ≠ null — لها صف tenant_billing_accounts؛ الشركات الحالية مش بتتسجّل تلقائيًا):
 *   suspended / canceled ⇒ blocked (قرار المنصة يسبق الدفع)
 *   active / grace (72 ساعة بعد النهاية) ⇒ full
 *   pending_payment / expired ⇒ restricted: قراءة + تجديد + دعم + العمليات التصحيحية الآمنة فقط
 *     (إلغاء أوردر قائم، مرتجع، تصحيح مخزون، حسم شحنة بوسطة، طباعة بوليصة قائمة) — لا عمليات تجارية جديدة.
 *     ويبهوك بوسطة للشحنات القائمة بيتعالج؛ Easy Order: تحديث حالة أوردر قائم بيتعالج، والأوردر **الجديد** بيتأجل
 *     (acceptNewOrders=false) ويتعالج مرة واحدة بعد التجديد. المهام الخلفية: full فقط.
 */
export type TenantAccessLevel = "full" | "restricted" | "read_only" | "blocked";
export type TenantAccessReason =
  | "trial" | "trial_ended" | "trial_no_end_date" | "active" | "past_due_grace" | "past_due_ended" | "past_due_unknown_period"
  | "expired" | "suspended" | "canceled" | "unknown"
  | "subscription_active" | "subscription_grace" | "subscription_pending_payment" | "subscription_expired";
export type TenantAccess = { level: TenantAccessLevel; reason: TenantAccessReason; processWebhooks: boolean; runJobs: boolean; until: Date | null; acceptNewOrders?: boolean };

export const PAST_DUE_GRACE_DAYS = 7;
const DAY = 86_400_000;

const make = (level: TenantAccessLevel, reason: TenantAccessReason, until: Date | null = null): TenantAccess =>
  level === "restricted"
    ? { level, reason, processWebhooks: true, runJobs: false, until, acceptNewOrders: false }
    : { level, reason, processWebhooks: level === "full", runJobs: level === "full", until };

/** هل الشركة تقبل أوردرات جديدة من التكاملات؟ (غياب الحقل = نفس processWebhooks — السلوك القديم). */
export const acceptsNewOrders = (a: TenantAccess) => a.acceptNewOrders ?? a.processWebhooks;

export function computeTenantAccess(
  tenant: { status: string; trialEndsAt: Date | null } | null | undefined,
  pastDueSince: Date | null,
  now: Date,
  /** حالة الاشتراك المشتقة — فقط لشركة مسجّلة في نموذج الاشتراك؛ null/غياب = السلوك القديم كما هو. */
  billing?: BillingStatus | null,
): TenantAccess {
  if (!tenant) return make("blocked", "unknown");
  if (billing) {
    if (tenant.status === "suspended") return make("blocked", "suspended");
    if (tenant.status === "canceled") return make("blocked", "canceled");
    switch (billing.state) {
      case "active": return make("full", "subscription_active", billing.paidUntil);
      case "grace": return make("full", "subscription_grace", billing.graceEndsAt);
      case "pending_payment": return make("restricted", "subscription_pending_payment");
      case "expired": return make("restricted", "subscription_expired", billing.graceEndsAt);
    }
  }
  switch (tenant.status) {
    case "active": return make("full", "active");
    case "trialing":
      if (!tenant.trialEndsAt) return make("read_only", "trial_no_end_date");
      return now.getTime() < tenant.trialEndsAt.getTime()
        ? make("full", "trial", tenant.trialEndsAt)
        : make("read_only", "trial_ended", tenant.trialEndsAt);
    case "past_due": {
      if (!pastDueSince) return make("read_only", "past_due_unknown_period");
      const graceEnd = new Date(pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * DAY);
      return now.getTime() < graceEnd.getTime() ? make("full", "past_due_grace", graceEnd) : make("read_only", "past_due_ended", graceEnd);
    }
    case "expired": return make("read_only", "expired");
    case "suspended": return make("blocked", "suspended");
    case "canceled": return make("blocked", "canceled");
    default: return make("blocked", "unknown");
  }
}

/** ما يُسمح به في read_only من الكتابات (tRPC paths) — دخول/خروج وإعدادات الاشتراك فقط. */
export const READ_ONLY_ALLOWED_MUTATIONS: readonly string[] = ["auth.logout"];
export const SUBSCRIPTION_SETTINGS_PREFIX = "subscription.";
/** ما يُسمح به في blocked (قراءة الهوية وحالة الوصول لعرض الشاشة + الخروج). */
export const BLOCKED_ALLOWED_PATHS: readonly string[] = ["auth.me", "auth.logout", "auth.myPermissions", "employeePortal.me", "tenantAccess.status", "system.health"];
/**
 * restricted (اشتراك لم يُدفع/انتهى بعد السماح): الكتابات التصحيحية الآمنة على بيانات **قائمة** فقط — لا إنشاء أوردر، لا
 * تأكيد، لا إرسال لبوسطة، لا استيراد. كل إجراء هنا لسه بيمر بصلاحياته ونطاق الشركة/النشاط العادي.
 */
export const RESTRICTED_ALLOWED_MUTATIONS: readonly string[] = [
  "auth.logout",
  "orders.cancel",                 // إلغاء أوردر قائم (يرجّع المخزون بنفس الدورة)
  "returns.markAsReturned",        // تسجيل مرتجع
  "printLogs.create",              // طباعة بوليصة/شيت لأوردرات قائمة
  "orders.bostaLinkShipment", "orders.bostaRequestReset", "orders.bostaApproveReset", // حسم شحنة قائمة غير مؤكدة
  "inventoryLedger.handover",      // تسليم مخزون لأوردر قائم
  "variants.updateStock",          // تصحيح رصيد
  "accountingV2.stocktakeCreate", "accountingV2.stocktakeLineUpdate", "accountingV2.stocktakeSubmit", "accountingV2.stocktakeApprove", // جرد
  "accountingV2.returnInspectionSubmit", "accountingV2.returnInspectionApprove", // فحص مرتجع
];

/** هل نداء tRPC مسموح لهذا المستوى؟ */
/** الأسباب الآمنة الافتراضية التي تحتاج مراجعة يدوية قبل التفعيل (أقسام تحذير مستقلة في المعاينة). */
export const REVIEW_BEFORE_ENABLE_REASONS: readonly TenantAccessReason[] = ["trial_no_end_date", "past_due_unknown_period"];

export function trpcCallAllowed(access: TenantAccess, type: "query" | "mutation" | "subscription", path: string): boolean {
  if (access.level === "full") return true;
  if (access.level === "blocked") return BLOCKED_ALLOWED_PATHS.includes(path);
  if (type === "query") return true;
  if (access.level === "restricted") return RESTRICTED_ALLOWED_MUTATIONS.includes(path) || path.startsWith(SUBSCRIPTION_SETTINGS_PREFIX);
  return READ_ONLY_ALLOWED_MUTATIONS.includes(path) || path.startsWith(SUBSCRIPTION_SETTINGS_PREFIX);
}

/** هل طلب Express مسموح؟ القراءة (GET/HEAD) = قراءة/تصدير؛ أي method آخر كتابة (رفع/استيراد). */
export function httpRequestAllowed(access: TenantAccess, method: string): boolean {
  if (access.level === "full") return true;
  if (access.level === "blocked") return false;
  // restricted مثل read_only هنا: مسارات Express الكاتبة = رفع/استيراد (عمليات جديدة)، مش تصحيح.
  return method === "GET" || method === "HEAD";
}

export const TENANT_ACCESS_MESSAGES: Record<TenantAccessReason, string> = {
  trial: "الفترة التجريبية سارية",
  trial_ended: "انتهت الفترة التجريبية — الحساب للقراءة فقط حتى الاشتراك",
  trial_no_end_date: "الفترة التجريبية بلا تاريخ نهاية مسجّل — الحساب للقراءة فقط حتى المراجعة",
  active: "الاشتراك فعّال",
  past_due_grace: "يوجد دفع متأخر — مهلة 7 أيام قبل وضع القراءة فقط",
  past_due_ended: "انتهت مهلة الدفع المتأخر — الحساب للقراءة فقط",
  past_due_unknown_period: "دفع متأخر بلا فترة اشتراك معروفة — الحساب للقراءة فقط حتى المراجعة",
  expired: "انتهى الاشتراك — الحساب للقراءة فقط",
  suspended: "الحساب موقوف — تواصل مع الدعم",
  canceled: "الاشتراك ملغي — تواصل مع الدعم",
  unknown: "تعذّر تحديد حالة الحساب",
  subscription_active: "الاشتراك فعّال",
  subscription_grace: "انتهت مدة الاشتراك — فترة سماح 72 ساعة والتشغيل مستمر، جدّد لتجنّب التوقف",
  subscription_pending_payment: "الحساب جاهز — فعّل الاشتراك لبدء العمليات الجديدة (العرض والتصحيح متاحين)",
  subscription_expired: "انتهى الاشتراك — العرض والتجديد والدعم والتصحيح متاحين، والعمليات الجديدة متوقفة لحد التجديد",
};
