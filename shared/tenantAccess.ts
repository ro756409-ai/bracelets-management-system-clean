/**
 * قرار وصول الشركة حسب حالتها (قرارات المالك) — دالة نقية واحدة، يستخدمها السيرفر (كل الطبقات) والواجهة للعرض.
 *
 *   trialing قبل trialEndsAt ⇒ full؛ عند/بعد trialEndsAt (أو بلا تاريخ) ⇒ read_only
 *   active ⇒ full
 *   past_due ⇒ full خلال 7 أيام من pastDueSince، ثم read_only (بلا pastDueSince ⇒ read_only، fail-closed)
 *   expired ⇒ read_only
 *   suspended / canceled ⇒ blocked
 *   حالة غير معروفة أو شركة غير موجودة ⇒ blocked (fail-closed)
 *
 * read_only: دخول، قراءة، تصدير، إعدادات الاشتراك، خروج — لا كتابة. blocked: لا شيء عدا الخروج وشاشة الحالة.
 * الويبهوك: يُستقبل ويُخزَّن دائمًا؛ يُعالج فقط والوصول full، والمؤجل يُعالج مرة واحدة بعد إعادة التفعيل.
 */
export type TenantAccessLevel = "full" | "read_only" | "blocked";
export type TenantAccessReason =
  | "trial" | "trial_ended" | "active" | "past_due_grace" | "past_due_ended" | "expired" | "suspended" | "canceled" | "unknown";
export type TenantAccess = { level: TenantAccessLevel; reason: TenantAccessReason; processWebhooks: boolean; runJobs: boolean; until: Date | null };

export const PAST_DUE_GRACE_DAYS = 7;
const DAY = 86_400_000;

const make = (level: TenantAccessLevel, reason: TenantAccessReason, until: Date | null = null): TenantAccess =>
  ({ level, reason, processWebhooks: level === "full", runJobs: level === "full", until });

export function computeTenantAccess(
  tenant: { status: string; trialEndsAt: Date | null } | null | undefined,
  pastDueSince: Date | null,
  now: Date,
): TenantAccess {
  if (!tenant) return make("blocked", "unknown");
  switch (tenant.status) {
    case "active": return make("full", "active");
    case "trialing":
      return tenant.trialEndsAt && now.getTime() < tenant.trialEndsAt.getTime()
        ? make("full", "trial", tenant.trialEndsAt)
        : make("read_only", "trial_ended", tenant.trialEndsAt);
    case "past_due": {
      if (!pastDueSince) return make("read_only", "past_due_ended");
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

/** هل نداء tRPC مسموح لهذا المستوى؟ */
export function trpcCallAllowed(access: TenantAccess, type: "query" | "mutation" | "subscription", path: string): boolean {
  if (access.level === "full") return true;
  if (access.level === "blocked") return BLOCKED_ALLOWED_PATHS.includes(path);
  if (type === "query") return true;
  return READ_ONLY_ALLOWED_MUTATIONS.includes(path) || path.startsWith(SUBSCRIPTION_SETTINGS_PREFIX);
}

/** هل طلب Express مسموح؟ القراءة (GET/HEAD) = قراءة/تصدير؛ أي method آخر كتابة (رفع/استيراد). */
export function httpRequestAllowed(access: TenantAccess, method: string): boolean {
  if (access.level === "full") return true;
  if (access.level === "blocked") return false;
  return method === "GET" || method === "HEAD";
}

export const TENANT_ACCESS_MESSAGES: Record<TenantAccessReason, string> = {
  trial: "الفترة التجريبية سارية",
  trial_ended: "انتهت الفترة التجريبية — الحساب للقراءة فقط حتى الاشتراك",
  active: "الاشتراك فعّال",
  past_due_grace: "يوجد دفع متأخر — مهلة 7 أيام قبل وضع القراءة فقط",
  past_due_ended: "انتهت مهلة الدفع المتأخر — الحساب للقراءة فقط",
  expired: "انتهى الاشتراك — الحساب للقراءة فقط",
  suspended: "الحساب موقوف — تواصل مع الدعم",
  canceled: "الاشتراك ملغي — تواصل مع الدعم",
  unknown: "تعذّر تحديد حالة الحساب",
};
