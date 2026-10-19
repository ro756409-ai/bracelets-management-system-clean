import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "@/components/shared/toast";
import { READ_ONLY_MESSAGE, READ_SAFE_ZONE, WRITE_CONTROL_SELECTOR, blockedWriteControl, isReadSafeControl, setTenantAccessLevel } from "@/lib/tenantReadOnly";
import type { TenantAccessLevel, TenantAccessReason } from "@shared/tenantAccess";

/**
 * مصدر الواجهة **الوحيد** لحالة وصول الشركة (`tenantAccess.status`). العلم معطل أو بلا جلسة ⇒ full ولا شيء
 * يتغيّر إطلاقًا. read_only ⇒ حارس التفاعل (ReadOnlyGuard) + رابط tRPC يرفض الكتابة؛ blocked ⇒ شاشة كاملة.
 * الإخفاء/التعطيل هنا تجربة استخدام فقط — حارس السيرفر هو الحماية.
 */
export type TenantAccessView = { enforced: boolean; level: TenantAccessLevel; reason: TenantAccessReason | null; message: string | null; until: Date | string | null; readOnly: boolean; blocked: boolean; billing: boolean };
const FULL: TenantAccessView = { enforced: false, level: "full", reason: null, message: null, until: null, readOnly: false, blocked: false, billing: false };
const Ctx = createContext<TenantAccessView>(FULL);
export const useTenantAccess = () => useContext(Ctx);

export function TenantAccessProvider({ children }: { children: ReactNode }) {
  const { data } = trpc.tenantAccess.status.useQuery(undefined, { retry: false, staleTime: 60_000, refetchOnWindowFocus: true });
  const value = useMemo<TenantAccessView>(() => {
    if (!data) return FULL;
    const billing = Boolean((data as { billing?: boolean }).billing);
    if (!data.enforced) return billing ? { ...FULL, billing } : FULL;
    return { enforced: true, level: data.level, reason: data.reason, message: data.message, until: data.until ?? null, readOnly: data.level === "read_only", blocked: data.level === "blocked", billing };
  }, [data]);
  useEffect(() => { setTenantAccessLevel(value.level); }, [value.level]);
  return (
    <Ctx.Provider value={value}>
      {value.readOnly && <ReadOnlyGuard />}
      {children}
    </Ctx.Provider>
  );
}

const BLOCKED_ATTR = "data-readonly-blocked";
const TITLE_ATTR = "data-readonly-title";

/** يعلّم كل عنصر كتابة غير آمن: aria-disabled + السبب كتلميح + مظهر معطّل (CSS). */
export function annotateReadOnly(root: ParentNode = document): number {
  let n = 0;
  root.querySelectorAll(WRITE_CONTROL_SELECTOR).forEach(el => {
    const blocked = !(el as HTMLButtonElement).disabled && !isReadSafeControl(el);
    if (blocked && !el.hasAttribute(BLOCKED_ATTR)) {
      el.setAttribute(BLOCKED_ATTR, "");
      el.setAttribute("aria-disabled", "true");
      if (!el.getAttribute("title")) { el.setAttribute("title", READ_ONLY_MESSAGE); el.setAttribute(TITLE_ATTR, ""); }
    }
    if (blocked) n++;
  });
  return n;
}
export function clearReadOnlyAnnotations(root: ParentNode = document) {
  root.querySelectorAll(`[${BLOCKED_ATTR}]`).forEach(el => {
    el.removeAttribute(BLOCKED_ATTR);
    el.removeAttribute("aria-disabled");
    if (el.hasAttribute(TITLE_ATTR)) { el.removeAttribute("title"); el.removeAttribute(TITLE_ATTR); }
  });
}

/**
 * حارس التفاعل (يُركَّب في read_only فقط): يمنع تفعيل أي عنصر كتابة غير آمن في مرحلة الالتقاط (قبل React)
 * لكل من الفأرة/اللمس/لوحة المفاتيح/إرسال النماذج، ويعلّمه معطّلًا بصريًا ولقارئ الشاشة مع السبب.
 */
export function ReadOnlyGuard() {
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-tenant-readonly", "true");
    let lastToast = 0;
    const notify = () => { const now = Date.now(); if (now - lastToast > 2500) { lastToast = now; toast.warning(READ_ONLY_MESSAGE); } };
    const stop = (e: Event, withToast: boolean) => { e.preventDefault(); e.stopImmediatePropagation(); if (withToast) notify(); };
    const onPointer = (e: Event) => { if (blockedWriteControl(e.target)) stop(e, e.type === "click"); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (blockedWriteControl(e.target)) stop(e, true);
    };
    const onSubmit = (e: Event) => {
      const form = e.target as Element | null;
      if (form instanceof Element && !form.closest(READ_SAFE_ZONE)) stop(e, true);
    };
    const types = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"] as const;
    types.forEach(t => document.addEventListener(t, onPointer, true));
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("submit", onSubmit, true);
    // setTimeout لا requestAnimationFrame: الأخير لا يعمل والصفحة في الخلفية فيتأخر التعليم البصري.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; annotateReadOnly(); }, 30); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "role", "aria-haspopup", "aria-expanded"] });
    annotateReadOnly();
    return () => {
      types.forEach(t => document.removeEventListener(t, onPointer, true));
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("submit", onSubmit, true);
      mo.disconnect();
      if (timer) clearTimeout(timer);
      html.removeAttribute("data-tenant-readonly");
      clearReadOnlyAnnotations();
    };
  }, []);
  return null;
}
