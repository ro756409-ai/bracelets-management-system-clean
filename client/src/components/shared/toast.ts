import { toast as sonnerToast } from "sonner";

/**
 * Thin Arabic-first wrapper around sonner. Not a replacement — every page already calls
 * `toast.success(...)` directly and that keeps working. This exists so new code has a
 * single place that enforces the two rules from the safety brief: never show a raw
 * technical error, and always confirm what happened in Arabic.
 */
export const toast = {
  success: (message: string) => sonnerToast.success(message),
  /** `action` اختياري: زر إجراء صريح داخل الرسالة (مثل «بدء عملية جديدة» عند CONFLICT في منع التكرار). */
  error: (message: string, opts?: { action?: { label: string; onClick: () => void } }) =>
    sonnerToast.error(message, opts?.action ? { action: opts.action } : undefined),
  warning: (message: string) => sonnerToast.warning(message),
  info: (message: string) => sonnerToast.info(message),
  /**
   * For a caught error whose `message` may be a raw provider/stack string. Falls back to
   * a generic Arabic message rather than ever rendering the raw error to the user.
   */
  apiError: (err: unknown, fallback = "حدث خطأ غير متوقع، حاول مرة أخرى") => {
    const message =
      err && typeof err === "object" && "message" in err && typeof (err as any).message === "string"
        ? (err as any).message
        : undefined;
    // Heuristic: a message that looks like Arabic prose (has Arabic letters) came from
    // our own tRPC error text and is safe to show. Anything else (stack traces, "fetch
    // failed", provider JSON) is technical and gets replaced.
    const looksArabic = message ? /[؀-ۿ]/.test(message) : false;
    sonnerToast.error(looksArabic ? message! : fallback);
  },
};
