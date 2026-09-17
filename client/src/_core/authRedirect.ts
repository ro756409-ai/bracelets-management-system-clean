import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { getLoginUrl } from "@/const";

/**
 * قرار التحويل لصفحة الدخول عند خطأ UNAUTHORIZED عام — منطق نقي قابل للاختبار.
 *
 * الإصلاح الحرج: الصفحات **العامة** (`/login`, `/signup`) لازم متتطردش أبدًا بسبب query
 * غير مصرّح متأخّر — التاجر بيملأ نموذج التسجيل، ومايصحّش يتحوّل قبل ما يخلّص.
 * مسارات الموظفين محفوظة زي ما كانت (جلساتهم منفصلة).
 */

// صفحات عامة + لوحة المنصة (لها مصادقتها المستقلة): لا تحويل بمعالج 401 الخاص بالعملاء.
export const PUBLIC_PATHS = ["/login", "/signup", "/platform-admin"];

// مسارات الموظفين: UNAUTHORIZED هنا مايوديش لدخول المالك.
export const EMPLOYEE_PATHS = [
  "/employee-login",
  "/employee-dashboard",
  "/warehouse-dashboard",
  "/manager-dashboard",
  "/facebook-entry",
  "/today-shipments",
  "/shipping-schedule",
  "/accountant",
];

/** هل المسار مُعفى من تحويل الدخول (عام أو موظف)؟ مطابقة دقيقة أو بادئة مسار (`/x/…`). */
export function isExemptFromLoginRedirect(pathname: string): boolean {
  return [...PUBLIC_PATHS, ...EMPLOYEE_PATHS].some(
    p => pathname === p || pathname.startsWith(p + "/")
  );
}

/** هل نحوّل لصفحة الدخول؟ فقط لو خطأ tRPC = UNAUTHORIZED **و** المسار مش مُعفى. */
export function shouldRedirectToLogin(error: unknown, pathname: string): boolean {
  if (!(error instanceof TRPCClientError)) return false;
  if (error.message !== UNAUTHED_ERR_MSG) return false;
  if (isExemptFromLoginRedirect(pathname)) return false;
  return true;
}

/**
 * ينفّذ التحويل عند اللزوم. `deps` للاختبار (حقن pathname/redirect)؛ في المتصفّح بيستخدم
 * window.location. مايعملش أي شيء لو المسار مُعفى (بما فيه /signup و/login).
 */
export function handleUnauthorizedRedirect(
  error: unknown,
  deps?: { pathname?: string; redirect?: (url: string) => void }
): void {
  const pathname =
    deps?.pathname ?? (typeof window !== "undefined" ? window.location.pathname : undefined);
  if (pathname === undefined) return;
  if (!shouldRedirectToLogin(error, pathname)) return;
  const redirect = deps?.redirect ?? ((url: string) => { window.location.href = url; });
  redirect(getLoginUrl());
}
