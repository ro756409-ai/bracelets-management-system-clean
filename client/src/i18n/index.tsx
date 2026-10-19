import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { activeBrand } from "@/lib/brandFlag";
import { MESSAGES, type MessageKey } from "./messages";

/**
 * ترجمة AR/EN حقيقية للصفحات العامة (الرئيسية، الدخول، التسجيل) وصفحة الاشتراك — قاموس مكتوب (كل مفتاح لازم يكون موجود في
 * اللغتين، والـtype بيفرض ده)، واتجاه RTL/LTR، والاختيار محفوظ في المتصفح (`mj.lang`).
 *
 *  • الهوية v1 (VITE_BRAND غير v2): العربي دائمًا ولا زر لغة — نفس الشكل الحالي بالظبط.
 *  • باقي صفحات النظام الداخلية لسه عربي/RTL — الصفحة المترجمة بتضبط lang/dir على <html> وهي مفتوحة بس وترجّعهم بعد كده.
 *  • التخزين ممكن يكون مقفول (وضع خاص) — كل قراءة/كتابة جوه try/catch، والافتراضي العربي.
 */
export type Lang = "ar" | "en";
export const LANG_STORAGE_KEY = "mj.lang";

export function readStoredLang(): Lang {
  try { return localStorage.getItem(LANG_STORAGE_KEY) === "en" ? "en" : "ar"; } catch { return "ar"; }
}
function storeLang(lang: Lang) {
  try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch { /* التخزين غير متاح — الاختيار للجلسة دي بس */ }
}

export const dirOf = (lang: Lang): "rtl" | "ltr" => (lang === "ar" ? "rtl" : "ltr");

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  let s: string = MESSAGES[lang][key] ?? MESSAGES.ar[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

type I18nValue = { lang: Lang; dir: "rtl" | "ltr"; canSwitch: boolean; setLang: (l: Lang) => void; t: (key: MessageKey, vars?: Record<string, string | number>) => string };
const fallback: I18nValue = { lang: "ar", dir: "rtl", canSwitch: false, setLang: () => {}, t: (k, v) => translate("ar", k, v) };
const Ctx = createContext<I18nValue>(fallback);

export function I18nProvider({ children, brand = activeBrand() }: { children: ReactNode; brand?: ReturnType<typeof activeBrand> }) {
  const canSwitch = brand === "v2";
  const [lang, setLangState] = useState<Lang>(() => (canSwitch ? readStoredLang() : "ar"));
  const setLang = useCallback((l: Lang) => { if (!canSwitch) return; setLangState(l); storeLang(l); }, [canSwitch]);
  const value = useMemo<I18nValue>(() => ({ lang, dir: dirOf(lang), canSwitch, setLang, t: (k, v) => translate(lang, k, v) }), [lang, canSwitch, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);

/** للصفحة المترجمة: lang/dir على <html> طول ما هي مفتوحة (قارئ الشاشة والخطوط والتمرير)، وترجع للعربي بعد الخروج. */
export function useDocumentLang() {
  const { lang, dir } = useI18n();
  useEffect(() => {
    const html = document.documentElement;
    const prev = { lang: html.getAttribute("lang"), dir: html.getAttribute("dir") };
    html.setAttribute("lang", lang); html.setAttribute("dir", dir);
    return () => { html.setAttribute("lang", prev.lang ?? "ar"); html.setAttribute("dir", prev.dir ?? "rtl"); };
  }, [lang, dir]);
}
