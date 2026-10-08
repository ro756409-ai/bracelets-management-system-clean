import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { EMPLOYEE_SESSION_KEY, readEmployeeScope } from "@/lib/employeeScope";
import { useMediaQuery } from "@/components/shared/useMediaQuery";
import {
  DEFAULT_PREFS, applyPrefsToRoot, clearPrefs, identityTag, loadPrefs, resolveIdentity, resolveReduceMotion, resolveTheme, sanitizePrefs, savePrefs,
  type DisplayPrefs, type SessionIdentity,
} from "@/lib/displayPrefs";

/**
 * مزوّد تخصيص العرض (المرحلة 5): يحمل تفضيلات **هذه الجلسة** ويطبّقها على الجذر فورًا.
 *   • الهوية من `auth.me` (مالك `u` / صناعية `s`) أو `employee_session` (موظف `e`) — راجع lib/displayPrefs.
 *   • تغيّر الهوية (خروج/دخول بحساب آخر، في نفس التاب أو تاب آخر) → تحميل تفضيلات الهوية الجديدة؛
 *     الزائر يعود للافتراضي ولا يُحفظ له شيء، فلا تنتقل إعدادات مستخدم لآخر.
 *   • «حسب الجهاز» يتابع `prefers-color-scheme` و`prefers-reduced-motion` أثناء فتح الصفحة (change events).
 *   • الكثافة المدمجة تُطبَّق على الديسكتوب فقط (≥768px).
 */
export interface DisplayPrefsContextValue {
  prefs: DisplayPrefs;
  update: (patch: Partial<DisplayPrefs>) => void;
  reset: () => void;
  /** null = زائر (لا حفظ)؛ undefined = الهوية لم تُحسم بعد */
  identity: SessionIdentity | null | undefined;
  canPersist: boolean;
  resolvedTheme: "light" | "dark";
  reduceMotion: boolean;
  isDesktop: boolean;
}

const DisplayPrefsContext = createContext<DisplayPrefsContextValue | undefined>(undefined);

export function DisplayPrefsProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  // جلسة الموظف المحلية — نفس أسلوب EmployeeScopeGuard: حدث storage من تاب آخر + استطلاع رخيص لنفس التاب.
  const [employeeId, setEmployeeId] = useState<number | null>(() => readEmployeeScope()?.employeeId ?? null);
  useEffect(() => {
    const check = () => { const next = readEmployeeScope()?.employeeId ?? null; setEmployeeId(prev => (prev === next ? prev : next)); };
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === EMPLOYEE_SESSION_KEY) check(); };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(check, 1000);
    return () => { window.removeEventListener("storage", onStorage); window.clearInterval(timer); };
  }, []);

  const identity = useMemo<SessionIdentity | null | undefined>(
    () => (loading ? undefined : resolveIdentity(user as { id: number } | null, employeeId != null ? { employeeId } : null)),
    [user, loading, employeeId]
  );
  const identityKey = identity === undefined ? "__loading__" : identity ? identityTag(identity) : "__guest__";

  const [prefs, setPrefsState] = useState<DisplayPrefs>(() => ({ ...DEFAULT_PREFS }));
  // عند حسم الهوية أو تغيّرها: حمّل تفضيلاتها (الزائر/الخروج = الافتراضي). لا نحمل أبدًا من مفتاح هوية أخرى.
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (identity === undefined) return;
    if (lastKey.current === identityKey) return;
    lastKey.current = identityKey;
    setPrefsState(loadPrefs(identity));
  }, [identity, identityKey]);

  const update = useCallback((patch: Partial<DisplayPrefs>) => {
    setPrefsState(prev => {
      const next = sanitizePrefs({ ...prev, ...patch });
      if (identity) savePrefs(identity, next);
      return next;
    });
  }, [identity]);

  const reset = useCallback(() => {
    setPrefsState({ ...DEFAULT_PREFS });
    if (identity) clearPrefs(identity);
  }, [identity]);

  const systemDark = useMediaQuery("(prefers-color-scheme: dark)", false);
  const systemReduce = useMediaQuery("(prefers-reduced-motion: reduce)", false);
  const isDesktop = useMediaQuery("(min-width: 768px)", true);

  useEffect(() => {
    applyPrefsToRoot(document.documentElement, prefs, { systemDark, systemReduce, isDesktop });
  }, [prefs, systemDark, systemReduce, isDesktop]);

  const value = useMemo<DisplayPrefsContextValue>(() => ({
    prefs, update, reset, identity, canPersist: Boolean(identity),
    resolvedTheme: resolveTheme(prefs.theme, systemDark),
    reduceMotion: resolveReduceMotion(prefs.motion, systemReduce),
    isDesktop,
  }), [prefs, update, reset, identity, systemDark, systemReduce, isDesktop]);

  return <DisplayPrefsContext.Provider value={value}>{children}</DisplayPrefsContext.Provider>;
}

export function useDisplayPrefs(): DisplayPrefsContextValue {
  const ctx = useContext(DisplayPrefsContext);
  if (!ctx) throw new Error("useDisplayPrefs must be used within DisplayPrefsProvider");
  return ctx;
}
