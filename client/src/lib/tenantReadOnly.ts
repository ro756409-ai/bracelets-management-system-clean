import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "../../../server/routers";
import { trpcCallAllowed, type TenantAccess, type TenantAccessLevel } from "@shared/tenantAccess";

/**
 * وضع «القراءة فقط» للشركة في الواجهة — طبقة **مركزية** فوق حارس السيرفر (الذي يبقى إلزاميًا):
 *  1) مخزن واحد للحالة (من tenantAccess.status) — لا شيء يتغيّر والإنفاذ معطل أو الوصول full.
 *  2) رابط tRPC يرفض أي mutation خارج المسموح (نفس trpcCallAllowed في السيرفر) قبل الشبكة.
 *  3) تصنيف عناصر التفاعل: كل عنصر كتابة (زر/بند قائمة/مفتاح/اختيار/إرسال نموذج) **ممنوع افتراضيًا**
 *     ما لم يكن داخل منطقة قراءة آمنة `[data-readonly-safe]` (تنقل/بحث/فلترة/تواريخ/تبويبات/ترقيم/
 *     تصدير/عرض/خروج) أو فاتح قائمة/اختيار/طيّ. الحرمان الافتراضي = أي زر نُسي يبقى معطلًا (fail-closed).
 */
export const READ_ONLY_MESSAGE = "الحساب في وضع القراءة فقط";

let level: TenantAccessLevel = "full";
const listeners = new Set<() => void>();
export function setTenantAccessLevel(next: TenantAccessLevel) {
  if (next === level) return;
  level = next;
  listeners.forEach(l => l());
}
export const getTenantAccessLevel = () => level;
export function subscribeTenantAccess(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

/** المسموح من الـmutations في المستوى الحالي — نفس قاعدة السيرفر. */
export function clientMutationAllowed(path: string): boolean {
  if (level === "full") return true;
  return trpcCallAllowed({ level, reason: "unknown", processWebhooks: false, runJobs: false, until: null } as TenantAccess, "mutation", path);
}

export const readOnlyLink: TRPCLink<AppRouter> = () => ({ op, next }) =>
  observable(observer => {
    if (op.type === "mutation" && !clientMutationAllowed(op.path)) {
      observer.error(TRPCClientError.from(new Error(READ_ONLY_MESSAGE)));
      return;
    }
    return next(op).subscribe(observer);
  });

/** عناصر التفاعل التي قد تكتب. الروابط `a[href]` تنقّل فلا تدخل هنا. */
export const WRITE_CONTROL_SELECTOR = [
  "button", "[role=button]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
  "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=option]",
  "input[type=checkbox]", "input[type=radio]", "input[type=file]", "input[type=submit]", "input[type=button]",
].join(",");

/** مناطق القراءة الآمنة: المعلَّمة صراحةً + أي نموذج بحث (role=search). */
export const READ_SAFE_ZONE = "[data-readonly-safe], [role=search]";

/** هل هذا العنصر (عنصر تفاعل) آمن للقراءة؟ */
export function isReadSafeControl(el: Element): boolean {
  if (el.closest("[data-readonly-write]")) return false;
  if (el.closest(READ_SAFE_ZONE)) return true;
  const role = el.getAttribute("role");
  if (role === "tab") return true;
  // مفاتيح العرض (فلاتر/فترات/أرشيف/تبويبات مضغوطة) تُعلن حالتها بـaria-pressed — تغيير عرض لا كتابة.
  // الاستثناء الوحيد في الكود (تفعيل/تعطيل نشاط) معلَّم صراحةً data-readonly-write.
  if (el.hasAttribute("aria-pressed")) return true;
  // فتح قائمة/اختيار/طيّ قراءة؛ الكتابة تُمنع عند البنود نفسها. فتح نافذة (dialog) ليس قراءة.
  const popup = el.getAttribute("aria-haspopup");
  if (popup && popup !== "dialog" && popup !== "false") return true;
  if (el.hasAttribute("aria-expanded") && !popup) return true;
  // اختيار قيمة داخل قائمة اختيار (فلاتر) قراءة؛ القوائم التي تكتب فورًا تُعلَّم data-readonly-write على مشغّلها ومحتواها.
  if (role === "option") return true;
  return false;
}

/** العنصر التفاعلي الذي يقع عليه الحدث، إن كان عنصر كتابة غير آمن (وإلا null). */
export function blockedWriteControl(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(WRITE_CONTROL_SELECTOR);
  if (!el) return null;
  if ((el as HTMLButtonElement).disabled) return null;
  return isReadSafeControl(el) ? null : el;
}
