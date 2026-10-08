import { useEffect, useState } from "react";

/**
 * يقرأ استعلام وسائط واحدًا ويتابعه. `fallback` هو ما يُفترض عندما لا يوجد `matchMedia` (jsdom/SSR)
 * — الجدول يفترض الشاشة الواسعة حتى لا تتغيّر نتائج الاختبارات القائمة.
 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback);
  const [matches, setMatches] = useState<boolean>(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}
